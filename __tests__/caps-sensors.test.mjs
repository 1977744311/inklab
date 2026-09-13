// InkLab 传感器能力：会话调度 / trace 回放 / 故障注入。纯逻辑，假钟 + 假 dispatchEvent，零 IO。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSensorCapabilities, DEFAULT_BASELINES } from '../lib/caps/sensors.mjs';
import { composeCapabilities } from '../lib/caps/contract.mjs';

// ── 测试替身 ────────────────────────────────────────────────────────────

/** 假钟：传感器全靠计时器推进，用真定时器测就只能靠 sleep 猜，抖一下就是随机失败。 */
function makeClock(startAt = 1_000_000) {
  let nowMs = startAt;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { id: seq, at: nowMs + Math.max(0, Number(ms) || 0), fn });
      return seq;
    },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    /** 推进 ms；跑的过程中新排的计时器只要落在窗口内也照跑（会话是链式排程的）。 */
    advance(ms) {
      const until = nowMs + Math.max(0, ms);
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next = null;
        for (const t of timers.values()) {
          if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
        }
        if (!next || next.at > until) break;
        nowMs = next.at;
        timers.delete(next.id);
        next.fn();
      }
      nowMs = until;
    },
    /** 只触发下一只计时器，并额外迟到 lateBy；模拟后台标签页/高负载下的 timer throttling。 */
    fireNextLate(lateBy = 0) {
      let next = null;
      for (const timer of timers.values()) {
        if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
      }
      if (!next) return false;
      timers.delete(next.id);
      nowMs = Math.max(nowMs, next.at + Math.max(0, Number(lateBy) || 0));
      next.fn();
      return true;
    },
  };
}

function makeSink() {
  const events = [];
  return {
    events,
    dispatchEvent: (name, detail) => { events.push({ name, detail }); },
    names: () => events.map((e) => e.name),
    of: (name) => events.filter((e) => e.name === name).map((e) => e.detail),
    clear: () => { events.length = 0; },
  };
}

function setup(opts = {}) {
  const clock = makeClock();
  const sink = makeSink();
  const api = createSensorCapabilities({
    dispatchEvent: sink.dispatchEvent,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...opts,
  });
  return { clock, sink, api, caps: api.capabilities, T0: clock.now() };
}

/** 一段真机风味的加速度样本：请求 60Hz(≈16.7ms)，实际到手 7/16/1/37ms，就是不等间隔。 */
const TRACE = [
  { t: 0, x: 0.10, y: 0.20, z: 9.70 },
  { t: 7, x: 0.30, y: 0.10, z: 9.90 },
  { t: 23, x: -0.40, y: 0.00, z: 10.40 },
  { t: 24, x: -0.20, y: 0.30, z: 10.10 },
  { t: 61, x: 0.00, y: 0.10, z: 9.60 },
];

test('traceState 只暴露控制台需要的摘要，clear 后明确回到 baseline', () => {
  const { api } = setup();
  assert.deepEqual(api.traceState('accelerometer'), {
    source: 'baseline', samples: 0, speed: 1, loop: false,
  });
  api.loadTrace('accelerometer', TRACE, { speed: 2, loop: true });
  assert.deepEqual(api.traceState('accelerometer'), {
    source: 'trace', samples: TRACE.length, speed: 2, loop: true,
  });
  api.clearTrace('accelerometer');
  assert.equal(api.traceState('accelerometer').source, 'baseline');
});

test('playTrace 可把短动作立即切给已在运行的 World Awareness 会话', async () => {
  const { api, caps, clock, sink } = setup();
  await caps.absoluteOrientation.start({ targetId: 'page', sessionId: 'world', frequency: 60 });
  clock.advance(0);
  sink.clear();
  const trace = [
    { t: 0, x: 0, y: 0, z: 0, w: 1 },
    { t: 20, x: 0.2, y: 0, z: 0, w: 0.979795897 },
  ];
  const loaded = api.playTrace('absoluteOrientation', trace);
  assert.equal(loaded.activeSessions, 1);
  clock.advance(20);
  const readings = sink.of('absoluteOrientation.reading');
  assert.equal(readings.length, 2);
  assert.equal(readings[1].x, 0.2);
});

// ── 会话与事件形状 ──────────────────────────────────────────────────────

