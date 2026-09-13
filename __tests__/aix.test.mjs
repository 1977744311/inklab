// Standalone archive-contract tests use fixtures/minimal.aix; see fixtures/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import { listAixEntries, readAix, toBundleFiles, versionOf } from '../lib/aix.mjs';
import { isTextPath, buildManifest, validateManifest } from '../lib/bundle.mjs';

const inflate = async (buf) => new Uint8Array(await promisify(inflateRaw)(buf));
const AIX = new URL('../fixtures/minimal.aix', import.meta.url).pathname;

const loadAix = async () => new Uint8Array(await readFile(AIX));

test('读得懂公开最小测试包：条目齐全且带入口', async () => {
  const entries = listAixEntries(await loadAix());
  assert.ok(entries.length >= 5, `条目太少(${entries.length})，多半没解对中央目录`);
  const names = new Set(entries.map((e) => e.name));
  for (const must of ['app.json', 'app.js', 'VERSION', 'AGENTS.md']) {
    assert.ok(names.has(must), `包里应有 ${must}`);
  }
  assert.ok([...names].some((n) => n.endsWith('.ink')), '包里应有页面');
});

test('解压出的内容能直接喂引擎：文本给 string、二进制给 Uint8Array', async () => {
  const bytes = await readAix(await loadAix(), inflate);
  const files = toBundleFiles(bytes, isTextPath);

  assert.equal(typeof files['app.json'], 'string', 'app.json 必须是文本，给字节引擎解析不了');
  assert.ok(JSON.parse(files['app.json']).pages.length > 0);

  const png = Object.keys(files).find((n) => n.endsWith('.png'));
  assert.ok(png, '包里应有图片资产');
  assert.ok(files[png] instanceof Uint8Array, '图片必须是 Uint8Array');
  // PNG magic：证明真解压了，而不是把压缩流原样递出去
  assert.deepEqual([...files[png].slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('包里的 VERSION 读得出来——排查「跑的到底是哪一版」的第一手证据', async () => {
  const bytes = await readAix(await loadAix(), inflate);
  const v = versionOf(bytes);
  assert.match(v, /^[0-9a-f-]{36}$/i, `VERSION 应是 uuid，实得 ${v}`);
});

test('包内容能过与源码目录同一套预检（两边判定口径必须一致）', async () => {
  const bytes = await readAix(await loadAix(), inflate);
  const files = toBundleFiles(bytes, isTextPath);
  // 包已经是发布态，不该再被 .aixignore 那套规则筛掉入口
  const manifest = buildManifest(Object.keys(files));
  assert.ok(manifest.includes('app.json') && manifest.includes('app.js'));
  assert.deepEqual(validateManifest(manifest, files['app.json']), [],
    '包里注册的页面必须都在包里——不一致说明打包漏了文件');
});

test('不是 zip 就明确报错，不返回半个空表让人以为包是空的', async () => {
  await assert.rejects(
    () => readAix(new Uint8Array([1, 2, 3, 4]), inflate),
    /找不到 zip 中央目录/,
  );
});

test('没注入 inflate 直接抛：本模块刻意不绑环境，浏览器与 node 各给各的解压', async () => {
  await assert.rejects(() => readAix(new Uint8Array(0)), /需要注入 inflate/);
});
