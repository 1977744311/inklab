#!/usr/bin/env node
// fetch-engine.mjs — 从 js.rokid.com 现取 Ink 引擎（glue + wasm）到本地 .engine/。
//
// 为什么要现取而不是入库：引擎是 Rokid 的私有产物，没有开源许可声明，也没发布到 npm。
// 我们只是把浏览器打开 Craft 时本来就会下载的同一份文件放到本地跑自己的智能体；
// 二进制绝不进 git、绝不随工具分发。仓库里只留 engine.lock.json 的版本与哈希。
//
//   node fetch-engine.mjs            取引擎并校验 lock
//   node fetch-engine.mjs --update   接受漂移并写入新 lock
//   node fetch-engine.mjs --check    只校验旧单引擎缓存，不发网络请求
//   node fetch-engine.mjs --matrix   按 runtimes.lock.json 拉齐全部命名 lane
//   node fetch-engine.mjs --matrix --check  只校验全部 lane，不发网络请求

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractMainBundlePath, extractChunkNames, rankGlueCandidates, looksLikeGlue,
  extractWasmPath, extractEngineVersion, compareLock, pickNewestBuild,
} from './lib/engine-source.mjs';
import { normalizeRuntimeRegistry, runtimeDisplayVersion } from './lib/runtime-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
import { engineCacheDirectory } from './lib/cache-path.mjs';
const ENGINE_DIR = engineCacheDirectory();
const LOCK_PATH = join(HERE, 'engine.lock.json');
const RUNTIMES_LOCK_PATH = join(HERE, 'runtimes.lock.json');
const ORIGIN = 'https://js.rokid.com';
const CRAFT_URL = `${ORIGIN}/craft`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const log = (...a) => console.log('[inklab]', ...a);

async function get(url, { text = false } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return text ? res.text() : new Uint8Array(await res.arrayBuffer());
}

const readJson = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};

// 尾窗要够大：实测 0.17.0 的 daily 串落在离文件末尾约 2.3MB 处，窗口小了会漏成 null。
const TAIL_BYTES = 4_000_000;

/** 只取 wasm 尾部读版本：版本串靠近文件末尾，整包 15–20MB，探测阶段不值当全下。 */
async function probeVersion(wasmUrl) {
  const res = await fetch(wasmUrl, { headers: { range: `bytes=-${TAIL_BYTES}` } });
  if (!res.ok) return { version: null, build: null };
  return extractEngineVersion(new Uint8Array(await res.arrayBuffer()));
}

/**
 * 顺着 Craft 首页 → 主 bundle → 候选 chunk，找出**全部**引擎 glue。
 * Craft 同时挂着多个构建（实测 0.16.1 正式版与 0.17.0-daily 并存，
 * 运行时由 satisfiesInkEngine 按工程声明的引擎区间择一），所以这里要全收后择新。
 */
async function locateGlues() {
  const html = await get(CRAFT_URL, { text: true });
  const mainPath = extractMainBundlePath(html);
  if (!mainPath) throw new Error('Craft 首页里没找到主 bundle：站点结构可能变了');
  log(`主 bundle ${mainPath}`);

  const mainJs = await get(ORIGIN + mainPath, { text: true });
  const candidates = rankGlueCandidates(extractChunkNames(mainJs));
  if (!candidates.length) throw new Error('主 bundle 里没有可疑的 chunk：站点结构可能变了');

  const found = [];
  for (const name of candidates) {
    const path = `/assets/${name}`;
    let js;
    try { js = await get(ORIGIN + path, { text: true }); } catch { continue; }
    if (!looksLikeGlue(js)) continue;
    const wasmPath = extractWasmPath(js);
    if (!wasmPath) continue;
    const { version, build } = await probeVersion(ORIGIN + wasmPath);
    log(`  候选 ${path} → ${wasmPath}  ink_web ${build || version || '(版本未解出)'}`);
    found.push({ path, js, wasmPath, version, build });
  }
  if (!found.length) throw new Error(`试了 ${candidates.length} 个候选 chunk 都不是引擎 glue：站点结构可能变了`);
  return found;
}

