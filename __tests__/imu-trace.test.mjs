import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_PREFIX, createRecordingAssembler, decodeRecordLine, encodeTrace, normalizeTrace, playTraceInSimulator, rebaseOrientation,
  sliceTrace, traceFileName, traceSummary,
} from '../lib/imu-trace.mjs';

test('读旧格式：样本数组与 { sensor, speed, samples } 都认，时间零点挪到第一条样本', () => {
  const bare = normalizeTrace([{ t: 500, x: 0, y: 9.8, z: 0 }, { t: 520, x: 0, y: 9.7, z: 0 }]);
  assert.deepEqual(Object.keys(bare.sensors), ['accelerometer']);
  assert.deepEqual(bare.sensors.accelerometer.samples.map((s) => s.t), [0, 20]);
  const envelope = normalizeTrace({ sensor: 'absoluteOrientation', speed: 2, samples: [{ t: 0, x: 0, y: 0, z: 0, w: 1 }] });
  assert.equal(envelope.speed, 2);
  assert.deepEqual(envelope.sensors.absoluteOrientation.samples[0], { t: 0, x: 0, y: 0, z: 0, w: 1 });
  assert.throws(() => normalizeTrace({ sensor: 'compass', samples: [{ t: 0 }] }), /不认识的传感器/);
  assert.throws(() => normalizeTrace([{ t: 0, x: 0, y: 'a', z: 0 }]), /y 不是有限数/);
  assert.throws(() => normalizeTrace({ sensor: 'accelerometer', speed: 0, samples: [{ t: 0, x: 0, y: 0, z: 0 }] }), /speed/);
});

test('v2 多传感器：共用时间零点，段落和标记跟着挪；写回去再读一致', () => {
  const trace = normalizeTrace({
    format: 'inklab-imu-trace', version: 2, name: 'rec', device: { model: 'RG_glasses' },
    sensors: {
      absoluteOrientation: { frequency: 60, rows: [[1000, 0, 0, 0, 1], [1016.667, 0.1, 0, 0, 0.995]] },
      accelerometer: { frequency: 60, rows: [[1005, 0, -9.7, -1.2], [1014.9, 0, -9.7, -1.2]] },
    },
    segments: [{ id: 'nod', label: '点头', from: 1000, to: 1016.667, expect: { nod: 1 } }],
    marks: [{ t: 1005, label: 'x' }],
  });
  assert.equal(trace.durationMs, 16.667);
  assert.deepEqual(trace.sensors.accelerometer.samples.map((s) => s.t), [5, 14.9]);
  assert.deepEqual(trace.segments[0], { id: 'nod', label: '点头', from: 0, to: 16.667, expect: { nod: 1 } });
  assert.deepEqual(trace.marks, [{ t: 5, label: 'x' }]);
  const again = normalizeTrace(JSON.parse(JSON.stringify(encodeTrace(trace))));
  assert.deepEqual(again.sensors, trace.sensors);
  assert.deepEqual(again.segments, trace.segments);
  assert.equal(encodeTrace(trace).format, 'inklab-imu-trace');
  assert.throws(() => normalizeTrace({ format: 'other', sensors: {} }), /不是 InkLab IMU 轨迹/);
});

test('截一段：按段落或时间，t 重新从 0 起；只要部分传感器', () => {
  const trace = normalizeTrace({
    sensors: {
      absoluteOrientation: { rows: [[0, 0, 0, 0, 1], [100, 0, 0, 0, 1], [200, 0.1, 0, 0, 0.99], [300, 0, 0, 0, 1]] },
      accelerometer: { rows: [[0, 0, 9.8, 0], [150, 0, 9.8, 0], [250, 0, 9.8, 0]] },
    },
    segments: [{ id: 'a', from: 100, to: 250 }, { id: 'b', from: 250, to: 300 }],
  });
  const a = sliceTrace(trace, { segment: 'a' });
  assert.equal(a.durationMs, 150);
  assert.deepEqual(a.sensors.absoluteOrientation.samples.map((s) => s.t), [0, 100]);
  assert.deepEqual(a.sensors.accelerometer.samples.map((s) => s.t), [50, 150]);
  assert.deepEqual(a.segments.map((s) => [s.id, s.from, s.to]), [['a', 0, 150]]);
  const onlyOrientation = sliceTrace(trace, { sensors: ['absoluteOrientation'] });
  assert.deepEqual(Object.keys(onlyOrientation.sensors), ['absoluteOrientation']);
  assert.throws(() => sliceTrace(trace, { segment: 'zzz' }), /没有段落 zzz/);
  assert.throws(() => sliceTrace(trace, { from: 400, to: 500 }), /没有样本/);
  assert.deepEqual(traceSummary(trace).sensors.absoluteOrientation, { samples: 4, hz: 10 });
});

