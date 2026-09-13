// net.mjs — 网络侧控制：Ink 请求拦截器 + fetch 层状态码注入 + 连通性事件。
//
// 网络不是 setHostCapabilities 里的能力命名空间（contract.mjs 的 CAPABILITY_METHODS 里没有它）。
// 引擎把它分成三处，本模块把三处包成一套场景脚本能一行切换的开关。
//
// ── 已证实（读 .engine/ink-glue.js 反解出来的，不是猜） ─────────────────────
// 1. 拦截器是 glue 模块导出的自由函数，不走能力表：
//      setInkRequestInterceptor(fn) / clearInkRequestInterceptor()
//      configureNetwork({interceptor}) | ({proxyUrl,targetSearchParam}) | ({clear:true})
//    glue `Vt`：fn 必须是 function / null / undefined，别的直接 TypeError。
// 2. fn 收到的请求描述符由 glue `kn` 组装，字段固定：
//      { url:string, method:大写字符串, headers:普通对象(值已 String 化),
//        body:string|Uint8Array|ArrayBuffer|null, metadata:object }
//    headers 过 `Lt`（Headers/二元组数组/对象都拍平），body 过 `Cn`（TypedArray 会被拷贝一份）。
//    metadata 是引擎标注的来路，实测 bundle 加载时是 {kind:'vfs', appId}。
// 3. fn 的返回值只有四种被接受（glue `An`），多一种都会抛：
//      null / undefined / false                         → 原样放行
//      { action:'continue' }                            → 原样放行
//      { action:'block', reason }                       → 引擎**抛** Error(reason || `Ink request blocked: ${url}`)
//      { action:'rewrite', url, method, headers, body } → 改写后再发（action 缺省即 rewrite）
//      其它 action → Error(`Unsupported Ink request interceptor action: ${...}`)
//    ⚠ **没有 fulfill/respond 动作：拦截器造不出响应。** 所以"按 URL 返回指定状态码"没法在
//      拦截器里做，只能在 fetch 层做（见 wrapFetch）。本模块分两层是被引擎逼的，不是设计洁癖。
// 4. fn 会被 await（glue `Wt` 里 `const a = await s(i)`）→ 返回一个 Promise 就等于注入延迟。
// 5. 引擎全部网络出口走 `__inkFetch`（glue `Gt`，挂在 wasm import 表上），它取的是
//    `globalThis.fetch`（glue `Pt`）。所以换掉 globalThis.fetch 能兜住**包括 LLM POST 在内**
//    的每一条出站请求；createProxyUrlResolver（glue `Et`）走的也是同一条 rewrite 路。
// 6. 连通性是 InkView 的方法而不是能力方法：view.dispatchConnectivityEvent(status)，
//    glue `$r` 只认小写 'online' | 'offline'，别的一律 TypeError。
//
// ── 推断（引擎不知道也不关心，是 InkLab 自己的约定） ────────────────────────
// - 规则匹配语义、优先级、日志形状、times 次数用尽即失效，都是本模块定的。
// - block 到了应用那儿只是一个"请求失败"的 Error（真机断网也是这个形态），应用分不出是谁断的，
//   所以 reason 里带 InkLab 字样：排查日志时一眼能认出这是注入的，不是真出网故障。

/** 整体断网时给引擎的错误文案。带 InkLab 前缀是为了在应用日志里能一眼认出是注入的。 */
export const OFFLINE_REASON = 'InkLab: 网络已断开（整体断网）';

/**
 * 外域出网默认桩的状态码与文案（见 createNetworkControl 的 `guardExternal`）。
 * 用 503 而不是 block：503 是「服务端暂时不可用」，应用的降级路径本来就要能吃下它；
 * block 抛的是网络层异常，会把「后端挂了」和「设备断网」两种降级混成一路。
 */
export const EXTERNAL_STUB_STATUS = 503;
export const EXTERNAL_STUB_REASON = 'InkLab: 外域出网被默认挡下（未在放行清单里）';

