// npm 来源：解包、integrity 校验、lane 条目，以及对着本机假 registry 找新版本（不联网）。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  extractTarball, findNpmBuilds, npmLaneEntry, npmLaneId, npmRegistry, verifyIntegrity, writeNpmLane,
} from '../lib/node/npm-engine.mjs';

/** 造一个 ustar 条目：name 超过 100 字节时拆进 prefix；pax 为真时前面垫一个 pax 头写 path。 */
function tarEntry(name, data, { pax = false, type = '0' } = {}) {
  const body = Buffer.from(data);
  const header = Buffer.alloc(512);
  let short = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100 && !pax) {
    const cut = name.lastIndexOf('/', 155);
    prefix = name.slice(0, cut);
    short = name.slice(cut + 1);
  }
  header.write(pax ? 'PaxHeader' : short, 0, 100);
  header.write('0000644\0', 100);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  header.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

function paxEntry(path, data) {
  const record = (key, value) => {
    const text = ` ${key}=${value}\n`;
    let length = text.length + 1;
    while (`${length}${text}`.length !== length) length = `${length}${text}`.length;
    return `${length}${text}`;
  };
  return Buffer.concat([tarEntry('', record('path', path), { pax: true, type: 'x' }), tarEntry('ignored', data)]);
}

const tgz = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const GLUE = "import init from './pkg/ink_web.js'; export const initInk = init;";
const WASM = Buffer.from('\0asm fake engine');
const packageFiles = (version) => [
  tarEntry('package/package.json', JSON.stringify({ name: '@yodaos-pkg/ink', version, main: './index.js' })),
  tarEntry('package/index.js', GLUE),
  tarEntry('package/pkg/ink_web.js', 'export default async () => {};'),
  tarEntry('package/pkg/ink_web_bg.wasm', WASM),
];

test('解包：去掉 package/，认 ustar 的 prefix 与 pax 的 path，跳过目录', () => {
  const longPath = `package/${'deep/'.repeat(25)}file.txt`;
  const files = extractTarball(tgz(
    tarEntry('package/pkg', '', { type: '5' }),
    ...packageFiles('1.0.0'),
    tarEntry(longPath, 'prefix'),
    paxEntry('package/audio/very-long-name.mp3', 'pax'),
  ));
  assert.equal(Buffer.from(files.get('index.js')).toString(), GLUE);
  assert.deepEqual(Buffer.from(files.get('pkg/ink_web_bg.wasm')), WASM);
  assert.equal(Buffer.from(files.get(longPath.slice('package/'.length))).toString(), 'prefix');
  assert.equal(Buffer.from(files.get('audio/very-long-name.mp3')).toString(), 'pax');
  assert.ok(!files.has('pkg'), '目录条目不算文件');
});

test('解包：跳出包目录的路径一律拒绝', () => {
  assert.throws(() => extractTarball(tgz(tarEntry('package/../../evil.js', 'x'))), /不安全的路径/);
  assert.throws(() => extractTarball(tgz(tarEntry('/etc/evil', 'x'))), /不安全的路径/);
});

test('integrity：对得上才放行，对不上或认不出都报错', () => {
  const bytes = Buffer.from('tarball');
  verifyIntegrity(bytes, integrity(bytes));
  assert.throws(() => verifyIntegrity(Buffer.from('other'), integrity(bytes)), /不符/);
  assert.throws(() => verifyIntegrity(bytes, 'md5-xxx'), /无法识别/);
});

test('lane 条目：正式版是 stable、带预发布后缀的是 daily；id 是 npm-ink-<版本>；记下 tarball 与哈希', () => {
  const files = extractTarball(tgz(...packageFiles('1.2.0')));
  const meta = { dist: { tarball: 'https://r/ink-1.2.0.tgz', integrity: 'sha512-x' } };
  const stable = npmLaneEntry({ version: '1.2.0', meta, files, registry: 'https://r', fetchedAt: '2026-11-17' });
  assert.equal(stable.id, 'npm-ink-1.2.0');
  assert.equal(stable.channel, 'stable');
  assert.equal(stable.engineBuild, '1.2.0');
  assert.equal(stable.engineVersion, '1.2.0', 'wasm 里读不出版本时用 npm 版本');
  assert.equal(stable.tarballUrl, 'https://r/ink-1.2.0.tgz');
  assert.equal(stable.glueSha256, sha256(Buffer.from(GLUE)));
  assert.equal(stable.wasmSha256, sha256(WASM));
  const daily = npmLaneEntry({ version: '1.3.0-daily.7', meta, files, registry: 'https://r', fetchedAt: '2026-11-17' });
  assert.equal(daily.channel, 'daily');
  assert.equal(daily.engineVersion, '1.3.0');
  assert.equal(npmLaneId('1.3.0-Daily.7'), 'npm-ink-1.3.0-daily.7');
});

