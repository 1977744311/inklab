import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalBluetoothUuid, createBluetoothSimulator, parseBluetoothBytes,
  parseBluetoothNotificationTraceJson,
} from '../lib/caps/bluetooth.mjs';

test('蓝牙 UUID/字节归一：标准别名、16-bit 与自定义 UUID 都得到引擎能吃的形状', () => {
  assert.equal(canonicalBluetoothUuid('heart_rate', 'service'), '0000180d-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalBluetoothUuid('2A37', 'characteristic'), '00002a37-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalBluetoothUuid('6F1D0001-8F5B-4C7E-9A21-4A19F2B4C001', 'characteristic'),
    '6f1d0001-8f5b-4c7e-9a21-4a19f2b4c001');
  assert.deepEqual([...parseBluetoothBytes('0x00, 0x58')], [0, 88]);
  assert.deepEqual([...parseBluetoothBytes('0058')], [0, 88]);
  assert.throws(() => parseBluetoothBytes('0x0'), /偶数位/);
  assert.throws(() => canonicalBluetoothUuid('wat'), /不认识/);
});

test('BLE 通知 trace JSON 支持固定间隔与逐帧时间戳，并拒绝含糊时间轴', () => {
  const fixed = parseBluetoothNotificationTraceJson('["00 46", [0, 71]]', {
    serviceUuid: 'heart_rate', characteristicUuid: 'heart_rate_measurement', intervalMs: 20,
  });
  assert.equal(fixed.serviceUuid, '0000180d-0000-1000-8000-00805f9b34fb');
  assert.equal(fixed.characteristicUuid, '00002a37-0000-1000-8000-00805f9b34fb');
  assert.equal(fixed.intervalMs, 20);
  assert.deepEqual(fixed.frames.map((frame) => [...frame.value]), [[0, 70], [0, 71]]);

  const timed = parseBluetoothNotificationTraceJson(JSON.stringify({
    deviceId: 'watch-1', serviceUuid: '180d', characteristicUuid: '2a37', loop: true,
    frames: [{ t: 0, value: '00 48' }, { t: 17, data: [0, 73] }],
  }));
  assert.equal(timed.deviceId, 'watch-1');
  assert.equal(timed.loop, true);
  assert.deepEqual(timed.frames.map((frame) => [frame.t, ...frame.value]), [[0, 0, 72], [17, 0, 73]]);

  assert.throws(() => parseBluetoothNotificationTraceJson('{"frames":[]}'), /非空帧/);
  assert.throws(() => parseBluetoothNotificationTraceJson(JSON.stringify({
    serviceUuid: '180d', characteristicUuid: '2a37', frames: [{ t: 10, value: '00' }, [1]],
  })), /不能混用/);
  assert.throws(() => parseBluetoothNotificationTraceJson(JSON.stringify({
    serviceUuid: '180d', characteristicUuid: '2a37', frames: [
      { t: 10, value: '00' }, { t: 9, value: '01' },
    ],
  })), /早于前一帧/);
});

test('默认模拟设备跑通发现 → GATT → Service → Characteristic → 通知', async () => {
  const sim = createBluetoothSimulator({ now: () => 123 });
  assert.equal(await sim.bluetooth.getAvailability(), true);
  assert.deepEqual(await sim.bluetooth.getDevices(), [], 'requestDevice 前不该凭空成为已授权设备');

  const device = await sim.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
  assert.equal(device.id, 'inklab-heart-rate-1');
  assert.deepEqual((await sim.bluetooth.getDevices()).map((d) => d.id), [device.id]);

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('heart_rate');
  const characteristic = await service.getCharacteristic('heart_rate_measurement');
  const seen = [];
  characteristic.addEventListener('characteristicvaluechanged', () => {
    seen.push([...new Uint8Array(characteristic.value.buffer, characteristic.value.byteOffset, characteristic.value.byteLength)]);
  });
  await characteristic.startNotifications();
  sim.emitNotification({
    serviceUuid: 'heart_rate', characteristicUuid: 'heart_rate_measurement',
  }, [0, 88]);

  assert.deepEqual(seen, [[0, 88]]);
  assert.equal(characteristic.value.getUint8(1), 88);
  assert.equal(sim.snapshot().devices[0].services[0].characteristics[0].notifying, true);
  assert.ok(sim.calls.some((c) => c.operation === 'bluetooth.requestDevice'));
  assert.ok(sim.calls.some((c) => c.operation === 'characteristic.notification'));
});