test('start 后按请求频率持续发 reading，targetId/sessionId 原样带回', async () => {
  const { clock, sink, caps, T0 } = setup();
  await caps.accelerometer.start({ targetId: 'acc-1', sessionId: 's-1', frequency: 50 });
  assert.deepEqual(sink.names(), [], 'start 的调用栈里不能同步回灌——引擎此刻还在 await 这个 Promise');

  clock.advance(0);
  assert.deepEqual(sink.names(), ['accelerometer.activate'], 'activate 先于任何 reading');
  assert.deepEqual(sink.of('accelerometer.activate')[0], { targetId: 'acc-1', sessionId: 's-1' });

  clock.advance(100);
  const readings = sink.of('accelerometer.reading');
  assert.equal(readings.length, 5, '50Hz → 20ms 一条');
  assert.deepEqual(readings.map((r) => r.timestamp - T0), [20, 40, 60, 80, 100]);
  for (const r of readings) {
    // route 少一个字段引擎就抛 TypeError，等于整条传感器链路静默失效。
    assert.equal(r.targetId, 'acc-1');
    assert.equal(r.sessionId, 's-1');
    assert.deepEqual(Object.keys(r).sort(), ['sessionId', 'targetId', 'timestamp', 'x', 'y', 'z']);
  }
});

test('引擎没给 frequency 时按 60Hz 兜底，不是不发数据', async () => {
  const { clock, sink, caps } = setup();
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's' });
  clock.advance(100);
  assert.equal(sink.of('gyroscope.reading').length, 6, '60Hz ≈ 16.7ms 一条，100ms 内 6 条');
});

test('absoluteOrientation 的 reading 带 w 轴，三轴传感器不带（引擎按轴名逐个取值）', async () => {
  const { clock, sink, caps } = setup();
  await caps.absoluteOrientation.start({ targetId: 'o', sessionId: 's', frequency: 100 });
  await caps.gyroscope.start({ targetId: 'o', sessionId: 's', frequency: 100 });
  clock.advance(10);

  const ori = sink.of('absoluteOrientation.reading')[0];
  assert.deepEqual(Object.keys(ori).sort(), ['sessionId', 'targetId', 'timestamp', 'w', 'x', 'y', 'z']);
  assert.equal(ori.w, 1, '静置姿态是单位四元数，缺 w 或 w=0 都是非法姿态');

  const gyro = sink.of('gyroscope.reading')[0];
  assert.equal('w' in gyro, false, '三轴传感器多带一个 w 会让应用误以为拿到了姿态');
});

test('缺 targetId/sessionId 的 start 当场抛，不静默空转一个没人听的计时器', async () => {
  const { clock, caps } = setup();
  await assert.rejects(caps.accelerometer.start({ sessionId: 's' }), /targetId/);
  await assert.rejects(caps.accelerometer.start({ targetId: 't' }), /sessionId/);
  assert.equal(clock.pending(), 0);
});

test('capabilities 能直接并进 composeCapabilities（方法名必须是引擎认识的 start/stop）', () => {
  const { api } = setup();
  const merged = composeCapabilities(api.capabilities);
  assert.deepEqual(
    Object.keys(merged).sort(),
    ['absoluteOrientation', 'accelerometer', 'gyroscope', 'magnetometer'],
  );
  for (const ns of Object.keys(merged)) {
    assert.deepEqual(Object.keys(merged[ns]).sort(), ['start', 'stop'], ns);
  }
});

// ── trace 回放 ──────────────────────────────────────────────────────────

test('trace 回放按样本自己的时间戳推进——真机请求 60Hz 到手不等间隔，等间隔假数据会骗过 timestamp 差值算法', async () => {
  const { clock, sink, api, caps, T0 } = setup();
  api.loadTrace('accelerometer', TRACE);
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 60 });
  clock.advance(500);

  assert.equal(sink.names()[0], 'accelerometer.activate');
  const readings = sink.of('accelerometer.reading');
  assert.deepEqual(readings.map((r) => r.timestamp - T0), [0, 7, 23, 24, 61],
    '间隔来自 trace（7/16/1/37ms），不是请求频率的 16.7ms');
  assert.deepEqual(readings.map((r) => r.z), TRACE.map((s) => s.z), '轴值原样回放，不加噪声');
  assert.deepEqual(readings.map((r) => r.x), TRACE.map((s) => s.x));
});

test('trace 回调即使被浏览器计时器反复延迟，reading timestamp 仍严格复现录制时间轴', async () => {
  const { clock, sink, api, caps } = setup();
  api.loadTrace('accelerometer', TRACE);
  await caps.accelerometer.start({ targetId: 'a', sessionId: 'late', frequency: 60 });

  assert.equal(clock.fireNextLate(200), true, '先触发迟到的 activate');
  const traceEpoch = clock.now();
  while (clock.fireNextLate(200)) { /* 每一帧都人为晚 200ms */ }

  const readings = sink.of('accelerometer.reading');
  assert.deepEqual(readings.map((reading) => reading.timestamp - traceEpoch), [0, 7, 23, 24, 61]);
  assert.ok(clock.now() - traceEpoch > 800, '墙钟确实被节流拉长，测试不能退化成准时调度');
});

