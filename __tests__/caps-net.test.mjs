// InkLab 网络控制：拦截器动作、规则隔离、fetch 层状态码、连通性事件。假钟 + 假 fetch，零真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNetworkControl, makeResponse, matcherOf, scrubHeaders, bodyToText, OFFLINE_REASON,
  isExternalUrl, EXTERNAL_STUB_STATUS, utf8Bytes, inspectBody,
} from '../lib/caps/net.mjs';

// ── 测试替身 ────────────────────────────────────────────────────────────

/** 假钟：定时器只在 advance() 里推进，延迟规则才能被确定性地断言。 */
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
    clearTimeout: (id) => { timers.delete(id); },
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
    flush,
  };
}

/** promise 是否已落定——用于断言"注入超时后确实还挂着"。 */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return done;
}

const req = (url, extra = {}) => ({ url, method: 'GET', headers: {}, body: null, metadata: {}, ...extra });

// ── 拦截器动作（只能产出引擎认识的三种） ─────────────────────────────────

test('放行时返回引擎认识的 continue 动作（glue An 只认 continue/block/rewrite）', async () => {
  const net = createNetworkControl();
  const decision = await net.interceptor(req('https://example.com/a'));
  assert.deepEqual(decision, { action: 'continue' });
});

test('整体断网：每条请求都被 block，reason 能认出是 InkLab 注入的；online() 立刻恢复', async () => {
  const net = createNetworkControl();
  net.offline();
  assert.equal(net.isOnline(), false);

  const blocked = await net.interceptor(req('https://js.rokid.com/robots.txt'));
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.reason, OFFLINE_REASON);
  assert.match(blocked.reason, /InkLab/, '真机断网也只是一个 Error，reason 里不带标记就分不出是谁断的');

  net.online();
  assert.deepEqual(await net.interceptor(req('https://js.rokid.com/robots.txt')), { action: 'continue' });
});

test('按 URL 模式断：只断命中的那条，别的照过（规则不串台）', async () => {
  const net = createNetworkControl();
  net.block('/chat/completions', { reason: '断 LLM，留其它' });

  const llm = await net.interceptor(req('https://api.example.com/v1/chat/completions'));
  const probe = await net.interceptor(req('https://js.rokid.com/robots.txt'));

  assert.equal(llm.action, 'block');
  assert.equal(llm.reason, '断 LLM，留其它');
  assert.deepEqual(probe, { action: 'continue' }, '探针 HEAD 不该被 LLM 的断网规则波及');
});

test('按 URL 模式延迟：命中的等满时长才落定，不命中的立刻放行', async () => {
  const clock = fakeClock();
  const net = createNetworkControl({ now: clock.now, setTimeout: clock.setTimeout });
  net.delay('/chat/completions', 3000);

  const slow = net.interceptor(req('https://api.example.com/v1/chat/completions'));
  const fast = net.interceptor(req('https://js.rokid.com/robots.txt'));

  assert.equal(await settled(fast), true, '没命中延迟规则的请求不该被拖住');
  assert.equal(await settled(slow), false, '命中的请求在时钟推进前必须还挂着');

  await clock.advance(2999);
  assert.equal(await settled(slow), false, '差 1ms 也不能提前放行');

  await clock.advance(1);
  assert.deepEqual(await slow, { action: 'continue' }, '延迟结束后仍然是放行，不是别的动作');
});

test('多条延迟同时命中取最慢的一条，不累加（每条说的是"至少慢 x"）', async () => {
  const clock = fakeClock();
  const net = createNetworkControl({ now: clock.now, setTimeout: clock.setTimeout });
  net.delay('/v1/', 200);
  net.delay('/chat/completions', 500);

  const p = net.interceptor(req('https://api.example.com/v1/chat/completions'));
  await clock.advance(499);
  assert.equal(await settled(p), false);
  await clock.advance(1);
  assert.equal(await settled(p), true, '累加的话 700ms 才会放行，那就把延迟规则叠成了玄学');
});

