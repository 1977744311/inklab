import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLUETOOTH_MODES, bluetoothModeFromSearch, createComputerBluetoothAdapter,
  createNavigatorBluetoothController,
  normalizeBluetoothMode,
} from '../lib/bluetooth-mode.mjs';
import { createBluetoothSimulator } from '../lib/caps/bluetooth.mjs';

test('蓝牙模式：缺省和未知值安全回落 mock，只有 computer 显式启用电脑蓝牙', () => {
  assert.equal(normalizeBluetoothMode(), BLUETOOTH_MODES.MOCK);
  assert.equal(normalizeBluetoothMode('wat'), BLUETOOTH_MODES.MOCK);
  assert.equal(normalizeBluetoothMode('COMPUTER'), BLUETOOTH_MODES.COMPUTER);
  assert.equal(bluetoothModeFromSearch('?bluetooth=computer'), BLUETOOTH_MODES.COMPUTER);
  assert.equal(bluetoothModeFromSearch('?bluetooth=real'), BLUETOOTH_MODES.MOCK);
});

test('navigator 接线：mock 装假体，computer 精确恢复并适配原生 prototype getter', () => {
  const nativeBluetooth = {
    requestDevice: async () => ({ id: 'watch-1' }),
    getAvailability: async () => true,
  };
  const proto = {};
  Object.defineProperty(proto, 'bluetooth', { configurable: true, get: () => nativeBluetooth });
  const navigatorRef = Object.create(proto);
  const simulator = createBluetoothSimulator();
  const controller = createNavigatorBluetoothController({ navigatorRef, simulator });

  assert.equal(navigatorRef.bluetooth, nativeBluetooth);
  controller.setMode('mock');
  assert.equal(navigatorRef.bluetooth, simulator.bluetooth);
  assert.equal(Object.hasOwn(navigatorRef, 'bluetooth'), true);
  assert.equal(controller.isComputerSupported(), true);

  controller.setMode('computer');
  assert.equal(Object.hasOwn(navigatorRef, 'bluetooth'), true);
  assert.equal(typeof navigatorRef.bluetooth.requestDevice, 'function');
  assert.equal(typeof navigatorRef.bluetooth.scanDevices, 'undefined');
  assert.notEqual(navigatorRef.bluetooth, nativeBluetooth);

  controller.setMode('mock');
  controller.restore();
  assert.equal(navigatorRef.bluetooth, nativeBluetooth);
});

test('电脑支持状态不把任意真值对象误报成 ready', () => {
  const proto = {};
  Object.defineProperty(proto, 'bluetooth', { configurable: true, get: () => ({ native: true }) });
  const navigatorRef = Object.create(proto);
  const controller = createNavigatorBluetoothController({ navigatorRef });

  controller.setMode('mock');
  assert.equal(controller.isComputerSupported(), false);
  controller.setMode('computer');
  assert.equal(controller.isComputerSupported(), false);
  assert.equal(Object.hasOwn(navigatorRef, 'bluetooth'), false);
});

test('navigator 接线：原本没有电脑蓝牙也能模拟，恢复后明确显示不支持', () => {
  const navigatorRef = {};
  const controller = createNavigatorBluetoothController({ navigatorRef });
  controller.setMode('mock');
  assert.equal(typeof navigatorRef.bluetooth.requestDevice, 'function');
  assert.equal(controller.isComputerSupported(), false);
  controller.setMode('computer');
  assert.equal('bluetooth' in navigatorRef, false);
});

test('navigator 接线：不可配置的原生自有属性会响亮拒绝，不静默假装装上了', () => {
  const nativeBluetooth = { native: true };
  const navigatorRef = {};
  Object.defineProperty(navigatorRef, 'bluetooth', { configurable: false, value: nativeBluetooth });
  const controller = createNavigatorBluetoothController({ navigatorRef });
  assert.throws(() => controller.setMode('mock'), /不可覆写/);
  assert.equal(navigatorRef.bluetooth, nativeBluetooth);
});