test('自定义 GATT 可读写，onWrite 能驱动业务协议假体', async () => {
  const writes = [];
  const sim = createBluetoothSimulator({ devices: [{
    id: 'wrist-1', name: 'IronCoach-Wrist-Test', services: [{
      uuid: '6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001',
      characteristics: [{
        uuid: '6f1d0004-8f5b-4c7e-9a21-4a19f2b4c001',
        properties: { read: false, write: true, writeWithoutResponse: true },
        onWrite: (bytes, ctx) => writes.push({ bytes: [...bytes], writeType: ctx.writeType }),
      }],
    }],
  }] });
  const device = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001');
  const command = await service.getCharacteristic('6f1d0004-8f5b-4c7e-9a21-4a19f2b4c001');
  await command.writeValueWithResponse(Uint8Array.from([1, 2, 3]));
  await command.writeValueWithoutResponse(Uint8Array.from([4, 5]));

  assert.deepEqual(writes, [
    { bytes: [1, 2, 3], writeType: 'writeValueWithResponse' },
    { bytes: [4, 5], writeType: 'writeValueWithoutResponse' },
  ]);
  assert.deepEqual(sim.snapshot().devices[0].services[0].characteristics[0].writes, [[1, 2, 3], [4, 5]]);
});

test('有响应/无响应写入严格服从 characteristic.properties，不把协议差异抹平', async () => {
  const sim = createBluetoothSimulator({ devices: [{
    id: 'write-mode-1', services: [{
      uuid: '180f',
      characteristics: [{ uuid: '2a19', properties: { read: false, writeWithoutResponse: true } }],
    }],
  }] });
  const device = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  const service = await (await device.gatt.connect()).getPrimaryService('180f');
  const characteristic = await service.getCharacteristic('2a19');

  await assert.rejects(characteristic.writeValueWithResponse([1]), (err) => err?.name === 'NotSupportedError');
  await characteristic.writeValueWithoutResponse([2]);
  assert.deepEqual(characteristic.writes.map((bytes) => [...bytes]), [[2]]);
});

test('适配器、断连和一次性故障都可控，resetRuntime 留设备定义但清运行态', async () => {
  const sim = createBluetoothSimulator();
  const device = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  let disconnected = 0;
  device.addEventListener('gattserverdisconnected', () => { disconnected += 1; });
  await device.gatt.connect();
  sim.setAvailability(false);
  assert.equal(device.gatt.connected, false);
  assert.equal(disconnected, 1);
  await assert.rejects(sim.bluetooth.requestDevice({ acceptAllDevices: true }), (err) => err?.name === 'NotFoundError');

  sim.setAvailability(true);
  sim.failNext('gatt.connect', { name: 'NetworkError', message: 'radio drop' });
  await assert.rejects(device.gatt.connect(), /radio drop/);
  await device.gatt.connect();
  assert.equal(device.gatt.connected, true, '故障只吃下一次，重试恢复');

  sim.resetRuntime();
  assert.equal(sim.devices().length, 1);
  assert.equal(sim.devices()[0].gatt.connected, false);
  assert.equal(sim.calls.length, 0);
});

