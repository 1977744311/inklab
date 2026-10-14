// InkLab LLM 能力：getConfig 的引擎契约、录制/回放的键归一、故障注入。假钟 + 假 fetch，零真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLanguageModelCapabilities, normalizeRequestBody, cassetteKey, scrubVolatile,
  OPENAI_CHAT_COMPLETIONS, REPLAY_ENDPOINT, API_KEY_ENV, replayModelFromSearch,
} from '../lib/caps/llm.mjs';
import { makeResponse } from '../lib/caps/net.mjs';

test('整页场景隔离只从 URL 恢复 replay 录像 model，不覆盖 live/record 真模型', () => {
  const search = '?llm=replay&llm-model=inklab-cassette';
  assert.equal(replayModelFromSearch(search, 'replay'), 'inklab-cassette');
  assert.equal(replayModelFromSearch(search, 'live'), '');
  assert.equal(replayModelFromSearch(search, 'record'), '');
});

// ── 测试替身 ────────────────────────────────────────────────────────────

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, entry] of timers) {
          if (entry.at <= target && (!next || entry.at < next.entry.at)) next = { id, entry };
        }
        if (!next) break;
        timers.delete(next.id);
        t = next.entry.at;
        next.entry.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
}

async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return done;
}

const ENDPOINT = 'https://llm.example.com/v1/chat/completions';
const KEY_ENV = { [API_KEY_ENV]: 'sk-live-DO-NOT-COMMIT-1234567890' };

/** 一次典型的对话请求：prompt 里带时间、会话 id、请求 id——每次都不一样。 */
const chatBody = ({ at, session, reqId, stream = true, user = '帮我复盘这组深蹲。' }) => JSON.stringify({
  model: 'qwen-max',
  stream,
  messages: [
    { role: 'system', content: '你是示例助手。' },
    { role: 'user', content: `现在时间 ${at}，会话 ${session}，请求 ${reqId}。${user}` },
  ],
});

const SSE = 'data: {"choices":[{"delta":{"content":"深蹲深度够了"}}]}\n\ndata: [DONE]\n\n';

/** 记录上游收到的原始请求，用来验证"归一只影响键、不改真正发出去的东西"。 */
function fakeUpstream(body = SSE, status = 200) {
  const seen = [];
  const fetch = async (input, init = {}) => {
    seen.push({ url: String(input), method: init.method, body: init.body, headers: init.headers });
    return makeResponse({ status, headers: { 'content-type': 'text/event-stream' }, body });
  };
  return { fetch, seen };
}

// ── getConfig：引擎认的形状 ──────────────────────────────────────────────

test('getConfig 返回引擎 Zr 强校验的 6 个字段，apiKey 只能藏在 headers 里（引擎没有 apiKey 字段）', async () => {
  const llm = createLanguageModelCapabilities({
    mode: 'live', endpoint: ENDPOINT, model: 'qwen-max', env: KEY_ENV,
    headers: { 'x-inklab': 'yes' },
  });
  const config = await llm.capabilities.languageModel.getConfig({ env: '', targetId: 't1', sessionId: 's1' });

  assert.deepEqual(Object.keys(config).sort(), [
    'apiStyle', 'defaultModel', 'endpoint', 'headers', 'shareVendorHeaders', 'vendorHeadersService',
  ], '多写引擎不理，少写 Zr 直接抛');
  assert.equal(config.endpoint, ENDPOINT);
  assert.equal(config.apiStyle, OPENAI_CHAT_COMPLETIONS, '引擎只认这一种 apiStyle');
  assert.equal(config.defaultModel, 'qwen-max');
  assert.equal(config.headers.Authorization, `Bearer ${KEY_ENV[API_KEY_ENV]}`);
  assert.equal(config.headers['x-inklab'], 'yes');
  assert.equal(config.shareVendorHeaders, false);
  assert.equal(config.vendorHeadersService, null);
});

test('endpoint 必须是完整 URL：给不出就在宿主侧报可读错，而不是让 Zr 抛裸英文', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'live', env: KEY_ENV });
  await assert.rejects(() => llm.capabilities.languageModel.getConfig({}), /没有 endpoint.*完整的 chat-completions URL/s);
});