test('在模拟器里放：每个传感器交给 caps.sensors，play 立刻切、load 等下次 start', () => {
  const calls = [];
  const caps = {
    playTrace: (name, samples, opts) => { calls.push(['play', name, samples.length, opts]); return { activeSessions: 1 }; },
    loadTrace: (name, samples, opts) => { calls.push(['load', name, samples.length, opts]); return {}; },
  };
  const trace = normalizeTrace({ sensors: { accelerometer: { rows: [[0, 0, 9.8, 0]] }, gyroscope: { rows: [[0, 0, 0, 0]] } } });
  playTraceInSimulator(caps, trace, { loop: true });
  playTraceInSimulator(caps, trace, { mode: 'load', speed: 2 });
  assert.deepEqual(calls, [
    ['play', 'accelerometer', 1, { speed: 1, loop: true }], ['play', 'gyroscope', 1, { speed: 1, loop: true }],
    ['load', 'accelerometer', 1, { speed: 2, loop: false }], ['load', 'gyroscope', 1, { speed: 2, loop: false }],
  ]);
});

test('录制行：拼回轨迹，按真机时间戳；段落、标记、最近 N 秒、截断的行', () => {
  const line = (obj) => decodeRecordLine(`I Ink: ink_script::console: ${RECORD_PREFIX}${JSON.stringify({ v: 1, ...obj })}`);
  assert.equal(decodeRecordLine('[audio] 播放失败'), null);
  assert.equal(decodeRecordLine(`${RECORD_PREFIX}{"v":1,"s":"accel`).ev, 'broken');
  const rec = createRecordingAssembler({ maxSeconds: 10 });
  assert.throws(() => rec.toTrace(), /还没有收到/);
  rec.push(line({ ev: 'hello', mode: 'record' }));
  rec.push(line({ s: 'absoluteOrientation', f: 60, r: [[44448000, 0, 0, 0, 1], [44448016.667, 0, 0, 0, 1], [44448033.333, 0.1, 0, 0, 0.99]] }));
  rec.push(line({ s: 'accelerometer', f: 60, r: [[44448005, 0, -9.7, -1.2], [44448014.9, 0, -9.7, -1.2], [44448020, 1, 2]] }));
  rec.push(line({ ev: 'segment', phase: 'begin', id: 'nod', label: '点头', ts: 44448010, expect: { nod: 1 } }));
  rec.push(line({ ev: 'segment', phase: 'end', id: 'nod', ts: 44448030 }));
  rec.push(line({ ev: 'error', s: 'magnetometer', error: 'OperationError', message: 'unsupported' }));
  rec.push(decodeRecordLine(`${RECORD_PREFIX}{"v":1,"s":"accelerometer","r":[[1,`));
  const stats = rec.stats();
  assert.equal(stats.sensors.absoluteOrientation.samples, 3);
  assert.equal(stats.sensors.accelerometer.samples, 2, '轴数不对的行丢掉');
  assert.equal(stats.broken, 1);
  assert.deepEqual(stats.segments, ['nod']);
  assert.equal(stats.errors[0].error, 'OperationError');
  rec.mark(rec.latest(), '这里');
  const trace = rec.toTrace({ name: 'rec-1', device: { model: 'RG_glasses' } });
  assert.equal(trace.device.source, 'record');
  assert.equal(trace.device.model, 'RG_glasses');
  assert.equal(trace.sensors.absoluteOrientation.frequency, 60);
  assert.deepEqual(trace.sensors.absoluteOrientation.samples.map((s) => Math.round(s.t)), [0, 17, 33]);
  assert.deepEqual(trace.segments.map((s) => [s.id, s.from, s.to, s.expect]), [['nod', 10, 30, { nod: 1 }]]);
  assert.deepEqual(trace.marks.map((m) => m.label), ['这里']);
  const last = rec.toTrace({ lastSeconds: 0.02 });
  assert.deepEqual(Object.values(last.sensors).map((e) => e.samples.length), [2, 1]);
  // 内存上限：只留最近 maxSeconds 秒
  rec.push(line({ s: 'absoluteOrientation', r: [[44468000, 0, 0, 0, 1]] }));
  assert.equal(rec.stats().sensors.absoluteOrientation.samples, 1);
  rec.clear();
  assert.deepEqual(rec.stats().sensors, {});
});

test('轨迹名：小写字母数字点横线下划线', () => {
  assert.equal(traceFileName('rg1-guided'), 'rg1-guided.json');
  assert.throws(() => traceFileName('../x'), /轨迹名/);
  assert.throws(() => traceFileName('Nod'), /轨迹名/);
});

test('rebaseOrientation：第一条变成单位四元数，之后是相对它的转动；加速度计不动', () => {
  const h = Math.SQRT1_2;
  // 第一条：绕 X 转 90°；第二条：再绕 X 多转 90°（共 180°）
  const trace = normalizeTrace({ format: 'inklab-imu-trace', version: 2, name: 'r', sensors: {
    absoluteOrientation: { samples: [{ t: 0, x: h, y: 0, z: 0, w: h }, { t: 10, x: 1, y: 0, z: 0, w: 0 }] },
    accelerometer: { samples: [{ t: 0, x: 1, y: 2, z: 3 }] } } });
  const out = rebaseOrientation(trace);
  const [a, b] = out.sensors.absoluteOrientation.samples;
  assert.deepEqual([a.x, a.y, a.z, a.w].map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0, 1]);
  assert.deepEqual([b.x, b.y, b.z, b.w].map((v) => Math.round(v * 1e6) / 1e6), [0.707107, 0, 0, 0.707107]);
  assert.equal(out.sensors.accelerometer, trace.sensors.accelerometer);
  assert.equal(trace.sensors.absoluteOrientation.samples[0].x, h, '不改原轨迹');
});
