// 能力集组装的集成冒烟：各模块单测都绿，不代表拼起来的那一套能喂饱引擎。
// 这里只问一个问题——**引擎会调的每个方法，组装结果里是不是都有**。
// 少一个的后果是硬的：引擎当场抛 `Host capability {ns}.{method} is not configured on Web host`；
// media 更狠——少了会回落到 navigator.mediaDevices，本地宿主会去开真摄像头。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostCapabilities } from '../lib/caps/index.mjs';
import {
  CAPABILITY_METHODS, BROWSER_BRIDGED_NAMESPACES, isKnownEvent, ALL_EVENT_NAMES,
} from '../lib/caps/contract.mjs';

function build(over = {}) {
  const events = [];
  const timers = [];
  const caps = createHostCapabilities({
    dispatchEvent: (name, detail) => events.push({ name, detail }),
    now: () => 1_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    readFile: async () => new Uint8Array([1, 2, 3]),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }),
    ...over,
  });
  return { caps, events, timers };
}

/** 上游 fetch 的最小答复（只有 H2 那几条用得到：证明「上游根本没被调」才是重点）。 */
const makeUpstreamResponse = () => ({
  ok: true, status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({}),
  text: async () => '{"choices":[]}',
});

test('组装结果把引擎会调的每个方法都配上了（少一个，该能力一被用到就抛）', () => {
  const { caps } = build();
  const missing = [];
  for (const [ns, methods] of Object.entries(CAPABILITY_METHODS)) {
    for (const m of methods) {
      if (typeof caps.capabilities?.[ns]?.[m] !== 'function') missing.push(`${ns}.${m}`);
    }
  }
  // geolocation / payment 之外的能力都必须齐全；battery 已是 0.17 一等假体。
  // 这几个应用大多用不到，但缺席就要在这里显式记账，而不是等运行时才发现。
  const expectedGaps = missing.filter((n) => /^(geolocation|payment)\./.test(n));
  const realGaps = missing.filter((n) => !expectedGaps.includes(n));
  assert.deepEqual(realGaps, [], `这些方法没配上，引擎一用就抛：${realGaps.join(', ')}`);
});

test('media 十个方法一个都不能少——少取流方法会碰真实硬件，少 takePhoto 会直接未配置', () => {
  const { caps } = build();
  for (const m of CAPABILITY_METHODS.media) {
    assert.equal(typeof caps.capabilities.media[m], 'function', `media.${m} 缺席`);
  }
});

test('bluetooth 走 navigator 独立桥，不混进 hostCapabilities 严格编解码表', () => {
  assert.equal(Object.hasOwn(CAPABILITY_METHODS, 'bluetooth'), false);
  assert.deepEqual(BROWSER_BRIDGED_NAMESPACES, ['bluetooth']);
});

test('事件桥要求 InkView 有能力事件靶，没有就当场抛（而不是事件全静默丢掉）', async () => {
  const { createEventBridge } = await import('../lib/caps/index.mjs');
  assert.throws(() => createEventBridge({}), /能力事件靶/);
  assert.throws(() => createEventBridge(null), /能力事件靶/);
});

test('事件桥拒绝不在契约表里的事件名，并提示同命名空间可用的名字', async () => {
  const { createEventBridge } = await import('../lib/caps/index.mjs');
  const seen = [];
  const view = { getHostCapabilitiesTarget: () => ({ dispatchEvent: (e) => seen.push(e.type) }) };
  const emit = createEventBridge(view);
  // 拼错一个字母是沉默失败的典型来源，必须在进引擎前拦下
  assert.throws(() => emit('speech.results', {}), /不认识事件 speech\.results/);
  assert.throws(() => emit('speech.results', {}), /speech 可用/);
  emit('speech.start', { targetId: 't', sessionId: 's' });
  assert.deepEqual(seen, ['speech.start']);
});

test('契约里已删掉 speech.synthesisStarted——引擎没有这个事件，发过去是静默落地', () => {
  assert.equal(isKnownEvent('speech.synthesisStarted'), false);
  assert.equal(isKnownEvent('speech.synthesisEnd'), true);
});

test('事件名表非空且互不重复（重复会让白名单校验形同虚设）', () => {
  assert.ok(ALL_EVENT_NAMES.length > 20);
  assert.equal(new Set(ALL_EVENT_NAMES).size, ALL_EVENT_NAMES.length);
});

test('dispose 能把在跑的采样与会话一次停干净（宿主重载引擎前必须做，否则野计时器打到已销毁的 view）', async () => {
  const { caps } = build();
  await caps.capabilities.accelerometer.start({ targetId: 't', sessionId: 's', frequency: 60 });
  assert.ok(caps.sensors.activeSessions().length > 0, '前置：确实有会话在跑');
  caps.dispose();
  assert.equal(caps.sensors.activeSessions().length, 0, 'dispose 后不该还有会话');
});

test('缺 dispatchEvent 直接抛：没有回灌出口的能力集是个哑弹，跑起来才发现代价太大', () => {
  assert.throws(() => createHostCapabilities({}), /dispatchEvent/);
});

