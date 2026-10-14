// `npm run engine` 的站点检查：在官方的两个平台（Craft、AIUI Studio）上找引擎构建，与 runtimes.lock.json 的 lane 比对，
// 没收录的追加成新 lane（`--discover` 是只读的演练）。
//
// 前半是纯函数（来自旧抓取器，行为不变）；后半把 bin/ 与 lib/ 复制到临时目录，
// 对着本地假站点真跑命令行，所以不碰外网。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  extractMainBundlePath, extractChunkNames, rankGlueCandidates, looksLikeGlue, extractWasmPath, laneEntry, newLaneId,
} from '../lib/node/engine-discovery.mjs';
import { normalizeRuntimeRegistry } from '../lib/runtime-lock.mjs';

// ── 纯函数 ──────────────────────────────────────────────────────────────

test('从站点首页取主 bundle 路径', () => {
  const html = '<head><link href="/assets/index-X.css"><script type="module" crossorigin src="/assets/index-fGBNsmlf.js"></script></head>';
  assert.equal(extractMainBundlePath(html), '/assets/index-fGBNsmlf.js');
  assert.equal(extractMainBundlePath('<html></html>'), null);
});

test('抽出动态 import 的 chunk 名并按可疑度排序(index-* 优先)', () => {
  const js = `a(()=>import("./flowDiagram-PKNHOUZH-D5IXPmuC.js"));b(()=>import("./index-D_EpyLZO.js"));
    c(()=>import("./nls.messages.zh-cn-DjCDCmFK.js"));d(()=>import("./index-CRZKnqBI.js"));
    e(()=>import("./index-D_EpyLZO.js"))`;
  const names = extractChunkNames(js);
  assert.equal(names.length, 4, '同名 chunk 去重');
  // 图表与语言包被噪声表滤掉，只剩两个 index-*
  assert.deepEqual(rankGlueCandidates(names), ['index-CRZKnqBI.js', 'index-D_EpyLZO.js']);
});

test('glue 识别要求 wasm 路径 + initInk + createInkView 三者同时具备', () => {
  const real = 'new URL("/assets/ink_web_bg-Cv9NP4M6.wasm",import.meta.url);function initInk(){}createInkView()';
  assert.equal(looksLikeGlue(real), true);
  assert.equal(looksLikeGlue('createInkView() 但没有 wasm'), false);
  assert.equal(looksLikeGlue('/assets/ink_web_bg-X.wasm 但没有入口'), false);
  assert.equal(looksLikeGlue(''), false);
});

test('从 glue 抽 wasm 资源路径', () => {
  assert.equal(extractWasmPath('n.wasmUrl||new URL("/assets/ink_web_bg-Cv9NP4M6.wasm",import.meta.url)'),
    '/assets/ink_web_bg-Cv9NP4M6.wasm');
  assert.equal(extractWasmPath('no wasm here'), null);
});

test('新 lane 的 id：daily 用构建戳，正式版用版本号；被占用就接哈希前 8 位；版本全缺时用哈希；只允许小写', () => {
  const hash = 'abcdef0123456789';
  assert.equal(newLaneId({ version: '0.19.0', build: '0.19.0-daily.202609230326' }, hash, new Set()),
    'craft-0.19.0-daily.202609230326');
  assert.equal(newLaneId({ version: '0.18.0', build: null }, hash, new Set()), 'craft-0.18.0');
  assert.equal(newLaneId({ version: '0.18.0', build: null }, hash, new Set(['craft-0.18.0'])), 'craft-0.18.0-abcdef01');
  assert.equal(newLaneId({ version: null, build: null }, hash, new Set()), 'craft-abcdef01');
  assert.equal(newLaneId({ version: '0.18.0-RC1', build: null }, hash, new Set()), 'craft-0.18.0-rc1');
});

test('lane 条目：daily 带构建戳，正式版没有；字段顺序固定（手写条目照着写），能原样通过清单校验', () => {
  const base = {
    id: 'craft-x', source: 'https://site.example/craft', fetchedAt: '2026-10-14', wasmSha256: 'w',
    build: { glueUrl: 'https://site.example/assets/g.js', glueSha256: 'g', wasmUrl: 'https://site.example/assets/x.wasm' },
  };
  const daily = laneEntry({ ...base, version: { version: '0.19.0', build: '0.19.0-daily.202609230326' } });
  assert.equal(daily.channel, 'daily');
  assert.equal(daily.engineBuild, '0.19.0-daily.202609230326');
  assert.equal(daily.label, 'Craft 0.19.0-daily.202609230326');
  assert.equal(daily.cacheDir, 'runtimes/craft-x');
  const stable = laneEntry({ ...base, version: { version: '0.18.0', build: null } });
  assert.equal(stable.channel, 'stable');
  assert.equal(stable.engineBuild, null);

  assert.deepEqual(Object.keys(daily), [
    'id', 'label', 'channel', 'cacheDir', 'source', 'fetchedAt', 'engineVersion', 'engineBuild',
    'glueUrl', 'glueSha256', 'wasmUrl', 'wasmSha256',
  ], '字段与顺序是手写条目（docs/guide.md）的样板，改它要连文档一起改');
  assert.equal(normalizeRuntimeRegistry([daily]).runtimes[0].id, 'craft-x');
});

