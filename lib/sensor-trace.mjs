// sensor-trace.mjs — 手动 IMU 控制台使用的轻量 trace 工具。
//
// 这里只提供一个明确标成“合成”的深蹲示例和 JSON 解包；真正的回放时序、轴补全、
// 会话隔离仍全部由 caps/sensors.mjs 负责，避免手动入口另造一套传感器实现。

/**
 * 已被 Iron Coach rep-engine 场景使用过的合成深蹲波形：先静止，再按固定周期运动。
 * 它用于流程/算法调试，不代表任何真实设备的噪声或佩戴姿态。
 */
export function createSquatAccelerometerTrace({
  reps = 6,
  hz = 60,
  stillMs = 3000,
  periodMs = 2000,
} = {}) {
  const count = Math.max(1, Math.trunc(Number(reps) || 0));
  const rate = Math.max(1, Number(hz) || 0);
  const leadIn = Math.max(0, Number(stillMs) || 0);
  const period = Math.max(100, Number(periodMs) || 0);
  const durationMs = leadIn + count * period;
  const stepMs = 1000 / rate;
  const samples = [];

  for (let t = 0; t <= durationMs; t += stepMs) {
    const still = t < leadIn;
    const motionT = Math.max(0, t - leadIn);
    samples.push({
      t: Math.round(t),
      x: 0.018 * Math.sin(t / 83),
      y: 9.81 + (still
        ? 0.045 * Math.sin(t / 53)
        : -2 * Math.sin((2 * Math.PI * motionT) / period)),
      z: 0.014 * Math.cos(t / 71),
    });
  }
  return samples;
}

/**
 * 页面级 World Awareness 的合成头部动作。nod 绕 X 轴，shake 绕 Y 轴，输出单位四元数。
 * 这是状态机/接线探针，不是对真实用户动作阈值的生物力学校准。
 */
export function createHeadGestureOrientationTrace(kind = 'nod', {
  hz = 60,
  cycles = 2,
  amplitudeRad = kind === 'shake' ? 0.42 : 0.34,
  leadInMs = 400,
  periodMs = 620,
  settleMs = 500,
} = {}) {
  if (kind !== 'nod' && kind !== 'shake') throw new TypeError('头部动作只支持 nod 或 shake');
  const rate = Math.max(1, Number(hz) || 60);
  const count = Math.max(1, Math.trunc(Number(cycles) || 1));
  const lead = Math.max(0, Number(leadInMs) || 0);
  const period = Math.max(200, Number(periodMs) || 620);
  const end = lead + count * period + Math.max(0, Number(settleMs) || 0);
  const axis = kind === 'nod' ? 'x' : 'y';
  const samples = [];
  for (let t = 0; t <= end; t += 1000 / rate) {
    const moving = t >= lead && t < lead + count * period;
    const angle = moving ? amplitudeRad * Math.sin((2 * Math.PI * (t - lead)) / period) : 0;
    const half = angle / 2;
    const q = { x: 0, y: 0, z: 0, w: Math.cos(half) };
    q[axis] = Math.sin(half);
    samples.push({ t: Math.round(t), ...q });
  }
  return samples;
}

/**
 * 接受两种手动导入形状：
 *   [{ t, x, y, z }, ...]
 *   { sensor: 'accelerometer', speed: 1, samples: [...] }
 * loop 由控制台勾选框负责，文件本身不替用户改变循环行为。
 */
export function parseSensorTraceJson(text, fallbackSensor = 'accelerometer') {
  const parsed = JSON.parse(String(text));
  const envelope = Array.isArray(parsed) ? { samples: parsed } : parsed;
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.samples)) {
    throw new TypeError('IMU trace 必须是样本数组，或带 samples 数组的对象');
  }
  const sensor = typeof envelope.sensor === 'string' && envelope.sensor.trim()
    ? envelope.sensor.trim()
    : String(fallbackSensor || 'accelerometer');
  const speed = envelope.speed === undefined ? 1 : Number(envelope.speed);
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError('IMU trace 的 speed 必须是正数');
  return { sensor, speed, samples: envelope.samples };
}
