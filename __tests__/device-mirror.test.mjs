import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDeviceMirror, createJpegFramer, mirrorFps, screenrecordCommand, remoteMirrorCleanup } from '../lib/node/device-mirror.mjs';

test('JPEG stream framing survives split markers and multiple frames per chunk', () => {
  const frames = [];
  const framer = createJpegFramer((frame) => frames.push([...frame]));
  framer.push(Buffer.from([0, 1, 0xff]));
  framer.push(Buffer.from([0xd8, 42, 0xff]));
  framer.push(Buffer.from([0xd9, 0xff, 0xd8, 43, 0xff, 0xd9]));
  assert.deepEqual(frames, [[255, 216, 42, 255, 217], [255, 216, 43, 255, 217]]);
});

test('corrupt decoder output cannot accumulate without a limit', () => {
  const framer = createJpegFramer(() => {}, { maxBytes: 8 });
  assert.throws(() => framer.push(Buffer.alloc(9)), /缓冲上限/);
});

test('measured FPS becomes zero on a static/stale stream, never invents a video rate', () => {
  assert.equal(mirrorFps([0, 100, 200, 300], 300), 10);
  assert.equal(mirrorFps([0, 100, 200, 300], 2000), 0);
  assert.equal(mirrorFps([300], 300), 0);
});

test('remote lifecycle only touches the owned PID file and validates all shell path tokens', () => {
  const path = '/data/local/tmp/inklab-mirror-abcd-1234.pid';
  assert.match(screenrecordCommand(path), /--output-format=h264/);
  assert.match(remoteMirrorCleanup(path), /\/proc\/\$p\/comm/);
  assert.doesNotMatch(remoteMirrorCleanup(path), /pkill|killall/);
  assert.throws(() => screenrecordCommand('/tmp/x; reboot'), /invalid/);
});

function fixture() {
  const children = [];
  const executions = [];
  const timers = new Map();
  let serial = 0;
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    Object.assign(child, { command, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; child.emit('close', 0); return true; };
    children.push(child); return child;
  };
  const mirror = createDeviceMirror({ spawnProcess,
    execute: async (file, args) => { executions.push({ file, args }); return { stdout: '' }; },
    setTimer(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const res = new EventEmitter();
  res.messages = []; res.writableLength = 0; res.writeHead = () => {};
  res.write = (line) => { res.messages.push(line); return true; };
  res.end = () => { res.ended = true; res.emit('close'); };
  return { mirror, children, executions, timers, res };
}

test('one continuous capture pipeline publishes actual frames; stop clears both children and remote owner', async () => {
  const { mirror, children, executions, timers, res } = fixture();
  const start = await mirror.start('SN1');
  mirror.subscribe(start.id, res);
  children[1].stdout.write(Buffer.from([0xff, 0xd8, 42, 0xff, 0xd9]));
  assert.equal(mirror.snapshot().status, 'streaming');
  assert.equal(mirror.snapshot().frames, 1);
  assert.equal(children.length, 2, 'no per-frame ADB screencap process');
  assert.ok(res.messages.some((m) => m.startsWith('event: frame')));
  await mirror.stop();
  assert.equal(mirror.snapshot().status, 'stopped');
  assert.ok(children.every((p) => p.killed));
  assert.ok(executions.some((c) => c.args.some((a) => typeof a === 'string' && a.includes('/proc/$p/comm'))));
  assert.equal(timers.size, 0);
  assert.equal(res.ended, true);
});

test('closing the last browser stream automatically reclaims the encoder', async () => {
  const { mirror, children, timers, res } = fixture();
  const start = await mirror.start('SN1');
  mirror.subscribe(start.id, res);
  res.emit('close');
  const timer = [...timers.values()].find((t) => t.ms === 2500);
  assert.ok(timer);
  timer.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(mirror.snapshot().status, 'stopped');
  assert.ok(children.every((p) => p.killed));
});

test('decoder/USB failure is surfaced and clears both processes', async () => {
  const { mirror, children, res } = fixture();
  const start = await mirror.start('SN1'); mirror.subscribe(start.id, res);
  children[0].stderr.write('device disconnected'); children[0].emit('close', 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(mirror.snapshot().status, 'error');
  assert.match(mirror.snapshot().error, /device disconnected/);
  assert.ok(children.every((p) => p.killed));
});

test('slow viewers drop frames instead of buffering an old movie', async () => {
  const { mirror, children, res } = fixture();
  const start = await mirror.start('SN1'); mirror.subscribe(start.id, res);
  res.writableLength = 1024 * 1024;
  children[1].stdout.write(Buffer.from([0xff, 0xd8, 42, 0xff, 0xd9]));
  assert.equal(mirror.snapshot().frames, 1);
  assert.equal(res.messages.filter((m) => m.startsWith('event: frame')).length, 0);
  await mirror.stop();
});
