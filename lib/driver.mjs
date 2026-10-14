// driver.mjs — 场景驱动层：把「按哪些键、等多久、断言什么」写成能重放的声明式脚本。
//
// 为什么要有这一层（全部来自 docs/runtime-notes.md 的实测，不是设计偏好）：
//
//  1) **脏参数不能进 wasm**。`dispatchInput` 的 type/key 传错不是普通 JS 异常，而是
//     `memory access out of bounds`；之后引擎状态可能已经脏了，只能重建 InkView。
//     所以校验必须发生在调 wasm 之前，且失败要抛人看得懂的错。
//
//  2) **两道闸的时钟来源不同**，配方也就不同：
//       - 同向导航键去重闸（约 700ms）看事件自带的 timestamp → 用虚拟时钟推进即可跨过；
//       - 换页后的激活冷却（约 1.2s）看应用自己的 Date.now() → 只能真实等待。
//     只推时间戳不等真实时间，就会出现「一批按键只有第一个生效」——实测被这个卡过。
//     因此本模块把「虚拟时间戳」与「真实等待」拆成两件事，谁也不能替谁。
//
//  3) **事件名拼错是沉默失败**。能力事件回灌的名字不在 CAPABILITY_EVENTS 里、或者没原样带回
//     引擎给的 targetId/sessionId，引擎认不出是哪一路，现象是「没反应」而不是报错。
//
// 依赖全靠注入（view / now / sleep / screenshot / log），模块本身零浏览器 API、零 node:fs，
// 所以 node --test 能直接跑，浏览器宿主里也能直接 import 同一份代码。

import { CAPABILITY_EVENTS, isKnownEvent, routeOf } from './caps/contract.mjs';

/** 引擎只认这两个 input type，别的会抛 `Unsupported input event type`。 */
export const INPUT_TYPES = Object.freeze(['keydown', 'keyup']);

/** 每次按键把虚拟时钟推进这么多，用来跨过应用约 700ms 的同向去重闸（留一倍余量）。 */
export const KEY_STEP_MS = 1500;

/** 换页后必须真实等待这么久，用来跨过应用约 1.2s 的激活冷却（这道闸跨不过去，只能等）。 */
export const PAGE_SETTLE_MS = 1300;

/** 按下与抬起之间的自然间隔（约一帧）。真机上 keyup 不会和 keydown 同一毫秒。 */
const KEYUP_GAP_MS = 16;

/** 场景步骤的全部合法写法。同时写两个 = 意图不明，宁可报错也不要猜。 */
export const STEP_KINDS = Object.freeze([
  'press', 'pressMany', 'activate', 'back', 'wait', 'wake', 'shot', 'expect', 'do',
]);

