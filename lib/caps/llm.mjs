// llm.mjs — languageModel / openService 能力 + LLM 请求的转发 / 录制 / 回放 / 故障注入。
//
// 关键事实：**宿主不发 LLM 请求，引擎自己发。** 宿主只回答"打到哪、带什么头、默认哪个模型"，
// 之后 POST、SSE 解析、tool_call 拼装全在 wasm 里。所以录制/回放挂不到 getConfig 上，
// 只能挂到请求路径上（见下方第 6 条与 net.mjs 的注释 3/5）。
//
// ── 已证实（glue `Zr`/`sn`/`Hi` + engine.wasm 字符串表） ──────────────────
// 1. languageModel.getConfig() 的返回值形状被 glue `Zr` 强校验，字段就是 6 个：
//      { endpoint: 必填非空字符串,
//        apiStyle: 必填非空字符串,
//        defaultModel: string | null,
//        headers: 普通对象（`sn` 会把每个值 String() 化）,
//        shareVendorHeaders: boolean,
//        vendorHeadersService: string | null }
//    wasm 里 `struct LanguageModelConfig with 6 elements` + 同名字段串一致印证。
//    → 任务书里写的 `{baseUrl, apiKey, model, headers}` **不是**引擎认的形状：
//      baseUrl → endpoint（且必须是完整的 chat-completions URL，见第 3 条），
//      apiKey  → 引擎没有这个字段，只能塞进 headers.Authorization，
//      model   → defaultModel。
//    本模块的 opts 保留 baseUrl/apiKey/model 这套顺手写法，落地时映射到引擎认的 6 字段。
// 2. apiStyle 实测唯一取值 'openai-chat-completions'（wasm 字符串表；配套错误串
//    "Unsupported language model apiStyle: "）。
// 3. 同一段 wasm 字符串区里紧挨着 model / stream / tools、"Content-Type" "application/json"、
//    以及 SSE 词汇 [DONE] / choices / delta / content / tool_calls / finish_reason
//    → 引擎发的是标准 OpenAI 兼容 chat-completions。整个 wasm 里**没有** "chat/completions"
//    这个字面量，说明引擎不会给 endpoint 拼路径：endpoint 必须写全。
// 4. defaultModel 的语义有原文："LanguageModel.create: `model` is required when host
//    `defaultModel` is unavailable" —— 应用不传 model 时就吃宿主给的这个默认值。
// 5. openService.getVendorHeaders **缺席**时 glue 写死兜底成 `{}`（`Hi` 里）：
//      if (ns === 'openService' && m === 'getVendorHeaders' && handler == null) { 解析请求JSON; return 编码({}) }
//    注意它仍然会先解析请求 JSON（非法 JSON 照样抛）。本模块装了这个方法，因此必须自己维持
//    同样的语义：没配置就返回 `{}`，永远不返回 null/undefined。
// 6. 引擎的出站请求全部走 `__inkFetch` → `globalThis.fetch`（glue `Gt`/`Pt`），
//    而请求拦截器没有 fulfill 动作（glue `An`）。→ 录制/回放/故障注入只能在 fetch 层做，
//    本模块导出的 `fetch` 就是给 globalThis.fetch 或 net.mjs 的 wrapFetch 串联用的。
// 7. 请求参数字段名（wasm serde 名表）：GetManifest{service}、GetConfig{env}。
//
// ── 推断（未实证，改动时按这里的假设复查） ────────────────────────────────
// - GetConfig.env 的取值集合没观测到（wasm 里没有 production/staging 之类字面量），
//   所以按 opts.profiles[env] 取档，取不到就用默认档。
// - getManifest 的返回值 glue 不校验（`ci` 原样透传给 wasm），真实形状要等探针录到样本；
//   这里默认给 `{}`，是"能力在、内容空"，不是"能力缺席"。
// - vendorHeadersService 与 getVendorHeaders(service) 的串联关系（配置里点名一个服务、
//   引擎再拿这个名字回头问宿主要头）来自字段命名，尚未在真机上观测到调用序列。

import { composeCapabilities } from './contract.mjs';
import { bodyToText, makeResponse, matcherOf, scrubSecrets } from './net.mjs';

/** 引擎唯一支持的 apiStyle。 */
export const OPENAI_CHAT_COMPLETIONS = 'openai-chat-completions';

