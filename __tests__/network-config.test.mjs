import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAppConfig } from '../lib/node/app-config.mjs';
import { parseArgs } from '../lib/node/serve.mjs';
import { buildPageUrl, parseE2eArgs } from '../lib/node/e2e.mjs';

test('workbench and e2e parse repeated allow patterns and player counts', () => {
  const args = ['app', '--players', '4', '--allow-external', 'https://example.com/*', '--allow-external', 'wss://example.com/*'];
  for (const parse of [parseArgs, parseE2eArgs]) {
    assert.equal(parse(args).players, 4);
    assert.deepEqual(parse(args).allowExternal, ['https://example.com/*', 'wss://example.com/*']);
    assert.throws(() => parse(['app', '--players', '7']), /1–6/);
    assert.throws(() => parse(['app', '--players']), /1–6/);
    assert.throws(() => parse(['app', '--allow-external']), /需要/);
  }
  assert.equal(new URL(buildPageUrl('http://localhost/?players=4')).searchParams.get('players'), '4');
});
test('optional app config merges CLI patterns without changing default guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-config-'));
  try {
    assert.deepEqual(await readAppConfig(dir), { allowExternal: [] });
    await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ allowExternal: ['example.com'] }));
    assert.deepEqual(await readAppConfig(dir, ['example.com', 'https://api.test/*']), { allowExternal: ['example.com', 'https://api.test/*'] });
    await writeFile(join(dir, 'inklab.config.json'), '{broken');
    await assert.rejects(readAppConfig(dir), SyntaxError);
    await writeFile(join(dir, 'inklab.config.json'), '{"allowExternal":"*"}');
    await assert.rejects(readAppConfig(dir), /数组/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