test('状态码规则不进拦截器：拦截器没有 fulfill 动作，只能在 fetch 层造响应', async () => {
  const net = createNetworkControl();
  net.status('/chat/completions', 503, { body: 'upstream down' });

  const decision = await net.interceptor(req('https://api.example.com/v1/chat/completions'));
  assert.deepEqual(decision, { action: 'continue' }, '在拦截器里返回"响应"会被引擎当成畸形 rewrite');

  const wrapped = net.wrapFetch(async () => makeResponse({ status: 200, body: 'real' }));
  const res = await wrapped('https://api.example.com/v1/chat/completions', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'upstream down');
});

test('状态码规则只打命中的 URL，别的照常透传到上游（不串台）', async () => {
  const net = createNetworkControl();
  net.status('/chat/completions', 429);
  let upstreamHits = 0;
  const wrapped = net.wrapFetch(async () => { upstreamHits += 1; return makeResponse({ status: 200, body: 'ok' }); });

  assert.equal((await wrapped('https://api.example.com/v1/chat/completions')).status, 429);
  assert.equal(upstreamHits, 0, '被注入状态码的请求不该真的打出去');

  const other = await wrapped('https://js.rokid.com/robots.txt');
  assert.equal(other.status, 200);
  assert.equal(upstreamHits, 1);
});

test('断网在 fetch 层也判（只装一层也能断），但延迟只在拦截器层，不会加两遍', async () => {
  const clock = fakeClock();
  const net = createNetworkControl({ now: clock.now, setTimeout: clock.setTimeout });
  net.delay('/chat/completions', 1000);
  const wrapped = net.wrapFetch(async () => makeResponse({ status: 200, body: 'ok' }));

  const p = wrapped('https://api.example.com/v1/chat/completions');
  assert.equal(await settled(p), true, 'fetch 层再延迟一次的话，一条 1s 的规则会变成 2s');
  assert.equal((await p).status, 200);

  net.offline();
  await assert.rejects(() => wrapped('https://api.example.com/v1/chat/completions'), /网络已断开/);
});

test('times 用尽后规则自动失效（"第一次失败、重试成功"是常见验收场景）', async () => {
  const net = createNetworkControl();
  net.status('/chat/completions', 500, { times: 1 });
  const wrapped = net.wrapFetch(async () => makeResponse({ status: 200, body: 'ok' }));

  assert.equal((await wrapped('https://api.example.com/v1/chat/completions')).status, 500);
  assert.equal((await wrapped('https://api.example.com/v1/chat/completions')).status, 200);
  assert.deepEqual(net.rules().map((r) => r.times), [0]);
});

// ── 录制与脱敏 ─────────────────────────────────────────────────────────

test('请求录制：拦截器层记引擎想发什么，fetch 层记实际出去了什么', async () => {
  const net = createNetworkControl();
  const wrapped = net.wrapFetch(async () => makeResponse({ status: 200, body: 'ok' }));
  await net.interceptor(req('https://api.example.com/v1/chat/completions', { method: 'POST' }));
  await wrapped('https://api.example.com/v1/chat/completions', { method: 'POST' });

  assert.equal(net.requestsOf('interceptor').length, 1);
  assert.equal(net.requestsOf('fetch').length, 1);
  assert.equal(net.requestsOf('interceptor')[0].decision, 'continue');
  assert.equal(net.requestsOf('fetch')[0].decision, 'pass');
});