test('Studio 的首页与 glue 引用 CDN 上的绝对地址：按原样取出；不在 /assets/ 下的外部脚本不是主 bundle', () => {
  const cdn = 'https://static.example.com/prod/studio/1.1.15/assets';
  assert.equal(extractMainBundlePath(`<script type="module" crossorigin src="${cdn}/index-CAFwGJn5.js"></script>`),
    `${cdn}/index-CAFwGJn5.js`);
  const mixed = '<script src="https://analytics.example.com/tracker.js"></script><script src="/assets/index-X.js"></script>';
  assert.equal(extractMainBundlePath(mixed), '/assets/index-X.js');
  assert.equal(extractMainBundlePath('<script src="https://analytics.example.com/tracker.js"></script>'), null);

  assert.equal(extractWasmPath(`new URL("${cdn}/ink_web_bg-CqhCECis.wasm",import.meta.url)`),
    `${cdn}/ink_web_bg-CqhCECis.wasm`);
});

test('新 lane 的 id 与标签带站点名：同一个版本在两个平台各是一条 lane；被占用时仍接哈希前 8 位', () => {
  const hash = 'abcdef0123456789';
  const version = { version: '0.19.0', build: '0.19.0-daily.202610080438' };
  assert.equal(newLaneId(version, hash, new Set(), 'studio'), 'studio-0.19.0-daily.202610080438');
  assert.equal(newLaneId(version, hash, new Set(['craft-0.19.0-daily.202610080438']), 'studio'),
    'studio-0.19.0-daily.202610080438', '别的平台的同版本不算占用');
  assert.equal(newLaneId(version, hash, new Set(['studio-0.19.0-daily.202610080438']), 'studio'),
    'studio-0.19.0-daily.202610080438-abcdef01');

  const entry = laneEntry({
    id: 'studio-x', source: 'https://aiui.example/', fetchedAt: '2026-10-14', wasmSha256: 'w', version, platform: 'studio',
    build: { glueUrl: 'https://cdn.example/assets/g.js', glueSha256: 'g', wasmUrl: 'https://cdn.example/assets/x.wasm' },
  });
  assert.equal(entry.label, 'Studio 0.19.0-daily.202610080438');
  assert.equal(normalizeRuntimeRegistry([entry]).runtimes[0].id, 'studio-x');
});

// ── 命令行 × 本地假站点 ──────────────────────────────────────────────────

const glueFor = (wasm) => Buffer.from(
  `const u=new URL("/assets/${wasm}",import.meta.url);function initInk(){}function createInkView(){}\n`,
);
const GLUE_A = glueFor('ink_web_bg-AAAA.wasm');
const GLUE_B = glueFor('ink_web_bg-BBBB.wasm');
const GLUE_C = glueFor('ink_web_bg-CCCC.wasm');
const GLUE_S = glueFor('ink_web_bg-SSSS.wasm');
const filler = (n) => Buffer.alloc(n, 7);
const WASM_A = filler(100);
const WASM_B = Buffer.concat([filler(2000), Buffer.from('0.19.0-daily.202609230326InkView is destroyed'), filler(500)]);
const WASM_C = filler(300); // 没有版本锚点：读不出版本
const WASM_S = Buffer.concat([filler(1500), Buffer.from('0.18.0Bundle file value must be a string or Uint8Array'), filler(400)]); // 正式版：只有语义版本
// Studio 的 daily：新布局，两处静态文案前面不再紧挨版本串，版本只在引擎版本表的 `ink<构建戳>skia` 里。
const WASM_D = Buffer.concat([
  filler(1800),
  Buffer.from('\0Bundle file value must be a string or Uint8Array\0\0InkView is destroyed\0\0ink0.19.0-daily.202610080438skia\0'),
  filler(300),
]);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const B_ID = 'craft-0.19.0-daily.202609230326';
const S_ID = 'craft-0.18.0';
const D_ID = 'studio-0.19.0-daily.202610080438';

const page = (mainPath) => `<html><head><script type="module" crossorigin src="${mainPath}"></script></head></html>`;
const imports = (...names) => names.map((n) => `import("./${n}")`).join(';');

let scratch;
let tool;
let server;
let base;
let hits = {};
let GLUE_D; // Studio 的 glue 里写的是带端口的绝对地址，端口要等假站点开始监听之后才知道
// Studio 的资源都在 CDN 上：路径前缀与 Craft 的 /assets/ 不同，首页与 glue 里引用它们用的是绝对地址。
const CDN = '/cdn/1.1.15/assets';

