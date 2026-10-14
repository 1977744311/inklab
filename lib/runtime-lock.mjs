// runtime-lock.mjs — 命名运行时矩阵的纯逻辑。
//
// 全局只有一个引擎时，一旦覆盖升级，旧截图与旧行为就失去复现条件。
// 这里把每个运行时当成不可变 lane：id、来源、版本、glue/wasm 哈希与本地缓存目录一起锁定。

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function assertRuntimeId(value) {
  const id = String(value || '');
  if (!ID_RE.test(id)) throw new TypeError(`非法运行时 id：${id || '(空)'}`);
  return id;
}

function normalizeOne(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = assertRuntimeId(r.id);
  if (!r.engineVersion && !r.engineBuild) throw new Error(`运行时 ${id} 缺版本`);
  if (!r.glueSha256 || !r.wasmSha256) throw new Error(`运行时 ${id} 缺二进制哈希`);
  return Object.freeze({
    id,
    label: String(r.label || id),
    channel: String(r.channel || 'custom'),
    cacheDir: String(r.cacheDir || `runtimes/${id}`),
    cacheOnly: Boolean(r.cacheOnly),
    source: String(r.source || ''),
    fetchedAt: r.fetchedAt ? String(r.fetchedAt) : null,
    engineVersion: r.engineVersion ? String(r.engineVersion) : null,
    engineBuild: r.engineBuild ? String(r.engineBuild) : null,
    glueUrl: r.glueUrl ? String(r.glueUrl) : null,
    glueSha256: String(r.glueSha256),
    wasmUrl: r.wasmUrl ? String(r.wasmUrl) : null,
    wasmSha256: String(r.wasmSha256),
  });
}

/**
 * 规整 runtimes.lock.json：它就是一个 lane 数组。校验每条 lane、拒绝重复 id；
 * 顺序即优先级，第一条是默认 lane（想换默认，把它挪到最前面）。
 * 全新 clone 还没有清单，是正常状态：只有站点检查（要往空清单里追加）才传 allowEmpty。
 */
export function normalizeRuntimeRegistry(rows, { allowEmpty = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('runtimes.lock.json 应该是一个 lane 数组：[ { "id": …, … }, … ]');
  const runtimes = rows.map(normalizeOne);
  const ids = new Set();
  for (const runtime of runtimes) {
    if (ids.has(runtime.id)) throw new Error(`运行时 id 重复：${runtime.id}`);
    ids.add(runtime.id);
  }
  if (!runtimes.length && !allowEmpty) {
    throw new Error('runtimes.lock.json 里还没有运行时：联网后运行 npm run engine 生成它（也可以照 docs/guide.md 手写）');
  }
  return Object.freeze({ default: runtimes[0]?.id ?? null, runtimes: Object.freeze(runtimes) });
}

/** URL ?runtimes=a,b 或 ?runtime=a；过滤不存在的 id、去重，并保证至少返回默认 lane。 */
export function selectRuntimeIds(search, registry, { max = 4 } = {}) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const raw = params.get('runtimes') || params.get('runtime') || '';
  const available = new Set((registry?.runtimes || []).map((r) => r.id));
  const selected = [];
  for (const id of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
    if (available.has(id) && !selected.includes(id)) selected.push(id);
    if (selected.length >= max) break;
  }
  const fallback = registry?.default && available.has(registry.default)
    ? registry.default : registry?.runtimes?.[0]?.id;
  return selected.length ? selected : (fallback ? [fallback] : []);
}

export function runtimeDisplayVersion(runtime) {
  return String(runtime?.engineBuild || runtime?.engineVersion || '?');
}
