// sensor-profiles.mjs — 模拟器传感器按哪台真机的脾气来（inklab.config.json 的 sensorProfile）。
//
// generic：按请求频率出数，四个传感器都有（旧行为，也是缺省）。
// rokid-rg1：RG1 一代眼镜经 Ink API 实测（2026-11-17，Ink 0.20.0-rc，InkLab IMU 探针）：
//   - 没有磁力计：new Magnetometer().start() 回 error 事件 OperationError「Magnetometer is unsupported on this device」；
//   - 加速度计 / 陀螺仪请求 60Hz，实际到手约 101Hz（9.89ms）；
//   - 姿态（Game Rotation Vector）请求 60Hz 给 60Hz；请求 10 或 30Hz 却给约 50Hz——系统里另有
//     客户端按 20ms 占着这个传感器，请求被抬高。这一条随系统状态变化，只是实测时的样子；
//   - 没实测过的请求频率，取最接近的实测点。
// 静止姿态、噪声这类数值不放在档案里：要真实值就录一条轨迹回放（e2e/traces/）。

export const SENSOR_PROFILES = Object.freeze({
  generic: Object.freeze({ id: 'generic', label: '通用：按请求频率出数，四个传感器都有' }),
  'rokid-rg1': Object.freeze({
    id: 'rokid-rg1',
    label: 'Rokid RG1（一代）：无磁力计，加速度计/陀螺仪 ~101Hz，姿态 50–60Hz',
    measured: 'RG1 · Ink 0.20.0-rc · 2026-11-17',
    unsupported: Object.freeze({
      magnetometer: Object.freeze({ error: 'OperationError', message: 'Magnetometer is unsupported on this device' }),
    }),
    rates: Object.freeze({
      accelerometer: Object.freeze([[60, 101.1]]),
      gyroscope: Object.freeze([[60, 101.1]]),
      absoluteOrientation: Object.freeze([[10, 50.55], [30, 50.55], [60, 60]]),
    }),
  }),
});

export function sensorProfile(value) {
  if (!value) return SENSOR_PROFILES.generic;
  if (typeof value === 'object') return value;
  const profile = SENSOR_PROFILES[value];
  if (!profile) throw new Error(`没有这个传感器档案：${value}（可用：${Object.keys(SENSOR_PROFILES).join(' / ')}）`);
  return profile;
}

/** 请求频率 → 这台设备实际给的频率（没有实测点就照请求给）。 */
export function deliveredFrequency(profile, sensor, requested) {
  const points = profile && profile.rates && profile.rates[sensor];
  if (!points || !points.length) return requested;
  let best = points[0];
  for (const point of points) if (Math.abs(point[0] - requested) < Math.abs(best[0] - requested)) best = point;
  return best[1];
}

/** 这台设备上不存在的传感器：start 时要回的错误；存在则 null。 */
export function unsupportedSensor(profile, sensor) {
  return (profile && profile.unsupported && profile.unsupported[sensor]) || null;
}
