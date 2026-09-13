// 宿主层的纯逻辑：热重载的变化攒批 + 场景脚本。零浏览器、零网络、零真实等待。
//
// 宿主页面本身（canvas/引擎/DOM）只能在真浏览器里验，那部分的证据在 RUNTIME-NOTES 与汇报里；
// 这里钉住的是两件「写歪了不会当场报错」的事：
//   1. 一次保存推一次重载（去抖没生效的话现象是引擎被连续重启，很难在页面上看出来）；
//   2. 场景脚本的步骤形状与断言口径（步骤写错了 driver 会当成失败，但失败原因得指得准）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChangeBatcher, WATCH_DEBOUNCE_MS, parseArgs, safeJoin,
  shouldIgnoreWatchPath, partitionAppFiles, llmEnvConfig, mergeLlmConfig, fillRequestDefaults,
} from '../serve.mjs';
import { createDriver } from '../lib/driver.mjs';
import { SCENARIOS, scenarioById } from '../scenarios/index.mjs';

// ── 假钟：把 setTimeout 变成「手动拨表」 ────────────────────────────────

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { at: now + Number(ms || 0), fn }); return seq; },
    clearTimeout: (h) => { timers.delete(h); },
    /** 拨表 ms 毫秒，按到点顺序触发。 */
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [handle, timer] = due;
        timers.delete(handle);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

// ── 热重载：变化攒批 ────────────────────────────────────────────────────

test('一次保存的一串 fs 事件只推一次重载', () => {
  const clock = fakeClock();
  const flushes = [];
  const batcher = createChangeBatcher({
    onFlush: (paths) => flushes.push(paths),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
  });

  // 编辑器一次保存常发好几条（rename + change，原子替换更多）
  batcher.push('app.wxss');
  clock.tick(20);
  batcher.push('app.wxss');
  clock.tick(20);
  batcher.push('pages/home/index.ink');
  assert.equal(flushes.length, 0, '安静期没过完不该推');

  clock.tick(WATCH_DEBOUNCE_MS);
  assert.equal(flushes.length, 1, '一串事件只推一批');
  assert.deepEqual(flushes[0].sort(), ['app.wxss', 'pages/home/index.ink'], '同一文件去重，不同文件都带上');
});

test('持续写盘不会把 flush 无限期顶掉（maxWait 兜底）', () => {
  const clock = fakeClock();
  const flushes = [];
  const batcher = createChangeBatcher({
    onFlush: (paths) => flushes.push(paths),
    delayMs: 200, maxWaitMs: 500,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
  });

  // 每 100ms 来一条：trailing 去抖单独用会永远等不到安静期
  for (let i = 0; i < 10; i += 1) { batcher.push(`f${i}.js`); clock.tick(100); }
  assert.ok(flushes.length >= 1, '到了 maxWait 必须推一次，不能一直攒着');
  assert.ok(flushes[0].length >= 4, `第一批应当把攒下的都带上，实际 ${flushes[0].length} 个`);
});

test('攒批期间没有事件就不推，stop 之后也不会再推', () => {
  const clock = fakeClock();
  const flushes = [];
  const batcher = createChangeBatcher({
    onFlush: (paths) => flushes.push(paths),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now,
  });
  clock.tick(5000);
  assert.equal(flushes.length, 0);

  batcher.push('a.js');
  batcher.stop();
  clock.tick(5000);
  assert.equal(flushes.length, 0, 'stop 之后那批就该丢掉（关服务时不该再回调）');
  assert.equal(clock.pending(), 0, '定时器要清干净，别留野表');
});

// ── serve.mjs 的其它纯逻辑 ──────────────────────────────────────────────

test('命令行参数：端口与 --open', () => {
  assert.deepEqual(parseArgs(['apps/x', '--port', '9001', '--open', '--compare-with', 'dist/x.aix']), {
    port: 9001, open: true, compareWith: 'dist/x.aix', input: 'apps/x', appDir: 'apps/x',
  });
  assert.deepEqual(parseArgs(['dist/x.aix']), {
    port: 8788, open: false, compareWith: null, input: 'dist/x.aix', appDir: 'dist/x.aix',
  });
});