/**
 * 这条 URL 是不是「外域」= 跟宿主页面不同源。
 *
 * 判据：
 *   - data: / blob: / about: / file: / javascript: → 不出网，不算外域（先分流，免得进 URL 解析）；
 *   - 其余一律 `new URL(text, origin)` **按宿主 origin 解析后比 origin**：相对路径（`/app/x`、
 *     `engine/y`）自然落回同源，而 **协议相对 URL（`//api.example.com/x`）会被正确判成外域**——
 *     这一条是 V3 P1-F M2 修的洞：旧实现先用 `/^[a-zA-Z][a-zA-Z0-9+.-]*:/` 判「有没有 scheme」，
 *     `//host/path` 没有 scheme 于是被当成相对路径直接放行，而浏览器 fetch 会拿页面协议补全后
 *     **真的打到 api.example.com** ——外域闸被一行写法绕过去，且日志里记的是 `decision:'pass'`。
 *   - 解析不出 URL 的怪串 → 按外域处理（挡下比放出去安全）；
 *   - **origin 为空（非浏览器环境，比如 node --test）→ 一律判「不是外域」**：不知道自己是谁就
 *     没法判谁是外人，此时整道闸天然是 no-op。这条是刻意的——反过来（什么都算外域）会让所有
 *     非浏览器调用方的请求凭空变成 503，是一种很吵的隐式行为改变。
 *
 * @param {string} url
 * @param {string} origin 宿主页面的 origin（浏览器里就是 location.origin）
 * @returns {boolean}
 */
export function isExternalUrl(url, origin) {
  const text = String(url == null ? '' : url).trim();
  if (!text) return false;
  if (!origin) return false; // 不知道自己是谁 → 这道闸不生效（见上）
  if (/^(data|blob|about|file|javascript):/i.test(text)) return false;
  try {
    return new URL(text, String(origin)).origin !== String(origin);
  } catch {
    return true;
  }
}

/**
 * 这个 fetch 的第一参数是不是 Request（鸭子类型判，不依赖宿主有没有全局 `Request`）。
 * 判据要同时看 `clone` 与 `text`：光有 url 的普通对象（引擎的请求描述符就是）不该被误判。
 */
export function isRequestLike(input) {
  return input != null && typeof input === 'object'
    && typeof input.url === 'string'
    && typeof input.clone === 'function'
    && typeof input.text === 'function';
}

/** Headers 实例 / 二元组数组 / 普通对象 → 普通对象（scrubHeaders 只吃普通对象）。 */
export function headersToObject(headers) {
  if (!headers) return {};
  const out = {};
  try {
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      headers.forEach((v, k) => { out[String(k)] = String(v); }); // Headers
      return out;
    }
    if (Array.isArray(headers)) {
      for (const pair of headers) if (Array.isArray(pair)) out[String(pair[0])] = String(pair[1]);
      return out;
    }
    if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) out[String(k)] = String(v);
    }
  } catch { /* 拍不平就当没有头，日志不该因为这个中断 */ }
  return out;
}

/**
 * 从 Request 载体里读出请求体文本（**clone 之后再读**：原件要原封不动交给下游 fetch，
 * 读过一次的 body 是不能再发的）。读不出来（已消费 / 流式 body）→ 如实标 inspectable:false。
 */
export async function readRequestBody(input) {
  try {
    const text = await input.clone().text();
    return { text: String(text || ''), inspectable: true, kind: 'request' };
  } catch {
    return { text: '', inspectable: false, kind: 'request-unreadable' };
  }
}

/** 日志里要抹掉的请求头（大小写不敏感）。录像/日志绝不能把密钥带进仓库。 */
export const SECRET_HEADERS = Object.freeze([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie',
]);

const SECRET_LITERAL = /\b(sk|rk|key)-[A-Za-z0-9_-]{8,}/g;

/** 请求体可能是 string / TypedArray / ArrayBuffer（glue `Cn` 的三种产物），统一成文本。 */
export function bodyToText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
    if (ArrayBuffer.isView(body)) {
      return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }
  } catch { /* 解不出来就退回 String()，日志不该因为编码失败而中断 */ }
  return String(body);
}

/**
 * 文本的 **UTF-8 字节数**（`bodyBytes` 的口径，V3 P1-F M4）。
 * `String.length` 数的是 UTF-16 码元：一段中文按它算只有真实出网字节数的三分之一，
 * 拿它当「这条载体多大」既误导人，也让体积闸形同虚设。
 */