test('speed 只压缩墙上时间，样本顺序与取值不变', async () => {
  const { clock, sink, api, caps, T0 } = setup();
  api.loadTrace('gyroscope', [{ t: 0, x: 1 }, { t: 10, x: 2 }, { t: 30, x: 3 }], { speed: 2 });
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's' });
  clock.advance(500);

  const readings = sink.of('gyroscope.reading');
  assert.deepEqual(readings.map((r) => r.timestamp - T0), [0, 5, 15]);
  assert.deepEqual(readings.map((r) => r.x), [1, 2, 3]);
});

test('loop 用 trace 最后一个间隔接回开头，避免 wrap 处凭空多出一个采样尖峰', async () => {
  const { clock, sink, api, caps, T0 } = setup();
  api.loadTrace('gyroscope', [{ t: 0, x: 1 }, { t: 10, x: 2 }, { t: 30, x: 3 }], { loop: true });
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's' });
  clock.advance(100);

  const readings = sink.of('gyroscope.reading');
  assert.deepEqual(readings.slice(0, 6).map((r) => r.timestamp - T0), [0, 10, 30, 50, 60, 80],
    'wrap 处的间隔 = trace 最后一个间隔 20ms');
  assert.deepEqual(readings.slice(0, 6).map((r) => r.x), [1, 2, 3, 1, 2, 3]);
});

test('不 loop 的 trace 放完即停：不回落基线，也不留计时器（悄悄接上假数据等于骗自己）', async () => {
  const { clock, sink, api, caps } = setup();
  api.loadTrace('accelerometer', TRACE);
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's' });
  clock.advance(5_000);

  assert.equal(sink.of('accelerometer.reading').length, TRACE.length);
  assert.equal(clock.pending(), 0);
  const [session] = api.activeSessions();
  assert.equal(session.exhausted, true, '会话还在（应用没 stop），但已经没有数据了');
  assert.equal(session.source, 'trace');
});

test('两路会话各走各的 trace 游标：错开 start 不会互相拽时间轴', async () => {
  const { clock, sink, api, caps, T0 } = setup();
  api.loadTrace('accelerometer', [{ t: 0, x: 1 }, { t: 20, x: 2 }, { t: 40, x: 3 }]);
  await caps.accelerometer.start({ targetId: 'p1', sessionId: 'a' });
  clock.advance(10);
  await caps.accelerometer.start({ targetId: 'p2', sessionId: 'b' });
  clock.advance(200);

  const at = (id) => sink.of('accelerometer.reading')
    .filter((r) => r.sessionId === id).map((r) => r.timestamp - T0);
  assert.deepEqual(at('a'), [0, 20, 40]);
  assert.deepEqual(at('b'), [10, 30, 50], '第二路从它自己的 start 时刻开始放，游标独立');
});

test('loadTrace 校验：未知传感器 / 空样本 / 非正 speed / 缺 t 都当场报错，缺轴按基线补', () => {
  const { api } = setup();
  assert.throws(() => api.loadTrace('barometer', [{ t: 0 }]), /不是传感器命名空间/);
  assert.throws(() => api.loadTrace('accelerometer', []), /至少要有一条样本/);
  assert.throws(() => api.loadTrace('accelerometer', [{ t: 0 }], { speed: 0 }), /speed/);
  assert.throws(() => api.loadTrace('accelerometer', [{ x: 1 }]), /非负 t/);
  assert.throws(() => api.loadTrace('accelerometer', [{ t: -1 }]), /非负 t/);
  assert.throws(() => api.loadTrace('accelerometer', [{ t: 10 }, { t: 9 }]), /早于前一条/);

  // 三轴 trace 灌进姿态传感器：缺的 w 补基线的 1，补 0 会得到一个非法四元数。
  const loaded = api.loadTrace('absoluteOrientation', [{ t: 0, x: 0, y: 0, z: 0 }]);
  assert.deepEqual(loaded, { sensor: 'absoluteOrientation', samples: 1, speed: 1, loop: false });
});

// ── 静止基线与噪声 ──────────────────────────────────────────────────────