test('发布包分拣不二次套源码排除表：VERSION 与包内开发物都保持发布真相', () => {
  const parts = partitionAppFiles(['app.json', 'app.js', 'VERSION', 'scripts/accident.js'], { published: true });
  assert.deepEqual(parts.manifest, ['VERSION', 'app.js', 'app.json', 'scripts/accident.js']);
});

test('目录穿越一律拒绝', () => {
  const root = '/tmp/inklab-root';
  assert.equal(safeJoin(root, '/pages/home/index.ink'), '/tmp/inklab-root/pages/home/index.ink');
  assert.equal(safeJoin(root, '/../../etc/passwd'), null);
  assert.equal(safeJoin(root, '/%2e%2e/%2e%2e/etc/passwd'), null, '百分号编码的 .. 同样要拦');
});


// ── watch 忽略规则与 e2e 资产分拣 ───────────────────────────────────────

test('watch 忽略：编辑器临时文件与 e2e 产物不触发重载，e2e/scenarios 例外', () => {
  // 编辑器临时物
  assert.equal(shouldIgnoreWatchPath('.git/index'), true);
  assert.equal(shouldIgnoreWatchPath('pages/home/index.ink.swp'), true);
  assert.equal(shouldIgnoreWatchPath('app.js~'), true);
  // 正常源码要触发
  assert.equal(shouldIgnoreWatchPath('pages/home/index.ink'), false);
  assert.equal(shouldIgnoreWatchPath('app.js'), false);
  // e2e 的读写物不触发：跑测写报告/基线若触发整包重载，等于自己打断自己
  assert.equal(shouldIgnoreWatchPath('e2e/baselines/onboarding-goal/x.png'), true);
  assert.equal(shouldIgnoreWatchPath('e2e/report/last-run.json'), true);
  assert.equal(shouldIgnoreWatchPath('e2e/cassettes/default.json'), true);
  // 但改场景脚本要触发（宿主重载时会重新 import 场景清单）
  assert.equal(shouldIgnoreWatchPath('e2e/scenarios/onboarding-goal.mjs'), false);
});

test('e2e 资产分拣：场景只认顶层 .mjs（测试文件不算），且不进 bundle', () => {
  const parts = partitionAppFiles([
    'app.json', 'app.js', 'pages/home/index.ink',
    'e2e/scenarios/onboarding-goal.mjs',
    'e2e/scenarios/helper.test.mjs',          // 测试文件不是场景
    'e2e/scenarios/nested/deep.mjs',          // 只认顶层
    'e2e/__tests__/scenarios.test.mjs',
    'e2e/cassettes/default.json',
    'e2e/baselines/onboarding-goal/shot.png',
    'e2e/baselines/onboarding-goal/shot.json',
    'e2e/report/last-run.json',               // 报告不算资产
  ]);
  assert.deepEqual(parts.e2eScenarios, ['e2e/scenarios/onboarding-goal.mjs']);
  assert.deepEqual(parts.e2eCassettes, ['e2e/cassettes/default.json']);
  assert.deepEqual(parts.e2eBaselines, [
    'e2e/baselines/onboarding-goal/shot.json',
    'e2e/baselines/onboarding-goal/shot.png',
  ]);
  // e2e 整个目录都不该出现在引擎 bundle 里
  assert.ok(parts.manifest.every((p) => !p.startsWith('e2e/')), 'e2e/ 不能进 bundle');
  assert.ok(parts.manifest.includes('app.json'));
});

test('LLM 环境配置：只透传 INKLAB_LLM_* 变量，空串等同没设', () => {
  assert.deepEqual(llmEnvConfig({}), { endpoint: null, model: null, apiKey: null, apiKeyFile: null });
  assert.deepEqual(llmEnvConfig({
    INKLAB_LLM_ENDPOINT: ' https://x.example/v1/chat/completions ',
    INKLAB_LLM_MODEL: 'gpt-x',
    INKLAB_LLM_API_KEY: '',
    INKLAB_LLM_API_KEY_FILE: '/keys/k',
    OTHER: 'leak-me-not',
  }), { endpoint: 'https://x.example/v1/chat/completions', model: 'gpt-x', apiKey: null, apiKeyFile: '/keys/k' });
});