/** 密钥只从环境变量注入。硬编码 / 写进仓库 = 事故，不是便利。 */
export const API_KEY_ENV = 'INKLAB_LLM_API_KEY';
export const ENDPOINT_ENV = 'INKLAB_LLM_ENDPOINT';
export const MODEL_ENV = 'INKLAB_LLM_MODEL';

/** E2E 整页隔离时从 URL 恢复 replay 专用的录像 model；live/record 绝不接受假 model。 */
export function replayModelFromSearch(search = '', mode = 'off') {
  if (String(mode) !== 'replay') return '';
  return String(new URLSearchParams(String(search)).get('llm-model') || '').trim();
}

/**
 * replay 模式默认给引擎的 endpoint。`.invalid` 是 RFC 2606 保留 TLD，永远解析不出去：
 * 万一 fetch 没接上，表现是响亮的 DNS 失败，而不是偷偷打到线上把真钱花掉。
 */
export const REPLAY_ENDPOINT = 'http://replay.inklab.invalid/v1/chat/completions';

export const CASSETTE_VERSION = 1;

/**
 * 宿主装载时算「外域出网闸的放行清单」（承重）。
 *
 * 修的是什么：链路是 `globalThis.fetch = net.wrapFetch(llm.fetch)` —— **外域闸在外侧、
 * 录像回放在内侧**。而 replay 的端点恒是外域（没配 endpoint 时兜底成 REPLAY_ENDPOINT，
 * 那是个 `.invalid` 域），旧实现又只在 `mode !== 'replay'` 时放行端点，于是引擎的每一次
 * LLM 请求都在外层被判外域、直接回 503，**根本走不到 llm.fetch**：录像形同虚设，
 * 应用测出来的全是「模型不可用」的降级路径，而不是被测的那条真路径。
 *
 * 为什么放行是安全的：放行只解除**外层那道闸**，请求随即落到内侧的 `llm.fetch`；
 * replay 模式下它照录像作答（未命中就抛 replay-miss），**一个字节都不出网**。
 *
 * @param {{mode?:string, endpoint?:string}|null} llmOpts 已解析的 LLM 配置（null/off → 空清单）
 * @returns {string[]} 放行模式清单（matcherOf 的子串写法）
 */
export function llmAllowExternal(llmOpts) {
  const opts = llmOpts && typeof llmOpts === 'object' ? llmOpts : null;
  const mode = opts ? String(opts.mode || '') : 'off';
  if (!opts || mode === 'off') return [];
  const list = [];
  if (opts.endpoint) list.push(String(opts.endpoint));
  // replay 没配 endpoint 时引擎拿到的是 REPLAY_ENDPOINT（见 resolveEndpoint）——它同样要放行，
  // 否则默认录像回放（e2e 的常规姿势）全程 503。
  if (mode === 'replay' && !list.includes(REPLAY_ENDPOINT)) list.push(REPLAY_ENDPOINT);
  return list;
}

// ── 请求体归一化 ────────────────────────────────────────────────────────
//
// 为什么必须归一：prompt 里天然带**每次都不一样**的东西——fact-pack 里的"当前时间"、
// 会话 id、组内计时、随机 requestId。整体哈希请求体的话，录制那一刻的时间戳被焊进键里，
// 回放时永远差那么几毫秒，命中率恒为 0，录像等于白录。
//
// 归一只做两件事，且**只影响 cassette 的键**，真正发给上游的请求体一个字节都不改：
//   1. 只保留决定回答内容的字段（model / stream / messages 的 role+文本 / tools 的名字与入参 schema）；
//   2. 把公认的易变片段替换成占位符（时间戳、日期、时刻、uuid、长数字 id、长十六进制 id、图片 data URI）。
// stream **保留在键里**：流式与非流式的响应线格式不同（SSE vs 单个 JSON），
// 用非流式录像喂流式请求会让引擎解析出垃圾——宁可报"未命中"，也不要喂错格式。

const VOLATILE_PATTERNS = Object.freeze([
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  [/\d{4}-\d{2}-\d{2}/g, '<DATE>'],
  [/\d{4}年\d{1,2}月\d{1,2}日/g, '<DATE>'],
  [/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<TIME>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\b\d{10,19}\b/g, '<EPOCH>'], // 秒/毫秒/微秒时间戳与雪花 id 都落在这个宽度
  [/\b[0-9a-f]{16,}\b/gi, '<HEX>'],
]);