test('Inspector 响应证据：状态/headers/body/截断标记齐全，敏感响应字段脱敏', async () => {
  const net = createNetworkControl({ bodyLimit: 24 });
  const wrapped = net.wrapFetch(async () => makeResponse({
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json', authorization: 'secret' },
    body: JSON.stringify({ token: 'sk-abcdefghijk', ok: true, padding: 'x'.repeat(40) }),
  }));
  await wrapped('http://127.0.0.1/api/create', { method: 'POST', body: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = net.requestsOf('response').at(-1);
  assert.equal(row.status, 201);
  assert.equal(row.responseHeaders.authorization, '<redacted>');
  assert.match(row.responseBody, /<redacted>/);
  assert.equal(row.responseBodyTruncated, true);
  assert.equal(row.responseBodyInspectable, true);
  assert.ok(row.responseBodyBytes > row.responseBody.length);
});

test('请求体整条留档：隐私白名单类断言看的是整个 body，不是前 200 字的摘要', async () => {
  const net = createNetworkControl();
  // 前 200 字全是白名单字段，违规字段藏在后面——只看 bodyPreview 会得出「合规」的假结论。
  const payload = JSON.stringify({
    title: '城市一日', pad: 'x'.repeat(400), photo: 'data:image/jpeg;base64,AAAA',
  });
  await net.interceptor(req('https://trips.example/api/trips', { method: 'POST', body: payload }));

  const [entry] = net.requestsOf('interceptor');
  assert.equal(entry.bodyPreview.length, 200, 'preview 还是给页面日志看的摘要');
  assert.equal(entry.bodyTruncated, false, '没超上限就要明说「看全了」');
  // bodyBytes 是 **UTF-8 字节数**，不是 UTF-16 码元数：载体里有中文时两者不等，
  // 而「这条外发了多大」问的恒是真出网字节。
  assert.equal(entry.bodyBytes, utf8Bytes(payload));
  assert.ok(entry.bodyBytes > payload.length, '载体含中文 → 字节数必然大于 length（口径确实换了）');
  assert.ok(entry.body.includes('data:image/jpeg'), '整条 body 里的违规字段必须看得见');
});

test('bodyBytes 按 UTF-8 计：纯 ASCII 与 length 相等，中文按 3 字节一个', () => {
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('城市'), 6, '中文 3 字节一个');
  assert.equal(utf8Bytes('a城b'), 5);
  assert.equal(utf8Bytes('😀'), 4, '代理对算一个 4 字节码点，不是两个 3 字节');
  assert.equal(utf8Bytes(null), 0);
});

test('请求体超上限时明说截断了：悄悄截断会把假阴性伪装成通过', async () => {
  const net = createNetworkControl({ bodyLimit: 64 });
  const payload = `${'a'.repeat(64)}data:image/jpeg;base64,ZZZZ`;
  await net.interceptor(req('https://trips.example/api/trips', { method: 'POST', body: payload }));

  const [entry] = net.requestsOf('interceptor');
  assert.equal(entry.bodyTruncated, true);
  assert.equal(entry.body.length, 64);
  assert.equal(entry.bodyBytes, utf8Bytes(payload), '截断了也要如实报**原始**体积（不是留档那一截的）');
});

test('日志里的密钥被抹掉：录像和日志会进仓库、会贴进 issue', async () => {
  const net = createNetworkControl();
  await net.interceptor(req('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer sk-live-abcdefghijklmnop', 'content-type': 'application/json' },
    body: '{"model":"m","key":"sk-live-abcdefghijklmnop"}',
  }));

  const dumped = net.toJSON();
  assert.ok(!dumped.includes('sk-live-abcdefghijklmnop'), '密钥不能出现在任何导出物里');
  assert.match(dumped, /<redacted>/);
  assert.match(dumped, /content-type/, '只抹值不抹键：还要看得出"确实带了哪些头"');
});

// ── 连通性事件 ─────────────────────────────────────────────────────────

test('offline()/online() 一行切换，并同步派发引擎认识的小写状态串', () => {
  const dispatched = [];
  const view = { dispatchConnectivityEvent: (s) => dispatched.push(s) };
  const net = createNetworkControl({ view });

  net.offline();
  net.online();
  assert.deepEqual(dispatched, ['offline', 'online'], 'glue $r 只认小写 online/offline');
});

