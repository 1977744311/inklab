// engine-discovery.mjs — 在站点（Craft、AIUI Studio）上找出 Ink 引擎构建（glue + wasm），供 `npm run engine` 使用。
//
// 引擎不发布到 npm，只作为站点资源存在：站点首页 → 主 bundle → 一批动态 import 的 chunk，
// 引擎 glue 是其中之一。站点同时挂着不止一个构建（正式版与 daily 并存），所以要全收。
// 页面里引用主 bundle 与 wasm 有两种写法：站点自己的相对路径（/assets/…），或 CDN 上的绝对地址。
// 引用写成哪种就按哪种解析，所以这里都只认“按原样写的引用”（写这段时的观察：Craft 用前一种，Studio 用后一种）。
// 只有“动态 import 出来的独立 chunk”才是可用的 glue：内联在主 bundle 里的引擎没有独立的 glue 文件，记不成 lane。
//
// 本模块只读（只发 GET，不写文件）；结果要不要追加进 runtimes.lock.json 由调用方决定。
// lane 是不可变的：新构建只能追加成新条目，绝不原地改已有的 lane
// （那会让基于它录的截图基线悄悄失去复现条件）。
//
// 前半是纯函数（给我文本，我告诉你下一步该抓什么），便于 node --test 直接覆盖；
// 只有 findBuilds 碰网络。

import { createHash } from 'node:crypto';

import { download } from './download.mjs';

/** 站点首页里主 bundle 的引用，按原样返回：站点相对路径（/assets/index-XXXX.js）或 CDN 上的绝对地址。 */
export function extractMainBundlePath(html) {
  const m = /<script[^>]+src="((?:https?:\/\/[^"]+)?\/assets\/[^"]+\.js)"/i.exec(String(html || ''));
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

/** glue 里写死的 wasm 资源引用，按原样返回：站点相对路径（Craft）或 CDN 上的绝对地址（Studio）。 */
export function extractWasmPath(glueJs) {
  const m = /["']((?:https?:\/\/[^"']+)?\/assets\/ink_web_bg[A-Za-z0-9._-]*\.wasm)["']/.exec(String(glueJs || ''));
  return m ? m[1] : null;
}

/**
 * 新 lane 的 id：<平台>-<构建戳或版本号>（平台就是站点的名字，如 craft、studio）。
 * 已被占用（同版本、不同字节的构建）就接上 glue 哈希的前 8 位；
 * 版本一个都没读出来时退而用哈希，让条目带着“缺版本”的原因被拒绝，而不是叫 craft-null。
 */
export function newLaneId({ version, build }, glueSha256, taken, platform = 'craft') {
  const id = `${platform}-${build || version || glueSha256.slice(0, 8)}`.toLowerCase();
  return taken.has(id) ? `${id}-${glueSha256.slice(0, 8)}` : id;
}

/** 未收录的构建 → lane 条目，字段顺序与 runtimes.lock.json 里现有的条目一致。 */
export function laneEntry({ id, source, fetchedAt, build, wasmSha256, version, platform = 'craft' }) {
  return {
    id,
    label: `${platform[0].toUpperCase()}${platform.slice(1)} ${version.build || version.version}`,
    channel: version.build ? 'daily' : 'stable',
    cacheDir: `runtimes/${id}`,
    source,
    fetchedAt,
    engineVersion: version.version,
    engineBuild: version.build,
    glueUrl: build.glueUrl,
    glueSha256: build.glueSha256,
    wasmUrl: build.wasmUrl,
    wasmSha256,
  };
}

/**
 * 顺着站点首页 → 主 bundle → 候选 chunk，找出站点上挂着的全部引擎构建。
 * 取不到的候选 chunk 不会让整件事失败，但会原样列在 skipped 里：结果可能不完整，调用方必须说出来，
 * 否则“没发现新构建”和“没能检查完”看起来一样。
 * downloadOptions 原样交给 download（超时、重试次数）；每个构建带着已经取回的 glue 字节，省得调用方再下一遍。
 */
export async function findBuilds(siteUrl, downloadOptions = {}) {
  const text = async (url) => new TextDecoder().decode(await download(url, downloadOptions));

  const mainPath = extractMainBundlePath(await text(siteUrl));
  if (!mainPath) throw new Error('站点首页里没找到主 bundle：站点结构可能变了');
  const mainUrl = new URL(mainPath, siteUrl).href;
  const candidates = rankGlueCandidates(extractChunkNames(await text(mainUrl)));
  if (!candidates.length) throw new Error('主 bundle 里没有可疑的 chunk：站点结构可能变了');

  const builds = [];
  const skipped = [];
  for (const name of candidates) {
    const glueUrl = new URL(name, mainUrl).href;
    let bytes;
    try {
      bytes = await download(glueUrl, downloadOptions);
    } catch (error) {
      skipped.push({ url: glueUrl, reason: error.message });
      continue;
    }
    const js = new TextDecoder().decode(bytes);
    const wasmPath = extractWasmPath(js);
    if (!looksLikeGlue(js) || !wasmPath) continue;
    builds.push({
      glueUrl,
      glue: bytes,
      glueSha256: createHash('sha256').update(bytes).digest('hex'),
      wasmUrl: new URL(wasmPath, glueUrl).href,
    });
  }
  if (!builds.length) throw new Error(`试了 ${candidates.length} 个候选 chunk 都不是引擎 glue：站点结构可能变了`);
  return { mainPath, candidates: candidates.length, builds, skipped };
}