/** 抹掉易变片段。顺序要紧：ISO 先于日期先于时刻，uuid 先于长十六进制。 */
export function scrubVolatile(text) {
  let out = String(text == null ? '' : text);
  for (const [re, token] of VOLATILE_PATTERNS) out = out.replace(re, token);
  return out;
}

/** 多模态内容拍平成文本。图片只留长度：data URI 几十 KB，进不了键也没必要进。 */
function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text') return String(part.text || '');
      const url = (part.image_url && part.image_url.url) || part.url || part.image;
      if (url) return `<IMG:${String(url).length}>`;
      return JSON.stringify(part);
    }).join('\n');
  }
  return JSON.stringify(content);
}

/** 工具定义按名字排序：同一组工具换个顺序注册不该算另一个请求。 */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const fn = (tool && tool.function) || tool || {};
    // record 保存的是 canonical：parameters 已经是 stableStringify 后的字符串。
    // 再校验/导入录像时不能把这层字符串二次 JSON 编码，否则同一工具请求会算出另一个键。
    const parameters = typeof fn.parameters === 'string'
      ? fn.parameters
      : stableStringify(fn.parameters || {});
    return {
      name: String(fn.name || ''),
      parameters,
    };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 键必须与对象字面量的书写顺序无关，否则同一个请求换个拼装顺序就成了新键。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const preview = (text) => scrubSecrets(String(text == null ? '' : text)).replace(/\s+/g, ' ').trim().slice(0, 48);

/**
 * 请求体 → { canonical, label }。canonical 进哈希，label 只用于把错误说清楚。
 * 解不出 JSON 时退化成"整段文本去易变片段"，仍然比整体哈希稳。
 */
export function normalizeRequestBody(body) {
  const text = bodyToText(body);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { canonical: { raw: scrubVolatile(text) }, label: preview(text) };
  }
  const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map((m) => ({
    role: String((m && m.role) || ''),
    content: scrubVolatile(flattenContent(m && m.content)),
  }));
  const canonical = {
    model: String(parsed.model || ''),
    stream: Boolean(parsed.stream),
    messages,
    tools: normalizeTools(parsed.tools),
  };
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const label = preview(lastUser ? lastUser.content : (messages.length ? messages[0].content : text));
  return { canonical, label };
}

/**
 * 16 位十六进制哈希。故意不用 node:crypto——这个模块要能被宿主页面直接 import，
 * 浏览器里没有 node:crypto，而 WebCrypto 的 digest 是异步的，键计算不该被迫异步化。
 * FNV-1a 双通道，碰撞概率在"一盘录像几百条"的量级下无关紧要。
 */
export function hash16(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 录像键：归一化 → 稳定序列化 → 哈希。 */
export function cassetteKey(body) {
  return hash16(stableStringify(normalizeRequestBody(body).canonical));
}

// ── 能力 + 请求路径 ─────────────────────────────────────────────────────

const asStringMap = (obj) => {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) out[String(k)] = String(v);
  return out;
};

/**
 * @param {object} [opts]
 * @param {'live'|'record'|'replay'} [opts.mode]
 * @param {string} [opts.endpoint] 完整的 chat-completions URL（引擎不会替你拼路径）
 * @param {string} [opts.apiKey] 缺省从 env[opts.apiKeyEnv] 读；**绝不硬编码**
 * @param {object} [opts.env] 环境变量来源（Node 传 process.env，浏览器传注入对象）
 * @param {string} [opts.model] → defaultModel
 * @param {object} [opts.headers] 额外请求头（会与 Authorization 合并）
 * @param {object} [opts.profiles] GetConfig 请求里 env 字段 → 配置覆盖档
 * @param {object} [opts.vendorHeaders] service 名 → 头；也可直接给一张扁平头表
 * @param {object} [opts.manifest] service 名 → manifest；也可直接给一份 manifest
 * @param {Array} [opts.cassette] 预载录像（replay 用）
 * @param {Function} [opts.fetch] 上游 fetch（live/record 转发用）
 * @param {string|RegExp|Function} [opts.match] 哪些请求算 LLM 请求；其余原样透传
 */