export function utf8Bytes(text) {
  const s = String(text == null ? '' : text);
  if (typeof TextEncoder === 'function') {
    try { return new TextEncoder().encode(s).length; } catch { /* 退到手算 */ }
  }
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.codePointAt(i);
    if (c <= 0x7f) n += 1;
    else if (c <= 0x7ff) n += 2;
    else if (c <= 0xffff) n += 3;
    else { n += 4; i += 1; } // 代理对：一次跨两个码元
  }
  return n;
}

/**
 * 请求体载体 → `{ text, inspectable, kind }`（V3 P1-F M3）。
 *
 * 为什么要 `inspectable`：隐私断言（「外发载体里没有 dataUrl」）是**否定式**的，只有在
 * **确实把整段载体读到了**的前提下才成立。`FormData` / `Blob` / `ReadableStream` 这些载体
 * `String()` 出来是 `[object FormData]`——旧实现照样把它记成一段「body 文本」，于是
 * 「里面没有 dataUrl」恒真：断言从「检视过、干净」悄悄退化成「压根没检视成」，
 * 而外发的原图一个字节都没被看见。所以这里显式区分两件事，让断言方能对
 * `bodyInspectable === false` **报错**而不是静默放行。
 *
 * @param {*} body
 * @returns {{text:string, inspectable:boolean, kind:string}}
 */
export function inspectBody(body) {
  if (body == null) return { text: '', inspectable: true, kind: 'none' };
  if (typeof body === 'string') return { text: body, inspectable: true, kind: 'string' };
  try {
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return { text: bodyToText(body), inspectable: true, kind: 'binary' };
    }
  } catch { /* 宿主没有 ArrayBuffer？继续往下判 */ }
  // URLSearchParams 的 toString() 就是真正会被发出去的那串，能看全。
  if (typeof globalThis.URLSearchParams === 'function' && body instanceof globalThis.URLSearchParams) {
    return { text: String(body), inspectable: true, kind: 'urlencoded' };
  }
  const kind = (body && body.constructor && body.constructor.name) ? String(body.constructor.name) : typeof body;
  return { text: '', inspectable: false, kind };
}

/** 文本里的裸密钥（sk-xxx 之类）也抹掉——密钥不只出现在头里，prompt 里贴过来的一样要抹。 */
export const scrubSecrets = (text) => String(text == null ? '' : text).replace(SECRET_LITERAL, '<redacted>');

/** 请求头脱敏：只抹值不抹键，排查时还能看出"确实带了 Authorization"。 */
export function scrubHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    out[String(k)] = SECRET_HEADERS.includes(String(k).toLowerCase()) ? '<redacted>' : scrubSecrets(v);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * URL 模式 → 判定函数。支持四种写法，覆盖场景脚本里的常见需求：
 *   函数    自定义 (url, req) => boolean
 *   正则    直接 test
 *   含 *    glob，`*` 匹配任意串，两端锚定
 *   普通串  子串包含（URL 很长，写全没意义；`'/chat/completions'` 是最自然的规则名）
 */
export function matcherOf(pattern) {
  if (typeof pattern === 'function') return (url, req) => Boolean(pattern(url, req));
  if (pattern instanceof RegExp) {
    // 带 g/y 的正则 test() 会记 lastIndex：同一条规则第二次匹配就会莫名其妙地漏。
    // 规则要被反复求值，这里重建一个无状态的副本。
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return (url) => re.test(url);
  }
  if (pattern == null || pattern === '*') return () => true;
  const text = String(pattern);
  if (text.includes('*')) {
    const re = new RegExp(`^${text.split('*').map(escapeRe).join('.*')}$`);
    return (url) => re.test(url);
  }
  return (url) => String(url).includes(text);
}

/**
 * 造一个响应。优先用运行环境真正的 Response（浏览器里引擎要读 body 流，SSE 靠它），
 * 只有在 Response 不存在、或状态码超出 Response 允许的 200..599 时（注入"离谱服务端"要用）
 * 才退到鸭子类型兜底对象。
 */