test('电脑适配：保留原生 requestDevice 结果，由 ink_web 负责 scanDevices 跨桥', async () => {
  const selected = { id: 'real-watch', name: 'Example Wrist' };
  const calls = [];
  const nativeBluetooth = {
    async getAvailability() { calls.push('available'); return true; },
    async getDevices() { calls.push('remembered'); return []; },
    requestDevice(options) { calls.push({ request: options }); return Promise.resolve(selected); },
  };
  const adapter = createComputerBluetoothAdapter(nativeBluetooth);

  assert.equal(await adapter.getAvailability(), true);
  assert.deepEqual(await adapter.getDevices(), []);
  assert.equal(await adapter.requestDevice({ filters: [{ services: ['wrist-service'] }] }), selected);
  assert.equal(typeof adapter.scanDevices, 'undefined', '不能抢走 ink_web 的原生设备代理路径');
  assert.deepEqual(calls.at(-1), { request: { filters: [{ services: ['wrist-service'] }] } });
});

test('电脑适配：引擎跨桥丢用户手势时挂起扫描，DOM 授权后原请求继续', async () => {
  const selected = { id: 'real-watch', name: 'Example-Wrist' };
  const options = { filters: [{ services: ['wrist-service'] }] };
  let attempts = 0;
  const adapter = createComputerBluetoothAdapter({
    requestDevice(received) {
      assert.deepEqual(received, options);
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Must be handling a user gesture to show a permission request");
        error.name = 'SecurityError';
        return Promise.reject(error);
      }
      return Promise.resolve(selected);
    },
  });

  const requestPromise = adapter.requestDevice(options);
  for (let i = 0; i < 4 && !adapter.needsAuthorization(); i += 1) await Promise.resolve();
  assert.equal(adapter.needsAuthorization(), true);
  assert.deepEqual(adapter.lastRequestOptions(), options);

  assert.equal(await adapter.authorizeDevice(), selected);
  assert.equal(await requestPromise, selected);
  assert.equal(adapter.needsAuthorization(), false);
  assert.equal(adapter.authorizedDevice(), selected);
  assert.equal(attempts, 2);
  assert.ok(adapter.calls.some((row) => row.operation === 'bluetooth.requestDevice.authorization-needed'));
});

test('电脑适配：已授权设备供后续重扫复用，不重复弹 chooser', async () => {
  const selected = { id: 'real-watch', name: 'Example-Wrist' };
  let attempts = 0;
  const adapter = createComputerBluetoothAdapter({
    requestDevice: async () => { attempts += 1; return selected; },
  });
  await adapter.requestDevice({ acceptAllDevices: true });
  await adapter.requestDevice({ acceptAllDevices: true });
  assert.equal(attempts, 1);
  assert.ok(adapter.calls.some((row) => row.operation === 'bluetooth.requestDevice.reuse'));
});

test('电脑适配：工程重载断开真实 GATT，但保留已授权设备供新实例重连', async () => {
  let disconnects = 0;
  const selected = {
    name: 'Example-Wrist',
    gatt: {
      connected: true,
      disconnect() { disconnects += 1; this.connected = false; },
    },
  };
  const adapter = createComputerBluetoothAdapter({ requestDevice: async () => selected });
  await adapter.requestDevice({ filters: [{ services: ['wrist-service'] }] });
  assert.equal(adapter.disconnectAuthorizedDevice(), true);
  assert.equal(disconnects, 1);
  assert.equal(adapter.authorizedDevice(), selected);
  assert.equal(adapter.disconnectAuthorizedDevice(), false);
  assert.ok(adapter.calls.some((row) => row.operation === 'bluetooth.gatt.disconnect-on-reload'));
});

test('navigator 接线：computer 保留 requestDevice 给 ink_web 适配 scanDevices，restore 仍还原 getter', async () => {
  const nativeBluetooth = {
    requestDevice: async () => ({ id: 'watch-1' }),
    getAvailability: async () => true,
  };
  const proto = {};
  Object.defineProperty(proto, 'bluetooth', { configurable: true, get: () => nativeBluetooth });
  const navigatorRef = Object.create(proto);
  const controller = createNavigatorBluetoothController({ navigatorRef });

  controller.setMode('computer');
  assert.notEqual(navigatorRef.bluetooth, nativeBluetooth);
  assert.equal(typeof navigatorRef.bluetooth.requestDevice, 'function');
  assert.equal(typeof navigatorRef.bluetooth.scanDevices, 'undefined');
  assert.equal(controller.isComputerSupported(), true);
  assert.equal(controller.nativeBluetooth(), nativeBluetooth);
  controller.restore();
  assert.equal(Object.hasOwn(navigatorRef, 'bluetooth'), false);
  assert.equal(navigatorRef.bluetooth, nativeBluetooth);
});