// 假站点：/craft 是正常站点（A、B 两个构建）；/partial 的主 bundle 里多引了一个已经下线（404）的 chunk；
// /noglue 里没有任何 glue；/broken 的首页没有主 bundle；/versionless 的构建读不出版本；
// /fresh 挂着一个 daily（B）和一个正式版（S），daily 排在前面。
const routes = {
  '/craft': page('/assets/index-main.js'),
  '/assets/index-main.js': imports('index-glue-a.js', 'index-glue-b.js', 'index-other.js',
    'flowDiagram-ABC.js', 'nls.messages.zh-cn-ABC.js'),
  '/partial': page('/assets/index-partial.js'),
  '/assets/index-partial.js': imports('index-glue-b.js', 'index-gone.js'),
  '/noglue': page('/assets/index-noglue.js'),
  '/assets/index-noglue.js': imports('index-other.js'),
  '/broken': '<html><body>没有主 bundle</body></html>',
  '/versionless': page('/assets/index-versionless.js'),
  '/assets/index-versionless.js': imports('index-glue-c.js'),
  '/fresh': page('/assets/index-fresh.js'),
  '/assets/index-fresh.js': imports('index-glue-b.js', 'index-glue-s.js'),
  '/assets/index-glue-a.js': GLUE_A,
  '/assets/index-glue-b.js': GLUE_B,
  '/assets/index-glue-c.js': GLUE_C,
  '/assets/index-glue-s.js': GLUE_S,
  // 干扰项：有 wasm 路径、也提到 createInkView，但没有 initInk —— 不是 glue，不能生成 lane 条目
  '/assets/index-other.js': 'new URL("/assets/ink_web_bg-ZZZZ.wasm",import.meta.url);function createInkView(){}',
  '/assets/ink_web_bg-AAAA.wasm': WASM_A,
  '/assets/ink_web_bg-BBBB.wasm': WASM_B,
  '/assets/ink_web_bg-CCCC.wasm': WASM_C,
  '/assets/ink_web_bg-SSSS.wasm': WASM_S,
};

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inklab-discover-'));
  tool = join(scratch, 'tool');
  await cp(new URL('../bin', import.meta.url), join(tool, 'bin'), { recursive: true });
  await cp(new URL('../lib', import.meta.url), join(tool, 'lib'), { recursive: true });
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const body = routes[req.url];
    if (body === undefined) { res.writeHead(404); return res.end('x'); }
    res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
    return res.end(body);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // /studio：只有 daily（D）是独立的 chunk；正式版的引擎内联在主 bundle 里（没有独立 glue，记不成 lane），
  // 所以主 bundle 本身长得像 glue，却不该被当成候选，它引用的 wasm 也不该被请求。
  GLUE_D = Buffer.from(
    `const w=new URL("${base}${CDN}/ink_web_bg-DDDD.wasm",import.meta.url);const a="${base}${CDN}/ink-audio-worklet-X.js";`
    + 'function initInk(){}function createInkView(){}\n',
  );
  Object.assign(routes, {
    '/studio': page(`${base}${CDN}/index-studio.js`),
    [`${CDN}/index-studio.js`]: `${imports('index-glue-d.js', 'html2canvas.esm-ABC.js')};`
      + `new URL("${base}${CDN}/ink_web_bg-INLINE.wasm",import.meta.url);function initInk(){}function createInkView(){}`,
    [`${CDN}/index-glue-d.js`]: GLUE_D,
    [`${CDN}/html2canvas.esm-ABC.js`]: 'export default 1', // 不是 glue 的候选 chunk：看一眼就放过
    [`${CDN}/ink_web_bg-DDDD.wasm`]: WASM_D,
    '/craft?v=1': routes['/craft'], // url 里带 = 的站点地址
  });
});

after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => { server?.close(resolve) || resolve(); });
  await rm(scratch, { recursive: true, force: true });
});

const lockEntry = ({ id, glue, wasm }) => ({
  id, label: id, channel: 'custom', cacheDir: `runtimes/${id}`, engineVersion: '9.9.9',
  glueSha256: sha256(glue), wasmSha256: sha256(wasm),
});

const LOCK_PATH = () => join(tool, 'runtimes.lock.json');
const siteFlags = (sites) => sites.map((site) => `--site=${site}`);

/** 真跑命令行；返回退出码、输出，以及跑完后的清单原文（没有清单文件时是 null）。 */
async function spawnEngine(args, cache, { fetchStub } = {}) {
  // 不写 --site 时检查的是真实的官方站点：漏写一次，测试就悄悄连了外网（--check 不联网，不用写；
  // fetchStub 把 fetch 换成了只记地址的桩，也不会联网）。
  assert.ok(fetchStub || args.includes('--check') || args.some((arg) => arg.startsWith('--site=')), `漏了 --site：${args.join(' ')}`);
  hits = {};
  const preload = fetchStub ? ['--import', pathToFileURL(fetchStub).href] : [];
  const child = spawn(process.execPath, [...preload, join(tool, 'bin/inklab-engine.mjs'), ...args], {
    env: { ...process.env, INKLAB_ENGINE_DIR: cache }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code] = await once(child, 'close');
  clearTimeout(guard);
  return { code, stdout, stderr, cache, lockAfter: await readFile(LOCK_PATH(), 'utf8').catch(() => null) };
}

/**
 * 摆好场景再真跑：清单里有 lanes（各自已在缓存里），站点检查指向假站点 url。
 * 清单按手写的样子缩进 2 空格、末尾带换行，这样才能验证“只追加”是字节级的。
 */
async function engine(args, lanes, { url = `${base}/craft`, sites = [url], fetchStub } = {}) {
  const lock = `${JSON.stringify(lanes.map(lockEntry), null, 2)}\n`;
  await writeFile(LOCK_PATH(), lock);
  const cache = await mkdtemp(join(scratch, 'cache-'));
  for (const { id, glue, wasm } of lanes) {
    const dir = join(cache, 'runtimes', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ink-glue.js'), glue);
    await writeFile(join(dir, 'engine.wasm'), wasm);
  }
  return { lockBefore: lock, ...(await spawnEngine([...args, ...siteFlags(sites)], cache, { fetchStub })) };
}

/** 全新 clone：没有清单文件，缓存是空的。lockText 给了就把它当清单原文写下去（用来造坏清单）。 */
async function freshClone(args, { url = `${base}/craft`, sites = [url], lockText = null } = {}) {
  await rm(LOCK_PATH(), { force: true });
  if (lockText !== null) await writeFile(LOCK_PATH(), lockText);
  const cache = await mkdtemp(join(scratch, 'cache-'));
  return spawnEngine([...args, ...siteFlags(sites)], cache);
}

const KNOWN_A = { id: 'known-a', glue: GLUE_A, wasm: WASM_A };
const exists = (path) => stat(path).then(() => true, () => false);
const entryOf = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));