test('lane 条目：包里缺 glue 或 wasm 直接报错', () => {
  const meta = { dist: { tarball: 't', integrity: 'i' } };
  const noWasm = extractTarball(tgz(tarEntry('package/index.js', GLUE)));
  assert.throws(() => npmLaneEntry({ version: '1.0.0', meta, files: noWasm, registry: 'r' }), /没有 pkg\/ink_web_bg\.wasm/);
});

test('registry 地址：INKLAB_NPM_REGISTRY 优先，去掉末尾斜杠', () => {
  assert.equal(npmRegistry({}), 'https://registry.npmjs.org');
  assert.equal(npmRegistry({ INKLAB_NPM_REGISTRY: 'https://mirror.example/' }), 'https://mirror.example');
});

let server;
let base;
let scratch;
const requests = [];
const TARBALLS = { '1.2.0': tgz(...packageFiles('1.2.0')), '1.3.0-daily.7': tgz(...packageFiles('1.3.0-daily.7')) };

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inklab-npm-engine-'));
  server = createServer((req, res) => {
    requests.push(req.url);
    const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (req.url === '/-/package/@yodaos-pkg/ink/dist-tags') return send(JSON.stringify({ latest: '1.2.0', daily: '1.3.0-daily.7', legacy: '0.1.0' }));
    const meta = /^\/@yodaos-pkg\/ink\/(.+)$/.exec(req.url);
    if (meta && TARBALLS[decodeURIComponent(meta[1])]) {
      const version = decodeURIComponent(meta[1]);
      return send(JSON.stringify({ version, dist: { tarball: `${base}/tarballs/${version}.tgz`, integrity: integrity(TARBALLS[version]) } }));
    }
    const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(req.url);
    if (tarball && TARBALLS[tarball[1]]) return send(TARBALLS[tarball[1]], 'application/octet-stream');
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => { server.close(resolve); });
  await rm(scratch, { recursive: true, force: true });
});

test('找新版本：只看 latest / daily；已有 lane 的版本不下载；返回解开的文件与条目', async () => {
  requests.length = 0;
  const { tags, fresh } = await findNpmBuilds([{ id: 'npm-ink-1.3.0-daily.7' }], { env: { INKLAB_NPM_REGISTRY: base } });
  assert.equal(tags.legacy, '0.1.0');
  assert.deepEqual(fresh.map((item) => [item.tag, item.entry.id]), [['latest', 'npm-ink-1.2.0']]);
  assert.equal(fresh[0].entry.source, `${base}/@yodaos-pkg/ink`);
  assert.equal(fresh[0].entry.tarballIntegrity, integrity(TARBALLS['1.2.0']));
  assert.ok(!requests.some((url) => url.includes('1.3.0')), `已收录的 daily 不该下载：${requests.join(' ')}`);
});

test('写 lane：整包落盘，并复制出 ink-glue.js 与 engine.wasm', async () => {
  const { fresh } = await findNpmBuilds([], { env: { INKLAB_NPM_REGISTRY: base } });
  assert.deepEqual(fresh.map((item) => item.entry.id), ['npm-ink-1.2.0', 'npm-ink-1.3.0-daily.7']);
  const root = join(scratch, 'runtimes', fresh[0].entry.id);
  await writeNpmLane(root, fresh[0].files);
  assert.deepEqual((await readdir(root)).sort(), ['engine.wasm', 'index.js', 'ink-glue.js', 'package.json', 'pkg']);
  assert.equal(await readFile(join(root, 'ink-glue.js'), 'utf8'), GLUE);
  assert.equal(sha256(await readFile(join(root, 'engine.wasm'))), fresh[0].entry.wasmSha256);
});