// ── replay 的 LLM 请求必须穿得过外域闸，才走得到录像 ──────────
//
// 现场：宿主把两层串成 `globalThis.fetch = net.wrapFetch(llm.fetch)` —— **外域闸在外层、
// 录像回放在内层**。而 replay 的端点恒是外域（没配 endpoint 时兜底成 REPLAY_ENDPOINT，
// 那是个 `.invalid` 域），旧的放行清单又写着 `mode !== 'replay'`：于是引擎的每一次 LLM 请求
// 在外层就被判外域回了 503，**根本走不到 caps.llm.fetch**。表现是「录像明明有、应用却一路走
// 模型不可用的降级」——被测的那条真路径一次都没跑到，而 e2e 全绿。
//
// 放行是安全的：解除的只是外层那道闸，请求随即落到内层的 llm.fetch，replay 模式照录像作答，
// 一个字节都不出网（下面的 baseCalled 恒 false 就是这一条的证据）。

test('H2 replay：LLM 请求穿过外域闸落到 llm.fetch（照录像作答，不是 503、也不出网）', async () => {
  const { llmAllowExternal, REPLAY_ENDPOINT } = await import('../lib/caps/llm.mjs');
  const { EXTERNAL_STUB_STATUS } = await import('../lib/caps/net.mjs');

  const body = JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: '讲讲德天瀑布' }] });
  let baseCalled = false;
  const upstream = async () => { baseCalled = true; return makeUpstreamResponse(); };

  const llmOpts = { mode: 'replay', cassette: [] };
  const { caps } = build({
    fetch: upstream,
    languageModel: llmOpts,
    net: {
      guardExternal: true,
      externalOrigin: 'http://127.0.0.1:5173',
      allowExternal: llmAllowExternal(llmOpts),
    },
  });
  // 先按引擎真实姿势把录像灌进去（键由请求体算出，与 record 时一致）。
  caps.llm.recordings.push({
    key: caps.llm.keyFor(body),
    label: '讲讲德天瀑布',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"choices":[{"message":{"content":"德天瀑布在中越边境。"}}]}',
  });

  const wired = caps.net.wrapFetch(caps.llm.fetch); // 宿主装的就是这一条链
  const res = await wired(REPLAY_ENDPOINT, { method: 'POST', body, headers: { 'content-type': 'application/json' } });

  assert.notEqual(res.status, EXTERNAL_STUB_STATUS, '被外域闸挡成 503 = 录像根本没被读到');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /德天瀑布在中越边境/, '答复来自录像');
  assert.equal(caps.llm.exchanges.at(-1).outcome, 'replay-hit', 'llm.fetch 真的接到了这次请求');
  assert.equal(baseCalled, false, '放行只是穿过闸：replay 不出网，上游 fetch 一次都没被调');
});

test('H2 放行清单只放 LLM 端点：应用自己硬编码的线上域名照样 503', async () => {
  const { llmAllowExternal, REPLAY_ENDPOINT } = await import('../lib/caps/llm.mjs');
  const { EXTERNAL_STUB_STATUS } = await import('../lib/caps/net.mjs');

  let baseCalled = false;
  const llmOpts = { mode: 'replay', cassette: [] };
  const { caps } = build({
    fetch: async () => { baseCalled = true; return makeUpstreamResponse(); },
    languageModel: llmOpts,
    net: {
      guardExternal: true,
      externalOrigin: 'http://127.0.0.1:5173',
      allowExternal: llmAllowExternal(llmOpts),
    },
  });
  const wired = caps.net.wrapFetch(caps.llm.fetch);
  const res = await wired('https://trips.example/api/weather');
  assert.equal(res.status, EXTERNAL_STUB_STATUS, '非 LLM 的外域请求必须照旧被挡下');
  assert.equal(baseCalled, false, '一个字节都不许打到别人的生产后端');
  // 反过来 LLM 端点在同一套闸下是通的（同一次装配里两条结论并存，证明放行是**点名**的）。
  assert.ok(caps.net.wouldStubExternal('https://trips.example/api/weather'));
  assert.equal(caps.net.wouldStubExternal(REPLAY_ENDPOINT), false);
});

test('H2 llmAllowExternal 口径：off 空清单；live/record 放端点；replay 连 .invalid 兜底端点一起放', async () => {
  const { llmAllowExternal, REPLAY_ENDPOINT } = await import('../lib/caps/llm.mjs');
  assert.deepEqual(llmAllowExternal(null), [], '没配模型 → 什么都不放行');
  assert.deepEqual(llmAllowExternal({ mode: 'off' }), []);
  assert.deepEqual(llmAllowExternal({ mode: 'live', endpoint: 'https://api.example.com/v1/chat/completions' }),
    ['https://api.example.com/v1/chat/completions'], 'live 那次出网是有意的');
  assert.deepEqual(llmAllowExternal({ mode: 'record', endpoint: 'https://api.example.com/v1/chat/completions' }),
    ['https://api.example.com/v1/chat/completions']);
  assert.deepEqual(llmAllowExternal({ mode: 'replay' }), [REPLAY_ENDPOINT],
    '没配 endpoint 的 replay 走 REPLAY_ENDPOINT —— 不放它就等于把默认录像回放全挡死');
  assert.deepEqual(llmAllowExternal({ mode: 'replay', endpoint: 'http://127.0.0.1:5173/api/llm' }),
    ['http://127.0.0.1:5173/api/llm', REPLAY_ENDPOINT], '两个都放：引擎实际用哪个取决于配置解析');
});
