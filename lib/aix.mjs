// aix.mjs — 直接读 .aix 包，把它变成引擎能吃的 bundle 文件表。
//
// 为什么要支持：日常调试跑源码目录就够了（改一行刷新即生效，本来就是 InkLab 的卖点）。
// 但有两件事必须拿包说话：
//   1. 对照线上——平台上跑的是某个 .aix，想复现线上问题就得跑那一份，而不是当前工作区
//   2. 回归旧版——dist/aiui-packages/ 里留着历次包，出问题时要二分定位是哪一版引入的
//
// .aix 就是 zip（deflate，见 aiui-deploy skill）。这里手写解析而不是拉依赖：
// 本仓工具链一贯零运行时依赖，而且我们只需要「读」这一半，不需要写。

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

/** 从后往前找中央目录结束记录（尾部可能有注释，所以不能直接取最后 22 字节）。 */
function findEndOfCentralDirectory(view, bytes) {
  const maxComment = 0xffff;
  const start = Math.max(0, bytes.length - 22 - maxComment);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 列出 .aix 里的条目（不解压内容，只读目录）。
 * @param {Uint8Array} bytes
 * @returns {{name:string, method:number, compressedSize:number, size:number, offset:number}[]}
 */
export function listAixEntries(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEndOfCentralDirectory(view, buf);
  if (eocd < 0) throw new Error('不是合法的 .aix（找不到 zip 中央目录）');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== SIG_CEN) throw new Error(`.aix 中央目录第 ${i} 项签名不对`);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 本地文件头之后才是数据；头长度不固定（文件名与 extra 长度写在头里）。 */
function dataRangeOf(view, entry) {
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  return { start, end: start + entry.compressedSize };
}

/**
 * 解出 .aix 的全部文件内容。
 * @param {Uint8Array} bytes
 * @param {(deflated:Uint8Array) => Promise<Uint8Array>} inflate
 *   注入解压实现——浏览器用 DecompressionStream('deflate-raw')，node 用 zlib.inflateRaw。
 *   本模块保持零环境依赖，两边共用。
 * @returns {Promise<Record<string, Uint8Array>>} 路径 → 字节
 */
export async function readAix(bytes, inflate) {
  if (typeof inflate !== 'function') throw new TypeError('readAix 需要注入 inflate 实现');
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = {};
  for (const entry of listAixEntries(buf)) {
    if (entry.name.endsWith('/')) continue; // 目录项没有内容
    const { start, end } = dataRangeOf(view, entry);
    const raw = buf.subarray(start, end);
    if (entry.method === 0) {
      out[entry.name] = new Uint8Array(raw); // stored，直接拷一份（不共享底层 buffer）
    } else if (entry.method === 8) {
      out[entry.name] = await inflate(raw);
    } else {
      throw new Error(`.aix 里 ${entry.name} 用了不支持的压缩方式 ${entry.method}`);
    }
  }
  return out;
}

/**
 * 把 readAix 的字节表转成引擎要的形态：文本走 string，二进制走 Uint8Array。
 * 判定口径与 bundle.mjs 的 isTextPath 保持一致——两处若分家，会出现「跑源码好好的、跑包就白屏」。
 */
export function toBundleFiles(fileBytes, isTextPath, decode = (b) => new TextDecoder('utf-8').decode(b)) {
  const files = {};
  for (const [path, bytes] of Object.entries(fileBytes)) {
    files[path] = isTextPath(path) ? decode(bytes) : bytes;
  }
  return files;
}

/** .aix 里的 VERSION 是平台校验与热更新触发器，排查「跑的到底是哪一版」时第一个要看的东西。 */
export function versionOf(fileBytes, decode = (b) => new TextDecoder('utf-8').decode(b)) {
  const raw = fileBytes.VERSION;
  return raw ? decode(raw).trim() : null;
}
