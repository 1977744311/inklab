// stamp.mjs — 截图基线的「源码指纹」。shots.mjs 的 stale 检测靠它区分
// 「这张图是当前源码跑出来的」和「这张图是上一版跑出来的」。
//
// 设计要点（每条都对着一种自欺）：
//
//  1. **不用 git commit sha。** 最常见的调试状态恰恰是「改了一行样式还没提交」——
//     HEAD 不变而画面变了，stale 检测直接失灵；反过来改 docs 也会让全部截图无谓变红。
//
//  2. **只把真正进 bundle 的字节算进去。** 指纹从递给 openBundle 的那份文件表算，
//     `.aixignore` 排除的东西天然不参与。
//
//  3. **必须并进引擎身份。** Craft 同时挂着 0.16.1 与 0.17.0-daily 两个构建，
//     同一份源码换个引擎重排版完全可能——不并进去，引擎漂移会悄悄改掉基线而没人知道。
//
//  4. **必须并进采集口径**（画布尺寸、DPR、场景 id、能力夹具 id）。
//     用不同注入转写跑出来的「聆听态」不是同一张证据——这是把 CAPTURE-PLAN 那套
//     「唯一允许 mock 的是 IMU」的纪律机器化。
//
//  5. **绝不并进与画面无关又会变的东西**：时间、分支名、跑的机器。
//     指纹天天变，stale 就天天亮，人两周内就会学会无视它——那比没有还糟。
//
//  6. **指纹要从同一次运行里、内存中的那份文件表算**，而不是渲染完再回头 stat 磁盘。
//     否则中途一次保存就能拼出「改后的源码 + 改前的画面」这条看起来合法的假证据。
//     这是整套设计里唯一真正防得住自欺的地方。

/** FNV-1a 64（用 BigInt）。不引 node:crypto，好让浏览器宿主与 node 测试共用同一份实现。 */
function fnv1a64(input) {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input[i] & 0xff);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

const utf8 = (s) => new TextEncoder().encode(String(s));

/** 单个文件的内容哈希。文本与二进制统一按字节算，避免「同内容不同类型」算出两个指纹。 */
export function hashFile(content) {
  if (content instanceof Uint8Array) return fnv1a64(content);
  if (typeof content === 'string') return fnv1a64(utf8(content));
  if (content && typeof content === 'object' && ArrayBuffer.isView(content)) {
    return fnv1a64(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  }
  throw new TypeError('hashFile: 只接受 string 或字节视图');
}

/**
 * bundle 内容指纹：逐文件哈希后按路径排序再整体哈希。
 * 排序保证同一份内容不因遍历顺序算出不同指纹。
 * @param {Record<string, string|Uint8Array>} files 递给 openBundle 的那份文件表
 */
export function bundleHash(files) {
  const entries = Object.keys(files || {}).sort()
    .map((path) => `${path}:${hashFile(files[path])}`);
  if (!entries.length) throw new Error('bundleHash: 文件表是空的，指纹没有意义');
  return fnv1a64(utf8(entries.join('\n')));
}

/**
 * 组一个完整的源码指纹。各分量原样留在返回值里——
 * 将来 stale 报警时能一眼看出是源码变了、引擎漂了、还是采集口径换了，而不只是「不一样」。
 *
 * @param {object} args
 * @param {Record<string,string|Uint8Array>} args.files  bundle 文件表（内存里那份）
 * @param {object} args.engine  { build|version, wasmSha256 } —— 来自 runtimes.lock.json 里选中的 lane
 * @param {object} args.viewport { width, height, scaleFactor }
 * @param {string} [args.scenario] 场景 id：不同脚本走到的同名屏不是同一张证据
 * @param {string} [args.fixtures] 能力夹具 id：注入不同转写/trace 得到的屏也不是同一张
 */
export function createSourceStamp({ files, engine, viewport, scenario = '', fixtures = '' }) {
  if (!engine || !(engine.build || engine.version)) {
    throw new Error('createSourceStamp: 必须带引擎身份，否则引擎漂移会悄悄改掉基线');
  }
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new Error('createSourceStamp: 必须带画布尺寸，换个尺寸的截图不是同一张证据');
  }
  const parts = {
    bundleHash: bundleHash(files),
    engineBuild: String(engine.build || engine.version),
    wasmSha256: String(engine.wasmSha256 || '').slice(0, 16),
    viewport: `${viewport.width}x${viewport.height}@${viewport.scaleFactor ?? 1}`,
    scenario: String(scenario || ''),
    fixtures: String(fixtures || ''),
  };
  const stamp = fnv1a64(utf8(Object.entries(parts).map(([k, v]) => `${k}=${v}`).join('|')));
  // 对外展示取前 12 位（报告里好读），完整值与各分量一并返回备查。
  return { stamp: stamp.slice(0, 12), full: stamp, parts };
}

/** 两个指纹哪一部分不同——stale 报警时直接告诉人「是引擎漂了」还是「是你改了源码」。 */
export function explainStampDiff(a, b) {
  const pa = a?.parts || {};
  const pb = b?.parts || {};
  const keys = [...new Set([...Object.keys(pa), ...Object.keys(pb)])];
  return keys.filter((k) => pa[k] !== pb[k]).map((k) => ({ part: k, was: pa[k], now: pb[k] }));
}