test('live/record 缺 API key 时在 getConfig 就拦下，不让引擎带空 Authorization 打出去换个 401 回来', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'live', endpoint: ENDPOINT, env: {} });
  await assert.rejects(
    () => llm.capabilities.languageModel.getConfig({}),
    (err) => {
      assert.match(err.message, new RegExp(API_KEY_ENV), '错误里要点名到底该设哪个环境变量');
      assert.match(err.message, /不要写进仓库/);
      return true;
    },
  );
});

test('replay 不出网所以不要 key；endpoint 落在保留 TLD .invalid——fetch 没接上时是响亮失败而不是偷偷打线上', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay', env: {} });
  const config = await llm.capabilities.languageModel.getConfig({});
  assert.equal(config.endpoint, REPLAY_ENDPOINT);
  assert.match(config.endpoint, /\.invalid\//);
  assert.equal(config.headers.Authorization, undefined, '没 key 就别造一个假的头');
});

test('GetConfig 请求带 env 字段（wasm serde 名表实证），按 env 选档', async () => {
  const llm = createLanguageModelCapabilities({
    mode: 'live',
    endpoint: ENDPOINT,
    env: KEY_ENV,
    profiles: { staging: { endpoint: 'https://staging.example.com/v1/chat/completions', model: 'qwen-turbo' } },
  });
  const prod = await llm.capabilities.languageModel.getConfig({ env: 'unknown-env' });
  const staging = await llm.capabilities.languageModel.getConfig({ env: 'staging' });

  assert.equal(prod.endpoint, ENDPOINT, '认不出的 env 回默认档，不能空手而归');
  assert.equal(staging.endpoint, 'https://staging.example.com/v1/chat/completions');
  assert.equal(staging.defaultModel, 'qwen-turbo');
  assert.deepEqual(llm.calls.map((c) => c.env), ['unknown-env', 'staging']);
});

// ── openService ────────────────────────────────────────────────────────

test('getVendorHeaders 没配置时返回 {}，对齐 glue 里写死的缺席兜底（绝不返回 null/undefined）', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay' });
  const headers = await llm.capabilities.openService.getVendorHeaders({ service: 'anything' });
  assert.deepEqual(headers, {});
  assert.notEqual(headers, null);
  assert.equal(typeof headers, 'object', 'sn 要求普通对象；返回 undefined 等于把兜底语义交给运气');
});

test('getVendorHeaders 按 service 取，值全部 String 化；没登记的 service 拿到 {} 而不是别家的头', async () => {
  const llm = createLanguageModelCapabilities({
    mode: 'replay',
    vendorHeaders: { assistant: { 'x-rokid-uid': 42, 'x-rokid-token': 'abc' } },
  });
  assert.deepEqual(await llm.capabilities.openService.getVendorHeaders({ service: 'assistant' }), {
    'x-rokid-uid': '42', 'x-rokid-token': 'abc',
  });
  assert.deepEqual(await llm.capabilities.openService.getVendorHeaders({ service: 'other' }), {});
});

test('单服务调试可以直接给一张扁平头表，不必套一层 service', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay', vendorHeaders: { 'x-rokid-token': 'abc' } });
  assert.deepEqual(await llm.capabilities.openService.getVendorHeaders({ service: 'assistant' }), { 'x-rokid-token': 'abc' });
});

test('getManifest 按请求里的 service 取（wasm serde 名表实证字段名），缺省 {} 表示"能力在、内容空"', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay', manifest: { assistant: { name: '示例助手' } } });
  assert.deepEqual(await llm.capabilities.openService.getManifest({ service: 'assistant' }), { name: '示例助手' });
  assert.deepEqual(await llm.capabilities.openService.getManifest({ service: 'nope' }), {});
  assert.deepEqual(llm.calls.map((c) => c.method), ['getManifest', 'getManifest']);
});

test('能力集只挂引擎认识的命名空间与方法（composeCapabilities 会挡住拼错的方法名）', () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay' });
  assert.deepEqual(Object.keys(llm.capabilities).sort(), ['languageModel', 'openService']);
  assert.deepEqual(Object.keys(llm.capabilities.languageModel), ['getConfig']);
  assert.deepEqual(Object.keys(llm.capabilities.openService).sort(), ['getManifest', 'getVendorHeaders']);
});

// ── 键归一 ─────────────────────────────────────────────────────────────

