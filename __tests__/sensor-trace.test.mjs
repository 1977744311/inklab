import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSquatAccelerometerTrace, createHeadGestureOrientationTrace, parseSensorTraceJson,
} from '../lib/sensor-trace.mjs';

test('合成深蹲 trace 先静止再产生明确周期运动，时间戳单调', () => {
  const samples = createSquatAccelerometerTrace({ reps: 2, hz: 20, stillMs: 1000, periodMs: 1000 });
  assert.equal(samples.length, 61);
  assert.ok(samples.every((sample, i) => i === 0 || sample.t > samples[i - 1].t));

  const stillY = samples.filter((sample) => sample.t < 1000).map((sample) => sample.y);
  const movingY = samples.filter((sample) => sample.t >= 1000).map((sample) => sample.y);
  assert.ok(Math.max(...stillY) - Math.min(...stillY) < 0.1, '静止段只能有微噪声');
  assert.ok(Math.max(...movingY) - Math.min(...movingY) > 3.9, '运动段要有足够明显的完整周期');
});

test('JSON trace 可直接用数组，也可携带 sensor/speed 信封', () => {
  const samples = [{ t: 0, x: 0, y: 0, z: 9.81 }];
  assert.deepEqual(parseSensorTraceJson(JSON.stringify(samples), 'gyroscope'), {
    sensor: 'gyroscope', speed: 1, samples,
  });
  assert.deepEqual(parseSensorTraceJson(JSON.stringify({
    sensor: 'accelerometer', speed: 2, samples,
  }), 'gyroscope'), { sensor: 'accelerometer', speed: 2, samples });
});

test('JSON trace 对缺 samples 和非法 speed 给出直接错误', () => {
  assert.throws(() => parseSensorTraceJson('{"sensor":"accelerometer"}'), /samples/);
  assert.throws(() => parseSensorTraceJson('{"samples":[],"speed":0}'), /speed/);
  assert.throws(() => parseSensorTraceJson('not-json'), SyntaxError);
});

test('点头/摇头 trace 是归一单位四元数，含静置首尾且动作轴不同', () => {
  const nod = createHeadGestureOrientationTrace('nod', { hz: 20, cycles: 1 });
  const shake = createHeadGestureOrientationTrace('shake', { hz: 20, cycles: 1 });
  for (const samples of [nod, shake]) {
    assert.deepEqual(samples[0], { t: 0, x: 0, y: 0, z: 0, w: 1 });
    assert.ok(samples.every((q) => Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9));
  }
  assert.ok(nod.some((q) => Math.abs(q.x) > 0.1));
  assert.ok(nod.every((q) => q.y === 0));
  assert.ok(shake.some((q) => Math.abs(q.y) > 0.1));
  assert.ok(shake.every((q) => q.x === 0));
  assert.throws(() => createHeadGestureOrientationTrace('roll'), /nod 或 shake/);
});