test('没有 trace 时回落静置基线：加速度计静置读的是重力，不是全 0', async () => {
  const { clock, sink, caps } = setup();
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  await caps.magnetometer.start({ targetId: 'm', sessionId: 's', frequency: 100 });
  clock.advance(10);

  const acc = sink.of('accelerometer.reading')[0];
  assert.equal(acc.z, DEFAULT_BASELINES.accelerometer.z);
  assert.ok(acc.z > 9, '全 0 会让"靠重力判朝向"的代码在 InkLab 假通过');
  assert.equal(sink.of('magnetometer.reading')[0].y, DEFAULT_BASELINES.magnetometer.y);
});

test('噪声只来自注入的 rng（可复现）；噪声关掉时一次也不取 rng，免得开关错开随机序列', async () => {
  const seq = [0, 0.5, 1];
  let calls = 0;
  const rng = () => { const v = seq[calls % seq.length]; calls += 1; return v; };
  const { clock, sink, caps } = setup({
    rng, noise: { gyroscope: 0.5 }, baselines: { gyroscope: { x: 1, y: 2, z: 3 } },
  });

  await caps.gyroscope.start({ targetId: 'g', sessionId: 's', frequency: 100 });
  clock.advance(10);
  const gyro = sink.of('gyroscope.reading')[0];
  assert.deepEqual([gyro.x, gyro.y, gyro.z], [0.5, 2, 3.5], '基线 ± 幅度×(2r-1)，逐轴依次取 rng');
  assert.equal(calls, 3);

  await caps.gyroscope.stop({ targetId: 'g', sessionId: 's' });
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  clock.advance(10);
  assert.equal(calls, 3, 'noise=0 的传感器不消耗随机序列');
  assert.deepEqual(sink.of('accelerometer.reading')[0].z, DEFAULT_BASELINES.accelerometer.z);
});

test('基线随改随生效（边跑边掰眼镜），trace 中途换只对之后新开的会话生效', async () => {
  const { clock, sink, api, caps } = setup();
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's1', frequency: 100 });
  clock.advance(10);
  assert.equal(sink.of('accelerometer.reading')[0].z, 9.81);

  api.setBaseline('accelerometer', { z: 5, x: 1 });
  sink.clear();
  clock.advance(10);
  assert.deepEqual([sink.of('accelerometer.reading')[0].x, sink.of('accelerometer.reading')[0].z], [1, 5]);

  // 换 trace 不能把正在跑的会话的时间轴接乱：老会话继续走基线。
  api.loadTrace('accelerometer', TRACE);
  sink.clear();
  clock.advance(20);
  for (const r of sink.of('accelerometer.reading')) assert.equal(r.z, 5);

  await caps.accelerometer.start({ targetId: 'a', sessionId: 's2', frequency: 100 });
  sink.clear();
  clock.advance(100);
  const fresh = sink.of('accelerometer.reading').filter((r) => r.sessionId === 's2');
  assert.deepEqual(fresh.map((r) => r.z), TRACE.map((s) => s.z), '新会话才吃到 trace');
});

// ── 多会话隔离与停止 ────────────────────────────────────────────────────

test('同一传感器开两路：频率各算，停一路不影响另一路', async () => {
  const { clock, sink, api, caps } = setup();
  await caps.accelerometer.start({ targetId: 'p1', sessionId: 'a', frequency: 100 });
  await caps.accelerometer.start({ targetId: 'p2', sessionId: 'b', frequency: 50 });
  clock.advance(40);

  const count = (id) => sink.of('accelerometer.reading').filter((r) => r.sessionId === id).length;
  assert.equal(count('a'), 4, '100Hz → 10ms');
  assert.equal(count('b'), 2, '50Hz → 20ms');
  assert.equal(api.activeSessions().length, 2);

  await caps.accelerometer.stop({ targetId: 'p2', sessionId: 'b' });
  sink.clear();
  clock.advance(40);
  assert.equal(count('b'), 0, '被停的那路彻底安静');
  assert.equal(count('a'), 4, '另一路照跑');
});

test('stop 之后不再发 reading，也不留计时器（引擎重载时野计时器会打到已销毁的 view 上）', async () => {
  const { clock, sink, api, caps } = setup();
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's', frequency: 100 });
  clock.advance(30);
  assert.equal(sink.of('gyroscope.reading').length, 3);

  await caps.gyroscope.stop({ targetId: 'g', sessionId: 's' });
  assert.equal(clock.pending(), 0);
  assert.deepEqual(api.activeSessions(), []);
  sink.clear();
  clock.advance(1_000);
  assert.deepEqual(sink.names(), []);
});

