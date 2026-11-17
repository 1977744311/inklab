import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readlink, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installCli } from '../scripts/install-cli.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inklab-install-cli-'));
  await mkdir(join(root, 'repo', 'bin'), { recursive: true });
  await writeFile(join(root, 'repo', 'package.json'), JSON.stringify({ bin: { demo: 'bin/demo.mjs', 'demo-e2e': 'bin/demo-e2e.mjs' } }));
  await writeFile(join(root, 'repo', 'bin', 'demo.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'repo', 'bin', 'demo-e2e.mjs'), '#!/usr/bin/env node\n');
  return { root, repo: join(root, 'repo'), binDir: join(root, 'bin') };
}

test('install-cli links every declared command and is idempotent', async () => {
  const { root, repo, binDir } = await fixture();
  try {
    const quiet = { log: () => {}, env: { PATH: binDir } };
    const first = await installCli({ root: repo, binDir, ...quiet });
    assert.deepEqual(first.results.map(r => r.action), ['linked', 'linked']);
    assert.equal(first.onPath, true);
    assert.equal(resolve(binDir, await readlink(join(binDir, 'demo'))), join(repo, 'bin', 'demo.mjs'));
    const again = await installCli({ root: repo, binDir, ...quiet });
    assert.deepEqual(again.results.map(r => r.action), ['unchanged', 'unchanged']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install-cli refuses to overwrite a regular file and uninstall only removes its own links', async () => {
  const { root, repo, binDir } = await fixture();
  try {
    const quiet = { log: () => {}, env: { PATH: '' } };
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'demo'), 'someone else');
    await assert.rejects(installCli({ root: repo, binDir, ...quiet }), /不是软链/);
    await rm(join(binDir, 'demo'));
    const installed = await installCli({ root: repo, binDir, ...quiet });
    assert.equal(installed.onPath, false);
    const removed = await installCli({ root: repo, binDir, uninstall: true, ...quiet });
    assert.deepEqual(removed.results.map(r => r.action), ['removed', 'removed']);
    await assert.rejects(lstat(join(binDir, 'demo')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
