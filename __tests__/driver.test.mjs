// InkLab 场景驱动层：输入安全 + 时序配方 + 场景脚本报告。零浏览器 API，假 view / 假钟 / 假 sleep。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDriver, KEY_STEP_MS, PAGE_SETTLE_MS } from '../lib/driver.mjs';

// ── 替身 ────────────────────────────────────────────────────────────────

/** 假 InkView：把每次调用原样记下来，尤其是 dispatchInput 的时间戳（时序断言全靠它）。 */
function fakeView(extra = {}) {
  const calls = [];
  return {
    calls,
    keydowns: () => calls.filter((c) => c.fn === 'input' && c.type === 'keydown'),
    inputs: () => calls.filter((c) => c.fn === 'input'),
    events: () => calls.filter((c) => c.fn === 'event'),
    dispatchInput: (type, key, ts) => calls.push({ fn: 'input', type, key, ts }),
    dispatchVoiceWakeup: (keyword, ts) => calls.push({ fn: 'wake', keyword, ts }),
    dispatchHostCapabilityEvent: (name, detail) => calls.push({ fn: 'event', name, detail }),
    requestRender: () => calls.push({ fn: 'render' }),
    ...extra,
  };
}

/**
 * 假钟：真实时间只在 sleep 时推进。这样「真实等待」在测试里既是可断言的数字（waits），
 * 又能真的影响 now()——驱动层「虚拟时钟不落后于真实时间」的兜底才测得出来。
 */
const START = 1_000_000;
function fakeClock(start = START) {
  let t = start;
  const waits = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
    waited: () => waits.reduce((a, b) => a + b, 0),
    advance: (ms) => { t += ms; },
  };
}

const makeDriver = (opts = {}) => {
  const view = opts.view || fakeView();
  const clock = opts.clock || fakeClock();
  const driver = createDriver({ view, now: clock.now, sleep: clock.sleep, ...opts.driver });
  return { view, clock, driver };
};

// ── 输入安全：脏参数绝不进 wasm ──────────────────────────────────────────

test('type 不是 keydown/keyup 时抛可读错误，一个字节都不进引擎', async () => {
  const { view, driver } = makeDriver();
  for (const bad of ['keypress', 'key', 'click', '', undefined, null, 42]) {
    assert.throws(() => driver.input(bad, 'Enter'), /type 只能是 keydown \/ keyup/, `应拒绝 ${String(bad)}`);
  }
  assert.equal(view.calls.length, 0, '校验失败时不能调 dispatchInput——脏参数进 wasm 会 memory access out of bounds');
});

test('key 为空串或非字符串时被挡下，且不消耗虚拟时钟', async () => {
  const { view, driver } = makeDriver();
  const before = driver.clock();
  for (const bad of ['', undefined, null, 7, {}, ['Enter'], Symbol('Enter')]) {
    await assert.rejects(() => driver.press(bad), /key 必须是非空字符串/, `应拒绝 ${String(bad)}`);
    assert.throws(() => driver.input('keydown', bad), /key 必须是非空字符串/);
  }
  assert.equal(view.calls.length, 0);
  assert.equal(driver.clock(), before, '坏参数不该推进虚拟时钟，否则后面按键的间隔会被悄悄拉大');

  // 挡下坏参数之后，正常按键仍照配方走（校验不留后遗症）。
  const at = await driver.press('Enter');
  assert.equal(at, before + KEY_STEP_MS);
});

// ── 时序配方：虚拟时间戳跨去重闸，真实等待跨激活冷却 ──────────────────────

