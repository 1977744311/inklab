import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleMeta, USAGE, VERSION } from '../lib/node/cli-meta.mjs';

test('every declared command has a usage line written as a command, not an npm script', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of Object.keys(pkg.bin)) {
    assert.ok(USAGE[name], `missing usage for ${name}`);
    assert.match(USAGE[name], new RegExp(`^用法: ${name} `));
    assert.doesNotMatch(USAGE[name], /npm (run|start)/);
  }
  assert.equal(VERSION, pkg.version);
});

test('--help and --version are handled before the command runs', () => {
  const lines = [];
  const log = line => lines.push(line);
  assert.equal(handleMeta('inklab-e2e', ['--version'], { log }), true);
  assert.equal(handleMeta('inklab-e2e', ['-h'], { log }), true);
  assert.equal(handleMeta('inklab-e2e', ['some/app', '--scenario', 'x'], { log }), false);
  assert.deepEqual(lines, [VERSION, USAGE['inklab-e2e']]);
});