test('归一抹掉 prompt 里每次都变的片段：时间戳/日期/时刻/uuid/长数字 id/长十六进制', () => {
  const out = scrubVolatile(
    '于 2026-08-25T10:00:00Z 开练，上次 2026-08-24，本组 18:42 结束，'
    + '会话 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071，请求 1756108800123，trace a1b2c3d4e5f60718',
  );
  assert.equal(
    out,
    '于 <TS> 开练，上次 <DATE>，本组 <TIME> 结束，会话 <UUID>，请求 <EPOCH>，trace <HEX>',
    '任何一处漏网，键就会随时间漂，录像永远打不中',
  );
});

test('多模态图片只按长度进键：data URI 几十 KB，整段进键既撑爆录像又永远打不中', () => {
  const { canonical } = normalizeRequestBody(JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么器械' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  }));
  assert.match(canonical.messages[0].content, /这是什么器械\n<IMG:\d+>/);
});

test('键与字段书写顺序无关（同一个请求换个拼装顺序不该变成新键）', () => {
  const a = JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] });
  const b = JSON.stringify({ messages: [{ content: 'hi', role: 'user' }], stream: false, model: 'm' });
  assert.equal(cassetteKey(a), cassetteKey(b));
});

test('带工具的 canonical 可再次算键：录像请求不能因 parameters 二次编码而自相矛盾', () => {
  const raw = JSON.stringify({
    model: 'm', stream: true,
    messages: [{ role: 'user', content: '结束训练' }],
    tools: [{
      type: 'function',
      function: {
        name: 'run_feature',
        parameters: {
          type: 'object', required: ['feature'],
          properties: { feature: { type: 'string', enum: ['finish_workout'] } },
        },
      },
    }],
  });
  const canonical = normalizeRequestBody(raw).canonical;
  assert.equal(cassetteKey(JSON.stringify(canonical)), cassetteKey(raw));
});

test('stream 留在键里：流式与非流式的响应线格式不同，混用会把 SSE 喂给非流式解析', () => {
  const streamed = chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', stream: true });
  const plain = chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', stream: false });
  assert.notEqual(cassetteKey(streamed), cassetteKey(plain));
});

// ── record / replay ────────────────────────────────────────────────────

test('record→replay：同一个 prompt 换了时间戳/会话 id/请求 id 仍然命中', async () => {
  const upstream = fakeUpstream();
  const recorder = createLanguageModelCapabilities({
    mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch,
  });
  const recorded = await recorder.fetch(ENDPOINT, {
    method: 'POST',
    body: chatBody({ at: '2026-08-25T10:00:00Z', session: '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071', reqId: '1756108800123' }),
  });
  assert.equal(await recorded.text(), SSE, 'record 模式也要把响应原样交给引擎');
  assert.equal(recorder.recordings.length, 1);

  const player = createLanguageModelCapabilities({ mode: 'replay', cassette: recorder.exportCassette().entries });
  const replayed = await player.fetch(ENDPOINT, {
    method: 'POST',
    body: chatBody({ at: '2026-08-26T23:59:59Z', session: '99887766-5544-3322-1100-aabbccddeeff', reqId: '1756199999999' }),
  });
  assert.equal(await replayed.text(), SSE, '整体哈希的话这里永远打不中，录像等于白录');
  assert.deepEqual(player.exchanges.map((e) => e.outcome), ['replay-hit']);
});

test('replay aliases 只放行显式登记的等价键，不把任意相似 prompt 模糊命中', async () => {
  const primary = chatBody({
    at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', user: '同一场景的 30 秒时间桶',
  });
  const equivalent = chatBody({
    at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', user: '同一场景的 35 秒时间桶',
  });
  const different = chatBody({
    at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', user: '另一条没有登记的请求',
  });
  const player = createLanguageModelCapabilities({
    mode: 'replay',
    cassette: [{
      key: cassetteKey(primary), aliases: [cassetteKey(equivalent)], status: 200,
      headers: { 'content-type': 'text/event-stream' }, body: SSE,
    }],
  });

  assert.equal(await (await player.fetch(ENDPOINT, { method: 'POST', body: equivalent })).text(), SSE);
  await assert.rejects(
    () => player.fetch(ENDPOINT, { method: 'POST', body: different }),
    /replay 未命中/,
  );
  assert.deepEqual(player.exchanges.map((entry) => entry.outcome), ['replay-hit', 'replay-miss']);
});