// ── --discover：只读的演练 ──

/** --discover 的场景：缓存是空的（它本来就不该碰缓存）。site 是 /路径（查那一个站点），或者一组完整的 --site 值。 */
async function discover(lanes, site = '/craft') {
  const lock = JSON.stringify(lanes.map(lockEntry));
  await writeFile(LOCK_PATH(), lock);
  const cache = await mkdtemp(join(scratch, 'cache-'));
  const run = await spawnEngine(['--discover', ...siteFlags(Array.isArray(site) ? site : [`${base}${site}`])], cache);
  return { ...run, lockBefore: lock, cacheFiles: await readdir(cache) };
}

test('--discover 发现未收录的构建：只取它的 wasm 算哈希，打印会被追加的条目，退出码 2，不写任何文件', async () => {
  const run = await discover([KNOWN_A]);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /✓ index-glue-a\.js {2}已收录为 known-a/);
  assert.match(run.stdout, /✗ index-glue-b\.js {2}没有任何 lane 收录它/);
  assert.match(run.stdout, /npm run engine 会把下面这条追加进 runtimes\.lock\.json/);

  const entry = entryOf(run.stdout);
  assert.equal(entry.id, B_ID);
  assert.equal(entry.cacheDir, `runtimes/${B_ID}`);
  assert.equal(entry.engineVersion, '0.19.0');
  assert.equal(entry.engineBuild, '0.19.0-daily.202609230326');
  assert.equal(entry.channel, 'daily');
  assert.equal(entry.source, `${base}/craft`);
  assert.equal(entry.glueUrl, `${base}/assets/index-glue-b.js`);
  assert.equal(entry.glueSha256, sha256(GLUE_B));
  assert.equal(entry.wasmUrl, `${base}/assets/ink_web_bg-BBBB.wasm`);
  assert.equal(entry.wasmSha256, sha256(WASM_B));

  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], 1);
  assert.equal(hits['/assets/ink_web_bg-AAAA.wasm'], undefined, '已收录的构建不需要它的 wasm');
  assert.doesNotMatch(run.stdout, /index-other\.js/, '只像 glue 的干扰项不算构建');
  assert.equal(hits['/assets/ink_web_bg-ZZZZ.wasm'], undefined);
  assert.equal(hits['/assets/flowDiagram-ABC.js'], undefined, '噪声 chunk 不该被请求');
  assert.equal(hits['/assets/nls.messages.zh-cn-ABC.js'], undefined);
  assert.equal(run.lockAfter, run.lockBefore, '只读：不改 lock');
  assert.deepEqual(run.cacheFiles, [], '只读：不往缓存目录写东西');
});

test('--discover 全部构建都已收录：退出码 0，一个 wasm 都不下载', async () => {
  const run = await discover([KNOWN_A, { id: 'known-b', glue: GLUE_B, wasm: WASM_B }]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /站点上的引擎构建都已被 lane 收录/);
  assert.doesNotMatch(run.stdout, /✗|\{/);
  assert.equal(hits['/assets/ink_web_bg-AAAA.wasm'], undefined);
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], undefined);
});

test('--discover 有候选 chunk 取不到：明说结果不完整；全部已收录时也不能报成功', async () => {
  const complete = await discover([{ id: 'known-b', glue: GLUE_B, wasm: WASM_B }], '/partial');
  assert.equal(complete.code, 1, complete.stdout + complete.stderr);
  assert.match(complete.stdout, /⚠ 没能检查 .*index-gone\.js：.*HTTP 404.*结果可能不完整/);
  assert.match(complete.stdout, /1 个候选没能检查，结果不完整（退出码 1）/);

  const found = await discover([KNOWN_A], '/partial');
  assert.equal(found.code, 2, '发现了未收录的构建，仍以 2 为准');
  assert.match(found.stdout, /⚠ 没能检查 .*index-gone\.js/);
});