test('派发非法连通性状态在宿主侧就报错，不把 TypeError 留给 wasm 抛', () => {
  const net = createNetworkControl({ view: { dispatchConnectivityEvent: () => {} } });
  assert.throws(() => net.dispatchConnectivity('OFFLINE!'), /online.*offline/s);
  assert.throws(() => net.dispatchConnectivity(1), /必须是字符串/);
  assert.doesNotThrow(() => net.dispatchConnectivity('Online'), 'glue 自己会 trim + 小写，大小写不该卡住调用方');
});

test('没挂 view 时切换连通性不炸，只是不派事件（规则依然生效）', async () => {
  const net = createNetworkControl();
  assert.doesNotThrow(() => net.offline());
  assert.equal((await net.interceptor(req('https://x/y'))).action, 'block');
  assert.throws(() => net.dispatchConnectivity('offline'), /attachView/);
});

// ── 挂载 ───────────────────────────────────────────────────────────────

test('install 优先走 configureNetwork({interceptor})，返回的卸载函数会清掉拦截器', () => {
  const seen = [];
  const bindings = {
    configureNetwork: (o) => seen.push(['configureNetwork', o]),
    clearInkRequestInterceptor: () => seen.push(['clear']),
  };
  const net = createNetworkControl();
  const uninstall = net.install(bindings);
  assert.equal(seen[0][0], 'configureNetwork');
  assert.equal(seen[0][1].interceptor, net.interceptor);
  uninstall();
  assert.deepEqual(seen[1], ['clear']);
});

test('只有 setInkRequestInterceptor 时退化使用它；两个都没有就直接说人话', () => {
  const seen = [];
  const net = createNetworkControl();
  net.install({ setInkRequestInterceptor: (fn) => seen.push(fn) });
  assert.equal(seen[0], net.interceptor);
  assert.throws(() => net.install({}), /configureNetwork 或 setInkRequestInterceptor/);
});

// ── 匹配器与响应工厂 ───────────────────────────────────────────────────

test('带 g 的正则不能有 lastIndex 记忆（否则同一条规则第二次匹配会莫名其妙地漏）', () => {
  const m = matcherOf(/completions/g);
  assert.equal(m('https://a/v1/chat/completions'), true);
  assert.equal(m('https://a/v1/chat/completions'), true, '第二次必须还中');
});

test('模式三种写法：子串、glob、谓词', () => {
  assert.equal(matcherOf('/chat/')('https://a/v1/chat/completions'), true);
  assert.equal(matcherOf('https://a/*/completions')('https://a/v1/completions'), true);
  assert.equal(matcherOf('https://a/*/completions')('https://b/v1/completions'), false);
  assert.equal(matcherOf((url, r) => r.method === 'HEAD')('https://a', { method: 'HEAD' }), true);
  assert.equal(matcherOf('*')('anything'), true);
});

test('makeResponse：正常状态码走真 Response，越界状态码走兜底对象，两条路形状一致', async () => {
  const real = makeResponse({ status: 503, body: 'boom', headers: { 'content-type': 'text/plain' } });
  assert.equal(real.status, 503);
  assert.equal(real.ok, false);
  assert.equal(await real.text(), 'boom');

  const shim = makeResponse({ status: 0, body: 'weird' });
  assert.equal(shim.status, 0);
  assert.equal(shim.ok, false);
  assert.equal(await shim.text(), 'weird');
  assert.equal(shim.headers.get('nope'), null);
});

test('bodyToText 吃下 glue Cn 的三种产物（字符串 / TypedArray / ArrayBuffer）', () => {
  assert.equal(bodyToText('{"a":1}'), '{"a":1}');
  assert.equal(bodyToText(new TextEncoder().encode('你好')), '你好');
  assert.equal(bodyToText(new TextEncoder().encode('abc').buffer), 'abc');
  assert.equal(bodyToText(null), '');
});

test('scrubHeaders 大小写不敏感地抹密钥头', () => {
  const out = scrubHeaders({ AUTHORIZATION: 'Bearer x', 'X-Api-Key': 'k', accept: 'application/json' });
  assert.equal(out.AUTHORIZATION, '<redacted>');
  assert.equal(out['X-Api-Key'], '<redacted>');
  assert.equal(out.accept, 'application/json');
});

