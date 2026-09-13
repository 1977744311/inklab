// battery.mjs — AIUI 0.17 Battery Status 宿主假体。
//
// 0.17 glue 的真实契约：battery.start(args) 必须返回完整状态；后续变化通过
// `battery.statuschange` 回灌，detail 带 targetId + 四个状态字段。BatteryManager 再由引擎侧
// 根据字段变化派 chargingchange/levelchange/chargingtimechange/dischargingtimechange。

import { routeOf } from './contract.mjs';

export const DEFAULT_BATTERY_STATUS = Object.freeze({
  charging: true,
  chargingTime: 0,
  dischargingTime: null,
  level: 0.82,
});

function finiteOrNull(value) {
  if (value == null || value === Infinity) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normalizeBatteryStatus(value, fallback = DEFAULT_BATTERY_STATUS) {
  const raw = value && typeof value === 'object' ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_BATTERY_STATUS;
  const level = raw.level == null ? Number(base.level) : Number(raw.level);
  return {
    charging: raw.charging == null ? Boolean(base.charging) : Boolean(raw.charging),
    chargingTime: raw.chargingTime === undefined ? finiteOrNull(base.chargingTime) : finiteOrNull(raw.chargingTime),
    dischargingTime: raw.dischargingTime === undefined ? finiteOrNull(base.dischargingTime) : finiteOrNull(raw.dischargingTime),
    level: Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1)),
  };
}

export function createBatteryCapabilities({
  dispatchEvent,
  initial = DEFAULT_BATTERY_STATUS,
  now = () => Date.now(),
} = {}) {
  if (typeof dispatchEvent !== 'function') throw new TypeError('battery 需要 dispatchEvent');
  let status = normalizeBatteryStatus(initial);
  const targets = new Set();
  const changes = [];

  const capabilities = {
    battery: {
      async start(args = {}) {
        const { targetId } = routeOf(args);
        if (targetId) targets.add(targetId);
        return { ...status };
      },
      async stop(args = {}) {
        const { targetId } = routeOf(args);
        if (targetId) targets.delete(targetId);
      },
    },
  };

  function setStatus(patch = {}) {
    const previous = status;
    status = normalizeBatteryStatus({ ...status, ...patch }, status);
    const changed = Object.keys(status).filter((key) => status[key] !== previous[key]);
    if (!changed.length) return { ...status, changed: [], listeners: targets.size };
    const rec = { at: now(), previous, status: { ...status }, changed, listeners: targets.size };
    changes.push(rec);
    for (const targetId of targets) dispatchEvent('battery.statuschange', { targetId, ...status });
    return { ...status, changed, listeners: targets.size };
  }

  return {
    capabilities,
    status: () => ({ ...status }),
    setStatus,
    listeners: () => [...targets],
    changes,
    reset() { status = normalizeBatteryStatus(initial); targets.clear(); changes.length = 0; },
  };
}