test('连按同一个键：虚拟时间戳每次至少 +1500ms，跨过应用约 700ms 的同向去重闸', async () => {
  const { view, driver } = makeDriver();
  await driver.pressMany('ArrowDown', 5);

  const downs = view.keydowns();
  assert.equal(downs.length, 5);
  for (let i = 1; i < downs.length; i += 1) {
    const gap = downs[i].ts - downs[i - 1].ts;
    assert.equal(gap, KEY_STEP_MS, `第 ${i} 次与上一次的时间戳间隔应为 ${KEY_STEP_MS}ms，实际 ${gap}ms`);
    assert.ok(gap > 700, '间隔一旦回退到 700ms 以内，脚本就又会被应用的去重闸吞键');
  }

  // keyup 必须落在自家 keydown 之后、下一次 keydown 之前，否则事件顺序在应用看来是乱的。
  const all = view.inputs();
  assert.deepEqual(all.map((c) => c.type), Array.from({ length: 10 }, (_, i) => (i % 2 ? 'keyup' : 'keydown')));
  for (let i = 0; i < all.length; i += 2) {
    assert.ok(all[i + 1].ts > all[i].ts, 'keyup 要晚于 keydown');
    if (all[i + 2]) assert.ok(all[i + 1].ts < all[i + 2].ts, 'keyup 要早于下一次 keydown');
  }
});

test('连按不做真实等待：去重闸只看事件时间戳，真的 sleep 只会让脚本白慢 n×1.5s', async () => {
  const { clock, driver } = makeDriver();
  await driver.pressMany('ArrowDown', 5);
  assert.deepEqual(clock.waits, [], 'pressMany 不应产生任何真实等待');
});

test('activate/back 换页后真实等待不少于 1300ms —— 这道冷却看应用自己的 Date.now()，跨不过去', async () => {
  const { view, clock, driver } = makeDriver();

  await driver.activate();
  assert.ok(clock.waited() >= PAGE_SETTLE_MS, `activate 后真实等待 ${clock.waited()}ms，应 ≥ ${PAGE_SETTLE_MS}ms`);
  assert.equal(view.keydowns().at(-1).key, 'Enter', 'activate 就是 Enter 的语义封装');

  const afterActivate = clock.waited();
  await driver.back();
  assert.ok(clock.waited() - afterActivate >= PAGE_SETTLE_MS, 'back 同样换页，同样要等冷却');
  assert.equal(view.keydowns().at(-1).key, 'Backspace');
});

test('settle：真实等待之后催一帧渲染（只做单帧的宿主上，不催就会拍到上一屏）', async () => {
  const { view, clock, driver } = makeDriver();
  await driver.settle();
  assert.deepEqual(clock.waits, [PAGE_SETTLE_MS]);
  assert.equal(view.calls.filter((c) => c.fn === 'render').length, 1);

  await driver.settle(50);
  assert.deepEqual(clock.waits, [PAGE_SETTLE_MS, 50], 'settle(ms) 可以指定更短的等待');
});

test('真实等待之后虚拟时间戳不回退（回退会被去重闸当成同一次按键吞掉）', async () => {
  const { view, clock, driver } = makeDriver();
  const first = await driver.press('ArrowDown');
  await driver.wait(10_000);        // 真实时间跑到虚拟时钟前面去了
  clock.advance(5_000);             // 页面加载之类的额外真实耗时
  const second = await driver.press('ArrowDown');

  assert.ok(second > first, '时间戳必须单调递增');
  assert.ok(second > clock.now(), '虚拟时钟要始终领先真实时间，避免下一次按键的间隔被压缩');
  assert.equal(view.keydowns().map((c) => c.ts).sort((a, b) => a - b).join(), `${first},${second}`);
});

// ── 场景脚本 ────────────────────────────────────────────────────────────