// ── 外域出网默认桩（guardExternal） ──────────────────────────────────────
//
// 为什么这道闸必须在 caps 层而不是场景层：应用里硬编码的线上域名多半在**启动链路**里就打出去了
// （有的应用在启动入口里就 fire-and-forget 预取天气），那时候场景脚本一行都还没跑。
// 实例级节流也拦不住——e2e 每个场景都重建 InkView，每次都是「第一次」。

/** 记账用的假上游：真出网走到这里就说明闸没拦住。 */
function spyFetch() {
  const hits = [];
  const fn = async (input, init) => {
    hits.push(String(typeof input === 'string' ? input : input && input.url));
    void init;
    return makeResponse({ status: 200, body: 'upstream' });
  };
  fn.hits = hits;
  return fn;
}

const guarded = (extra = {}) => createNetworkControl({
  externalOrigin: 'http://127.0.0.1:5173', ...extra,
});

test('外域出网默认挡下：不同源的请求回 503 且一个字节都没真出去', async () => {
  const net = guarded();
  const upstream = spyFetch();
  const res = await net.wrapFetch(upstream)('https://trips.example.com/api/weather');

  assert.equal(res.status, EXTERNAL_STUB_STATUS);
  assert.deepEqual(upstream.hits, [], '真上游一次都不该被碰到');
  const rec = net.requestsOf('fetch').at(-1);
  assert.equal(rec.decision, 'external-stub', '日志里要能证明「这条没出去」，不是靠猜');
  assert.match(rec.reason, /InkLab/, 'reason 要能认出是注入的，不是真后端 503');
});

test('外域闸不误伤同源：宿主自己的 /app/ /engine/ 与相对路径照常出去', async () => {
  const net = guarded();
  const upstream = spyFetch();
  const f = net.wrapFetch(upstream);
  await f('http://127.0.0.1:5173/app/lib/compiled-pack.js');
  await f('/api/manifest');
  await f('data:application/json,{}');

  assert.equal(upstream.hits.length, 3, '同源 / 相对路径 / data: 都不该被当成外域');
  assert.deepEqual(net.requestsOf('fetch').map((r) => r.decision), ['pass', 'pass', 'pass']);
});

test('外域闸让位于显式规则：场景桩过的 /api/trips 照常走 status 那一支（分享场景的承重前提）', async () => {
  const net = guarded();
  const upstream = spyFetch();
  net.status('/api/trips', 200, { body: JSON.stringify({ shortLink: 'https://example.invalid/t/x' }) });

  const res = await net.wrapFetch(upstream)('https://trips.example.com/api/trips', { method: 'POST', body: '{}' });

  assert.equal(res.status, 200, '显式桩优先于外域默认桩');
  assert.equal(await res.text(), JSON.stringify({ shortLink: 'https://example.invalid/t/x' }));
  assert.deepEqual(upstream.hits, [], '桩掉的请求同样不出网');
  assert.equal(net.requestsOf('fetch').at(-1).decision, 'status');
});

test('allowExternal 点名放行：清单内的外域真出去，别的照挡（LLM live 的上游走这条）', async () => {
  const net = guarded({ allowExternal: ['api.openai-like.test'] });
  const upstream = spyFetch();
  const f = net.wrapFetch(upstream);

  const ok = await f('https://api.openai-like.test/v1/chat/completions', { method: 'POST', body: '{}' });
  const stubbed = await f('https://trips.example.com/api/weather');

  assert.equal(ok.status, 200);
  assert.deepEqual(upstream.hits, ['https://api.openai-like.test/v1/chat/completions']);
  assert.equal(stubbed.status, EXTERNAL_STUB_STATUS, '放行是点名的，不是一放全放');
});