test('--discover 站点结构变了：首页没有主 bundle / 候选里没有 glue，都明确报错（退出码 1），不装作没有新构建', async () => {
  const broken = await discover([KNOWN_A], '/broken');
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /没找到主 bundle：站点结构可能变了/);

  const noglue = await discover([KNOWN_A], '/noglue');
  assert.equal(noglue.code, 1);
  assert.match(noglue.stderr, /都不是引擎 glue：站点结构可能变了/);
});

// ── npm run engine：查站点 → 追加新 lane → 装配 ──

test('npm run engine 发现未收录的构建：追加成新 lane、字节落进缓存、wasm 只下一次；再跑一次什么都不变', async () => {
  const run = await engine([], [KNOWN_A]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`已把 1 条新 lane 追加到 runtimes\\.lock\\.json：${B_ID.replaceAll('.', '\\.')}`));

  const before = JSON.parse(run.lockBefore);
  const after = JSON.parse(run.lockAfter);
  assert.deepEqual(after.slice(0, 1), before, '已有条目原样不动');
  assert.equal(after.length, 2);
  const { fetchedAt, ...added } = after[1];
  assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(added, {
    id: B_ID, label: 'Craft 0.19.0-daily.202609230326', channel: 'daily', cacheDir: `runtimes/${B_ID}`,
    source: `${base}/craft`, engineVersion: '0.19.0', engineBuild: '0.19.0-daily.202609230326',
    glueUrl: `${base}/assets/index-glue-b.js`, glueSha256: sha256(GLUE_B),
    wasmUrl: `${base}/assets/ink_web_bg-BBBB.wasm`, wasmSha256: sha256(WASM_B),
  });
  // 字节级“只追加”：旧文件除了收尾的 `]` 之外，是新文件的前缀；格式也和手写的一样
  assert.ok(run.lockAfter.startsWith(run.lockBefore.slice(0, run.lockBefore.lastIndexOf('\n]'))));
  assert.equal(run.lockAfter, `${JSON.stringify(after, null, 2)}\n`);
  assert.equal(await exists(join(tool, 'runtimes.lock.json.tmp')), false, '不留临时文件');

  const dir = join(run.cache, added.cacheDir);
  assert.ok((await readFile(join(dir, 'ink-glue.js'))).equals(GLUE_B));
  assert.ok((await readFile(join(dir, 'engine.wasm'))).equals(WASM_B));
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], 1, '新构建的 wasm 只下载一次，装配时直接用落盘的');
  assert.equal(hits['/assets/ink_web_bg-AAAA.wasm'], undefined, '已收录构建的 wasm 不下载');
  assert.match(run.stdout, new RegExp(`✓ ${B_ID.replaceAll('.', '\\.')} · 已有锁定缓存`));
  assert.match(run.stdout, /2 条运行时 lane 已就绪/);

  const again = await spawnEngine([`--site=${base}/craft`], run.cache);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.lockAfter, run.lockAfter, '再跑一次：lock 一个字节都不变');
  assert.match(again.stdout, /站点上的引擎构建都已被 lane 收录/);
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], undefined);
  assert.equal(hits['/assets/ink_web_bg-AAAA.wasm'], undefined);
});

test('npm run engine 站点连不上或结构变了：只警告，照常按锁装配，锁不动，而且很快放弃', async () => {
  const startedAt = Date.now();
  const refused = await engine([], [KNOWN_A], { url: 'http://127.0.0.1:1/craft' });
  assert.equal(refused.code, 0, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /⚠ 没能检查 http:\/\/127\.0\.0\.1:1\/craft：.*按现有的 runtimes\.lock\.json 继续/);
  assert.match(refused.stdout, /known-a · 已有锁定缓存/);
  assert.equal(refused.lockAfter, refused.lockBefore);
  assert.ok(Date.now() - startedAt < 6000, `断网时不该为查站点等很久（用了 ${Date.now() - startedAt}ms）`);

  const broken = await engine([], [KNOWN_A], { url: `${base}/broken` });
  assert.equal(broken.code, 0, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /⚠ 没能检查 .*没找到主 bundle.*按现有的 runtimes\.lock\.json 继续/);
  assert.match(broken.stdout, /1 条运行时 lane 已就绪/);
  assert.equal(broken.lockAfter, broken.lockBefore);
});

test('npm run engine 有候选 chunk 取不到：不说“都已收录”（没检查完），照常装配', async () => {
  const run = await engine([], [{ id: 'known-b', glue: GLUE_B, wasm: WASM_B }], { url: `${base}/partial` });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /⚠ 没能检查 .*index-gone\.js/);
  assert.match(run.stdout, /已检查到的引擎构建都已被 lane 收录（有 1 个候选没能检查，结果不完整）/);
  assert.doesNotMatch(run.stdout, /站点上的引擎构建都已被 lane 收录/);
  assert.match(run.stdout, /1 条运行时 lane 已就绪/);
  assert.equal(run.lockAfter, run.lockBefore);
});

test('npm run engine --check：即使给了站点也不发任何网络请求（不查站点），不改清单', async () => {
  const run = await engine(['--check'], [KNOWN_A]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /✓ known-a/);
  assert.deepEqual(hits, {});
  assert.equal(run.lockAfter, run.lockBefore);
});

