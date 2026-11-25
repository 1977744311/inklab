import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDeviceLock, deviceLockOwner } from '../lib/node/device-lock.mjs';

test('两个进程同时申请只放行一个，持有者被杀后可以接手，过期的释放不会删掉新锁', { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'inklab-lock-test-'));
  const module = new URL('../lib/node/device-lock.mjs', import.meta.url).href;
  const script = `
    import { acquireDeviceLock } from ${JSON.stringify(module)};
    const [root, project] = process.argv.slice(1);
    process.once('message', () => {
      try {
        acquireDeviceLock('SN', { project }, root);
        process.on('message', () => {});
        process.send(200);
      } catch (err) { process.send(err.statusCode || 500, () => process.disconnect()); }
    });
    process.send('ready');`;
  const peers = ['first', 'second'].map((project) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, project], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    return { child, ready: once(child, 'message'), exited: once(child, 'exit'), project };
  });
  t.after(async () => {
    for (const { child } of peers) child.kill('SIGKILL');
    await Promise.all(peers.map((peer) => peer.exited));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(peers.map((peer) => peer.ready));
  const outcomes = await Promise.all(peers.map(({ child }) => {
    const reply = once(child, 'message');
    child.send('claim');
    return reply.then(([status]) => status);
  }));
  assert.deepEqual(outcomes.toSorted(), [200, 409]);
  const winner = peers[outcomes.indexOf(200)];
  assert.equal(deviceLockOwner('SN', root).project, winner.project);
  winner.child.kill('SIGKILL');
  await winner.exited;
  const older = acquireDeviceLock('SN', { project: 'third' }, root);
  older.release();
  const newer = acquireDeviceLock('SN', { project: 'fourth' }, root);
  older.release();
  assert.equal(deviceLockOwner('SN', root).project, 'fourth');
  newer.release();
  assert.equal(deviceLockOwner('SN', root), null);
});

test('系统重用已退出工作台的 PID 时仍可回收旧锁', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'inklab-lock-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  acquireDeviceLock('SN', { project: 'old' }, root);
  const [slot] = await readdir(root);
  const [marker] = await readdir(join(root, slot));
  const file = join(root, slot, marker);
  const previous = JSON.parse(await readFile(file));
  assert.ok(previous.started);
  await writeFile(file, JSON.stringify({ ...previous, started: 'Mon Jan  1 00:00:00 1990' }));
  const replacement = acquireDeviceLock('SN', { project: 'current' }, root);
  assert.equal(deviceLockOwner('SN', root).project, 'current');
  replacement.release();
});