test('断网优先于外域闸：offline 时外域请求抛的仍是断网错误（两种降级不能混成一路）', async () => {
  const net = guarded();
  net.offline();
  await assert.rejects(
    () => net.wrapFetch(spyFetch())('https://trips.example.com/api/weather'),
    /网络已断开/,
    '断网是应用要区分的另一种降级：不能被 503 顶掉',
  );
});

test('guardExternal(false) 关掉闸；wouldStubExternal 能提前说清这条会不会被挡', async () => {
  const net = guarded();
  assert.equal(net.isExternalGuarded(), true, '默认开');
  assert.equal(net.wouldStubExternal('https://trips.example.com/api/weather'), true);
  assert.equal(net.wouldStubExternal('/api/manifest'), false);

  net.guardExternal(false);
  const upstream = spyFetch();
  await net.wrapFetch(upstream)('https://trips.example.com/api/weather');
  assert.deepEqual(upstream.hits, ['https://trips.example.com/api/weather'], '关掉之后真出网');
});

test('非浏览器环境（拿不到 origin）整道闸天然 no-op —— 不把所有绝对 URL 凭空变成 503', async () => {
  const net = createNetworkControl(); // node --test 里没有 location
  const upstream = spyFetch();
  await net.wrapFetch(upstream)('https://example.com/a');
  assert.deepEqual(upstream.hits, ['https://example.com/a']);
  assert.equal(isExternalUrl('https://example.com/a', ''), false);
});

test('isExternalUrl：相对路径/data:/同源都不算外域，异源与解析不出来的怪串算', () => {
  const o = 'http://127.0.0.1:5173';
  assert.equal(isExternalUrl('/api/manifest', o), false);
  assert.equal(isExternalUrl('http://127.0.0.1:5173/app/x.js', o), false);
  assert.equal(isExternalUrl('data:image/png;base64,AA==', o), false);
  assert.equal(isExternalUrl('blob:http://127.0.0.1:5173/abc', o), false);
  assert.equal(isExternalUrl('https://127.0.0.1:5173/x', o), true, '协议不同就是异源');
  assert.equal(isExternalUrl('http://127.0.0.1:9999/x', o), true, '端口不同就是异源');
  assert.equal(isExternalUrl('https://trips.example.com/api/weather', o), true);
  assert.equal(isExternalUrl('http://[not a url', o), true, '解析不出来的按外域挡下');
});

// ── 协议相对 URL（//host/path）不许绕过外域闸 ────────────────
//
// 旧判据是「有没有 scheme」：`//api.example.com/x` 没有 scheme，于是被当成相对路径直接放行。
// 而浏览器 fetch 会拿页面协议补全它，**真的打到 api.example.com**——闸被一行写法绕过去，
// 日志里还记的是 decision:'pass'（查账时看不出异常）。改成按宿主 origin 解析后比 origin。

test('M2 协议相对 URL 判外域：`//host/path` 会被浏览器补全成真出网，不是相对路径', () => {
  const o = 'http://127.0.0.1:5173';
  assert.equal(isExternalUrl('//api.example.com/x', o), true, '这一条就是被绕过去的那个洞');
  assert.equal(isExternalUrl('//trips.example.com/api/weather', o), true);
  // 同源写法照旧不算外域（补全后落回宿主自己）。
  assert.equal(isExternalUrl('//127.0.0.1:5173/app/x.js', o), false, '协议相对 + 同一个 host:port → 同源');
  assert.equal(isExternalUrl('/api/x', o), false, '真正的相对路径仍是同源');
  assert.equal(isExternalUrl('app/x.js', o), false, '无前导斜杠的相对路径同样同源');
  assert.equal(isExternalUrl('?a=1', o), false);
});

test('M2 协议相对 URL 在闸上真的被挡下（不只是判定函数对）', async () => {
  const net = guarded();
  const upstream = spyFetch();
  const res = await net.wrapFetch(upstream)('//trips.example.com/api/weather');
  assert.equal(res.status, EXTERNAL_STUB_STATUS);
  assert.deepEqual(upstream.hits, [], '一个字节都不许打到别人的生产后端');
  assert.equal(net.requestsOf('fetch').at(-1).decision, 'external-stub');
});