async function verifyCachedRuntime(runtime, root) {
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

async function syncRuntimeMatrix({ checkOnly = false } = {}) {
  const [matrix, legacy] = await Promise.all([readJson(RUNTIMES_LOCK_PATH), readJson(LOCK_PATH)]);
  const registry = normalizeRuntimeRegistry(matrix, legacy);
  let ready = 0;
  let skipped = 0;
  for (const runtime of registry.runtimes) {
    const root = resolve(ENGINE_DIR, runtime.cacheDir);
    if (!(root === ENGINE_DIR || root.startsWith(ENGINE_DIR + sep))) {
      throw new Error(`${runtime.id} 的 cacheDir 越出 .engine：${runtime.cacheDir}`);
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
    if (!runtime.glueUrl || !runtime.wasmUrl) {
      throw new Error(`${runtime.id} 缺 glueUrl/wasmUrl，无法拉取`);
    }
    log(`拉取 ${runtime.id} · ink_web ${runtimeDisplayVersion(runtime)}`);
    const [glue, wasm] = await Promise.all([
      get(runtime.glueUrl),
      get(runtime.wasmUrl),
    ]);
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
    log(`✓ ${runtime.id} · ${(wasm.length / 1048576).toFixed(1)}MB`);
  }
  if (!ready) throw new Error('没有任何运行时 lane 可用');
  log(`${ready} 条运行时 lane ${checkOnly ? '校验通过' : '已就绪'}${skipped ? ` · ${skipped} 条 cache-only 缺席` : ''}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const lock = await readJson(LOCK_PATH);

  if (args.has('--matrix')) {
    await syncRuntimeMatrix({ checkOnly: args.has('--check') });
    return;
  }

  if (args.has('--check')) {
    if (!lock) { console.error('[inklab] 还没有 engine.lock.json，先跑一次不带 --check 的取引擎'); process.exit(1); }
    for (const [file, want] of [['ink-glue.js', lock.glueSha256], ['engine.wasm', lock.wasmSha256]]) {
      const p = join(ENGINE_DIR, file);
      try { await stat(p); } catch { console.error(`[inklab] 缺 ${file}，请重新取引擎`); process.exit(1); }
      const got = sha256(await readFile(p));
      if (got !== want) { console.error(`[inklab] ${file} 哈希与 lock 不符\n  lock ${want}\n  盘上 ${got}`); process.exit(1); }
    }
    log(`引擎校验通过：ink_web ${lock.engineBuild || lock.engineVersion}`);
    return;
  }

  const glues = await locateGlues();
  const chosen = pickNewestBuild(glues) || glues[0];
  if (glues.length > 1) {
    log(`站点挂着 ${glues.length} 个引擎构建，取最新：ink_web ${chosen.build || chosen.version}`);
  }
  log(`引擎 wasm ${chosen.wasmPath}（体积较大，稍候）`);
  const wasm = await get(ORIGIN + chosen.wasmPath);

  // 拿到完整 wasm 后按完整内容复算一次，lock 里的版本不受尾窗大小影响。
  const full = extractEngineVersion(wasm);
  const actual = {
    engineVersion: full.version || chosen.version,
    engineBuild: full.build || chosen.build,
    gluePath: chosen.path,
    glueSha256: sha256(Buffer.from(chosen.js, 'utf8')),
    wasmPath: chosen.wasmPath,
    wasmSha256: sha256(wasm),
  };

  const cmp = compareLock(lock, actual);
  if (cmp.status === 'drift' && !args.has('--update')) {
    console.error('[inklab] 引擎与 engine.lock.json 不符（Craft 发过新版）：');
    for (const c of cmp.changes) console.error(`  ${c.key}\n    lock ${c.was}\n    线上 ${c.now}`);
    console.error('[inklab] 确认要跟进新版就加 --update 重跑；不确认则先停下，别让本地悄悄跑在另一个引擎上。');
    process.exit(2);
  }

  await mkdir(ENGINE_DIR, { recursive: true });
  // glue 默认按 import.meta.url 去找 /assets/ink_web_bg-*.wasm；本地统一改名，
  // 宿主再用 initInk({wasmUrl}) 显式指定，避免依赖站点目录结构。
  await writeFile(join(ENGINE_DIR, 'ink-glue.js'), chosen.js, 'utf8');
  await writeFile(join(ENGINE_DIR, 'engine.wasm'), wasm);

  if (cmp.status !== 'match') {
    await writeFile(LOCK_PATH, `${JSON.stringify({
      note: '引擎二进制不入库，只锁版本与哈希。见 README.md',
      source: CRAFT_URL,
      fetchedAt: new Date().toISOString().slice(0, 10),
      ...actual,
    }, null, 2)}\n`, 'utf8');
    log(`已写入 engine.lock.json（${cmp.status === 'absent' ? '首次' : '已更新'}）`);
  }
  log(`引擎就绪：ink_web ${actual.engineBuild || actual.engineVersion} · wasm ${(wasm.length / 1048576).toFixed(1)}MB`);
}

main().catch((err) => { console.error('[inklab]', err.message); process.exit(1); });
