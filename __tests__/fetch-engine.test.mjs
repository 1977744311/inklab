// inklab-engine 的整条拉取链路：下载（含断连重试）→ 哈希校验 → 落盘 → 二次跳过，以及按名字挑 lane。
//
// 入口读的是「自己所在仓库」的 runtimes.lock.json（每个人的本机清单），而且默认会先查 Craft 站点。
// 所以把 bin/ 与 lib/ 复制到临时目录，配一份指向本地服务的清单，
// 并让站点检查指向一个本地的“死站点”（一律 404，只会警告），真跑一遍命令行；测试不碰外网。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GLUE = Buffer.from('// fake glue\n');
const WASM = Buffer.alloc(1_500_000, 3); // 十进制 1.5MB；按 1048576 算会显示 1.4，用来钉住单位口径
const WASM_OTHER = Buffer.alloc(1_500_000, 4); // 与 lock 里的哈希对不上的“被换过的内容”
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let scratch;
let tool; // 复制出来的仓库（bin + lib + 测试用清单）
let server;
let base;
let deadSite; // 站点检查的目标：一律 404，不参与 hits 计数
let hits = {}; // 每个路径被请求的次数
let wasmBehaviors; // /engine.wasm 的行为，按请求次序依次生效，用完沿用最后一个

const serveOk = (body) => (_req, res) => { res.writeHead(200, { 'content-length': String(body.length) }); res.end(body); };
const serveStatus = (code) => (_req, res) => { res.writeHead(code); res.end('x'); };
const serveTruncated = (_req, res) => { // 声明了完整长度，发一半就掐断连接
  res.writeHead(200, { 'content-length': String(WASM.length) });
  res.write(WASM.subarray(0, 500_000));
  setTimeout(() => res.socket.destroy(), 30);
};

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inklab-fetch-engine-'));
  tool = join(scratch, 'tool');
  await cp(new URL('../bin', import.meta.url), join(tool, 'bin'), { recursive: true });
  await cp(new URL('../lib', import.meta.url), join(tool, 'lib'), { recursive: true });

  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/engine.wasm') {
      return wasmBehaviors[Math.min(hits[req.url] - 1, wasmBehaviors.length - 1)](req, res);
    }
    if (req.url === '/glue.js' || req.url === '/other-glue.js') return serveOk(GLUE)(req, res);
    if (req.url === '/other.wasm') return serveOk(WASM)(req, res);
    return serveStatus(404)(req, res);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  deadSite = http.createServer(serveStatus(404));
  await new Promise((resolve) => { deadSite.listen(0, '127.0.0.1', resolve); });

  const lane = (id, glue, wasm) => ({
    id, label: id, channel: 'custom', cacheDir: `runtimes/${id}`, engineVersion: '9.9.9',
    glueUrl: `${base}/${glue}`, glueSha256: sha256(GLUE), wasmUrl: `${base}/${wasm}`, wasmSha256: sha256(WASM),
  });
  await writeFile(join(tool, 'runtimes.lock.json'), JSON.stringify([
    lane('fake', 'glue.js', 'engine.wasm'), lane('other', 'other-glue.js', 'other.wasm'),
  ]));
});

after(async () => {
  server?.closeAllConnections();
  deadSite?.closeAllConnections();
  await new Promise((resolve) => { server?.close(resolve) || resolve(); });
  await new Promise((resolve) => { deadSite?.close(resolve) || resolve(); });
  await rm(scratch, { recursive: true, force: true });
});

/** 真跑命令行。每次用全新的缓存目录，返回退出码、输出和缓存目录。 */
async function runEngine(args = []) {
  hits = {};
  const cache = await mkdtemp(join(scratch, 'cache-'));
  return { cache, ...(await spawnEngine(args, cache)) };
}