// ── 载体挂在 Request / FormData 上时，隐私断言不许恒真 ───────
//
// 「外发载体里没有 dataUrl」是**否定式**结论，只在「整段载体确实读到了」的前提下成立。
// 旧实现只取 init.body：`fetch(new Request(url,{body}))` 的 body 恒记成空串，
// FormData 更糟——String() 出来是 `[object FormData]`，一样「没有 dataUrl」。
// 断言于是从「检视过、干净」悄悄退化成「压根没检视成」，而原图一个字节都没被看见。

test('M3 Request 载体：body 从 input 上补取，且断言得到 bodyInspectable:true', async () => {
  if (typeof Request !== 'function') return; // 老 node 没有全局 Request：这条跳过而不是假绿
  const net = guarded();
  const upstream = spyFetch();
  const payload = JSON.stringify({ title: '城市一日', photo: 'data:image/jpeg;base64,AAAA' });
  const request = new Request('http://127.0.0.1:5173/api/trips', {
    method: 'POST', body: payload, headers: { 'content-type': 'application/json' },
  });

  await net.wrapFetch(upstream)(request);

  const rec = net.requestsOf('fetch').at(-1);
  assert.equal(rec.method, 'POST', 'method 也在 Request 上，不在 init 里');
  assert.equal(rec.bodyInspectable, true, '读到了整段载体');
  assert.equal(rec.body, payload, '内容与原件逐字一致');
  assert.ok(rec.body.includes('data:image/jpeg'), '违规字段这下真的看得见了（旧实现这里是空串）');
  assert.equal(rec.headers['content-type'], 'application/json', 'Headers 实例也要拍平进日志');
  assert.deepEqual(upstream.hits, ['http://127.0.0.1:5173/api/trips'], '同源照常放行');
});

test('M3 Request 的 body 是 clone 之后读的：原件照常发得出去（读过一次的 body 不能再发）', async () => {
  if (typeof Request !== 'function') return;
  const net = guarded();
  const sent = [];
  const upstream = async (input) => { sent.push(await input.text()); return makeResponse({ status: 200 }); };
  const request = new Request('http://127.0.0.1:5173/api/trips', { method: 'POST', body: 'HELLO' });

  await net.wrapFetch(upstream)(request);

  assert.deepEqual(sent, ['HELLO'], '下游拿到的仍是完整原件——记日志不能把请求吃掉');
});

test('M3 看不进去的载体（FormData / Blob / 流）如实标 bodyInspectable:false，不伪装成「干净」', async () => {
  assert.deepEqual(inspectBody(null), { text: '', inspectable: true, kind: 'none' });
  assert.deepEqual(inspectBody('abc'), { text: 'abc', inspectable: true, kind: 'string' });
  assert.equal(inspectBody(new Uint8Array([65, 66])).text, 'AB', 'TypedArray 看得全');

  if (typeof FormData === 'function') {
    const fd = new FormData();
    fd.append('photo', 'data:image/jpeg;base64,AAAA');
    const got = inspectBody(fd);
    assert.equal(got.inspectable, false, 'FormData 看不成——这一条必须说出来');
    assert.equal(got.text, '', '不许拿 "[object FormData]" 冒充载体文本');
    assert.equal(got.kind, 'FormData', '类标注要指名是什么载体');
  }

  const net = guarded();
  const weird = { toString: () => '[object Whatever]' }; // 非文本载体的最小替身
  await net.wrapFetch(spyFetch())('http://127.0.0.1:5173/api/trips', { method: 'POST', body: weird });
  const rec = net.requestsOf('fetch').at(-1);
  assert.equal(rec.bodyInspectable, false);
  assert.equal(rec.body, '', '看不成就是空，不是一段假的「载体文本」');
  // 隐私断言方据此能分清两件事：这条不是「检视过、里面没有 dataUrl」。
  assert.ok(!rec.body.includes('dataUrl') && rec.bodyInspectable === false,
    '「body 里没有 dataUrl」在 bodyInspectable=false 时不构成任何结论');
});