test('LLM 配置合并：环境变量压过本地档，requestDefaults 只来自本地档', () => {
  const merged = mergeLlmConfig(
    { endpoint: null, model: 'env-model', apiKey: null, apiKeyFile: null },
    {
      endpoint: 'http://127.0.0.1:8317/v1/chat/completions', model: 'file-model',
      apiKeyFile: '/outside/key', requestDefaults: { enable_thinking: false },
    },
  );
  assert.deepEqual(merged, {
    endpoint: 'http://127.0.0.1:8317/v1/chat/completions',
    model: 'env-model',           // 环境变量优先
    apiKey: null,                 // 密钥本体谁都没给——由 serve 按 apiKeyFile 现读
    apiKeyFile: '/outside/key',
    requestDefaults: { enable_thinking: false },
  });
  assert.deepEqual(mergeLlmConfig({}, {}), {
    endpoint: null, model: null, apiKey: null, apiKeyFile: null, requestDefaults: null,
  });
  assert.equal(mergeLlmConfig({}, { requestDefaults: {} }).requestDefaults, null, '空对象等同没配');
});

test('requestDefaults 只补缺失字段：引擎显式写的字段绝不覆盖，非 JSON 原样放行', () => {
  const body = JSON.stringify({ model: 'm', stream: true, messages: [] });
  const out = JSON.parse(fillRequestDefaults(body, { enable_thinking: false, stream: false }));
  assert.equal(out.enable_thinking, false, '缺失字段补上');
  assert.equal(out.stream, true, '引擎写了 stream:true，绝不被 defaults 覆盖');
  assert.equal(fillRequestDefaults('not-json', { a: 1 }), 'not-json', '解不出 JSON 原样转发');
  assert.equal(fillRequestDefaults(body, null), body, '没配 defaults 一字不动');
});

// ── 内置场景（通用冒烟；应用专属场景的测试在各工程 e2e/__tests__/ 下） ────

test('内置场景清单：id 唯一、字段齐、步骤形状合法', async () => {
  assert.ok(SCENARIOS.length >= 1, '至少要有一个内置场景');
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复（宿主按 id 取）');

  const view = {
    dispatchInput() {}, dispatchVoiceWakeup() {},
    dispatchHostCapabilityEvent() {}, requestRender() {},
    isRunning: () => true,
  };
  const driver = createDriver({
    view, sleep: async () => {},
    screenshot: (name) => ({ name, dataUrl: 'data:image/png;base64,AA==' }),
  });
  const KINDS = ['press', 'pressMany', 'activate', 'back', 'wait', 'wake', 'shot', 'expect', 'do'];
  for (const s of SCENARIOS) {
    assert.ok(s.title && s.summary, `${s.id} 缺 title/summary`);
    assert.equal(scenarioById(s.id), s, 'scenarioById 要能取回同一个对象');
    const steps = s.build({ caps: {}, driver, view });
    assert.ok(Array.isArray(steps) && steps.length > 0, `${s.id} 的 build 要返回非空数组`);
    for (const [i, step] of steps.entries()) {
      const found = KINDS.filter((k) => k in step);
      assert.equal(found.length, 1, `${s.id} steps[${i}] 写了 ${found.length} 个动作`);
      assert.equal(typeof step.label, 'string', `${s.id} steps[${i}] 缺 label`);
    }
  }
  assert.equal(scenarioById('没有这个场景'), null);
});

test('冒烟场景在最小假 view 上全绿；引擎不在运行态时失败点指得准', async () => {
  const mk = (running) => createDriver({
    view: {
      dispatchInput() {}, dispatchVoiceWakeup() {},
      dispatchHostCapabilityEvent() {}, requestRender() {},
    },
    sleep: async () => {},
    screenshot: (name) => ({ name, dataUrl: 'data:image/png;base64,AA==' }),
  });
  const smoke = scenarioById('smoke');

  const okDriver = mk();
  const okView = { isRunning: () => true };
  const okReport = await okDriver.runScenario(smoke.build({ view: okView }));
  assert.equal(okReport.ok, true, okReport.summary);
  assert.equal(okReport.shots.length, 1);

  const badDriver = mk();
  const badView = { isRunning: () => false };
  const badReport = await badDriver.runScenario(smoke.build({ view: badView }));
  assert.equal(badReport.ok, false);
  assert.match(badReport.failure.reason, /运行态/);
});