test('全绿场景：逐步返回 index/kind/ok/ms，截图打点收进 shots', async () => {
  const view = fakeView();
  const clock = fakeClock();
  const driver = createDriver({
    view, now: clock.now, sleep: clock.sleep, screenshot: (name) => `png:${name}`,
  });

  const res = await driver.runScenario([
    { wake: 'inklab' },
    { pressMany: ['ArrowDown', 3] },
    { activate: true },
    { shot: 'home' },
    { expect: () => view.keydowns().length === 4 },
  ]);

  assert.equal(res.ok, true, res.summary);
  assert.equal(res.failure, null);
  assert.equal(res.skipped, 0);
  assert.deepEqual(res.steps.map((s) => s.kind), ['wake', 'pressMany', 'activate', 'shot', 'expect']);
  assert.deepEqual(res.steps.map((s) => s.ok), [true, true, true, true, true]);
  assert.deepEqual(res.steps.map((s) => s.index), [0, 1, 2, 3, 4]);
  assert.match(res.summary, /5 步全部通过/);

  // 换页那一步的耗时必须体现真实等待，否则说明冷却被省掉了。
  assert.ok(res.steps[2].ms >= PAGE_SETTLE_MS, `activate 步耗时 ${res.steps[2].ms}ms`);
  assert.deepEqual(res.shots, [{ name: 'home', at: clock.now(), value: 'png:home', step: 3 }]);
  assert.equal(view.calls.filter((c) => c.fn === 'wake')[0].keyword, 'inklab');
});

test('单张截图可携带独立 diffOptions，字符串旧写法保持原记录形状', async () => {
  const view = fakeView();
  const clock = fakeClock();
  const driver = createDriver({
    view, now: clock.now, sleep: clock.sleep, screenshot: (name) => `png:${name}`,
  });
  const diffOptions = { tolerance: 1, ignoreRegions: [{ x: 0, y: 10, w: 20, h: 5 }] };
  const res = await driver.runScenario([
    { shot: 'static' },
    { shot: { name: 'live', diffOptions } },
  ]);

  assert.equal(res.ok, true, res.summary);
  assert.deepEqual(res.shots, [
    { name: 'static', at: clock.now(), value: 'png:static', step: 0 },
    { name: 'live', at: clock.now(), value: 'png:live', step: 1, diffOptions },
  ]);
  assert.deepEqual(res.steps.map((step) => step.label), ['shot static', 'shot live']);
});

test('单图 diffOptions 形状错误在截图步骤就失败，不拖到整轮基线阶段', async () => {
  const { driver } = makeDriver({ driver: { screenshot: (name) => `png:${name}` } });
  for (const shot of [
    { name: '', diffOptions: {} },
    { name: 'live', diffOptions: [] },
    { name: 'live', diffOptions: 1 },
  ]) {
    const report = await driver.runScenario([{ shot }]);
    assert.equal(report.ok, false);
    assert.match(report.failure.reason, /shot\.(name|diffOptions)/);
    assert.deepEqual(report.shots, []);
  }
});

test('失败报告指出第几步、什么原因，后面的步骤不再执行', async () => {
  const { view, driver } = makeDriver();
  const res = await driver.runScenario([
    { press: 'ArrowDown' },
    { expect: () => '焦点没落到「今日训练」卡片' },
    { press: 'Enter' },
    { press: 'Enter' },
  ]);

  assert.equal(res.ok, false);
  assert.equal(res.failure.index, 1, '要能定位到具体是第几步');
  assert.equal(res.failure.kind, 'expect');
  assert.equal(res.failure.reason, '焦点没落到「今日训练」卡片', 'expect 返回的字符串就是失败原因');
  assert.match(res.summary, /第 2\/4 步/);
  assert.match(res.summary, /焦点没落到/);
  assert.match(res.summary, /后面 2 步未执行/);

  assert.equal(res.steps.length, 2, '失败即停：只报告已经跑过的步骤');
  assert.equal(res.steps[0].ok, true);
  assert.equal(res.steps[1].ok, false);
  assert.equal(res.steps[1].reason, res.failure.reason);
  assert.equal(view.keydowns().filter((c) => c.key === 'Enter').length, 0, '失败之后不该再往引擎里发键');
});

test('expect 返回 false / 忘了 return / 抛异常，三种写法都能定位到那一步', async () => {
  const cases = [
    [() => false, /expect 返回 false/],
    [() => { /* 忘了 return */ }, /没有给出结论/],
    [() => { throw new Error('页面还停在 home'); }, /页面还停在 home/],
    ['不是函数', /expect 必须是函数/],
  ];
  for (const [expect, pattern] of cases) {
    const { driver } = makeDriver();
    const res = await driver.runScenario([{ press: 'ArrowDown' }, { expect }]);
    assert.equal(res.ok, false);
    assert.equal(res.failure.index, 1);
    assert.match(res.failure.reason, pattern);
  }
});