test('重开同一路会话不会留下两个计时器同时发（引擎会重启同一 session）', async () => {
  const { clock, sink, caps } = setup();
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  clock.advance(5);
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  sink.clear();
  clock.advance(100);
  assert.equal(sink.of('accelerometer.reading').length, 10, '还是 10ms 一条，不是双倍');
});

test('stopAll 清场：宿主重载引擎前必须能把四路传感器一次停干净', async () => {
  const { clock, sink, api, caps } = setup();
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's', frequency: 100 });
  await caps.absoluteOrientation.start({ targetId: 'o', sessionId: 's', frequency: 100 });
  clock.advance(30);
  assert.equal(api.activeSessions().length, 3);

  api.stopAll();
  assert.equal(clock.pending(), 0);
  assert.deepEqual(api.activeSessions(), []);
  sink.clear();
  clock.advance(1_000);
  assert.deepEqual(sink.names(), []);
});

// ── 故障注入 ────────────────────────────────────────────────────────────

test('injectError：下一次 start 直接报错且不 activate（权限被拒就是这个样子）', async () => {
  const { clock, sink, api, caps } = setup();
  api.injectError('magnetometer', { error: 'NotAllowedError', message: '用户拒绝了传感器权限' });
  await caps.magnetometer.start({ targetId: 'm', sessionId: 's' });
  clock.advance(1_000);

  assert.deepEqual(sink.names(), ['magnetometer.error'], '没有 activate，也没有 reading');
  assert.deepEqual(sink.of('magnetometer.error')[0], {
    targetId: 'm', sessionId: 's', error: 'NotAllowedError', message: '用户拒绝了传感器权限',
  });
  assert.deepEqual(api.activeSessions(), []);
  assert.equal(clock.pending(), 0);
});

test('injectError 对进行中的会话在下一个采样点生效：报错后立刻停，不再有 reading', async () => {
  const { clock, sink, api, caps } = setup();
  await caps.gyroscope.start({ targetId: 'g', sessionId: 's', frequency: 100 });
  clock.advance(25);
  assert.equal(sink.of('gyroscope.reading').length, 2);

  api.injectError('gyroscope', { error: 'NotReadableError', message: 'IMU 掉线' });
  sink.clear();
  clock.advance(1_000);
  assert.deepEqual(sink.names(), ['gyroscope.error']);
  assert.deepEqual(sink.of('gyroscope.error')[0], {
    targetId: 'g', sessionId: 's', error: 'NotReadableError', message: 'IMU 掉线',
  });
  assert.equal(clock.pending(), 0);
});

test('afterReadings：先正常发 N 条再挂（模拟跑着跑着掉线，测应用的中途降级）', async () => {
  const { clock, sink, api, caps } = setup();
  api.injectError('accelerometer', { error: 'NotReadableError', message: '', afterReadings: 3 });
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's', frequency: 100 });
  clock.advance(1_000);

  assert.deepEqual(sink.names(), [
    'accelerometer.activate',
    'accelerometer.reading', 'accelerometer.reading', 'accelerometer.reading',
    'accelerometer.error',
  ]);
  assert.equal(sink.of('accelerometer.error')[0].message, '', 'message 缺省是空串，不是 undefined');
});

test('故障是粘的：clearError 之前重试照样失败——真机的权限拒绝不会自愈', async () => {
  const { clock, sink, api, caps } = setup();
  api.injectError('accelerometer', { error: 'NotAllowedError' });

  await caps.accelerometer.start({ targetId: 'a', sessionId: 's1' });
  clock.advance(50);
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's2' });
  clock.advance(50);
  assert.deepEqual(sink.names(), ['accelerometer.error', 'accelerometer.error']);

  api.clearError('accelerometer');
  sink.clear();
  await caps.accelerometer.start({ targetId: 'a', sessionId: 's3', frequency: 100 });
  clock.advance(30);
  assert.equal(sink.names()[0], 'accelerometer.activate');
  assert.equal(sink.of('accelerometer.reading').length, 3);
});

test('故障按传感器隔离：注入陀螺仪不影响加速度计（降级路径常常只挂一路）', async () => {
  const { clock, sink, api, caps } = setup();
  api.injectError('gyroscope', { error: 'NotReadableError' });
  await caps.gyroscope.start({ targetId: 'x', sessionId: 's', frequency: 100 });
  await caps.accelerometer.start({ targetId: 'x', sessionId: 's', frequency: 100 });
  clock.advance(30);

  assert.equal(sink.of('gyroscope.reading').length, 0);
  assert.equal(sink.of('gyroscope.error').length, 1);
  assert.equal(sink.of('accelerometer.reading').length, 3);
  assert.equal(sink.of('accelerometer.error').length, 0);
});