/** 报错里把值原样说清楚：字符串带引号，别的带类型，免得「收到 undefined」看不出是哪种 undefined。 */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value}(${String(value)})`;
}

/**
 * 进 wasm 前的最后一道校验。单独导出是为了让别的宿主代码也能复用同一套口径——
 * 这道校验漏掉一次的代价是引擎状态脏掉，比多校验一次贵得多。
 */
export function assertInput(type, key) {
  if (!INPUT_TYPES.includes(type)) {
    throw new TypeError(
      `dispatchInput 的 type 只能是 ${INPUT_TYPES.join(' / ')}，收到 ${describe(type)}`,
    );
  }
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(
      `dispatchInput 的 key 必须是非空字符串，收到 ${describe(key)}`
      + '（类型传错会让 wasm memory access out of bounds，引擎状态从此不可信，只能重建 InkView）',
    );
  }
}

/**
 * 建一个驱动器。
 *
 * @param {object} opts
 * @param {object} opts.view                InkView 实例（测试里注假的）
 * @param {() => number} [opts.now]         真实时钟，只用于计时与「虚拟时钟不落后于真实时间」的兜底
 * @param {(ms:number) => Promise<void>} [opts.sleep] 真实等待，跨激活冷却唯一的办法
 * @param {(name:string) => any} [opts.screenshot]    截图打点；不注入时 shot 步骤会明确报错而不是静默跳过
 * @param {(line:string) => void} [opts.log]          每步进展的可读日志
 * @param {(event:object) => void} [opts.onStep]      步级进度钩子（宿主页面拿它做实时渲染）：
 *        每步先收 {phase:'start',index,kind,label}，执行完再收 {phase:'end',index,kind,label,ok,ms,reason?}。
 *        观察钩子抛错不反伤场景执行。
 * @param {object} [opts.route]             能力事件默认路由（引擎调能力方法时给的 args，含 targetId/sessionId）
 * @param {number} [opts.stepMs]            虚拟时钟步长，默认 KEY_STEP_MS
 * @param {number} [opts.settleMs]          换页后真实等待，默认 PAGE_SETTLE_MS
 */
export function createDriver({
  view,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  screenshot,
  log,
  onStep,
  route,
  stepMs = KEY_STEP_MS,
  settleMs = PAGE_SETTLE_MS,
} = {}) {
  if (!view || typeof view.dispatchInput !== 'function') {
    throw new TypeError('createDriver 需要一个带 dispatchInput 的 InkView 实例');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须是函数');
  if (typeof sleep !== 'function') throw new TypeError('sleep 必须是函数');
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new TypeError(`stepMs 必须是正数毫秒，收到 ${describe(stepMs)}`);
  }
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    throw new TypeError(`settleMs 必须是 ≥0 的毫秒数，收到 ${describe(settleMs)}`);
  }

  const say = (line) => {
    if (typeof log !== 'function') return;
    try { log(line); } catch { /* 日志不该反伤脚本 */ }
  };
  const notifyStep = (event) => {
    if (typeof onStep !== 'function') return;
    try { onStep(event); } catch { /* 观察钩子不反伤场景执行 */ }
  };

  // 虚拟时钟：只喂给事件的第三参，与真实时间解耦。
  // 每次取值都同时满足两件事——比上一次至少大 stepMs（跨去重闸），且不落后于真实时间
  // （换页真实等待过后真实时间可能已经跑到前面，时间戳回退会被去重闸当成"同一次按键"吞掉）。
  let stamp = now();
  const nextStamp = () => { stamp = Math.max(stamp, now()) + stepMs; return stamp; };
  const keyupGap = Math.min(KEYUP_GAP_MS, Math.floor(stepMs / 2));

  const stats = { inputs: 0, presses: 0, wakes: 0, events: 0, shots: 0, waitedMs: 0 };
  const shots = [];
  let defaultRoute = route;

  /** 单条 input。timestamp 省略时用虚拟时钟；校验永远在 dispatch 之前。 */
  function input(type, key, timestamp) {
    assertInput(type, key);
    const ts = Number.isFinite(timestamp) ? timestamp : nextStamp();
    view.dispatchInput(type, key, ts);
    stats.inputs += 1;
    return ts;
  }

  /** 一次完整按键（按下 + 抬起）。返回这次用的虚拟时间戳，便于排查被吞键。 */
  async function press(key) {
    assertInput('keydown', key); // 先校验再动时钟：坏参数不该消耗时间戳，也不该留下半条 input
    const at = nextStamp();
    input('keydown', key, at);
    input('keyup', key, at + keyupGap);
    stats.presses += 1;
    say(`press ${key} @${at}`);
    return at;
  }

  /**
   * 连按同一个键 n 次。**刻意不做真实等待**：同向去重闸看的是事件时间戳，
   * 虚拟时钟已经把它跨过去了；这里若改成真实 sleep，只会让脚本白白慢 n×1.5s。
   * gapMs 留给确实需要真实节奏的场合（如按键之间要等一次异步渲染）。
   */
  async function pressMany(key, times, { gapMs = 0 } = {}) {
    if (!Number.isInteger(times) || times < 0) {
      throw new TypeError(`pressMany 的次数必须是非负整数，收到 ${describe(times)}`);
    }
    const stamps = [];
    for (let i = 0; i < times; i += 1) {
      stamps.push(await press(key));
      if (gapMs > 0) await wait(gapMs);
    }
    return stamps;
  }

  /** 真实等待。这是唯一能跨过应用侧 Date.now() 冷却的手段，没有捷径。 */
  async function wait(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError(`wait 需要一个 ≥0 的毫秒数，收到 ${describe(ms)}`);
    }
    if (ms > 0) {
      await sleep(ms);
      stats.waitedMs += ms;
    }
    return ms;
  }

  /**
   * 真实等待 + 让渲染跟上。
   * requestRender 这一下在起了 startRendering 的宿主里是多余的，但脚本也可能跑在只做单帧的宿主上，
   * 那种情况下状态推进了画面却不重绘，截图会拍到上一屏——排查时极易误判成「按键没送达」。
   */
  async function settle(ms = settleMs) {
    const waited = await wait(ms);
    try { view.requestRender?.(); } catch { /* 渲染请求失败不该让脚本挂掉 */ }
    return waited;
  }

  /** Enter 的语义封装：激活会换页，所以按完必须真实等冷却。 */
  async function activate(opts = {}) {
    const at = await press('Enter');
    await settle(numberOr(opts.settleMs, settleMs));
    return at;
  }

  /** Backspace 的语义封装：返回同样是换页，同样要等冷却。 */
  async function back(opts = {}) {
    const at = await press('Backspace');
    await settle(numberOr(opts.settleMs, settleMs));
    return at;
  }

  /** 语音唤醒。keyword 空串/非字符串引擎会抛 TypeError，这里先拦下并说清楚是哪个参数。 */
  async function wake(keyword = 'inklab') {
    if (typeof keyword !== 'string' || keyword === '') {
      throw new TypeError(`dispatchVoiceWakeup 的 keyword 必须是非空字符串，收到 ${describe(keyword)}`);
    }
    if (typeof view.dispatchVoiceWakeup !== 'function') {
      throw new TypeError('这个 view 没有 dispatchVoiceWakeup（引擎版本不符或注入了不完整的假 view）');
    }
    const at = nextStamp();
    view.dispatchVoiceWakeup(keyword, at);
    stats.wakes += 1;
    say(`wake ${keyword} @${at}`);
    return at;
  }

  /** 截图打点。没注入 screenshot 时明确报错——静默跳过会让「有截图」的假象骗到自己。 */
  async function shot(name, extra = {}) {
    const label = typeof name === 'string' && name ? name : `shot-${shots.length}`;
    if (typeof screenshot !== 'function') {
      throw new TypeError(`没有注入 screenshot，拍不了「${label}」：场景里写了 shot 就得给宿主的截图函数`);
    }
    const value = await screenshot(label);
    const rec = { name: label, at: now(), value: value === undefined ? null : value, ...extra };
    shots.push(rec);
    stats.shots += 1;
    say(`shot ${label}`);
    return rec;
  }

  /** 记下引擎给的这一路（引擎调能力方法时的 args），之后 emit 不必每次手传 route。 */
  function useRoute(args) {
    defaultRoute = args;
    return routeOf(args);
  }

  /**
   * 能力事件回灌。两件事必须做对，否则都是沉默失败：
   * 事件名要在引擎的表里；detail 要原样带回引擎给的 targetId/sessionId。
   */
  function emit(name, detail = {}, routeArgs) {
    if (!isKnownEvent(name)) {
      const ns = String(name || '').split('.')[0];
      const hint = CAPABILITY_EVENTS[ns]
        ? `${ns} 下可用：${CAPABILITY_EVENTS[ns].join(', ')}`
        : `已知命名空间：${Object.keys(CAPABILITY_EVENTS).join(', ')}`;
      throw new Error(`引擎不认识事件 ${describe(name)}（拼错事件名是沉默失败的常见来源）；${hint}`);
    }
    if (typeof view.dispatchHostCapabilityEvent !== 'function') {
      throw new TypeError('这个 view 没有 dispatchHostCapabilityEvent');
    }
    // 路由来源优先级：显式参数 > 驱动器默认 > detail 里自带的那对。
    const r = routeOf(routeArgs || defaultRoute || detail);
    if (!r.targetId || !r.sessionId) {
      throw new TypeError(
        `${name} 缺 targetId/sessionId：必须原样带回引擎调用能力方法时给的那一对，否则引擎认不出是哪一路`,
      );
    }
    const payload = { ...detail, targetId: r.targetId, sessionId: r.sessionId };
    view.dispatchHostCapabilityEvent(name, payload);
    stats.events += 1;
    say(`emit ${name} → ${r.targetId}/${r.sessionId}`);
    return payload;
  }

  // ── 场景脚本 ────────────────────────────────────────────────────────────

  /** 一步只能声明一种动作；零个或多个都算写错，直接报出来而不是猜作者想干嘛。 */
  function kindOf(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { kind: 'unknown', error: `步骤必须是对象，收到 ${describe(step)}` };
    const found = STEP_KINDS.filter((k) => k in step);
    if (found.length === 0) {
      return { kind: 'unknown', error: `步骤里没有任何已知动作；可用的是 ${STEP_KINDS.join(' / ')}` };
    }
    if (found.length > 1) {
      return { kind: found[0], error: `一步只能写一个动作，这步同时写了 ${found.join(' + ')}` };
    }
    return { kind: found[0], error: null };
  }

  /** 报告里用的人话标签：失败时不用回头翻脚本就知道卡在哪一步。 */
  function labelOf(step, kind) {
    if (step && typeof step === 'object' && typeof step.label === 'string' && step.label) return step.label;
    switch (kind) {
      case 'press': return `press ${String(step.press)}`;
      case 'pressMany': {
        const [key, times] = Array.isArray(step.pressMany) ? step.pressMany : [step.pressMany, 1];
        return `pressMany ${String(key)}×${times}`;
      }
      case 'activate': return 'activate(Enter)';
      case 'back': return 'back(Backspace)';
      case 'wait': return `wait ${step.wait}ms`;
      case 'wake': return `wake ${step.wake === true ? 'inklab' : String(step.wake)}`;
      case 'shot': return `shot ${String(step.shot && typeof step.shot === 'object'
        ? step.shot.name : step.shot)}`;
      case 'expect': return 'expect';
      case 'do': return 'do';
      default: return 'unknown';
    }
  }

  /** 执行一步。返回 undefined = 通过；返回字符串 = 失败原因（抛异常同样算失败）。 */
  async function runStep(step, kind, ctx) {
    switch (kind) {
      case 'press':
        await press(step.press);
        return undefined;
      case 'pressMany': {
        const [key, times] = Array.isArray(step.pressMany) ? step.pressMany : [step.pressMany, 1];
        await pressMany(key, times);
        return undefined;
      }
      case 'activate':
        await activate(optionsOf(step.activate));
        return undefined;
      case 'back':
        await back(optionsOf(step.back));
        return undefined;
      case 'wait':
        await wait(step.wait);
        return undefined;
      case 'wake':
        await wake(step.wake === true ? undefined : step.wake);
        return undefined;
      case 'shot':
      {
        const spec = shotStepOf(step.shot);
        await shot(spec.name, {
          step: ctx.index,
          ...(spec.diffOptions ? { diffOptions: spec.diffOptions } : {}),
        });
        return undefined;
      }
      case 'expect': {
        if (typeof step.expect !== 'function') return `expect 必须是函数，收到 ${describe(step.expect)}`;
        const verdict = await step.expect(ctx);
        if (verdict === true) return undefined;
        if (typeof verdict === 'string') return verdict || 'expect 返回了空字符串（要么 return true，要么 return 失败原因）';
        if (verdict === false) return '断言不成立（expect 返回 false）';
        return `expect 没有给出结论，返回了 ${describe(verdict)}（要么 return true，要么 return 失败原因）`;
      }
      case 'do': {
        if (typeof step.do !== 'function') return `do 必须是函数，收到 ${describe(step.do)}`;
        await step.do(ctx);
        return undefined;
      }
      default:
        return '无法识别的步骤';
    }
  }

  /**
   * 跑一段声明式场景。**遇到第一个失败就停**——后面的步骤在错误状态上跑出来的结果没有参考价值，
   * 还会淹没真正的失败点。返回结构里 failure/summary 直接指出第几步、什么原因。
   */
  async function runScenario(steps = []) {
    if (!Array.isArray(steps)) throw new TypeError(`runScenario 需要一个步骤数组，收到 ${describe(steps)}`);

    const shotsFrom = shots.length;
    const results = [];
    let failure = null;

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const { kind, error } = kindOf(step);
      const label = labelOf(step, kind);
      const startedAt = now();
      let reason = error || undefined;

      notifyStep({ phase: 'start', index, kind, label });
      if (!reason) {
        try {
          reason = await runStep(step, kind, {
            view, driver: api, index, step, steps, results, shots, now, log: say,
          });
        } catch (err) {
          reason = err && err.message ? err.message : String(err);
        }
      }

      const ok = !reason;
      const ms = Math.max(0, now() - startedAt);
      results.push({ index, kind, label, ok, ms, ...(ok ? {} : { reason }) });
      notifyStep({ phase: 'end', index, kind, label, ok, ms, ...(ok ? {} : { reason }) });
      say(`#${index} ${label} ${ok ? `ok (${ms}ms)` : `失败：${reason}`}`);
      if (!ok) { failure = { index, kind, label, reason }; break; }
    }

    const skipped = steps.length - results.length;
    return {
      ok: !failure,
      steps: results,
      shots: shots.slice(shotsFrom),
      skipped,
      failure,
      summary: failure
        ? `第 ${failure.index + 1}/${steps.length} 步（steps[${failure.index}]「${failure.label}」）失败：${failure.reason}`
          + (skipped > 0 ? `；后面 ${skipped} 步未执行` : '')
        : `${results.length} 步全部通过`,
    };
  }

  const api = {
    view,
    // 输入
    input, press, pressMany, activate, back, wake,
    // 时间
    wait, settle,
    // 取证
    shot, shots,
    // 能力事件
    emit, useRoute,
    // 场景
    runScenario,
    // 排查用
    clock: () => stamp,
    stats: () => ({ ...stats }),
  };
  return api;
}

/** 步骤里 `activate: true` / `activate: { settleMs }` 两种写法都收。 */
function optionsOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 截图步骤兼容两种写法：
 *   { shot: 'home' }
 *   { shot: { name:'set-live', diffOptions:{ tolerance:1, ignoreRegions:[…] } } }
 * 后者只改变这一张图的 diff 口径，不会把动态区豁免扩散到同场其他截图。
 */
function shotStepOf(value) {
  if (typeof value === 'string' && value) return { name: value, diffOptions: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`shot 必须是非空字符串或 { name, diffOptions }，收到 ${describe(value)}`);
  }
  if (typeof value.name !== 'string' || !value.name) {
    throw new TypeError(`shot.name 必须是非空字符串，收到 ${describe(value.name)}`);
  }
  if (value.diffOptions == null) return { name: value.name, diffOptions: null };
  if (typeof value.diffOptions !== 'object' || Array.isArray(value.diffOptions)) {
    throw new TypeError(`shot.diffOptions 必须是对象，收到 ${describe(value.diffOptions)}`);
  }
  return { name: value.name, diffOptions: { ...value.diffOptions } };
}

function numberOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
