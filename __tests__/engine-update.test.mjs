// 启动时的自动检查：一天最多一次、可关、失败只警告（record 注入，不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UPDATE_INTERVAL_MS, autoUpdateEngines, shouldCheck } from '../lib/node/engine-update.mjs';

test('该不该查：没查过就查；一天内不再查；INKLAB_NO_UPDATE=1 不查；INKLAB_UPDATE=force 一定查', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  assert.equal(shouldCheck({ env: {}, now, checkedAt: 0 }), true);
  assert.equal(shouldCheck({ env: {}, now, checkedAt: now - 60_000 }), false);
  assert.equal(shouldCheck({ env: {}, now, checkedAt: now - UPDATE_INTERVAL_MS }), true);
  assert.equal(shouldCheck({ env: {}, now, checkedAt: now + 60_000 }), true, '时钟回拨时照样查');
  assert.equal(shouldCheck({ env: { INKLAB_NO_UPDATE: '1' }, now, checkedAt: 0 }), false);
  assert.equal(shouldCheck({ env: { INKLAB_UPDATE: 'force' }, now, checkedAt: now }), true);
});

test('查成功记下时间，一天内第二次不再查；有新 lane 时说一声', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-update-'));
  const env = { INKLAB_ENGINE_DIR: dir };
  const now = Date.parse('2026-11-17T12:00:00Z');
  const lines = [];
  let calls = 0;
  const record = async () => { calls += 1; return ['npm-ink-9.9.9']; };
  try {
    assert.deepEqual(await autoUpdateEngines({ env, now, log: (line) => lines.push(line), record }), ['npm-ink-9.9.9']);
    assert.match(lines.join('\n'), /已取回新引擎：npm-ink-9\.9\.9/);
    assert.equal(JSON.parse(await readFile(join(dir, 'update-check.json'), 'utf8')).checkedAt, '2026-11-17T12:00:00.000Z');
    assert.deepEqual(await autoUpdateEngines({ env, now: now + 3_600_000, log: () => {}, record }), []);
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('查不了只警告、不抛错，也不记时间（下次启动再试）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-update-'));
  const lines = [];
  try {
    const added = await autoUpdateEngines({
      env: { INKLAB_ENGINE_DIR: dir }, log: (line) => lines.push(line),
      record: async () => { throw new Error('fetch failed'); },
    });
    assert.deepEqual(added, []);
    assert.match(lines.join('\n'), /没能检查 npm 上的新引擎（fetch failed），先用本机已有的引擎；INKLAB_NO_UPDATE=1 可关掉检查/);
    await assert.rejects(readFile(join(dir, 'update-check.json')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