test('npm run engine 按名字拉：同样先查站点并追加，装配只做点名的 lane', async () => {
  const run = await engine(['known-a'], [KNOWN_A]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /已把 1 条新 lane 追加到 runtimes\.lock\.json/);
  assert.match(run.stdout, /1 条运行时 lane 已就绪/);
  assert.equal(JSON.parse(run.lockAfter).length, 2);
});

test('npm run engine 版本读不出来的构建：不自动收录，说明原因，锁不动，其它照常', async () => {
  const run = await engine([], [KNOWN_A], { url: `${base}/versionless` });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /⚠ 没能自动收录 .*index-glue-c\.js：运行时 craft-[0-9a-f]{8} 缺版本/);
  assert.doesNotMatch(run.stdout, /已把 \d+ 条新 lane 追加/);
  assert.equal(run.lockAfter, run.lockBefore);
  assert.deepEqual(await readdir(join(run.cache, 'runtimes')), ['known-a'], '没收录的构建不往缓存里放东西');
  assert.match(run.stdout, /1 条运行时 lane 已就绪/);
});

test('npm run engine 新 lane 的 id 已被占用（同版本、不同字节）：接上哈希前 8 位，追加后 lock 仍然合法', async () => {
  const squatter = { id: B_ID, glue: GLUE_A, wasm: WASM_A }; // 占着 id，但字节与站点上的 B 不同
  const run = await engine([], [squatter]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const ids = JSON.parse(run.lockAfter).map((r) => r.id);
  assert.deepEqual(ids, [B_ID, `${B_ID}-${sha256(GLUE_B).slice(0, 8)}`]);

  const check = await spawnEngine(['--check'], run.cache);
  assert.equal(check.code, 0, '追加之后整份 lock 与缓存都应该通过校验：' + check.stdout + check.stderr);
});

// ── 全新 clone：清单和缓存都还没有 ──

const re = (text) => text.replaceAll('.', '\\.');

test('全新 clone（没有清单）：凭站点生成清单，正式版排第一当默认，字节落进缓存；再跑零变化，--check 通过', async () => {
  const site = `${base}/fresh`;
  const run = await freshClone([], { url: site });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`已把 2 条新 lane 追加到 runtimes\\.lock\\.json：${re(S_ID)}、${re(B_ID)}`));

  const rows = JSON.parse(run.lockAfter);
  assert.deepEqual(rows.map((r) => r.id), [S_ID, B_ID], '站点上 daily 排在前面，清单里正式版要排第一：第一条就是默认 lane');
  assert.equal(normalizeRuntimeRegistry(rows).default, S_ID);
  assert.equal(run.lockAfter, `${JSON.stringify(rows, null, 2)}\n`, '清单就是一个数组，缩进 2 空格、末尾换行');
  for (const [row, glue, wasm] of [[rows[0], GLUE_S, WASM_S], [rows[1], GLUE_B, WASM_B]]) {
    assert.ok((await readFile(join(run.cache, row.cacheDir, 'ink-glue.js'))).equals(glue), row.id);
    assert.ok((await readFile(join(run.cache, row.cacheDir, 'engine.wasm'))).equals(wasm), row.id);
  }
  assert.equal(hits['/assets/ink_web_bg-SSSS.wasm'], 1, 'wasm 只下一次');
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], 1);
  assert.equal(await exists(join(tool, 'runtimes.lock.json.tmp')), false, '不留临时文件');

  const again = await spawnEngine([`--site=${site}`], run.cache);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.lockAfter, run.lockAfter, '再跑一次：清单一个字节都不变');
  assert.equal(hits['/assets/ink_web_bg-SSSS.wasm'], undefined);
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], undefined);

  const check = await spawnEngine(['--check'], run.cache);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /2 条运行时 lane 校验通过/);
});

test('--discover 在没有清单时照样能用：列出会生成的全部条目，不创建清单也不写缓存', async () => {
  await rm(LOCK_PATH(), { force: true });
  const cache = await mkdtemp(join(scratch, 'cache-'));
  const run = await spawnEngine(['--discover', `--site=${base}/fresh`], cache);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.equal(run.stdout.match(/会把下面这条追加进 runtimes\.lock\.json/g).length, 2);
  assert.equal(run.lockAfter, null);
  assert.deepEqual(await readdir(cache), []);
});

test('没有清单、站点又连不上：不创建任何文件，退出码 1，并说怎么办', async () => {
  const run = await freshClone([], { url: 'http://127.0.0.1:1/craft' });
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /⚠ 没能检查 http:\/\/127\.0\.0\.1:1\/craft/);
  assert.match(run.stderr, /runtimes\.lock\.json 里还没有运行时：联网后运行 npm run engine/);
  assert.equal(run.lockAfter, null);
  assert.deepEqual(await readdir(run.cache), []);
});

test('没有清单时 --check：不发请求，说怎么生成', async () => {
  const run = await freshClone(['--check']);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /runtimes\.lock\.json 里还没有运行时：联网后运行 npm run engine/);
  assert.deepEqual(hits, {});
  assert.equal(run.lockAfter, null);
});