export function makeResponse({ status = 200, statusText = '', headers = {}, body = '' } = {}) {
  const code = Number(status);
  const usable = typeof globalThis.Response === 'function' && Number.isInteger(code) && code >= 200 && code <= 599;
  if (usable) return new globalThis.Response(body, { status: code, statusText, headers });

  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = String(v);
  const text = typeof body === 'string' ? body : bodyToText(body);
  const shim = {
    ok: code >= 200 && code < 300,
    status: code,
    statusText: String(statusText || ''),
    url: '',
    headers: {
      get: (k) => (Object.prototype.hasOwnProperty.call(lower, String(k).toLowerCase()) ? lower[String(k).toLowerCase()] : null),
      has: (k) => Object.prototype.hasOwnProperty.call(lower, String(k).toLowerCase()),
      entries: () => Object.entries(lower)[Symbol.iterator](),
    },
    text: async () => text,
    json: async () => JSON.parse(text),
    clone: () => shim,
  };
  return shim;
}

/**
 * 网络控制台。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] 时钟注入（测试用假钟）
 * @param {Function} [opts.setTimeout] 定时器注入（延迟规则靠它，测试里必须可假）
 * @param {boolean} [opts.startOffline] 起手就断网
 * @param {object} [opts.view] InkView 实例；给了就在 offline()/online() 时同步派发连通性事件
 * @param {number} [opts.logLimit] 请求日志**条数**上限，防长跑把内存吃满
 * @param {number} [opts.bodyLimit] 每条日志保留的完整请求体上限（字符）。默认 256KiB：
 *   隐私/白名单类断言必须能看**整个** body（「载体里没有 dataUrl」这种结论，看前 200 字得不出来），
 *   而 bodyPreview 是给页面日志看的摘要，两者不能互相替代。超限时截断并置 bodyTruncated=true，
 *   让断言能分清「看全了」与「只看了一截」——悄悄截断会把假阴性伪装成通过。
 * @param {number} [opts.logBytesLimit] 请求日志**总体积**上限（字节，默认 4MiB，V3 P1-F M4）。
 *   条数闸单独用是算不住的：500 条 × 256KiB 的 body、且拦截器/fetch 两层各记一条，最坏
 *   ~256MiB 全压在内存里（无头 Chrome 里就是标签页被杀）。超限时**丢最旧**并把
 *   `logStats().truncatedLog` 置真——账查不全时必须能看出来是「被丢了」，而不是「本来就没有」。
 * @param {boolean} [opts.guardExternal] **外域出网默认挡下**（默认开）。本地宿主跑的是真源码，
 *   应用里任何一条硬编码的线上域名（看见崇左的启动天气预取就是一例：`applyLaunchEntry` 里
 *   fire-and-forget 打 `branding.webHost/api/weather`，发生在任何场景步骤**之前**，场景层
 *   拦不住）都会真的打到别人的生产后端。开着这道闸时，不同源的请求一律回
 *   `EXTERNAL_STUB_STATUS`(503) 且**不真的出去**，日志里记 `decision:'external-stub'`——
 *   既是隐私/稳定边界，也是「本轮零真实外呼」的可断言证据。
 *   放行走显式清单：`allowExternal(pattern)`（LLM live/record 的上游端点由宿主自动放行）。
 * @param {string} [opts.externalOrigin] 宿主页面的 origin（浏览器里传 location.origin）。
 * @param {Array} [opts.allowExternal] 起手就放行的外域清单（matcherOf 的四种写法都行）。
 */
