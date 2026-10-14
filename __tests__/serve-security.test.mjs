// serve 的入口校验与错误边界：Host（挡 DNS 重绑定）、跨站子资源、LLM 转发路由的 Origin 白名单，
// 以及「一个坏请求不许带走整个服务」。这些都是 HTTP 层的行为，得起真服务、发真请求才测得到。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXTURE_AIX = new URL('../fixtures/minimal.aix', import.meta.url).pathname;

let serve; // serve.mjs 的导出：引擎缓存目录在 import 时就定了，所以要先设环境变量再动态 import
let scratch;
let upstream;
let lab;
const upstreamHits = [];

/** 发真 HTTP；node:http 允许自己指定 Host，fetch 不行，而伪造 Host 正是这里要测的。 */
function request({ port = lab.port, method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`请求超时：${method} ${path}`)));
    req.end(body);
  });
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inklab-serve-'));
  // serve 读的是「自己所在仓库」的 runtimes.lock.json（每个人的本机清单）和 llm.local.json，测试不能依赖它们。
  // 所以把 lib/、host/、scenarios/ 复制到临时目录，配一份自己的清单。
  const tool = join(scratch, 'tool');
  for (const dir of ['lib', 'host', 'scenarios']) {
    await cp(new URL(`../${dir}`, import.meta.url), join(tool, dir), { recursive: true });
  }
  await writeFile(join(tool, 'runtimes.lock.json'), JSON.stringify([{
    id: 'stub', engineVersion: '9.9.9', glueSha256: 'a'.repeat(64), wasmSha256: 'b'.repeat(64),
  }]));
  // 假引擎缓存：stub 这条 lane 的文件在 runtimes/stub/，有这两个文件它就算「已取」。
  const engineDir = join(scratch, 'engine');
  await mkdir(join(engineDir, 'runtimes/stub'), { recursive: true });
  await writeFile(join(engineDir, 'runtimes/stub/ink-glue.js'), '// stub');
  await writeFile(join(engineDir, 'runtimes/stub/engine.wasm'), 'stub');
  process.env.INKLAB_ENGINE_DIR = engineDir;

  const appDir = join(scratch, 'app');
  await mkdir(appDir);
  await writeFile(join(appDir, 'app.json'), JSON.stringify({ appId: 'serve-security' }));

  // 假上游：记下每次到达的请求。「被拒的请求一次都不许到这里」是 Origin 白名单的实质。
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      upstreamHits.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise((r) => { upstream.listen(0, '127.0.0.1', r); });

  serve = await import(pathToFileURL(join(tool, 'lib/node/serve.mjs')).href);
  lab = await serve.createInkLabServer({
    input: appDir,
    port: 0,
    env: { INKLAB_LLM_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions` },
  });
});

after(async () => {
  await lab?.close();
  await new Promise((r) => { upstream?.close(r) || r(); });
  await rm(scratch, { recursive: true, force: true });
});

test('合法 Host（127.0.0.1 / localhost）照常服务', async () => {
  for (const host of [`127.0.0.1:${lab.port}`, `localhost:${lab.port}`]) {
    for (const path of ['/', '/api/manifest', '/app/app.json', '/host/inklab.js', '/host/lib/bundle.mjs', '/engine/ink-glue.js']) {
      const r = await request({ path, headers: { host } });
      assert.equal(r.status, 200, `${host} ${path}`);
    }
  }
});

test('Host 不是回环名（DNS 重绑定）：所有路由一律 403', async () => {
  const hits = upstreamHits.length;
  const routes = [
    '/', '/api/manifest', '/api/watch', '/app/app.json', '/host/inklab.js',
    '/runtimes/stub/ink-glue.js', '/engine/ink-glue.js', '/api/device/status', '/device',
  ];
  for (const host of [`evil.example:${lab.port}`, `127.0.0.1.evil.example:${lab.port}`, 'localhost.evil.example']) {
    for (const path of routes) {
      const r = await request({ path, headers: { host } });
      assert.equal(r.status, 403, `${host} ${path}`);
    }
    // LLM 转发路由：预检和真请求都不行，而且请求到不了上游。
    const pre = await request({ method: 'OPTIONS', path: '/llm/chat/completions', headers: { host } });
    assert.equal(pre.status, 403, `${host} OPTIONS /llm`);
    const post = await request({
      method: 'POST', path: '/llm/chat/completions', headers: { host, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(post.status, 403, `${host} POST /llm`);
  }
  assert.equal(upstreamHits.length, hits, '伪造 Host 的请求不许到达 LLM 上游');
});

test('跨站的子资源请求被拒；顶层导航与同源请求放行', async () => {
  const cross = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' };
  assert.equal((await request({ path: '/app/app.json', headers: cross })).status, 403);
  assert.equal((await request({ path: '/host/inklab.js', headers: cross })).status, 403);

  // 在别的网页里点链接打开宿主：跨站，但是顶层导航，什么也读不到。
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await request({ path: '/', headers: nav })).status, 200);

  for (const site of ['same-origin', 'same-site', 'none']) {
    assert.equal((await request({ path: '/app/app.json', headers: { 'sec-fetch-site': site } })).status, 200, site);
  }
});

test('LLM 转发路由：只认宿主页面自己的 Origin，预检不再回 *', async () => {
  const hits = upstreamHits.length;
  const pageOrigin = `http://127.0.0.1:${lab.port}`;
  const host = `localhost:${lab.port}`; // 页面按 localhost 访问转发路由（见 /api/manifest 的注释）

  const pre = await request({
    method: 'OPTIONS',
    path: '/llm/chat/completions',
    headers: {
      host, origin: pageOrigin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], pageOrigin, '回的是页面自己的 Origin，不是 *');
  assert.match(pre.headers['access-control-allow-headers'], /authorization/, 'Authorization 得显式放行，* 管不到它');
  assert.match(pre.headers.vary, /origin/i);

  // 页面真正的 POST。localhost 与 127.0.0.1 在浏览器看来不同站，所以带 cross-site——这条路由不能套跨站检查。
  const ok = await request({
    method: 'POST',
    path: '/llm/chat/completions',
    headers: {
      host, origin: pageOrigin, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors',
      authorization: 'Bearer page-key', 'content-type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], pageOrigin);
  assert.equal(upstreamHits.length, hits + 1);
  assert.equal(upstreamHits.at(-1).authorization, 'Bearer page-key', 'Authorization 原样带给上游');

  // 别的网页（含同机别的端口）：拒绝，不回任何 CORS 头，更重要的是到不了上游。
  const foreign = [
    'https://evil.example', `http://evil.example:${lab.port}`, `http://127.0.0.1:${lab.port + 1}`,
    `https://127.0.0.1:${lab.port}`, 'http://127.0.0.1', 'null',
  ];
  for (const origin of foreign) {
    const preflight = await request({
      method: 'OPTIONS', path: '/llm/chat/completions', headers: { host, origin },
    });
    assert.equal(preflight.status, 403, `预检 ${origin}`);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, origin);
    const post = await request({
      method: 'POST', path: '/llm/chat/completions', headers: { host, origin, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(post.status, 403, `POST ${origin}`);
    assert.equal(post.headers['access-control-allow-origin'], undefined, origin);
  }
  assert.equal(upstreamHits.length, hits + 1, '被拒的跨域请求一次都不许到达上游');

  // 没有 Origin 的是非浏览器客户端（curl 之类）：不归 CORS 管，照常转发，也不回 CORS 头。
  const plain = await request({
    method: 'POST', path: '/llm/chat/completions', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['access-control-allow-origin'], undefined);
  assert.equal(upstreamHits.length, hits + 2);
});

test('lib/node/ 不下发给浏览器，大小写与百分号编码都绕不过去', async () => {
  for (const path of [
    '/host/lib/node/serve.mjs', '/host/lib/NODE/serve.mjs', '/host/lib/%6eode/serve.mjs', '/host/lib/node%2fserve.mjs',
  ]) {
    assert.equal((await request({ path })).status, 404, path);
  }
});

test('目录穿越与畸形编码一律拒绝，而且服务不死', async () => {
  for (const path of [
    '/host/..%2f..%2fpackage.json', '/host/%E0%A4%A', '/host/%',
    '/runtimes/stub/%E0%A4%A', '/engine/%E0%A4%A',
  ]) {
    assert.equal((await request({ path })).status, 403, path);
  }
  // %2e%2e 会被 URL 解析当成点段直接折叠成 /package.json，到不了 safeJoin；总之不能是 200。
  const folded = await request({ path: '/host/%2e%2e/%2e%2e/package.json' });
  assert.ok([403, 404].includes(folded.status), `实际 ${folded.status}`);
  assert.equal((await request({ path: '/' })).status, 200, '畸形请求之后服务还在');
});

test('请求处理里抛错只让这一个请求失败，服务不退出', async () => {
  const aix = join(scratch, 'broken.aix');
  await copyFile(FIXTURE_AIX, aix);
  const lines = [];
  const second = await serve.createInkLabServer({ input: aix, port: 0, env: {}, log: (l) => lines.push(l) });
  try {
    // 服务跑着的时候工程包损坏了：下一次 /api/manifest 的 refresh() 会抛。
    await writeFile(aix, 'not a zip');
    const bad = await request({ port: second.port, path: '/api/manifest' });
    assert.equal(bad.status, 500);
    assert.equal(bad.body, 'internal error', '响应里不带内部细节（可能含本机路径）');
    assert.ok(lines.some((l) => l.includes('请求失败') && l.includes('/api/manifest')), '细节进日志');
    assert.equal((await request({ port: second.port, path: '/' })).status, 200, '出错之后服务还在');
  } finally {
    await second.close();
  }
});