test('清单坏了（不是合法 JSON / 还是旧格式的对象）：明说哪里不对，不动它，也不去站点那边忙活', async () => {
  const broken = '[{"id": "a",]';
  const badJson = await freshClone([], { lockText: broken });
  assert.equal(badJson.code, 1, badJson.stdout + badJson.stderr);
  assert.match(badJson.stderr, /runtimes\.lock\.json 不是合法的 JSON/);
  assert.equal(badJson.lockAfter, broken);
  assert.deepEqual(hits, {});

  const oldFormat = '{ "default": "a", "runtimes": [] }';
  const old = await freshClone([], { lockText: oldFormat });
  assert.equal(old.code, 1, old.stdout + old.stderr);
  assert.match(old.stderr, /应该是一个 lane 数组/);
  assert.equal(old.lockAfter, oldFormat);
  assert.deepEqual(hits, {});
});

// ── 两个平台：Craft + AIUI Studio ──
// 官方两个平台都在用，各自发布自己的引擎构建，所以每次都要两边一起查。

const knownD = () => ({ id: 'known-d', glue: GLUE_D, wasm: WASM_D });
const DOWN = 'http://127.0.0.1:1/craft'; // 连不上的站点

test('默认检查官方的两个平台：Craft 与 AIUI Studio；给了 --site 就只查给的（桩记下全部请求，只放行本机，不联网）', async () => {
  const stub = join(scratch, 'record-fetch.mjs');
  await writeFile(stub, [
    "import { appendFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = async (url, init) => {',
    '  appendFileSync(`${fileURLToPath(import.meta.url)}.log`, `${url}\\n`);',
    "  if (!String(url).startsWith('http://127.0.0.1:')) throw new TypeError('fetch failed');",
    '  return realFetch(url, init);',
    '};',
  ].join('\n'));
  const requestedUrls = async () => [...new Set((await readFile(`${stub}.log`, 'utf8')).trim().split('\n'))];

  const bare = await engine([], [KNOWN_A], { sites: [], fetchStub: stub });
  assert.equal(bare.code, 0, bare.stdout + bare.stderr);
  assert.deepEqual(await requestedUrls(), ['https://js.rokid.com/craft', 'https://aiui.rokid.com/']);
  assert.match(bare.stdout, /⚠ 没能检查 https:\/\/js\.rokid\.com\/craft：/);
  assert.match(bare.stdout, /⚠ 没能检查 https:\/\/aiui\.rokid\.com\/：/);
  assert.match(bare.stdout, /known-a · 已有锁定缓存/, '两个站点都查不了也照常按清单装配');
  assert.equal(bare.lockAfter, bare.lockBefore);

  await rm(`${stub}.log`);
  const given = await engine([], [KNOWN_A], { sites: [`studio=${base}/studio`], fetchStub: stub });
  assert.equal(given.code, 0, given.stdout + given.stderr);
  const requested = await requestedUrls();
  assert.ok(requested.includes(`${base}/studio`));
  assert.ok(requested.every((url) => url.startsWith(`${base}/`)), `给了 --site 就不再查默认的站点：${requested.join(' ')}`);
});

test('Studio 的页面结构（主 bundle、glue、wasm 都在 CDN 上，写的是绝对地址）：认得出，lane 以 studio- 打头；内联在主 bundle 里的引擎不算', async () => {
  const run = await discover([KNOWN_A], [`studio=${base}/studio`]);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.equal(run.stdout.match(/会把下面这条追加进 runtimes\.lock\.json/g).length, 1);

  const entry = entryOf(run.stdout);
  assert.equal(entry.id, D_ID);
  assert.equal(entry.label, 'Studio 0.19.0-daily.202610080438');
  assert.equal(entry.engineVersion, '0.19.0', '新布局的 daily：版本从引擎版本表里的构建戳读出');
  assert.equal(entry.engineBuild, '0.19.0-daily.202610080438');
  assert.equal(entry.channel, 'daily');
  assert.equal(entry.source, `${base}/studio`);
  assert.equal(entry.glueUrl, `${base}${CDN}/index-glue-d.js`);
  assert.equal(entry.glueSha256, sha256(GLUE_D));
  assert.equal(entry.wasmUrl, `${base}${CDN}/ink_web_bg-DDDD.wasm`);
  assert.equal(entry.wasmSha256, sha256(WASM_D));

  assert.equal(hits[`${CDN}/ink_web_bg-DDDD.wasm`], 1);
  assert.equal(hits[`${CDN}/html2canvas.esm-ABC.js`], 1, '不是 glue 的候选 chunk：看一眼就放过');
  assert.equal(hits[`${CDN}/ink_web_bg-INLINE.wasm`], undefined, '内联在主 bundle 里的引擎没有独立 glue：不是候选，它的 wasm 也不用取');
  assert.equal(run.lockAfter, run.lockBefore, '只读：不改 lock');
  assert.deepEqual(run.cacheFiles, [], '只读：不往缓存目录写东西');
});