export function createNetworkControl({
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  startOffline = false,
  view = null,
  logLimit = 500,
  bodyLimit = 256 * 1024,
  logBytesLimit = 4 * 1024 * 1024,
  guardExternal = true,
  externalOrigin = (typeof globalThis.location === 'object' && globalThis.location)
    ? globalThis.location.origin : '',
  allowExternal: initialAllow = [],
} = {}) {
  let isOnlineFlag = !startOffline;
  let boundView = view;
  let ruleSeq = 0;
  let guardOn = Boolean(guardExternal);
  const origin = String(externalOrigin || '');
  const rules = [];
  const requests = [];

  const sleep = (ms) => new Promise((resolve) => { setT(resolve, ms); });

  // ── 日志体积记账（V3 P1-F M4）。`sizes` 与 `requests` 同下标平行维护（把尺寸挂到条目上会污染
  //    对外的记录形状，而断言方是照着这个形状写的），clearLog 两边一起清。
  const sizes = [];
  let loggedBytes = 0;
  let droppedEntries = 0;
  const bytesCap = Number.isFinite(logBytesLimit) && logBytesLimit >= 0 ? Number(logBytesLimit) : Infinity;
  const entryBytes = (entry) => utf8Bytes(entry.body || '')
    + utf8Bytes(entry.bodyPreview || '')
    + utf8Bytes(entry.responseBody || '')
    + utf8Bytes(entry.responseBodyPreview || '')
    + utf8Bytes(entry.url || '')
    + utf8Bytes(entry.reason || '')
    + 256; // headers / decision / 各种小字段的定额，宁可高估
  const dropOldest = () => {
    requests.shift();
    loggedBytes -= sizes.shift() || 0;
    if (loggedBytes < 0) loggedBytes = 0;
    droppedEntries += 1;
  };

  const log = (entry) => {
    const record = { at: now(), ...entry };
    requests.push(record);
    sizes.push(entryBytes(record));
    loggedBytes += sizes[sizes.length - 1];
    while (requests.length > logLimit) dropOldest();
    // 体积闸永远给最新那条留位置：单条就超上限时它照样进得来（否则最该看的那条反而没了），
    // 只是账上会记成 truncatedLog。
    while (requests.length > 1 && loggedBytes > bytesCap) dropOldest();
    return record;
  };

  const observeResponse = (response, requestInfo, decision) => {
    const common = {
      layer: 'response',
      url: requestInfo.url,
      method: requestInfo.method,
      decision,
      status: Number(response?.status) || 0,
      statusText: String(response?.statusText || ''),
      responseHeaders: scrubHeaders(headersToObject(response?.headers)),
    };
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream') || typeof response?.clone !== 'function') {
      log({
        ...common,
        responseBody: '', responseBodyPreview: '', responseBodyBytes: 0,
        responseBodyTruncated: false, responseBodyInspectable: false,
        responseBodyKind: contentType.includes('text/event-stream') ? 'stream' : 'unreadable',
      });
      return;
    }
    let clone;
    try { clone = response.clone(); } catch {
      log({ ...common, responseBody: '', responseBodyPreview: '', responseBodyBytes: 0,
        responseBodyTruncated: false, responseBodyInspectable: false, responseBodyKind: 'uncloneable' });
      return;
    }
    // 不阻塞 fetch 返回；普通响应的 clone 在后台采集。流式响应上面明确不读，避免无限挂起/缓存。
    Promise.resolve().then(() => clone.text()).then((text) => {
      const full = scrubSecrets(String(text || ''));
      const cap = Number.isFinite(bodyLimit) && bodyLimit >= 0 ? bodyLimit : Infinity;
      log({
        ...common,
        responseBodyPreview: full.slice(0, 200),
        responseBody: full.length > cap ? full.slice(0, cap) : full,
        responseBodyBytes: utf8Bytes(full),
        responseBodyTruncated: full.length > cap,
        responseBodyInspectable: true,
        responseBodyKind: 'text',
      });
    }).catch((error) => {
      log({
        ...common,
        responseBody: '', responseBodyPreview: '', responseBodyBytes: 0,
        responseBodyTruncated: false, responseBodyInspectable: false,
        responseBodyKind: 'read-error', responseBodyError: String(error?.message || error),
      });
    });
  };

  const addRule = (kind, pattern, extra) => {
    const rule = {
      id: ++ruleSeq,
      kind,
      pattern,
      match: matcherOf(pattern),
      times: Number.isFinite(extra && extra.times) ? Number(extra.times) : Infinity,
      ...extra,
    };
    rules.push(rule);
    return rule;
  };

  // 起手的外域放行清单（宿主装载时把 LLM 上游端点喂进来）。
  for (const pattern of Array.isArray(initialAllow) ? initialAllow : [initialAllow]) {
    if (pattern != null && pattern !== '') addRule('allow', pattern, {});
  }

  /** 取第一条命中且没用尽次数的规则；命中即扣次（用尽的规则留在表里但不再生效，方便看历史）。 */
  const pick = (kind, url, req) => {
    for (const rule of rules) {
      if (rule.kind !== kind || rule.times <= 0) continue;
      if (rule.match(url, req)) return rule;
    }
    return null;
  };

  const consume = (rule) => { if (rule && Number.isFinite(rule.times)) rule.times -= 1; };

  /** 多条延迟规则同时命中时取最慢的那条，不累加——每条说的是"至少慢 x"，不是"一共慢 x"。 */
  const delayRuleFor = (url, req) => {
    let best = null;
    for (const rule of rules) {
      if (rule.kind !== 'delay' || rule.times <= 0) continue;
      if (rule.match(url, req) && (!best || rule.ms > best.ms)) best = rule;
    }
    return best;
  };

  /**
   * 请求描述符 → 一条日志记录的公共字段。
   * @param {object} req `{url, method, headers, body}`
   * @param {{text:string,inspectable:boolean,kind:string}} [bodyInfo] 已经取好的载体（Request 载体
   *   要 await clone().text() 才拿得到，取不到就由调用方传一份 `inspectable:false` 的标注进来）。
   */
  const describe = (req, bodyInfo) => {
    const info = bodyInfo || inspectBody(req && req.body);
    const full = scrubSecrets(info.text);
    const cap = Number.isFinite(bodyLimit) && bodyLimit >= 0 ? bodyLimit : Infinity;
    return {
      url: String((req && req.url) || ''),
      method: String((req && req.method) || 'GET').toUpperCase(),
      headers: scrubHeaders(req && req.headers),
      bodyPreview: full.slice(0, 200),
      body: full.length > cap ? full.slice(0, cap) : full,
      // **UTF-8 字节数**（不是 UTF-16 码元数）：中文载体按 length 算只有真实出网体积的三分之一。
      bodyBytes: utf8Bytes(full),
      bodyTruncated: full.length > cap,
      // 载体到底看没看成（V3 P1-F M3）。false = FormData/Blob/流这类看不进去的载体 —— 此时
      // `body` 是空串，**任何「载体里没有 X」的断言都不成立**，断言方必须据此报错而不是静默通过。
      bodyInspectable: info.inspectable !== false,
      bodyKind: String(info.kind || 'none'),
    };
  };

  /**
   * 直接喂给 glue 的 setInkRequestInterceptor / configureNetwork({interceptor})。
   * 只产出引擎认识的三种动作（continue / block / rewrite），状态码注入不在这一层——
   * 引擎的 An 没有 fulfill 分支，这里返回一个"响应"只会被当成 rewrite 的畸形对象。
   */
  const interceptor = async (req) => {
    const info = describe(req);
    const { url } = info;

    if (!isOnlineFlag) {
      log({ layer: 'interceptor', ...info, decision: 'block', reason: OFFLINE_REASON });
      return { action: 'block', reason: OFFLINE_REASON };
    }

    const blocked = pick('block', url, req);
    if (blocked) {
      consume(blocked);
      const reason = blocked.reason || `InkLab: 已按规则断开 ${url}`;
      log({ layer: 'interceptor', ...info, decision: 'block', reason, ruleId: blocked.id });
      return { action: 'block', reason };
    }

    const delayRule = delayRuleFor(url, req);
    const delayedMs = delayRule ? delayRule.ms : 0;
    if (delayedMs > 0) {
      consume(delayRule);
      await sleep(delayedMs);
    }

    const rewrite = pick('rewrite', url, req);
    if (rewrite) {
      consume(rewrite);
      const to = typeof rewrite.to === 'function' ? String(rewrite.to(req)) : String(rewrite.to);
      log({ layer: 'interceptor', ...info, decision: 'rewrite', delayedMs, to, ruleId: rewrite.id });
      return {
        action: 'rewrite', url: to, method: req.method, headers: req.headers, body: req.body,
      };
    }

    log({ layer: 'interceptor', ...info, decision: 'continue', delayedMs });
    return { action: 'continue' };
  };

  /**
   * 包一层 fetch，装到 globalThis.fetch 上（glue `Pt` 取的就是它）。
   * 分工：断网/延迟归拦截器（引擎实证支持），状态码归这一层（拦截器造不出响应）。
   * block 在两层都判：两层都装时拦截器先抛、根本走不到这里，所以不会双重施加；
   * 只装这一层（比如无拦截器的裸调试）时断网依然有效。**延迟只在拦截器做**，否则会加两遍。
   */
  const wrapFetch = (baseFetch) => {
    const base = typeof baseFetch === 'function' ? baseFetch : globalThis.fetch;
    if (typeof base !== 'function') throw new TypeError('wrapFetch: 需要一个可用的 fetch 实现');
    return async (input, init = {}) => {
      const url = typeof input === 'string' ? String(input) : String((input && input.url) || input);
      const req = { url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body };
      // **载体也可能挂在 Request 上**（`fetch(new Request(url, {method:'POST', body}))`，V3 P1-F M3）：
      // 旧实现只取 init.body，这类请求的 body 恒空 → 「外发载体里没有 dataUrl」恒真，
      // 隐私断言从「检视过、干净」退化成「压根没检视成」。这里从 input 上补取（**clone 之后再读**，
      // 绝不消耗调用方那一份 body），读不到就如实记 bodyInspectable:false。
      let bodyInfo = null;
      if (req.body == null && isRequestLike(input)) {
        bodyInfo = await readRequestBody(input);
        if (!req.method || String(req.method).toUpperCase() === 'GET') {
          req.method = String(input.method || 'GET');
        }
        if (!init || init.headers == null) req.headers = headersToObject(input.headers);
      }
      const info = describe(req, bodyInfo);

      if (!isOnlineFlag) {
        log({ layer: 'fetch', ...info, decision: 'block', reason: OFFLINE_REASON });
        throw new Error(OFFLINE_REASON);
      }
      const blocked = pick('block', url, req);
      if (blocked) {
        consume(blocked);
        const reason = blocked.reason || `InkLab: 已按规则断开 ${url}`;
        log({ layer: 'fetch', ...info, decision: 'block', reason, ruleId: blocked.id });
        throw new Error(reason);
      }
      const stub = pick('status', url, req);
      if (stub) {
        consume(stub);
        log({ layer: 'fetch', ...info, decision: 'status', status: stub.status, ruleId: stub.id });
        const response = makeResponse({
          status: stub.status, statusText: stub.statusText, headers: stub.headers, body: stub.body,
        });
        observeResponse(response, info, 'status');
        return response;
      }
      // 外域默认桩（最后一道，在**显式规则之后**：场景显式桩的 /api/trips 照常走上面那一支）。
      if (guardOn && isExternalUrl(url, origin)) {
        const allowed = pick('allow', url, req);
        if (allowed) {
          consume(allowed);
        } else {
          log({
            layer: 'fetch', ...info, decision: 'external-stub',
            status: EXTERNAL_STUB_STATUS, reason: EXTERNAL_STUB_REASON,
          });
          const response = makeResponse({
            status: EXTERNAL_STUB_STATUS,
            statusText: 'Service Unavailable',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: EXTERNAL_STUB_REASON, url }),
          });
          observeResponse(response, info, 'external-stub');
          return response;
        }
      }
      log({ layer: 'fetch', ...info, decision: 'pass' });
      try {
        const response = await base(input, init);
        observeResponse(response, info, 'pass');
        return response;
      } catch (error) {
        log({
          layer: 'response', url: info.url, method: info.method, decision: 'error', status: 0,
          responseBodyInspectable: false, responseBodyKind: 'fetch-error',
          responseBodyError: String(error?.message || error),
        });
        throw error;
      }
    };
  };

  const setConnectivity = (next) => {
    isOnlineFlag = Boolean(next);
    if (boundView && typeof boundView.dispatchConnectivityEvent === 'function') {
      boundView.dispatchConnectivityEvent(isOnlineFlag ? 'online' : 'offline');
    }
    return control;
  };

  const control = {
    interceptor,
    wrapFetch,

    /** 一行断网：翻标志位 + 同步派发连通性事件（应用的 probeNetwork 会因为 block 抛错而判离线）。 */
    offline: () => setConnectivity(false),
    online: () => setConnectivity(true),
    isOnline: () => isOnlineFlag,

    /** 把 InkView 挂上，之后 offline()/online() 才会同时通知引擎。 */
    attachView(v) { boundView = v || null; return control; },

    /**
     * 手动派发连通性事件。校验口径对齐 glue `$r`：只认小写 'online'|'offline'，
     * 别的在引擎里是 TypeError——与其让错误从 wasm 里冒出来，不如在这儿就说人话。
     */
    dispatchConnectivity(status) {
      if (typeof status !== 'string') throw new TypeError('dispatchConnectivity: status 必须是字符串');
      const s = status.trim().toLowerCase();
      if (s !== 'online' && s !== 'offline') {
        throw new TypeError("dispatchConnectivity: status 只能是 'online' 或 'offline'（引擎 $r 的口径）");
      }
      if (!boundView || typeof boundView.dispatchConnectivityEvent !== 'function') {
        throw new TypeError('dispatchConnectivity: 还没 attachView(view)');
      }
      boundView.dispatchConnectivityEvent(s);
      return control;
    },

    /** 按 URL 模式断（引擎侧表现为 fetch 抛错，和真机断网同形）。 */
    block(pattern, { reason, times } = {}) { addRule('block', pattern, { reason, times }); return control; },
    /** 按 URL 模式延迟（靠拦截器被 await 这一条实证特性实现）。 */
    delay(pattern, ms, { times } = {}) { addRule('delay', pattern, { ms: Math.max(0, Number(ms) || 0), times }); return control; },
    /** 按 URL 模式返回指定状态码（只在 wrapFetch 层生效）。 */
    status(pattern, status, { body = '', headers = {}, statusText = '', times } = {}) {
      addRule('status', pattern, { status: Number(status), body, headers, statusText, times });
      return control;
    },
    /** 按 URL 模式改写（createProxyUrlResolver 的通用版；引擎实证支持 rewrite 动作）。 */
    rewrite(pattern, to, { times } = {}) { addRule('rewrite', pattern, { to, times }); return control; },

    /**
     * **显式放行一条外域**（只对 guardExternal 那道闸生效；断网/block 规则照样优先）。
     * 用它的场合是「这次就是要打真实上游」——LLM live/record 的端点、或手动排障时想看真后端。
     */
    allowExternal(pattern, { times } = {}) { addRule('allow', pattern, { times }); return control; },
    /** 外域默认桩的开关（手动排障时可临时关掉；场景里请优先用 allowExternal 点名放行）。 */
    guardExternal(on = true) { guardOn = Boolean(on); return control; },
    isExternalGuarded: () => guardOn,
    /** 这条 URL 现在会不会被外域闸挡下（排查「为什么我的请求回了 503」用）。 */
    wouldStubExternal: (url) => Boolean(guardOn && isExternalUrl(url, origin) && !pick('allow', String(url), null)),

    /** 当前规则表（只读快照，排查"为什么这条请求没被断"时用）。 */
    rules: () => rules.map((r) => ({ id: r.id, kind: r.kind, pattern: String(r.pattern), times: r.times })),
    /** 清空规则表。**放行清单也在这张表里**——清完之后外域闸会重新挡住原先放行的域名（含宿主自动放行的 LLM 端点）。 */
    clearRules() { rules.length = 0; return control; },

    /** 请求日志：拦截器层记"引擎想发什么"，fetch 层记"实际出去了什么"，两层各一条。 */
    requests,
    requestsOf: (layer) => requests.filter((r) => r.layer === layer),
    clearLog() {
      requests.length = 0;
      sizes.length = 0;
      loggedBytes = 0;
      droppedEntries = 0;
      return control;
    },
    /**
     * 日志记账（V3 P1-F M4）。`truncatedLog` 为真 = 有旧条目因为条数/体积闸被丢掉了，
     * **这本账不完整**——「全程零真实外呼」这类穷举式断言看到它必须失败而不是照常通过。
     */
    logStats: () => ({
      entries: requests.length,
      bytes: loggedBytes,
      dropped: droppedEntries,
      truncatedLog: droppedEntries > 0,
      limits: { entries: logLimit, bytes: bytesCap },
    }),
    toJSON: () => JSON.stringify(requests, null, 2),

    /**
     * 挂到 glue 上。优先用 configureNetwork（glue `Pr`：{interceptor} 直接转 setInkRequestInterceptor），
     * 退化到 setInkRequestInterceptor。返回卸载函数。
     */
    install(bindings) {
      const b = bindings || {};
      if (typeof b.configureNetwork === 'function') b.configureNetwork({ interceptor });
      else if (typeof b.setInkRequestInterceptor === 'function') b.setInkRequestInterceptor(interceptor);
      else throw new TypeError('install: 需要 glue 的 configureNetwork 或 setInkRequestInterceptor');
      return () => {
        if (typeof b.clearInkRequestInterceptor === 'function') b.clearInkRequestInterceptor();
        else if (typeof b.configureNetwork === 'function') b.configureNetwork({ clear: true });
      };
    },
  };

  return control;
}
