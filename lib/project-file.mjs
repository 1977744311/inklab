// project-file.mjs — 宿主场景从当前被测工程读二进制 fixture。
// 路径只能落在 serve.mjs 的 /app/ 静态根；非 2xx 必须响亮失败，
// 否则 404 文字会被 caps.media 当成照片字节，直到视觉模型才报“非法图片”。

export function projectFileUrl(name) {
  const raw = String(name == null ? '' : name).trim().replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new TypeError(`非法的工程文件路径：${raw || '（空）'}`);
  }
  return `/app/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

export async function readProjectFile(name, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('readProjectFile 需要 fetch');
  const url = projectFileUrl(name);
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(Number(response.status)) ? Number(response.status) : 0;
    throw new Error(`读不到工程文件 ${name}（HTTP ${status || '未知'}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