test('归一只用于算键：真正转发给上游的请求体一个字节都没动', async () => {
  const upstream = fakeUpstream();
  const recorder = createLanguageModelCapabilities({
    mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch,
  });
  const body = chatBody({ at: '2026-08-25T10:00:00Z', session: 'sess-1', reqId: '1756108800123' });
  await recorder.fetch(ENDPOINT, { method: 'POST', body });

  assert.equal(upstream.seen[0].body, body, '改请求体等于改被调试对象的行为，那就不是调试了');
  assert.equal(upstream.seen[0].method, 'POST');
});

test('replay 未命中报可读错误：给出算出的键、现有条目、以及怎么补录；绝不静默返回空响应', async () => {
  const upstream = fakeUpstream();
  const recorder = createLanguageModelCapabilities({ mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  await recorder.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) });

  const player = createLanguageModelCapabilities({ mode: 'replay', cassette: recorder.exportCassette().entries });
  await assert.rejects(
    () => player.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1', user: '换了一句完全不同的话。' }) }),
    (err) => {
      assert.match(err.message, /replay 未命中/);
      assert.match(err.message, /计算出的键: [0-9a-f]{16}/, '没有键就没法手动比对');
      assert.match(err.message, /录像里现有 1 条/);
      assert.match(err.message, /换了一句完全不同的话/, '要能一眼看出是哪句 prompt 没中');
      assert.match(err.message, /mode:'record'/, '错误要顺带给出下一步');
      return true;
    },
  );
  assert.deepEqual(player.exchanges.map((e) => e.outcome), ['replay-miss']);
});

test('空录像回放也报同一类错，不是"看起来成功但内容为空"', async () => {
  const player = createLanguageModelCapabilities({ mode: 'replay' });
  await assert.rejects(
    () => player.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) }),
    /录像是空的/,
  );
});