test('M3 普通字符串 body 照旧 bodyInspectable:true（既有断言不被新字段改口径）', async () => {
  const net = guarded();
  await net.wrapFetch(spyFetch())('http://127.0.0.1:5173/api/trips', { method: 'POST', body: '{"a":1}' });
  const rec = net.requestsOf('fetch').at(-1);
  assert.equal(rec.bodyInspectable, true);
  assert.equal(rec.bodyKind, 'string');
  assert.equal(rec.body, '{"a":1}');
});

// ── 请求日志体积有界，且丢过就得说出来 ──────────────────────
//
// 条数闸单独用是算不住的：logLimit 500 条 × bodyLimit 256KiB × 拦截器/fetch 两层各一条，
// 最坏 ~256MiB 全压在内存里（无头 Chrome 里就是标签页被杀，跑到一半没有任何解释）。

test('M4 总体积上限：超限丢最旧，并把 truncatedLog 标出来（账不完整不许装作完整）', async () => {
  const net = createNetworkControl({ logBytesLimit: 4096, bodyLimit: 4096 });
  assert.equal(net.logStats().truncatedLog, false, '起手账是完整的');

  const big = 'x'.repeat(1200);
  for (let i = 0; i < 12; i += 1) {
    await net.interceptor(req(`https://trips.example/api/t${i}`, { method: 'POST', body: big }));
  }

  const stats = net.logStats();
  assert.ok(stats.bytes <= 4096, `体积必须收在闸内，实际 ${stats.bytes}`);
  assert.ok(stats.entries < 12, '装不下就得丢，不能无界堆着');
  assert.ok(stats.dropped > 0);
  assert.equal(stats.truncatedLog, true, '丢过就必须说出来——「零真实外呼」这类穷举断言看到它得失败');
  // 丢的是**最旧**的：最新那条必须还在（排障看的就是最后发生了什么）。
  assert.match(net.requestsOf('interceptor').at(-1).url, /api\/t11$/);
});

test('M4 单条就超上限时它照样进得来（最该看的那条不能反而被丢掉）', async () => {
  const net = createNetworkControl({ logBytesLimit: 64, bodyLimit: 1024 * 1024 });
  await net.interceptor(req('https://trips.example/api/trips', { method: 'POST', body: 'y'.repeat(5000) }));
  assert.equal(net.requestsOf('interceptor').length, 1, '闸永远给最新那条留位置');
  assert.equal(net.logStats().truncatedLog, false, '没丢过任何条目 → 账仍是完整的');
});

test('M4 条数闸照旧生效，且 clearLog 把记账一起清干净', async () => {
  const net = createNetworkControl({ logLimit: 3 });
  for (let i = 0; i < 6; i += 1) {
    await net.interceptor(req(`https://trips.example/api/t${i}`));
  }
  assert.equal(net.requestsOf('interceptor').length, 3);
  assert.equal(net.logStats().entries, 3);
  assert.equal(net.logStats().truncatedLog, true);

  net.clearLog();
  const cleared = net.logStats();
  assert.equal(cleared.entries, 0);
  assert.equal(cleared.bytes, 0);
  assert.equal(cleared.truncatedLog, false, 'clearLog 之后是一本新账，不该继续报「丢过」');
});

test('M4 默认闸位不误伤常规跑测：一场 e2e 的量级远在上限之内', async () => {
  const net = createNetworkControl();
  for (let i = 0; i < 60; i += 1) {
    await net.interceptor(req(`https://trips.example/api/t${i}`, { method: 'POST', body: '{"a":1}' }));
  }
  assert.equal(net.logStats().truncatedLog, false, '常规量级一条都不该被丢（丢了就等于默认配置在说谎）');
  assert.equal(net.requestsOf('interceptor').length, 60);
});