test('resetRuntime 后旧同 ID device 的延迟断开不污染新连接、事件或调用账', async () => {
  const sim = createBluetoothSimulator();
  const staleDevice = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  const staleService = await (await staleDevice.gatt.connect()).getPrimaryService('heart_rate');
  const staleCharacteristic = await staleService.getCharacteristic('heart_rate_measurement');
  await staleCharacteristic.startNotifications();
  let staleDisconnectEvents = 0;
  staleDevice.addEventListener('gattserverdisconnected', () => { staleDisconnectEvents += 1; });

  sim.resetRuntime();
  const currentDevice = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  assert.equal(staleDevice.id, currentDevice.id, '两代仍是同一逻辑设备 ID');
  assert.notEqual(staleDevice, currentDevice, 'resetRuntime 应创建新一代浏览器对象');
  await currentDevice.gatt.connect();
  let currentDisconnectEvents = 0;
  currentDevice.addEventListener('gattserverdisconnected', () => { currentDisconnectEvents += 1; });
  const callsBeforeStaleTeardown = sim.calls.length;

  await assert.rejects(
    staleCharacteristic.stopNotifications(),
    (err) => err?.name === 'InvalidStateError',
    '旧 generation 的 characteristic 操作应在记账前拒绝',
  );
  staleDevice.gatt.disconnect();

  assert.equal(staleDevice.gatt.connected, false, '旧对象自身仍应完成本地清理');
  assert.equal(currentDevice.gatt.connected, true, '旧对象断开不得命中新一代同 ID 设备');
  assert.equal(staleDisconnectEvents, 0, '旧 generation 不得再派 gattserverdisconnected');
  assert.equal(currentDisconnectEvents, 0, '新 wrapper 不得收到旧 generation 的断线事件');
  assert.equal(sim.calls.length, callsBeforeStaleTeardown, '旧 generation 清理不得污染新一轮调用账');
  assert.equal(sim.calls.some((call) => call.operation === 'gatt.disconnect'), false);
});

test('通知 trace 可按固定间隔回放，适合 50Hz IMU 数据流', async () => {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimeout = (fn, ms) => { seq += 1; timers.set(seq, { at: now + Number(ms), fn }); return seq; };
  const clearTimeout = (id) => timers.delete(id);
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  };
  const sim = createBluetoothSimulator({ now: () => now, setTimeout, clearTimeout });
  const device = await sim.bluetooth.requestDevice({ acceptAllDevices: true });
  const service = await (await device.gatt.connect()).getPrimaryService('heart_rate');
  const characteristic = await service.getCharacteristic('heart_rate_measurement');
  const seen = [];
  characteristic.addEventListener('characteristicvaluechanged', () => seen.push(characteristic.value.getUint8(1)));
  await characteristic.startNotifications();

  const trace = sim.playNotificationTrace({
    serviceUuid: 'heart_rate', characteristicUuid: 'heart_rate_measurement',
    frames: [[0, 70], [0, 71], [0, 72]], intervalMs: 20,
  });
  assert.equal(trace.stats().status, 'running');
  assert.equal(trace.stats().emittedFrames, 0);
  assert.equal(sim.activeNotificationTraces().length, 1);
  tick(0); assert.deepEqual(seen, [70]);
  assert.equal(trace.stats().emittedFrames, 1);
  tick(20); assert.deepEqual(seen, [70, 71]);
  tick(20); assert.deepEqual(seen, [70, 71, 72]);
  assert.deepEqual(await trace.done, { stopped: false, frames: 3 });
  assert.equal(trace.stats().status, 'completed');
  assert.equal(trace.stats().running, false);
  assert.equal(trace.stats().emittedFrames, 3);
  assert.deepEqual(sim.activeNotificationTraces(), []);

  const loop = sim.playNotificationTrace({
    serviceUuid: 'heart_rate', characteristicUuid: 'heart_rate_measurement',
    frames: [[0, 73], [0, 74]], intervalMs: 20, loop: true,
  });
  tick(0);
  assert.equal(loop.stats().emittedFrames, 1);
  assert.equal(sim.stopNotificationTraces({ characteristicUuid: 'heart_rate_measurement' }), 1);
  assert.deepEqual(await loop.done, { stopped: true, frames: 1 });
  assert.equal(loop.stats().status, 'stopped');
  assert.deepEqual(sim.snapshot().notificationTraces, []);
});

test('通知 trace 遇到断连会让 done 明确失败，不在计时器里留下未处理异常', async () => {
  const timers = [];
  const sim = createBluetoothSimulator({
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  const trace = sim.playNotificationTrace({
    serviceUuid: 'heart_rate', characteristicUuid: 'heart_rate_measurement', frames: [[0, 70]],
  });
  timers.shift()();
  await assert.rejects(trace.done, (err) => err?.name === 'NetworkError');
  assert.equal(trace.stats().status, 'failed');
  assert.equal(trace.stats().error.name, 'NetworkError');
  assert.deepEqual(sim.activeNotificationTraces(), []);
});
