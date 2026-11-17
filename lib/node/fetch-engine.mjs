// fetch-engine.mjs — 把 Ink 运行时（glue + wasm）取到本机缓存目录，并维护 runtimes.lock.json 这份本机清单。
//
// 引擎的来源有三处，按新旧排：
//   npm 上的 @yodaos-pkg/ink（官方发布渠道，Apache-2.0）：dist-tag latest 是正式版、daily 是每日构建，最新；
//   AIUI Studio 网页版、Craft 网页里嵌的构建：比 npm 旧，留着是为了对照「网页里看到的效果」。
// 二进制只放在本机缓存，不进 git、不随工具分发。
//
// 每个人取到哪些引擎都不一样，所以清单（runtimes.lock.json）和缓存（.engine/）都是本机状态，
// 都不入库。清单是一个 lane 数组，每条记着来源、版本与哈希。默认用哪条不看顺序，
// 看通道名 latest（版本最高的正式版），见 lib/runtime-lock.mjs。
//
//   inklab-engine                     先查 npm 与 Craft、AIUI Studio 两个站点：有清单没收录的构建，
//                                     就追加成新 lane、把已取回的字节落进缓存（全新 clone 没有清单，
//                                     就从这一步生成）；然后拉齐清单里的全部 lane（本地缓存与清单一致的直接跳过）。
//                                     某个来源查不了只警告，照常装配
//   inklab-engine craft-0.18.0        同样先查来源，但只拉指定的 lane（可写多个）
//   inklab-engine --check             只校验本地缓存，不发网络请求，也不查来源（可与 lane 名连用）
//   inklab-engine --discover          只读：同样的检查，但只打印会追加的条目，不写任何文件
//                                     （有未收录的构建时退出码为 2；没能查完为 1）
//   --site=[<名字>=]<url>（可重复）    只查给定的站点，不再查 npm 与默认的两个站点；名字（缺省 craft）是新 lane id 的前缀
//
// inklab / inklab-e2e / inklab-matrix 启动时也会查一次 npm（一天最多一次，见 engine-update.mjs）。
// 下载中某个文件 30 秒没有新字节就中止并重试（最多 3 次，间隔 1/2/4 秒），并显示速度和剩余时间。
// 旧写法 --matrix 仍可传，没有额外效果。

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { download, formatProgress } from './download.mjs';
import { findBuilds, laneEntry, newLaneId } from './engine-discovery.mjs';
import { NPM_PACKAGE, fetchNpmPackage, findNpmBuilds, writeNpmLane } from './npm-engine.mjs';
import { extractEngineVersion } from './engine-version.mjs';
import { engineCacheDirectory } from './cache-path.mjs';
import { readRuntimeLock } from './runtime-lock-file.mjs';
import { RUNTIME_ALIASES, normalizeRuntimeRegistry, resolveRuntimeAliases, runtimeDisplayVersion } from '../runtime-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_DIR = engineCacheDirectory();
const RUNTIMES_LOCK_PATH = join(ROOT, 'runtimes.lock.json');
// 站点检查的默认对象：官方的两个平台各挂着自己的引擎构建，少查一个就会漏掉只在那边发布的版本。
// 名字是新 lane id 的前缀。
const SITES = [
  { name: 'craft', url: 'https://js.rokid.com/craft' },
  { name: 'studio', url: 'https://aiui.rokid.com/' },
];
// 查站点只是顺手一看：断网时尽快放弃（约 1 秒），别拖住后面的装配。
const SITE_CHECK_DOWNLOAD = { retries: 1, stallMs: 10_000 };

