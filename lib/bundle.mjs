// bundle.mjs — 把一个 AIUI 工程目录整理成引擎能吃的 bundle 文件表（纯逻辑）。
//
// 引擎的 openBundle({appId, files}) 接受「路径 → 内容」的映射，文本给 string、
// 二进制给 Uint8Array。关键点：**不需要打包 .aix，也不需要任何编译步骤**——
// 引擎自己解析 .ink / .js / app.json，所以本地宿主可以直接跑源码目录。

/**
 * 不进 bundle 的东西。口径对齐 .aixignore（真机包排除什么，本地就排除什么），
 * 再额外排掉纯开发物，避免把 3MB 的 mockup 图塞进引擎。
 * 这里刻意**不排除 data/**：build-pack 的产物是 lib/compiled-pack.js，data/ 只是内容源，
 * 与 .aixignore 同理排除，保持本地与真机包一致。
 */
export const DEFAULT_EXCLUDES = [
  /(^|\/)\.[^/]+$/,               // 点文件/点目录
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)__tests__(\/|$)/,
  /\.test\.mjs$/,
  /(^|\/)e2e(\/|$)/,              // 工程自带的 e2e 资产（场景/录像/基线），是测试物不是应用代码
  /(^|\/)scripts(\/|$)/,
  /(^|\/)data(\/|$)/,
  /(^|\/)docs(\/|$)/,
  /(^|\/)assets\/mockups-ai(\/|$)/,
  /(^|\/)assets\/app-icon\.png$/,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)README\.md$/,
  /(^|\/)VOICE-COMMANDS\.md$/,
  /(^|\/)BASELINE\.md$/,
];

/** 按扩展名判断走 string 还是 Uint8Array。引擎对二者都接受，但给错会解析失败。 */
const TEXT_EXT = /\.(ink|js|mjs|json|wxss|css|md|txt|svg)$/i;
export const isTextPath = (p) => TEXT_EXT.test(String(p || ''));

/** 路径是否应当进 bundle。extra 允许调用方追加排除项（如临时屏蔽某页排障）。 */
export function shouldInclude(relPath, extra = []) {
  const p = String(relPath || '').replace(/^\.\//, '');
  if (!p) return false;
  return ![...DEFAULT_EXCLUDES, ...extra].some((re) => re.test(p));
}

/**
 * 把目录下的相对路径清单整理成稳定清单：过滤 + 归一化 + 排序。
 * 排序让 manifest 可 diff——引擎不关心顺序，但人和 git 关心。
 */
export function buildManifest(relPaths, extra = []) {
  const seen = new Set();
  const out = [];
  for (const raw of relPaths || []) {
    const p = String(raw).replace(/^\.\//, '').replace(/\\/g, '/');
    if (!shouldInclude(p, extra) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.sort();
}

/**
 * 工程完整性预检：引擎对缺失入口的报错很含糊（Craft 上表现为白屏），
 * 本地宿主提前把它变成一句人话。返回 problems[]，空数组=可以跑。
 */
export function validateManifest(manifest, appJsonText) {
  const problems = [];
  const files = new Set(manifest);
  if (!files.has('app.json')) problems.push('缺 app.json（引擎的入口清单）');
  if (!files.has('app.js')) problems.push('缺 app.js');

  if (appJsonText) {
    let appJson = null;
    try {
      appJson = JSON.parse(appJsonText);
    } catch (err) {
      problems.push(`app.json 不是合法 JSON：${err.message}`);
    }
    const pages = appJson && Array.isArray(appJson.pages) ? appJson.pages : null;
    if (appJson && !pages) {
      problems.push('app.json 里没有 pages 数组');
    } else if (pages) {
      for (const route of pages) {
        // app.json 写 "pages/home/index"，盘上是 "pages/home/index.ink"。
        if (!files.has(`${route}.ink`)) problems.push(`app.json 注册了 ${route}，但盘上没有 ${route}.ink`);
      }
      if (pages.length === 0) problems.push('app.json 的 pages 是空数组');
    }
  }
  return problems;
}
