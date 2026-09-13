import test from 'node:test';
import assert from 'node:assert/strict';

import { createBatteryCapabilities, normalizeBatteryStatus } from '../lib/caps/battery.mjs';

test('电池状态归一化钳制 level，并用 null 表示宿主无法估计时长', () => {
  assert.deepEqual(normalizeBatteryStatus({ level: 2, charging: false, chargingTime: -1, dischargingTime: Infinity }), {
    charging: false, chargingTime: null, dischargingTime: null, level: 1,
  });
});

test('battery.start 返回完整初态；真实变化才按 targetId 派 statuschange', async () => {
  const events = [];
  const battery = createBatteryCapabilities({
    dispatchEvent: (name, detail) => events.push({ name, detail }),
    initial: { level: 0.8, charging: true, chargingTime: 600, dischargingTime: null },
    now: () => 123,
  });
  assert.deepEqual(await battery.capabilities.battery.start({ targetId: 'battery-1' }), {
    level: 0.8, charging: true, chargingTime: 600, dischargingTime: null,
  });
  assert.equal(battery.setStatus({ level: 0.8 }).changed.length, 0);
  assert.equal(events.length, 0);

  const changed = battery.setStatus({ level: 0.12, charging: false, chargingTime: null, dischargingTime: 900 });
  assert.deepEqual(changed.changed.sort(), ['charging', 'chargingTime', 'dischargingTime', 'level']);
  assert.deepEqual(events, [{
    name: 'battery.statuschange',
    detail: { targetId: 'battery-1', charging: false, chargingTime: null, dischargingTime: 900, level: 0.12 },
  }]);
  await battery.capabilities.battery.stop({ targetId: 'battery-1' });
  battery.setStatus({ level: 0.1 });
  assert.equal(events.length, 1, 'stop 后不再回灌');
});
