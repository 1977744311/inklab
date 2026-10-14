// engine-version.mjs — 从引擎 wasm 的二进制里读出版本串（纯函数，零 IO）。
//
// 运行时二进制不入库，仓库里只在 runtimes.lock.json 里锁来源、版本与哈希。
// 取回后用这里的锚点法再核对一次 lock 里写的版本，防止「URL 没变、内容被换」。

// 版本串在 wasm 数据段里紧挨着引擎自己的静态错误文案，靠锚点取比裸 semver 正则可靠得多：
// 整个 wasm 里有几十个第三方 crate 的版本号，裸正则必然误命中。
// 实测两处锚点各挂一样东西：
//   语义版本（0.17.0）      ← 紧挨 'Bundle file value must be a string or Uint8Array'
//   daily 构建戳（可能没有） ← 紧挨 'InkView is destroyed'
export const VERSION_ANCHOR = 'Bundle file value must be a string or Uint8Array';
export const BUILD_ANCHOR = 'InkView is destroyed';

// 新布局的 daily（实测 0.19.0-daily.202610080438 起）里，两处静态文案不再紧挨版本串，上面的锚点读不出来；
// 但引擎自带的版本表仍把 `ink`、版本、`skia` 三个字符串连在一起。daily 构建会把这一串换成构建戳（带预发布后缀）；
// 正式版这里写的是 crate 版本 0.1.0，不是发行版本，所以只认带预发布后缀的：读不出就是读不出（宁缺勿错）。
const STAMP_PATTERN = /ink(\d+\.\d+\.\d+-[A-Za-z0-9.]+)skia/;

/** 取紧贴在 anchor 之前的版本串；不存在或不紧邻都返回 null（宁缺勿错）。 */
function versionBefore(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const m = /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)$/.exec(text.slice(Math.max(0, at - 64), at));
  return m ? m[1] : null;
}

/**
 * 引擎版本。同一站点可能同时挂着不止一个构建（正式版与 daily 并存），
 * 所以版本必须逐构建、逐 wasm 解析。
 * @param {Uint8Array} wasmBytes 完整 wasm 或其尾部切片（两处锚点都靠近文件末尾）
 */
export function extractEngineVersion(wasmBytes) {
  const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes || []);
  const text = Buffer.from(bytes).toString('latin1');
  const version = versionBefore(text, VERSION_ANCHOR);
  const stamped = versionBefore(text, BUILD_ANCHOR) ?? STAMP_PATTERN.exec(text)?.[1] ?? null;
  return {
    version: version ? version.split('-')[0] : (stamped ? stamped.split('-')[0] : null),
    // 只有带预发布后缀的才算构建戳；正式版这里本来就没有版本串。
    build: stamped && stamped.includes('-') ? stamped : null,
  };
}