async function spawnEngine(args, cache) {
  const siteArg = `--site=http://127.0.0.1:${deadSite.address().port}/craft`;
  const child = spawn(process.execPath, [join(tool, 'bin/inklab-engine.mjs'), ...args, siteArg], {
    env: { ...process.env, INKLAB_ENGINE_DIR: cache }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code] = await once(child, 'close');
  clearTimeout(guard);
  return { code, stdout, stderr };
}

const exists = (path) => stat(path).then(() => true, () => false);

test('下载中断后自动重试，哈希通过才落盘；再跑一次直接用缓存，不再发请求', async () => {
  wasmBehaviors = [serveTruncated, serveOk(WASM)];
  const first = await runEngine(['fake']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /⚠ fake wasm：.*terminated.*重试（1\/3）/);
  assert.match(first.stdout, /✓ fake · 1\.5MB/);
  assert.equal(hits['/engine.wasm'], 2);
  assert.ok((await readFile(join(first.cache, 'runtimes/fake/engine.wasm'))).equals(WASM));
  assert.ok((await readFile(join(first.cache, 'runtimes/fake/ink-glue.js'))).equals(GLUE));

  hits = {};
  const second = await spawnEngine(['fake'], first.cache);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /已有锁定缓存/);
  assert.deepEqual(hits, {}, '缓存与 lock 一致时不该有任何网络请求');
});

test('下载内容与 lock 的哈希不符：失败、不落盘、不重试（内容错了重试也没用）', async () => {
  wasmBehaviors = [serveOk(WASM_OTHER)];
  const run = await runEngine(['fake']);
  assert.equal(run.code, 1, run.stdout);
  assert.match(run.stderr, /fake 下载内容与 lock 不符：glue ok；wasm [0-9a-f]{64}/);
  assert.equal(hits['/engine.wasm'], 1);
  assert.equal(await exists(join(run.cache, 'runtimes/fake/engine.wasm')), false);
  assert.equal(await exists(join(run.cache, 'runtimes/fake/ink-glue.js')), false);
});

test('源站 404 不重试，错误里有 URL 和状态码', async () => {
  wasmBehaviors = [serveStatus(404)];
  const run = await runEngine(['fake']);
  assert.equal(run.code, 1, run.stdout);
  assert.ok(run.stderr.includes(`${base}/engine.wasm → HTTP 404`), run.stderr);
  assert.equal(hits['/engine.wasm'], 1);
  assert.doesNotMatch(run.stdout, /重试/);
});

test('只拉指定的 lane：没点名的不下载、不落盘', async () => {
  wasmBehaviors = [serveOk(WASM)];
  const run = await runEngine(['other']);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(hits['/other.wasm'], 1);
  assert.equal(hits['/engine.wasm'], undefined, '没点名的 lane 不该有请求');
  assert.equal(await exists(join(run.cache, 'runtimes/other/engine.wasm')), true);
  assert.equal(await exists(join(run.cache, 'runtimes/fake')), false);
});

test('不指定 lane 就拉全部', async () => {
  wasmBehaviors = [serveOk(WASM)];
  const run = await runEngine();
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.equal(hits['/engine.wasm'], 1);
  assert.equal(hits['/other.wasm'], 1);
  assert.match(run.stdout, /2 条运行时 lane 已就绪/);
});

test('点了 lock 里没有的 lane：直接报错并列出可选项，不发任何请求', async () => {
  wasmBehaviors = [serveOk(WASM)];
  const run = await runEngine(['fake', 'nope']);
  assert.equal(run.code, 1, run.stdout);
  assert.match(run.stderr, /lock 里没有运行时：nope（可选：fake、other）/);
  assert.deepEqual(hits, {});
});

test('--check 只校验点名的 lane，不碰没点名的', async () => {
  wasmBehaviors = [serveOk(WASM)];
  const cache = await mkdtemp(join(scratch, 'cache-'));
  // 先只拉 fake，缓存里就只有它；other 不在缓存里。
  assert.equal((await spawnEngine(['fake'], cache)).code, 0);

  const onlyFake = await spawnEngine(['--check', 'fake'], cache);
  assert.equal(onlyFake.code, 0, onlyFake.stdout + onlyFake.stderr);
  assert.match(onlyFake.stdout, /1 条运行时 lane 校验通过/);

  const all = await spawnEngine(['--check'], cache);
  assert.equal(all.code, 1, '全量校验应当发现 other 缺文件');
  assert.match(all.stderr, /other 缺 ink-glue\.js/);
});
