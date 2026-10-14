import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectSource, diffProjectSnapshots, normalizeProjectPath,
} from '../lib/node/project-source.mjs';

const ROOT = new URL('../', import.meta.url).pathname;

test('源码目录与 .aix 都暴露同一快照接口，发布包身份含 VERSION/MD5/SHA-256', async () => {
  const dir = await createProjectSource('fixtures/cap-probe-app', { cwd: ROOT });
  const pkg = await createProjectSource('fixtures/minimal.aix', { cwd: ROOT });

  assert.equal(dir.type, 'directory');
  assert.ok(dir.snapshot().manifest.includes('pages/home/index.ink'));
  assert.match(await dir.read('e2e/scenarios/aiui-017-conformance.mjs'), /aiui-017-conformance/,
    'e2e 文件不进 bundle，但源码源仍应按需提供给场景 loader');

  const identity = pkg.describe();
  assert.equal(identity.type, 'aix');
  assert.match(identity.version, /^[0-9a-f-]{36}$/i);
  assert.match(identity.md5, /^[0-9a-f]{32}$/);
  assert.match(identity.sha256, /^[0-9a-f]{64}$/);
  assert.ok(pkg.snapshot().manifest.includes('VERSION'), '发布包不做二次排除');
  assert.equal(typeof await pkg.read('app.json'), 'string');
});

test('工程差分按内容而不是路径数量判断，并给 added/removed/changed', () => {
  const left = { files: { 'app.js': 'one', 'same.js': 'same', 'gone.js': 'x' } };
  const right = { files: { 'app.js': 'two', 'same.js': 'same', 'new.js': 'y' } };
  assert.deepEqual(diffProjectSnapshots(left, right), {
    added: ['new.js'], removed: ['gone.js'], changed: ['app.js'], same: 1, equal: false,
  });
  assert.equal(diffProjectSnapshots(left, left).equal, true);
});

test('工程内路径拒绝绝对路径、空段与目录穿越', () => {
  assert.equal(normalizeProjectPath('pages/home/index.ink'), 'pages/home/index.ink');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../x', 'a//x', 'a/./x']) {
    assert.equal(normalizeProjectPath(bad), null, bad);
  }
});