test('步骤写错当场报出来，不猜作者想干嘛', async () => {
  const { driver } = makeDriver();

  const empty = await driver.runScenario([{}]);
  assert.equal(empty.ok, false);
  assert.equal(empty.steps[0].kind, 'unknown');
  assert.match(empty.failure.reason, /没有任何已知动作/);
  assert.match(empty.failure.reason, /press/, '要顺手列出可用的动作名');

  const ambiguous = await driver.runScenario([{ press: 'Enter', shot: 'home' }]);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.failure.reason, /同时写了 press \+ shot/);

  const notObject = await driver.runScenario(['press Enter']);
  assert.equal(notObject.ok, false);
  assert.match(notObject.failure.reason, /步骤必须是对象/);

  await assert.rejects(() => driver.runScenario('press Enter'), /需要一个步骤数组/);
});

test('没注入 screenshot 时 shot 步骤明确失败，不静默跳过（假装拍了会骗到自己）', async () => {
  const { driver } = makeDriver();
  const res = await driver.runScenario([{ shot: 'home' }]);
  assert.equal(res.ok, false);
  assert.match(res.failure.reason, /没有注入 screenshot/);
  assert.match(res.failure.reason, /home/);
  assert.deepEqual(res.shots, []);
});

test('do 逃生舱拿得到 ctx，可以在脚本中间直接驱动 driver', async () => {
  const { view, driver } = makeDriver();
  const seen = [];
  const res = await driver.runScenario([
    { press: 'ArrowDown' },
    { do: async (ctx) => { seen.push(ctx.index, ctx.view === view); await ctx.driver.press('ArrowUp'); } },
    { expect: (ctx) => ctx.driver.stats().presses === 2 || `presses=${ctx.driver.stats().presses}` },
  ]);

  assert.equal(res.ok, true, res.summary);
  assert.deepEqual(seen, [1, true]);
  assert.deepEqual(view.keydowns().map((c) => c.key), ['ArrowDown', 'ArrowUp']);
});

test('自定义 label 让失败报告直接说人话', async () => {
  const { driver } = makeDriver();
  const res = await driver.runScenario([
    { label: '进入今日训练', activate: true },
    { label: '第一组该出现倒计时', expect: () => false },
  ]);
  assert.equal(res.failure.label, '第一组该出现倒计时');
  assert.match(res.summary, /第一组该出现倒计时/);
});

// ── 能力事件回灌 ────────────────────────────────────────────────────────

test('事件名不在契约里就拒绝，并提示同命名空间可用的名字（拼错是沉默失败的常见来源）', () => {
  const { view, driver } = makeDriver({ driver: { route: { targetId: 't1', sessionId: 's1' } } });

  assert.throws(() => driver.emit('speech.results', { transcript: '开始' }), (err) => {
    assert.match(err.message, /引擎不认识事件 "speech\.results"/);
    assert.match(err.message, /speech\.result/, '提示里要给出正确的名字');
    return true;
  });
  assert.throws(() => driver.emit('camera.frame', {}), /已知命名空间：/);
  assert.throws(() => driver.emit('', {}), /引擎不认识事件/);
  assert.equal(view.events().length, 0, '未知事件名一条都不能进引擎');
});

