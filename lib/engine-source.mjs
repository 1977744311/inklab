// engine-source.mjs — 从 Craft 前端产物里定位 Ink 引擎（glue + wasm）的纯逻辑层。
//
// 背景：Craft 把眼镜上的 Ink 容器（QuickJS 逻辑层 + Skia 视图层）整个编译成 wasm 搬进浏览器。
// 引擎并未发布到 npm，只作为 js.rokid.com 的站点资源存在，所以本地宿主必须从站点现取。
// 取回的二进制**不入库**（见 .gitignore），仓库里只存 engine.lock.json 的版本与哈希。
//
// 本文件零 IO：只做「给我文本，我告诉你下一步该抓什么」，便于 node --test 直接覆盖。

/** Craft 首页里主 bundle 的相对路径（形如 /assets/index-XXXX.js）。 */
export function extractMainBundlePath(html) {
  const m = /<script[^>]+src="(\/assets\/[^"]+\.js)"/i.exec(String(html || ''));
  return m ? m[1] : null;
}

/**
 * 主 bundle 里所有动态 import 的 chunk 名。引擎 glue 是其中之一；
 * 其余绝大多数是 mermaid / monaco 语言包，靠 rankGlueCandidates 排序后按序试。
 */
export function extractChunkNames(bundleJs) {
  const out = new Set();
  for (const m of String(bundleJs || '').matchAll(/import\("\.\/([A-Za-z0-9._-]+\.js)"\)/g)) {
    out.add(m[1]);
  }
  return [...out];
}

// 已知与引擎无关的 chunk 前缀（文档站自带的图表/编辑器/语言包），先排掉省下网络往返。
const NOISE = /^(.*(diagram|mermaid|editor\.main|github|katex|shiki)|nls\.messages|cose-bilkent|dagre|kanban-|mindmap-|timeline-)/i;

/** 把候选 chunk 按「像引擎 glue」的程度排序：vite 对无名入口产出的 index-*.js 最可疑。 */
export function rankGlueCandidates(names) {
  return [...names]
    .filter((n) => !NOISE.test(n))
    .sort((a, b) => {
      const score = (n) => (/^index-/.test(n) ? 0 : 1);
      return score(a) - score(b) || a.localeCompare(b);
    });
}

/** 一段 JS 是不是引擎 glue：必须同时具备 wasm 路径、初始化入口与 InkView 工厂。 */
export function looksLikeGlue(js) {
  const s = String(js || '');
  return /ink_web_bg[A-Za-z0-9._-]*\.wasm/.test(s)
    && s.includes('createInkView')
    && s.includes('initInk');
}

/** glue 里写死的 wasm 资源路径（相对站点根）。 */
export function extractWasmPath(glueJs) {
  const m = /["'](\/assets\/ink_web_bg[A-Za-z0-9._-]*\.wasm)["']/.exec(String(glueJs || ''));
  return m ? m[1] : null;
}

// 版本串在 wasm 数据段里紧挨着引擎自己的静态错误文案，靠锚点取比裸 semver 正则可靠得多：
// 整个 wasm 里有几十个第三方 crate 的版本号，裸正则必然误命中。
// 实测两处锚点各挂一样东西：
//   语义版本（0.17.0）      ← 紧挨 'Bundle file value must be a string or Uint8Array'
//   daily 构建戳（可能没有） ← 紧挨 'InkView is destroyed'
export const VERSION_ANCHOR = 'Bundle file value must be a string or Uint8Array';
export const BUILD_ANCHOR = 'InkView is destroyed';

/** 取紧贴在 anchor 之前的版本串；不存在或不紧邻都返回 null（宁缺勿错）。 */
function versionBefore(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/.exec(text.slice(Math.max(0, at - 64), at));
  return m ? m[1] : null;
}

/**
 * 引擎版本。Craft 同时挂着不止一个构建（实测 0.16.1 正式版与 0.17.0-daily 并存，
 * 由 satisfiesInkEngine 按工程声明的区间选用），所以版本必须逐构建解析。
 * @param {Uint8Array} wasmBytes 完整 wasm 或其尾部切片（两处锚点都靠近文件末尾）
 */
export function extractEngineVersion(wasmBytes) {
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes || []);
  const text = Buffer.from(bytes).toString('latin1');
  const version = versionBefore(text, VERSION_ANCHOR);
  const stamped = versionBefore(text, BUILD_ANCHOR);
  return {
    version: version ? version.split('-')[0] : (stamped ? stamped.split('-')[0] : null),
    // 只有带预发布后缀的才算构建戳；正式版这里本来就没有版本串。
    build: stamped && stamped.includes('-') ? stamped : null,
  };
}

/** 语义版本比较（只比 major.minor.patch；带预发布后缀的视为同版本的更新构建）。 */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '0.0.0').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [A, B] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  // 主版本相同时，带 daily 戳的是更新的构建。
  const stamp = (v) => Number((/-daily\.(\d+)/.exec(String(v || '')) || [])[1] || 0);
  return stamp(a) - stamp(b);
}

/** 在多个候选构建里挑最新的一个。candidates: [{version, build, ...}] */
export function pickNewestBuild(candidates) {
  const usable = (candidates || []).filter((c) => c && c.version);
  if (!usable.length) return null;
  return usable.reduce((best, c) => (compareVersions(c.build || c.version, best.build || best.version) > 0 ? c : best));
}

/**
 * 比对已取引擎与 lock。返回 { status, changes[] }：
 *   'match'    完全一致，可直接用
 *   'absent'   仓库里还没有 lock（首次取），调用方应写入
 *   'drift'    版本或哈希与 lock 不符——Craft 发过新版，需要人确认后再更新 lock
 */
export function compareLock(lock, actual) {
  if (!lock) return { status: 'absent', changes: [] };
  const changes = [];
  for (const key of ['engineVersion', 'engineBuild', 'gluePath', 'glueSha256', 'wasmPath', 'wasmSha256']) {
    const was = lock[key];
    const now = actual[key];
    if (was != null && now != null && was !== now) changes.push({ key, was, now });
  }
  return { status: changes.length ? 'drift' : 'match', changes };
}