/** --site=[<名字>=]<url>，可重复；给了就只查给的（也不查 npm）。没写名字的当 craft。 */
function parseSites(argv) {
  const given = argv.filter((arg) => arg.startsWith('--site=')).map((arg) => arg.slice('--site='.length));
  if (!given.length) return SITES;
  return given.map((value) => {
    const named = /^([a-z][a-z0-9-]*)=(.+)$/.exec(value);
    return named ? { name: named[1], url: named[2] } : { name: 'craft', url: value };
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log('[inklab]', ...a);
export const LOCK_PATH = RUNTIMES_LOCK_PATH;
export const ENGINE_ROOT = ENGINE_DIR;

// 进度：交互终端里原地刷新一行；管道/CI 里每 15 秒一行，免得长下载期间毫无输出。
export function createProgress(label) {
  const tty = Boolean(process.stdout.isTTY);
  const interval = tty ? 250 : 15_000;
  let startedAt = Date.now();
  let lastShown = startedAt;
  return {
    update({ received, total }) {
      const now = Date.now();
      if (now - lastShown < interval) return;
      lastShown = now;
      const line = formatProgress({ label, received, total, elapsedMs: now - startedAt });
      process.stdout.write(tty ? `\r${line}\x1b[K` : `${line}\n`);
    },
    clear() { if (tty) process.stdout.write('\r\x1b[K'); }, // 输出别的行之前先擦掉进度行
    restart() { startedAt = Date.now(); lastShown = startedAt; }, // 重试从 0 字节重来，计速也重来
  };
}

export async function verifyCachedRuntime(runtime, root) {
  const rows = [
    ['ink-glue.js', runtime.glueSha256],
    ['engine.wasm', runtime.wasmSha256],
  ];
  for (const [file, want] of rows) {
    const path = join(root, file);
    try { await stat(path); } catch { throw new Error(`${runtime.id} 缺 ${file}`); }
    const got = sha256(await readFile(path));
    if (got !== want) throw new Error(`${runtime.id}/${file} 哈希不符（lock ${want}，盘上 ${got}）`);
  }
}

async function syncRuntimeMatrix({ checkOnly = false, only = [] } = {}) {
  const registry = normalizeRuntimeRegistry(await readRuntimeLock(RUNTIMES_LOCK_PATH));
  const known = registry.runtimes.map((r) => r.id);
  const unknown = only.filter((id) => !known.includes(id));
  if (unknown.length) throw new Error(`lock 里没有运行时：${unknown.join('、')}（可选：${known.join('、')}）`);
  let ready = 0;
  let skipped = 0;
  for (const runtime of registry.runtimes.filter((r) => !only.length || only.includes(r.id))) {
    const root = resolve(ENGINE_DIR, runtime.cacheDir);
    if (!(root === ENGINE_DIR || root.startsWith(ENGINE_DIR + sep))) {
      throw new Error(`${runtime.id} 的 cacheDir 越出引擎缓存目录：${runtime.cacheDir}`);
    }
    if (checkOnly) {
      try {
        await verifyCachedRuntime(runtime, root);
        ready += 1;
        log(`✓ ${runtime.id} · ink_web ${runtimeDisplayVersion(runtime)}`);
      } catch (error) {
        if (!runtime.cacheOnly) throw error;
        skipped += 1;
        log(`○ ${runtime.id} · cache-only 历史 lane 本机缺席（不拦其它版本）`);
      }
      continue;
    }
    // 历史构建的 CDN URL 可能已经回收；只要本地缓存仍与 lock 完全一致，就保留它，
    // 不为了“重新下载”而把一条可复现 lane 变成不可用。
    try {
      await verifyCachedRuntime(runtime, root);
      ready += 1;
      log(`✓ ${runtime.id} · 已有锁定缓存`);
      continue;
    } catch { /* 缺失/漂移才去源站重取 */ }
    if (runtime.cacheOnly) {
      skipped += 1;
      log(`○ ${runtime.id} · cache-only 历史 lane 本机缺席，源站已回收；跳过`);
      continue;
    }
    if (runtime.tarballUrl) {
      await syncNpmLane(runtime, root);
      ready += 1;
      continue;
    }
    if (!runtime.glueUrl || !runtime.wasmUrl) {
      throw new Error(`${runtime.id} 缺 glueUrl/wasmUrl，无法拉取`);
    }
    log(`拉取 ${runtime.id} · ink_web ${runtimeDisplayVersion(runtime)}`);
    const progress = createProgress(runtime.id);
    const retryNotice = (what) => ({ attempt, retries, delayMs, reason }) => {
      progress.clear();
      log(`⚠ ${runtime.id} ${what}：${reason}，${delayMs / 1000} 秒后重试（${attempt}/${retries}）`);
    };
    let glue;
    let wasm;
    try {
      [glue, wasm] = await Promise.all([
        download(runtime.glueUrl, { onRetry: retryNotice('glue') }),
        download(runtime.wasmUrl, {
          onProgress: progress.update,
          onRetry: (retry) => { retryNotice('wasm')(retry); progress.restart(); },
        }),
      ]);
    } finally {
      progress.clear(); // 失败时也要把进度行擦掉，免得错误信息接在它后面
    }
    const glueHash = sha256(glue);
    const wasmHash = sha256(wasm);
    if (glueHash !== runtime.glueSha256 || wasmHash !== runtime.wasmSha256) {
      throw new Error(`${runtime.id} 下载内容与 lock 不符：`
        + `glue ${glueHash === runtime.glueSha256 ? 'ok' : glueHash}；`
        + `wasm ${wasmHash === runtime.wasmSha256 ? 'ok' : wasmHash}`);
    }
    const actualVersion = extractEngineVersion(wasm);
    if (actualVersion.version && actualVersion.version !== runtime.engineVersion) {
      throw new Error(`${runtime.id} 版本不符：lock ${runtime.engineVersion}，二进制 ${actualVersion.version}`);
    }
    if (runtime.engineBuild && actualVersion.build && actualVersion.build !== runtime.engineBuild) {
      throw new Error(`${runtime.id} build 不符：lock ${runtime.engineBuild}，二进制 ${actualVersion.build}`);
    }
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ink-glue.js'), glue);
    await writeFile(join(root, 'engine.wasm'), wasm);
    ready += 1;
    log(`✓ ${runtime.id} · ${(wasm.length / 1e6).toFixed(1)}MB`); // 与进度行同一口径（十进制 MB）
  }
  if (!ready) throw new Error('没有任何运行时 lane 可用');
  log(`${ready} 条运行时 lane ${checkOnly ? '校验通过' : '已就绪'}${skipped ? ` · ${skipped} 条 cache-only 缺席` : ''}`);
}

/** npm 来源的 lane：整包取回、校验 integrity 再解进缓存目录，最后按清单核对 glue / wasm 哈希。 */
async function syncNpmLane(runtime, root) {
  if (!runtime.tarballIntegrity) throw new Error(`${runtime.id} 缺 tarballIntegrity，无法校验`);
  log(`拉取 ${runtime.id} · ${NPM_PACKAGE}@${runtime.engineBuild || runtime.engineVersion}`);
  const progress = createProgress(runtime.id);
  let files;
  try {
    files = await fetchNpmPackage({ dist: { tarball: runtime.tarballUrl, integrity: runtime.tarballIntegrity } }, {
      onProgress: progress.update,
      onRetry: ({ attempt, retries, delayMs, reason }) => {
        progress.clear();
        log(`⚠ ${runtime.id} tarball：${reason}，${delayMs / 1000} 秒后重试（${attempt}/${retries}）`);
        progress.restart();
      },
    });
  } finally {
    progress.clear();
  }
  await writeNpmLane(root, files);
  await verifyCachedRuntime(runtime, root);
  log(`✓ ${runtime.id} · ${(files.get('pkg/ink_web_bg.wasm').length / 1e6).toFixed(1)}MB`);
}

/**
 * 看站点上有哪些引擎构建，哪些已被 lane 收录（按 glue 哈希认）。
 * 没被收录的才取回 wasm 算哈希、读版本，连同已经取回的字节一起返回；本函数不写任何文件。
 */
async function scanSite(site, registry, pageDownload = {}) {
  log(`检查 ${site.url}`);
  const found = await findBuilds(site.url, pageDownload);
  log(`主 bundle ${found.mainPath}，检查了 ${found.candidates} 个候选 chunk，站点上挂着 ${found.builds.length} 个引擎构建：`);
  for (const skip of found.skipped) log(`⚠ 没能检查 ${skip.url}：${skip.reason}（结果可能不完整）`);

  const fresh = [];
  for (const build of found.builds) {
    const file = new URL(build.glueUrl).pathname.split('/').pop();
    const lane = registry.runtimes.find((r) => r.glueSha256 === build.glueSha256);
    if (lane) {
      log(`  ✓ ${file}  已收录为 ${lane.id} · ink_web ${runtimeDisplayVersion(lane)}`);
      continue;
    }
    log(`  ✗ ${file}  没有任何 lane 收录它，取回 wasm 计算哈希`);
    const progress = createProgress(file);
    let wasm;
    try {
      wasm = await download(build.wasmUrl, {
        onProgress: progress.update,
        onRetry: ({ attempt, retries, delayMs, reason }) => {
          progress.clear();
          log(`⚠ ${file} wasm：${reason}，${delayMs / 1000} 秒后重试（${attempt}/${retries}）`);
          progress.restart();
        },
      });
    } finally {
      progress.clear();
    }
    const version = extractEngineVersion(wasm);
    log(`    ink_web ${version.build || version.version || '(版本未解出)'} · ${(wasm.length / 1e6).toFixed(1)}MB`);
    fresh.push({ site, build, version, wasm, wasmSha256: sha256(wasm) });
  }
  if (!fresh.length) {
    log(found.skipped.length
      ? `已检查到的引擎构建都已被 lane 收录（有 ${found.skipped.length} 个候选没能检查，结果不完整）`
      : '站点上的引擎构建都已被 lane 收录');
  }
  return { found, fresh };
}

/**
 * 逐个站点检查。一个站点查不了不该连累另一个：错误交给 onFailure 处理，其余站点照常。
 * 返回查成功的那些站点的结果。
 */
async function scanSites(sites, registry, pageDownload, onFailure) {
  const scans = [];
  for (const site of sites) {
    try {
      scans.push(await scanSite(site, registry, pageDownload));
    } catch (error) {
      onFailure(site, error);
    }
  }
  return scans;
}

/**
 * 给每个未收录的构建生成 lane 条目。放进整份清单里校验不过的（缺版本、id 冲突等）单独挑出来，不收：
 * 清单写坏了，之后所有命令都会跟着坏。
 * 正式版排在 daily 前面：清单还是空的时候，第一条就是默认 lane，不该碰巧是 daily。
 */
function planLanes(fresh, rows) {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const taken = new Set(rows.map((r) => r.id));
  const accepted = [];
  const rejected = [];
  const rank = (item) => (item.version.build ? 1 : 0);
  for (const item of [...fresh].sort((a, b) => rank(a) - rank(b))) {
    const { name, url } = item.site;
    const id = newLaneId(item.version, item.build.glueSha256, taken, name);
    const entry = laneEntry({
      id, source: url, fetchedAt, build: item.build, wasmSha256: item.wasmSha256, version: item.version, platform: name,
    });
    try {
      normalizeRuntimeRegistry([...rows, ...accepted.map((a) => a.entry), entry]);
    } catch (error) {
      rejected.push({ entry, reason: error.message });
      continue;
    }
    taken.add(id);
    accepted.push({ entry, item });
  }
  return { accepted, rejected };
}

/** 先写临时文件再改名：中途被打断也不会留下写了一半的清单。 */
async function writeLock(rows) {
  const tmp = `${RUNTIMES_LOCK_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`);
  await rename(tmp, RUNTIMES_LOCK_PATH);
}

/** 查 npm：失败不连累站点检查，交给 onFailure。返回 findNpmBuilds 的结果，失败时为 null。 */
async function scanNpm(rows, downloadOptions, onFailure) {
  log(`检查 npm ${NPM_PACKAGE}`);
  try {
    const result = await findNpmBuilds(rows, { downloadOptions, packageOptions: {}, log });
    if (!result.fresh.length) log('npm 上 latest / daily 指向的版本都已被 lane 收录');
    return result;
  } catch (error) {
    onFailure({ url: `npm ${NPM_PACKAGE}` }, error);
    return null;
  }
}

/** --discover：只读。打印 inklab-engine 会追加的条目，不写任何文件。 */
async function discoverBuilds({ sites, npm }) {
  const rows = await readRuntimeLock(RUNTIMES_LOCK_PATH);
  let failedSites = 0;
  const onFailure = (site, error) => {
    failedSites += 1;
    console.error(`[inklab] ⚠ 没能检查 ${site.url}：${error.message}`);
  };
  const npmScan = npm ? await scanNpm(rows, {}, onFailure) : null;
  const scans = await scanSites(sites, normalizeRuntimeRegistry(rows, { allowEmpty: true }), {}, onFailure);
  const fresh = scans.flatMap((scan) => scan.fresh);
  const npmFresh = npmScan?.fresh || [];
  if (!fresh.length && !npmFresh.length) {
    const skipped = scans.reduce((sum, scan) => sum + scan.found.skipped.length, 0);
    const gaps = [skipped && `${skipped} 个候选没能检查`, failedSites && `${failedSites} 个来源没能检查`].filter(Boolean);
    if (gaps.length) { // 没检查完就不能报成功，否则“没发现新构建”和“没能检查完”看起来一样
      log(`有 ${gaps.join('、')}，结果不完整（退出码 1）`);
      process.exitCode = 1;
    }
    return;
  }
  for (const { tag, entry } of npmFresh) {
    log(`未收录的 ${NPM_PACKAGE}@${tag}（${entry.engineBuild}）：inklab-engine 会把下面这条追加进 runtimes.lock.json`);
    console.log(JSON.stringify(entry, null, 2));
  }
  const { accepted, rejected } = planLanes(fresh, [...rows, ...npmFresh.map((item) => item.entry)]);
  for (const { entry } of accepted) {
    log(`未收录的 ink_web ${entry.engineBuild || entry.engineVersion}：inklab-engine 会把下面这条追加进 runtimes.lock.json`);
    console.log(JSON.stringify(entry, null, 2));
  }
  for (const { entry, reason } of rejected) log(`⚠ ${entry.glueUrl} 没法自动收录：${reason}`);
  log(`${fresh.length + npmFresh.length} 个构建没有 lane 收录（退出码 2）`);
  process.exitCode = 2;
}

/**
 * 把 npm 上还没有 lane 的版本追加进清单并落进缓存。
 * 供 inklab-engine 与启动时的自动检查共用；网络问题由调用方决定是警告还是报错。
 * @returns {Promise<string[]>} 新加的 lane id
 */
export async function recordNpmBuilds({ downloadOptions = {}, quiet = false } = {}) {
  const rows = await readRuntimeLock(RUNTIMES_LOCK_PATH);
  const progress = createProgress(NPM_PACKAGE);
  const packageOptions = {
    onProgress: progress.update,
    onRetry: ({ attempt, retries, delayMs, reason }) => {
      progress.clear();
      log(`⚠ ${NPM_PACKAGE} tarball：${reason}，${delayMs / 1000} 秒后重试（${attempt}/${retries}）`);
      progress.restart();
    },
  };
  let fresh;
  try {
    // quiet：只说要下载的新版本，不逐条报“已收录”
    const say = quiet ? (...line) => { if (!String(line[0]).trimStart().startsWith('✓')) log(...line); } : log;
    ({ fresh } = await findNpmBuilds(rows, { downloadOptions, packageOptions, log: say }));
  } finally {
    progress.clear();
  }
  if (!fresh.length) return [];
  const entries = fresh.map((item) => item.entry);
  normalizeRuntimeRegistry([...rows, ...entries]); // 写坏清单之前先校验
  for (const { entry, files } of fresh) await writeNpmLane(resolve(ENGINE_DIR, entry.cacheDir), files);
  await writeLock([...rows, ...entries]);
  return entries.map((entry) => entry.id);
}

/**
 * inklab-engine 的第一步：查 npm 与站点，把清单里没有的构建追加成新 lane，并把已经取回的字节落进缓存
 * （为了算哈希本来就得下载，不落盘就白下了）。
 * 这一步的网络问题只警告：来源查不了，不该挡住“按现有的清单装配缓存”。
 */
async function recordNewBuilds({ sites, npm }) {
  if (npm) {
    log(`检查 npm ${NPM_PACKAGE}`);
    try {
      const added = await recordNpmBuilds({ downloadOptions: SITE_CHECK_DOWNLOAD });
      log(added.length
        ? `已把 ${added.length} 条新 lane 追加到 runtimes.lock.json：${added.join('、')}`
        : 'npm 上 latest / daily 指向的版本都已被 lane 收录');
    } catch (error) {
      log(`⚠ 没能检查 npm ${NPM_PACKAGE}：${error.message}；按现有的 runtimes.lock.json 继续`);
    }
  }
  const rows = await readRuntimeLock(RUNTIMES_LOCK_PATH);
  const registry = normalizeRuntimeRegistry(rows, { allowEmpty: true });
  const scans = await scanSites(sites, registry, SITE_CHECK_DOWNLOAD, (site, error) => {
    log(`⚠ 没能检查 ${site.url}：${error.message}；按现有的 runtimes.lock.json 继续`);
  });
  const fresh = scans.flatMap((scan) => scan.fresh);
  if (!fresh.length) return;
  const { accepted, rejected } = planLanes(fresh, rows);
  for (const { entry, reason } of rejected) log(`⚠ 没能自动收录 ${entry.glueUrl}：${reason}`);
  if (!accepted.length) return;
  try {
    await writeLock([...rows, ...accepted.map((a) => a.entry)]);
  } catch (error) {
    log(`⚠ 没能把新构建写进 runtimes.lock.json：${error.message}；按现有的清单继续`);
    return;
  }
  for (const { entry, item } of accepted) {
    const root = resolve(ENGINE_DIR, entry.cacheDir);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ink-glue.js'), item.build.glue);
    await writeFile(join(root, 'engine.wasm'), item.wasm);
  }
  log(`已把 ${accepted.length} 条新 lane 追加到 runtimes.lock.json：${accepted.map((a) => a.entry.id).join('、')}`);
}

/** --list：不联网。列出本机的 lane、哪些有缓存，以及每个通道名现在指向哪条（--json 给脚本用，如 aiui doctor）。 */
async function listRuntimes({ json = false } = {}) {
  const registry = normalizeRuntimeRegistry(await readRuntimeLock(RUNTIMES_LOCK_PATH));
  const cached = [];
  for (const runtime of registry.runtimes) {
    try { await verifyCachedRuntime(runtime, resolve(ENGINE_DIR, runtime.cacheDir)); cached.push(runtime); } catch { /* 没缓存 */ }
  }
  const aliases = resolveRuntimeAliases(cached);
  if (json) {
    console.log(JSON.stringify({
      default: aliases.latest,
      aliases,
      runtimes: registry.runtimes.map((runtime) => ({
        id: runtime.id, version: runtimeDisplayVersion(runtime), cached: cached.includes(runtime),
      })),
    }, null, 2));
    return;
  }
  const pointers = new Map();
  for (const [name, id] of Object.entries(aliases)) if (id) pointers.set(id, [...(pointers.get(id) || []), name]);
  for (const runtime of registry.runtimes) {
    const mark = cached.includes(runtime) ? '✓' : '○';
    const names = pointers.get(runtime.id);
    console.log(`${mark} ${runtime.id.padEnd(40)} ${runtimeDisplayVersion(runtime).padEnd(28)}${names ? ` ← ${names.join(' / ')}` : ''}`);
  }
  console.log('');
  for (const [name, meaning] of Object.entries(RUNTIME_ALIASES)) {
    console.log(`${name.padEnd(7)} ${meaning}：${aliases[name] || '（本机没有）'}${name === 'latest' ? '（默认）' : ''}`);
  }
}

export async function main(argv) {
  if (argv.includes('--list')) {
    await listRuntimes({ json: argv.includes('--json') });
    return;
  }
  const sites = parseSites(argv);
  const npm = !argv.some((arg) => arg.startsWith('--site='));
  if (argv.includes('--discover')) {
    await discoverBuilds({ sites, npm });
    return;
  }
  if (!argv.includes('--check')) await recordNewBuilds({ sites, npm });
  await syncRuntimeMatrix({
    checkOnly: argv.includes('--check'),
    only: argv.filter((arg) => !arg.startsWith('-')),
  });
}