test('能力事件自动带上引擎给的 targetId/sessionId（漏了引擎认不出是哪一路）', () => {
  const { view, driver } = makeDriver();

  // 路由既可以显式传，也可以先 useRoute 记下引擎调能力方法时给的整个 args。
  driver.emit('speech.result', { transcript: '下一组' }, { targetId: 't1', sessionId: 's1', lang: 'zh' });
  driver.useRoute({ targetId: 't2', sessionId: 's2', continuous: true });
  driver.emit('speech.end', {});
  driver.emit('accelerometer.reading', { x: 0, y: 1, z: 9.8 });

  assert.deepEqual(view.events(), [
    { fn: 'event', name: 'speech.result', detail: { transcript: '下一组', targetId: 't1', sessionId: 's1' } },
    { fn: 'event', name: 'speech.end', detail: { targetId: 't2', sessionId: 's2' } },
    { fn: 'event', name: 'accelerometer.reading', detail: { x: 0, y: 1, z: 9.8, targetId: 't2', sessionId: 's2' } },
  ]);
});

test('拿不到 targetId/sessionId 就不发：引擎那边表现为沉默失败，最难查', () => {
  const { view, driver } = makeDriver();
  assert.throws(() => driver.emit('speech.result', { transcript: '开始' }), /缺 targetId\/sessionId/);
  assert.throws(() => driver.emit('speech.result', {}, { targetId: 't1' }), /缺 targetId\/sessionId/);
  assert.equal(view.events().length, 0);
});

// ── 唤醒与构造 ──────────────────────────────────────────────────────────

test('语音唤醒的 keyword 必须是非空字符串（引擎那边直接抛 TypeError）', async () => {
  const { view, driver } = makeDriver();
  for (const bad of ['', null, 3, {}]) {
    await assert.rejects(() => driver.wake(bad), /keyword 必须是非空字符串/);
  }
  assert.equal(view.calls.length, 0);

  const at = await driver.wake('inklab');
  assert.deepEqual(view.calls, [{ fn: 'wake', keyword: 'inklab', ts: at }]);
  assert.equal(at, START + KEY_STEP_MS, '唤醒也走同一个虚拟时钟，免得和按键时间戳打架');
});

test('createDriver 对注入项挑剔一点，免得半残的 view 跑到一半才炸', async () => {
  assert.throws(() => createDriver(), /带 dispatchInput 的 InkView/);
  assert.throws(() => createDriver({ view: {} }), /带 dispatchInput 的 InkView/);
  assert.throws(() => createDriver({ view: fakeView(), now: 123 }), /now 必须是函数/);
  assert.throws(() => createDriver({ view: fakeView(), sleep: null }), /sleep 必须是函数/);
  assert.throws(() => createDriver({ view: fakeView(), stepMs: 0 }), /stepMs 必须是正数毫秒/);
  assert.throws(() => createDriver({ view: fakeView(), settleMs: -1 }), /settleMs 必须是 ≥0/);

  // 没有 dispatchVoiceWakeup 的 view 也要说清楚缺的是什么，而不是 undefined is not a function。
  const bare = { dispatchInput() {} };
  await assert.rejects(() => createDriver({ view: bare }).wake('x'), /没有 dispatchVoiceWakeup/);
  assert.throws(() => createDriver({ view: bare }).emit('speech.end', {}, { targetId: 't', sessionId: 's' }),
    /没有 dispatchHostCapabilityEvent/);
});

test('onStep：每步 start/end 成对按序到达，钩子抛错不反伤场景', async () => {
  const view = fakeView();
  const events = [];
  const driver = createDriver({
    view,
    sleep: async () => {},
    onStep: (e) => {
      events.push(`${e.phase}:${e.index}:${e.label}${e.phase === 'end' ? `:${e.ok}` : ''}`);
      throw new Error('观察者故意炸'); // 抛错不能打断场景
    },
  });
  const report = await driver.runScenario([
    { press: 'Enter', label: '按一下' },
    { expect: () => '故意失败', label: '断言步' },
    { wait: 1, label: '不会执行' },
  ]);
  assert.equal(report.ok, false, '断言步失败要如实反映');
  assert.deepEqual(events, [
    'start:0:按一下', 'end:0:按一下:true',
    'start:1:断言步', 'end:1:断言步:false',
    // 第 3 步失败即停，不再有事件
  ], '成对、按序，失败即停');
  assert.equal(report.steps.length, 2, '钩子抛错不影响结果记账');
});