test('--site 的写法：名字=url 命名站点（lane id 的前缀）；不带名字的当 craft，url 自己带 = 也不会被当成名字', async () => {
  const plain = await discover([KNOWN_A], [`${base}/craft?v=1`]);
  assert.equal(plain.code, 2, plain.stdout + plain.stderr);
  const entry = entryOf(plain.stdout);
  assert.equal(entry.id, B_ID);
  assert.equal(entry.source, `${base}/craft?v=1`);

  const named = await discover([KNOWN_A], [`craft=${base}/craft?v=1`, `studio=${base}/studio`]);
  assert.equal(named.code, 2, named.stdout + named.stderr);
  assert.equal(named.stdout.match(/会把下面这条追加进 runtimes\.lock\.json/g).length, 2, 'craft 与 studio 两条');
  assert.match(named.stdout, new RegExp(`"id": "${re(B_ID)}"`));
  assert.match(named.stdout, new RegExp(`"id": "${re(D_ID)}"`));
});

test('两个站点一起查：新构建带着各自的站点名追加，正式版排第一当默认（不论站点先后），再跑零变化', async () => {
  const sites = [`studio=${base}/studio`, `craft=${base}/fresh`]; // 故意让 studio（只有 daily）排在前面
  const run = await freshClone([], { sites });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, new RegExp(`检查 ${re(base)}/studio`));
  assert.match(run.stdout, new RegExp(`检查 ${re(base)}/fresh`));

  const rows = JSON.parse(run.lockAfter);
  assert.deepEqual(rows.map((r) => r.id), [S_ID, D_ID, B_ID], '正式版排第一；两个 daily 保持站点的先后');
  assert.equal(normalizeRuntimeRegistry(rows).default, S_ID);
  assert.deepEqual(rows.map((r) => r.source), [`${base}/fresh`, `${base}/studio`, `${base}/fresh`]);
  assert.deepEqual(rows.map((r) => r.label), ['Craft 0.18.0', 'Studio 0.19.0-daily.202610080438', 'Craft 0.19.0-daily.202609230326']);
  for (const [row, glue, wasm] of [[rows[0], GLUE_S, WASM_S], [rows[1], GLUE_D, WASM_D], [rows[2], GLUE_B, WASM_B]]) {
    assert.ok((await readFile(join(run.cache, row.cacheDir, 'ink-glue.js'))).equals(glue), row.id);
    assert.ok((await readFile(join(run.cache, row.cacheDir, 'engine.wasm'))).equals(wasm), row.id);
  }
  assert.equal(hits[`${CDN}/ink_web_bg-DDDD.wasm`], 1, 'wasm 只下一次');
  assert.equal(hits['/assets/ink_web_bg-SSSS.wasm'], 1);
  assert.equal(hits['/assets/ink_web_bg-BBBB.wasm'], 1);

  const again = await spawnEngine(siteFlags(sites), run.cache);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.lockAfter, run.lockAfter, '再跑一次：清单一个字节都不变');
  assert.equal(again.stdout.match(/站点上的引擎构建都已被 lane 收录/g).length, 2, '两个站点各说一句');
  assert.deepEqual(Object.keys(hits).filter((url) => url.endsWith('.wasm')), [], '已收录的构建不再下载 wasm');

  const check = await spawnEngine(['--check'], run.cache);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /3 条运行时 lane 校验通过/);
});

test('一个站点查不了不连累另一个：照样收录能查的那个，只警告坏的那个（先坏后好、先好后坏都一样）', async () => {
  for (const sites of [[`craft=${DOWN}`, `studio=${base}/studio`], [`studio=${base}/studio`, `craft=${DOWN}`]]) {
    const run = await engine([], [KNOWN_A], { sites });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /⚠ 没能检查 http:\/\/127\.0\.0\.1:1\/craft：.*按现有的 runtimes\.lock\.json 继续/);
    assert.deepEqual(JSON.parse(run.lockAfter).map((r) => r.id), ['known-a', D_ID], sites.join(' '));
    assert.match(run.stdout, /2 条运行时 lane 已就绪/);
  }
});

test('--discover 一个站点查不了：照样报另一个站点的发现（退出码 2）；另一个也没新东西时退出码 1，并说清是站点没查成', async () => {
  const found = await discover([KNOWN_A], [`craft=${DOWN}`, `studio=${base}/studio`]);
  assert.equal(found.code, 2, found.stdout + found.stderr);
  assert.match(found.stderr, /⚠ 没能检查 http:\/\/127\.0\.0\.1:1\/craft：/);
  assert.equal(entryOf(found.stdout).id, D_ID);

  const gap = await discover([KNOWN_A, knownD()], [`craft=${DOWN}`, `studio=${base}/studio`]);
  assert.equal(gap.code, 1, gap.stdout + gap.stderr);
  assert.match(gap.stderr, /⚠ 没能检查 http:\/\/127\.0\.0\.1:1\/craft：/);
  assert.match(gap.stdout, /1 个站点没能检查，结果不完整（退出码 1）/);

  const clear = await discover([KNOWN_A, { id: 'known-b', glue: GLUE_B, wasm: WASM_B }, knownD()],
    [`craft=${base}/craft`, `studio=${base}/studio`]);
  assert.equal(clear.code, 0, clear.stdout + clear.stderr);
  assert.doesNotMatch(clear.stdout + clear.stderr, /没能检查|不完整|✗/);
});