export function createLanguageModelCapabilities({
  mode = 'live',
  endpoint,
  apiKey,
  env = {},
  model,
  apiStyle = OPENAI_CHAT_COMPLETIONS,
  headers = {},
  shareVendorHeaders = false,
  vendorHeadersService = null,
  vendorHeaders = null,
  manifest = null,
  profiles = {},
  cassette = [],
  fetch: upstreamFetch,
  match = '/chat/completions',
  apiKeyEnv = API_KEY_ENV,
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
} = {}) {
  if (!['live', 'record', 'replay'].includes(mode)) {
    throw new TypeError(`createLanguageModelCapabilities: mode 只能是 live/record/replay，收到 ${mode}`);
  }

  const readEnv = (name) => {
    const source = env && typeof env === 'object' ? env : {};
    const v = source[name];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };

  const isLlmRequest = matcherOf(match);
  const calls = [];       // 能力方法调用流水（getConfig / getManifest / getVendorHeaders）
  const recordings = [];  // 录像条目
  const faults = [];      // 待生效的故障注入（先进先出）
  const exchanges = [];   // 每次 LLM 请求的结局，排查用

  for (const entry of Array.isArray(cassette) ? cassette : []) {
    if (entry && typeof entry.key === 'string') recordings.push(entry);
  }

  const resolveEndpoint = (profile) => String(profile.endpoint || endpoint || readEnv(ENDPOINT_ENV)
    || (mode === 'replay' ? REPLAY_ENDPOINT : '')).trim();
  const resolveKey = (profile) => String(profile.apiKey || apiKey || readEnv(apiKeyEnv) || '').trim();
  const resolveModel = (profile) => String(profile.model || model || readEnv(MODEL_ENV) || '').trim();

  // ── 能力方法 ──

  /** 引擎向宿主要模型配置。返回值形状必须过 glue `Zr`，见文件头第 1 条。 */
  async function getConfig(args) {
    const envName = args && typeof args === 'object' ? String(args.env || '') : '';
    const profile = (profiles && profiles[envName]) || {};
    calls.push({ method: 'getConfig', env: envName, args, at: now() });

    const url = resolveEndpoint(profile);
    if (!url) {
      throw new Error(
        `languageModel.getConfig: 没有 endpoint。给 opts.endpoint，或设环境变量 ${ENDPOINT_ENV}（要写完整的 chat-completions URL，引擎不拼路径）`,
      );
    }
    const key = resolveKey(profile);
    // replay 不出网，自然不需要 key；live/record 缺 key 时**在这儿就报错**：
    // 让引擎带着空 Authorization 打出去，换回来的是 401，排查时会误判成"模型配置错了"。
    if (mode !== 'replay' && !key) {
      throw new Error(
        `languageModel.getConfig: mode='${mode}' 需要 API key，但环境变量 ${apiKeyEnv} 是空的。`
        + '（密钥只从环境变量注入，不要写进仓库或 opts 字面量）',
      );
    }

    return {
      endpoint: url,
      apiStyle: String(profile.apiStyle || apiStyle),
      defaultModel: resolveModel(profile) || null,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...asStringMap(headers),
        ...asStringMap(profile.headers),
      },
      shareVendorHeaders: Boolean(profile.shareVendorHeaders ?? shareVendorHeaders),
      vendorHeadersService: (profile.vendorHeadersService ?? vendorHeadersService) || null,
    };
  }

  // 两种写法都吃：按 service 分层的 { svc: {...} }，和单服务调试时直接给的一张扁平表。
  // 分层表遇到没登记的 service 要返回空，不能把别家的头漏给它。
  const lookupByService = (table, service) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
    if (service && Object.prototype.hasOwnProperty.call(table, service)) {
      const named = table[service];
      return named && typeof named === 'object' ? named : null;
    }
    const values = Object.values(table);
    const nested = values.length > 0 && values.every((v) => v && typeof v === 'object' && !Array.isArray(v));
    return nested ? null : table;
  };

  /** wasm serde 名表实证：GetManifest 请求带 service 字段。 */
  async function getManifest(args) {
    const service = args && typeof args === 'object' ? String(args.service || '') : '';
    calls.push({ method: 'getManifest', service, args, at: now() });
    return lookupByService(manifest, service) || {};
  }

  /**
   * glue 在这个方法缺席时会兜底成 `{}`。我们装上了这个方法，就得自己维持同一语义：
   * 没配置 → `{}`，而不是 null/undefined。（返回值还会过 `sn`：必须普通对象，值被 String 化。）
   */
  async function getVendorHeaders(args) {
    const service = args && typeof args === 'object' ? String(args.service || '') : '';
    calls.push({ method: 'getVendorHeaders', service, args, at: now() });
    return asStringMap(lookupByService(vendorHeaders, service));
  }

  const capabilities = composeCapabilities({
    languageModel: { getConfig },
    openService: { getManifest, getVendorHeaders },
  });

  // ── 请求路径：故障注入 → replay / record / live ──

  const takeFault = (url, req) => {
    const idx = faults.findIndex((f) => !f.match || f.match(url, req));
    if (idx < 0) return null;
    return faults.splice(idx, 1)[0];
  };

  const applyFault = async (fault, url) => {
    if (fault.kind === 'timeout') {
      const after = Number(fault.afterMs);
      // 不给 afterMs 就永不落定：真机上的"超时"就是这个样子——请求没回音，
      // 先落定的是应用自己那把超时闸（例如 8s）。
      if (!Number.isFinite(after) || after <= 0) return new Promise(() => {});
      return new Promise((_resolve, reject) => {
        setT(() => reject(new Error(`InkLab 注入超时（timeout ${after}ms）：${url}`)), after);
      });
    }
    if (fault.kind === 'http') {
      return makeResponse({
        status: Number.isFinite(Number(fault.status)) ? Number(fault.status) : 503,
        statusText: fault.statusText || '',
        headers: fault.headers || { 'content-type': 'application/json' },
        body: fault.body == null ? '{"error":{"message":"InkLab 注入的上游错误"}}' : fault.body,
      });
    }
    if (fault.kind === 'malformed') {
      // 200 但体是坏的：引擎会在解析阶段炸，走的是与 HTTP 错误不同的一条降级路径。
      return makeResponse({
        status: 200,
        headers: fault.headers || { 'content-type': 'application/json' },
        body: fault.body == null ? '{"choices":[{"delta":' : fault.body,
      });
    }
    throw new TypeError(`failNext: 不认识的 kind='${fault.kind}'（只有 timeout / http / malformed）`);
  };

  // 同一确定性场景可能因宿主墙钟节流落到两个已观察到、语义等价的时间桶。录像可显式
  // 声明 aliases 复用同一响应；不做模糊相似匹配，未列出的请求仍响亮 replay-miss。
  const findRecording = (key) => recordings.find((r) => (
    r.key === key || (Array.isArray(r.aliases) && r.aliases.includes(key))
  )) || null;

  const replayMissError = (key, label, canonical) => {
    const known = recordings.slice(0, 8)
      .map((r) => `  ${r.key}  「${r.label || ''}」`)
      .join('\n');
    return new Error(
      `InkLab replay 未命中：录像里没有这次请求。\n`
      + `  计算出的键: ${key}\n`
      + `  model=${canonical.model || '?'} stream=${canonical.stream} messages=${(canonical.messages || []).length}\n`
      + `  最后一句 user: 「${label}」\n`
      + (recordings.length ? `  录像里现有 ${recordings.length} 条：\n${known}\n` : '  录像是空的。\n')
      + '  键已经对时间戳/uuid/长数字 id 做过归一，还不中说明 prompt 结构、model 或 stream 变了。\n'
      + "  补录：用 mode:'record' 跑一遍同样的场景。",
    );
  };

  /**
   * 装到 globalThis.fetch（引擎的 __inkFetch 取的就是它），或串进 net.mjs 的 wrapFetch。
   * 非 LLM 请求原样透传——换掉全局 fetch 之后，bundle 加载、图标、探针 HEAD 都会经过这里，
   * 把它们也录进 cassette 只会把录像撑爆且永远命中不了。
   */
  async function handle(input, init = {}) {
    const url = typeof input === 'string' ? String(input) : String((input && input.url) || input);
    const req = { url, method: String((init && init.method) || 'GET').toUpperCase(), headers: init && init.headers, body: init && init.body };

    if (!isLlmRequest(url, req)) {
      if (typeof upstreamFetch !== 'function') throw new TypeError(`InkLab llm.fetch: 没有上游 fetch，无法透传 ${url}`);
      return upstreamFetch(input, init);
    }

    const { canonical, label } = normalizeRequestBody(req.body);
    const key = hash16(stableStringify(canonical));

    const fault = takeFault(url, req);
    if (fault) {
      exchanges.push({ at: now(), key, label, outcome: `fault:${fault.kind}` });
      return applyFault(fault, url);
    }

    if (mode === 'replay') {
      const hit = findRecording(key);
      if (!hit) {
        exchanges.push({ at: now(), key, label, outcome: 'replay-miss' });
        throw replayMissError(key, label, canonical);
      }
      exchanges.push({ at: now(), key, label, outcome: 'replay-hit' });
      return makeResponse({
        status: hit.status || 200, headers: hit.headers || {}, body: hit.body == null ? '' : hit.body,
      });
    }

    if (typeof upstreamFetch !== 'function') {
      throw new TypeError(`InkLab llm.fetch: mode='${mode}' 需要上游 fetch（opts.fetch），否则请求无处可去`);
    }
    // 注意：转发出去的是**原始 init**，归一化只用于算键。改请求体等于改被调试对象的行为。
    const res = await upstreamFetch(input, init);
    if (mode !== 'record') {
      exchanges.push({ at: now(), key, label, outcome: `live:${res && res.status}` });
      return res;
    }

    // record：整段读完再重造一个响应交给引擎。代价说清楚——流式的到达时序在 record 下会丢失
    // （所有 chunk 一次到齐）。要看真实流式时序请用 mode:'live'。
    const text = await res.text();
    const stored = {
      key,
      label,
      at: now(),
      status: res.status,
      headers: { 'content-type': (res.headers && res.headers.get && res.headers.get('content-type')) || 'application/json' },
      body: text,
      // 只存归一化后的请求，不存原始请求头/请求体：原始头里有 Authorization，
      // 录像是要进仓库或者贴进 issue 的，密钥不能跟着走。
      request: canonical,
    };
    const existing = recordings.findIndex((r) => r.key === key);
    if (existing >= 0) recordings[existing] = stored; else recordings.push(stored);
    exchanges.push({ at: now(), key, label, outcome: `record:${res.status}` });
    return makeResponse({ status: stored.status, headers: stored.headers, body: text });
  }

  return {
    capabilities,
    mode,

    /** 能力方法调用流水（引擎问了什么、什么时候问的）。 */
    calls,
    /** 每次 LLM 请求的结局：replay-hit / replay-miss / fault:* / record:200 …… */
    exchanges,
    /** 录像条目（record 写入，replay 读取）。 */
    recordings,

    /**
     * 一次性故障注入，按入队顺序生效，用完自动回到正常模式。
     * @param {{kind:'timeout'|'http'|'malformed', afterMs?:number, status?:number, body?:string,
     *          headers?:object, when?:string|RegExp|Function}} spec
     */
    failNext(spec) {
      if (spec == null) { faults.length = 0; return null; }
      const kind = spec && spec.kind;
      if (!['timeout', 'http', 'malformed'].includes(kind)) {
        throw new TypeError(`failNext: kind 只能是 timeout / http / malformed，收到 ${kind}`);
      }
      const fault = { ...spec, kind, match: spec.when == null ? null : matcherOf(spec.when) };
      faults.push(fault);
      return fault;
    },
    pendingFaults: () => faults.length,

    /** 引擎的出站请求入口（装到 globalThis.fetch 或串进 net.wrapFetch）。 */
    fetch: handle,

    /** 给定请求体算出录像键（排查"为什么没命中"时手动比对用）。 */
    keyFor: cassetteKey,

    /** 导出录像（可直接 JSON.stringify 落盘）。里面不含任何请求头，因此不含密钥。 */
    exportCassette: () => ({ version: CASSETTE_VERSION, apiStyle, entries: recordings.slice() }),
    toJSON() { return JSON.stringify(this.exportCassette(), null, 2); },

    /** 载入录像（接受 exportCassette() 的产物、数组、或它们的 JSON 文本）。 */
    loadCassette(input) {
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      const entries = Array.isArray(parsed) ? parsed : (parsed && parsed.entries) || [];
      recordings.length = 0;
      for (const entry of entries) if (entry && typeof entry.key === 'string') recordings.push(entry);
      return recordings.length;
    },
  };
}
