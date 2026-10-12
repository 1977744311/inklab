// Full pixel fingerprint for temporal rendering checks. PNG size/tail can collide on moving UI.
export function rgbaFrameHash({ width, height, data } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !data || data.length !== width * height * 4) throw new TypeError('invalid RGBA frame');
  const bytes = data.BYTES_PER_ELEMENT === 1 && data.byteOffset % 4 === 0 ? data : new Uint8Array(data);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, width * height);
  const multiply = Math.imul;
  let hash = 2166136261;
  for (let i = 0; i < words.length; i += 1) hash = multiply(hash ^ words[i], 16777619);
  return `${width}x${height}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