test('导出的录像里没有任何密钥：录像是要进仓库、贴进 issue 的', async () => {
  const upstream = fakeUpstream();
  const recorder = createLanguageModelCapabilities({ mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  await recorder.fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY_ENV[API_KEY_ENV]}` },
    body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }),
  });

  const dumped = recorder.toJSON();
  assert.ok(!dumped.includes(KEY_ENV[API_KEY_ENV]), '密钥不能出现在导出物里');
  assert.ok(!dumped.includes('Authorization'), '干脆不存请求头，比事后过滤可靠');
  assert.match(dumped, /深蹲深度够了/, '该存的响应体还得在');
});

test('loadCassette 吃 JSON 文本与裸数组两种输入', async () => {
  const upstream = fakeUpstream();
  const recorder = createLanguageModelCapabilities({ mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  const body = chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' });
  await recorder.fetch(ENDPOINT, { method: 'POST', body });

  const player = createLanguageModelCapabilities({ mode: 'replay' });
  assert.equal(player.loadCassette(recorder.toJSON()), 1);
  assert.equal(await (await player.fetch(ENDPOINT, { method: 'POST', body })).text(), SSE);
  assert.equal(player.loadCassette(recorder.exportCassette().entries), 1);
});

test('非 LLM 请求原样透传：换掉全局 fetch 后 bundle 加载与探针 HEAD 都会经过这里，不能被录进去', async () => {
  const upstream = fakeUpstream('robots');
  const recorder = createLanguageModelCapabilities({ mode: 'record', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  const res = await recorder.fetch('https://js.rokid.com/robots.txt', { method: 'HEAD' });

  assert.equal(res.status, 200);
  assert.equal(recorder.recordings.length, 0);
  assert.equal(recorder.exchanges.length, 0);
  assert.equal(upstream.seen[0].url, 'https://js.rokid.com/robots.txt');
});

// ── 故障注入 ───────────────────────────────────────────────────────────

test("failNext timeout 默认永不落定：先落定的必须是应用自己那把 8s 闸", async () => {
  const clock = fakeClock();
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({
    mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch, now: clock.now, setTimeout: clock.setTimeout,
  });
  llm.failNext({ kind: 'timeout' });

  const inflight = llm.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) });
  let appFallback = null;
  clock.setTimeout(() => { appFallback = 'rules'; }, 8000); // 应用自己的生成超时闸

  await clock.advance(8000);
  assert.equal(appFallback, 'rules', '应用必须能靠自己的定时器脱身');
  assert.equal(await settled(inflight), false, '请求还挂着——真机断网/网关吞包就是这个样子');
  assert.equal(upstream.seen.length, 0, '注入超时不该真的打出去');
});

test('failNext timeout 给了 afterMs 就到点抛错（用来验证"迟到但确实回来了"的路径）', async () => {
  const clock = fakeClock();
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({
    mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch, now: clock.now, setTimeout: clock.setTimeout,
  });
  llm.failNext({ kind: 'timeout', afterMs: 12000 });

  const inflight = llm.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) });
  let outcome = null;
  inflight.then(() => { outcome = 'resolved'; }, (err) => { outcome = err; });

  await clock.advance(11999);
  assert.equal(outcome, null, '没到点不能提前失败');
  await clock.advance(1);
  assert.match(outcome.message, /注入超时（timeout 12000ms）/);
});

test('failNext http：造出的是真·HTTP 失败（引擎的 Dt 会把它变成 "Request failed with 503"）', async () => {
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({ mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  llm.failNext({ kind: 'http', status: 503, body: '{"error":{"message":"upstream down"}}' });

  const res = await llm.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) });
  assert.equal(res.status, 503);
  assert.equal(res.ok, false);
  assert.match(await res.text(), /upstream down/);
  assert.equal(upstream.seen.length, 0);
});

test('failNext malformed：200 但体解析不了——这条降级路径与 HTTP 错误不是同一条', async () => {
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({ mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  llm.failNext({ kind: 'malformed' });

  const res = await llm.fetch(ENDPOINT, { method: 'POST', body: chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' }) });
  assert.equal(res.status, 200, '状态码是好的，坏的是体：应用不能靠 res.ok 判断安全');
  const text = await res.text();
  assert.throws(() => JSON.parse(text));
});

test('故障是一次性的，按入队顺序生效，用完自动回到正常模式', async () => {
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({ mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch });
  llm.failNext({ kind: 'http', status: 429 });
  llm.failNext({ kind: 'malformed' });
  assert.equal(llm.pendingFaults(), 2);

  const body = chatBody({ at: '2026-08-25T10:00:00Z', session: 'a', reqId: '1' });
  assert.equal((await llm.fetch(ENDPOINT, { method: 'POST', body })).status, 429);
  const broken = await (await llm.fetch(ENDPOINT, { method: 'POST', body })).text();
  assert.throws(() => JSON.parse(broken));
  assert.equal((await llm.fetch(ENDPOINT, { method: 'POST', body })).status, 200, '故障用完就该回到正常转发');
  assert.equal(upstream.seen.length, 1);
  assert.equal(llm.pendingFaults(), 0);
});

test('failNext 的 when 只打指定 URL，别的请求不受影响（故障之间不串台）', async () => {
  const upstream = fakeUpstream();
  const llm = createLanguageModelCapabilities({
    mode: 'live', endpoint: ENDPOINT, env: KEY_ENV, fetch: upstream.fetch, match: () => true,
  });
  llm.failNext({ kind: 'http', status: 500, when: '/v1/chat/completions' });

  const other = await llm.fetch('https://llm.example.com/v1/embeddings', { method: 'POST', body: '{}' });
  assert.equal(other.status, 200, '没命中 when 的请求不该把故障消费掉');
  assert.equal(llm.pendingFaults(), 1);

  const hit = await llm.fetch(ENDPOINT, { method: 'POST', body: '{}' });
  assert.equal(hit.status, 500);
});

test('failNext 只认三种 kind；failNext(null) 清空待生效故障', () => {
  const llm = createLanguageModelCapabilities({ mode: 'replay' });
  assert.throws(() => llm.failNext({ kind: 'explode' }), /timeout \/ http \/ malformed/);
  llm.failNext({ kind: 'http' });
  llm.failNext(null);
  assert.equal(llm.pendingFaults(), 0);
});

test('mode 只有三种，写错在构造时就炸（写成 replays 之后会安静地走 live 打到线上）', () => {
  assert.throws(() => createLanguageModelCapabilities({ mode: 'replays' }), /live\/record\/replay/);
});

test('record/live 没给上游 fetch 时说人话，而不是抛 undefined is not a function', async () => {
  const llm = createLanguageModelCapabilities({ mode: 'live', endpoint: ENDPOINT, env: KEY_ENV });
  await assert.rejects(
    () => llm.fetch(ENDPOINT, { method: 'POST', body: '{}' }),
    /需要上游 fetch/,
  );
});
