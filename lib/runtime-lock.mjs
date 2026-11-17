// runtime-lock.mjs — 命名运行时矩阵的纯逻辑。
//
// 全局只有一个引擎时，一旦覆盖升级，旧截图与旧行为就失去复现条件。
// 这里把每个运行时当成不可变 lane：id、来源、版本、glue/wasm 哈希与本地缓存目录一起锁定。
//
// lane 不可变，但「最新」会变：通道名（latest / daily / studio）是指向某条 lane 的活指针，
// 每次按清单里现有的 lane 重新算。项目里写通道名，引擎更新后不用改项目；
// 要钉死复现某次结果，就写具体的 lane id。

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
    tarballUrl: r.tarballUrl ? String(r.tarballUrl) : null,
    tarballIntegrity: r.tarballIntegrity ? String(r.tarballIntegrity) : null,
    glueUrl: r.glueUrl ? String(r.glueUrl) : null,
    glueSha256: String(r.glueSha256),
    wasmUrl: r.wasmUrl ? String(r.wasmUrl) : null,
    wasmSha256: String(r.wasmSha256),
  });
}

/** 通道名，按说明顺序：正式版、每日构建、AIUI Studio 网页版内嵌的那个。 */
export const RUNTIME_ALIASES = Object.freeze({
  latest: '最新正式版',
  daily: '最新构建（含每日构建）',
  studio: 'AIUI Studio 网页版内嵌的引擎',
});

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text || ''));
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
}

/** semver 比较：a < b 返回负数。预发布低于同号正式版；数字段按数值比。读不出的版本最小。 */
export function compareEngineVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** lane 的来源平台：npm、studio、craft，认不出的算 custom。 */
export function runtimePlatform(runtime) {
  const source = String(runtime?.source || '');
  if (/registry\.npmjs\.org|jsdelivr|@yodaos-pkg\/ink|\/ink\/-\//.test(source) || String(runtime?.id || '').startsWith('npm-')) return 'npm';
  if (/aiuistudio|aiui\.rokid\.com/.test(source)) return 'studio';
  if (/js\.rokid\.com/.test(source)) return 'craft';
  return 'custom';
}

const PLATFORM_RANK = { npm: 3, studio: 2, craft: 1, custom: 0 };

/** 同号版本里谁更“新”：npm 官方包优先，再看取回日期。 */
function newer(a, b) {
  const byVersion = compareEngineVersions(runtimeDisplayVersion(a), runtimeDisplayVersion(b));
  if (byVersion) return byVersion > 0;
  const byPlatform = PLATFORM_RANK[runtimePlatform(a)] - PLATFORM_RANK[runtimePlatform(b)];
  if (byPlatform) return byPlatform > 0;
  return String(a.fetchedAt || '') > String(b.fetchedAt || '');
}

const pick = (rows) => rows.reduce((best, row) => (!best || newer(row, best) ? row : best), null)?.id ?? null;

/**
 * 在给定的 lane 里算出每个通道名指向谁（调用方先滤掉本机没缓存的）。
 * latest = 版本最高的正式版；daily = 版本最高的任意构建；studio = Studio 网页版来源里版本最高的。
 */
export function resolveRuntimeAliases(runtimes) {
  const rows = [...(runtimes || [])];
  const stable = rows.filter((row) => !runtimeDisplayVersion(row).includes('-'));
  return {
    latest: pick(stable) ?? pick(rows),
    daily: pick(rows),
    studio: pick(rows.filter((row) => runtimePlatform(row) === 'studio')),
  };
}

/** lane id 或通道名 → lane id；都不是就返回 null。 */
export function resolveRuntimeId(name, registry) {
  const value = String(name || '').trim();
  if ((registry?.runtimes || []).some((runtime) => runtime.id === value)) return value;
  return Object.hasOwn(RUNTIME_ALIASES, value) ? registry?.aliases?.[value] ?? null : null;
}

/**
 * 规整 runtimes.lock.json：它就是一个 lane 数组。校验每条 lane、拒绝重复 id；
 * 默认 lane 是 latest 通道（版本最高的正式版），不再看顺序；想临时换默认，设 INKLAB_RUNTIME。
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
    throw new Error('runtimes.lock.json 里还没有运行时：联网后运行 inklab-engine 生成它（也可以照 docs/guide.md 手写）');
  }
  const aliases = Object.freeze(resolveRuntimeAliases(runtimes));
  return Object.freeze({ default: aliases.latest ?? runtimes[0]?.id ?? null, aliases, runtimes: Object.freeze(runtimes) });
}

/** URL ?runtimes=a,b 或 ?runtime=a（可写通道名）；过滤不存在的 id、去重，并保证至少返回默认 lane。 */
export function selectRuntimeIds(search, registry, { max = 4 } = {}) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const raw = params.get('runtimes') || params.get('runtime') || '';
  const available = new Set((registry?.runtimes || []).map((r) => r.id));
  const selected = [];
  for (const name of raw.split(',').map((v) => v.trim()).filter(Boolean)) {
    const id = available.has(name) ? name : registry?.aliases?.[name];
    if (id && available.has(id) && !selected.includes(id)) selected.push(id);
    if (selected.length >= max) break;
  }
  const fallback = registry?.default && available.has(registry.default)
    ? registry.default : registry?.runtimes?.[0]?.id;
  return selected.length ? selected : (fallback ? [fallback] : []);
}

export function runtimeDisplayVersion(runtime) {
  return String(runtime?.engineBuild || runtime?.engineVersion || '?');
}
