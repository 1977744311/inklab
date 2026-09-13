// bluetooth-mode.mjs — InkLab 的蓝牙来源开关。
//
// mock 模式把 caps/bluetooth.mjs 的结构化假体装到 navigator.bluetooth；computer 模式
// 删除这层自有覆写，恢复浏览器原生 Web Bluetooth。不要把蓝牙塞进 hostCapabilities：
// ink_web 0.17 的蓝牙走独立 web_bluetooth bridge，不经过那张能力编解码表。

import { createBluetoothSimulator } from './caps/bluetooth.mjs';

export const BLUETOOTH_MODES = Object.freeze({
  MOCK: 'mock',
  COMPUTER: 'computer',
});

/** 未知值安全回落 mock：自动化环境不能因拼错参数意外弹真实设备选择框。 */
export function normalizeBluetoothMode(value) {
  return String(value || '').trim().toLowerCase() === BLUETOOTH_MODES.COMPUTER
    ? BLUETOOTH_MODES.COMPUTER
    : BLUETOOTH_MODES.MOCK;
}

export function bluetoothModeFromSearch(search = '') {
  return normalizeBluetoothMode(new URLSearchParams(String(search)).get('bluetooth'));
}

/**
 * Desktop Chromium implements the standard Web Bluetooth chooser (`requestDevice`) but not
 * Ink's continuous `scanDevices` extension.  Keep that adaptation inside ink_web: it knows how
 * to proxy a native BluetoothDevice across the WASM/QuickJS boundary.  This wrapper only keeps a
 * chooser request pending when that boundary has consumed Chromium's transient user gesture.
 * A later DOM click resolves the same request with the original service filters.
 */
export function createComputerBluetoothAdapter(nativeBluetooth) {
  if (!nativeBluetooth || (typeof nativeBluetooth !== 'object' && typeof nativeBluetooth !== 'function')) {
    return null;
  }
  if (typeof nativeBluetooth.scanDevices === 'function') return nativeBluetooth;
  if (typeof nativeBluetooth.requestDevice !== 'function') return null;

  let authorizedDevice = null;
  let lastRequestOptions = null;
  let pendingAuthorization = null;
  const calls = [];
  const record = (operation, detail = {}) => {
    calls.push({ at: Date.now(), operation, ...detail });
    if (calls.length > 200) calls.splice(0, calls.length - 200);
  };
  const deviceName = (device) => String(device && device.name || '未命名设备');
  const call = (name, args) => nativeBluetooth[name](...args);
  const needsTrustedGesture = (error) => {
    const name = String(error && error.name || '');
    const message = String(error && error.message || error || '');
    return name === 'SecurityError' && /user gesture|permission request/i.test(message);
  };
  const selectNative = (options, operation) => {
    lastRequestOptions = options;
    record(operation);
    // requestDevice must be invoked before the first await so a DOM click keeps
    // Chromium's transient user activation alive.
    const selected = nativeBluetooth.requestDevice(options);
    return Promise.resolve(selected).then((device) => {
      authorizedDevice = device;
      record(`${operation}.selected`, { name: deviceName(device) });
      return device;
    });
  };
  const waitForAuthorization = (options) => {
    lastRequestOptions = options;
    if (!pendingAuthorization) {
      let resolvePending;
      let rejectPending;
      const promise = new Promise((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      pendingAuthorization = {
        options, promise, resolve: resolvePending, reject: rejectPending,
      };
      record('bluetooth.requestDevice.authorization-needed');
    }
    return pendingAuthorization.promise;
  };
  const adapter = {
    calls,
    requestDevice(options = {}) {
      if (authorizedDevice) {
        record('bluetooth.requestDevice.reuse', { name: deviceName(authorizedDevice) });
        return Promise.resolve(authorizedDevice);
      }
      try {
        const selected = selectNative(options, 'bluetooth.requestDevice');
        return selected.catch((error) => {
          if (!needsTrustedGesture(error)) throw error;
          return waitForAuthorization(options);
        });
      } catch (error) {
        if (!needsTrustedGesture(error)) throw error;
        return waitForAuthorization(options);
      }
    },
    authorizeDevice(options = null) {
      const requestOptions = options || pendingAuthorization?.options || lastRequestOptions;
      if (!requestOptions) {
        throw new Error('请先让应用执行一次搜索，以取得真实服务过滤条件');
      }
      const pending = pendingAuthorization;
      const selected = selectNative(requestOptions, 'bluetooth.authorizeDevice');
      return selected.then((device) => {
        if (pending && pendingAuthorization === pending) {
          pendingAuthorization = null;
          pending.resolve(device);
        }
        return device;
      }, (error) => {
        record('bluetooth.authorizeDevice.error', {
          name: String(error && error.name || 'Error'),
        });
        throw error;
      });
    },
    needsAuthorization: () => Boolean(pendingAuthorization),
    authorizedDevice: () => authorizedDevice,
    lastRequestOptions: () => lastRequestOptions,
    disconnectAuthorizedDevice() {
      const gatt = authorizedDevice && authorizedDevice.gatt;
      if (!gatt || gatt.connected !== true || typeof gatt.disconnect !== 'function') return false;
      gatt.disconnect();
      record('bluetooth.gatt.disconnect-on-reload', { name: deviceName(authorizedDevice) });
      return true;
    },
    clearAuthorization() {
      authorizedDevice = null;
      if (pendingAuthorization) {
        pendingAuthorization.reject(new Error('电脑蓝牙授权已清除'));
        pendingAuthorization = null;
      }
      record('bluetooth.authorization.cleared');
    },
  };
  if (typeof nativeBluetooth.getAvailability === 'function') {
    adapter.getAvailability = (...args) => {
      record('bluetooth.getAvailability');
      return call('getAvailability', args);
    };
  }
  if (typeof nativeBluetooth.getDevices === 'function') {
    adapter.getDevices = async (...args) => {
      record('bluetooth.getDevices');
      const devices = await call('getDevices', args);
      if (!authorizedDevice || !Array.isArray(devices) || devices.includes(authorizedDevice)) {
        return devices;
      }
      return [...devices, authorizedDevice];
    };
  }
  return Object.freeze(adapter);
}

/**
 * 保存 navigator.bluetooth 的原始自有描述符，并在两种来源之间可逆切换。
 * 原生属性通常住在 Navigator.prototype 上，因此 computer 模式多数只是 delete 自有 mock 覆写。
 */
export function createNavigatorBluetoothController({
  navigatorRef = globalThis.navigator,
  simulator = createBluetoothSimulator(),
} = {}) {
  if (!navigatorRef || (typeof navigatorRef !== 'object' && typeof navigatorRef !== 'function')) {
    throw new TypeError('InkLab: 蓝牙模式需要 navigator 对象');
  }
  if (!simulator || !simulator.bluetooth) throw new TypeError('InkLab: 蓝牙模式需要 simulator.bluetooth');

  const originalOwn = Object.getOwnPropertyDescriptor(navigatorRef, 'bluetooth');
  const originalValue = (() => { try { return navigatorRef.bluetooth || null; } catch { return null; } })();
  const computerBluetooth = createComputerBluetoothAdapter(originalValue);
  let mode = null;

  const installMock = () => {
    const current = Object.getOwnPropertyDescriptor(navigatorRef, 'bluetooth');
    if (current && current.configurable === false && current.value !== simulator.bluetooth) {
      throw new Error('InkLab: 当前浏览器的 navigator.bluetooth 不可覆写，不能启用模拟蓝牙');
    }
    Object.defineProperty(navigatorRef, 'bluetooth', {
      configurable: true,
      enumerable: originalOwn ? Boolean(originalOwn.enumerable) : true,
      writable: false,
      value: simulator.bluetooth,
    });
  };

  const restoreOriginal = () => {
    const current = Object.getOwnPropertyDescriptor(navigatorRef, 'bluetooth');
    if (originalOwn) {
      Object.defineProperty(navigatorRef, 'bluetooth', originalOwn);
      return;
    }
    if (current && (current.value === simulator.bluetooth || current.value === computerBluetooth)) {
      delete navigatorRef.bluetooth;
    }
  };

  const installComputer = () => {
    restoreOriginal();
    if (!computerBluetooth || computerBluetooth === originalValue) return;
    const current = Object.getOwnPropertyDescriptor(navigatorRef, 'bluetooth');
    if (current && current.configurable === false) return;
    Object.defineProperty(navigatorRef, 'bluetooth', {
      configurable: true,
      enumerable: originalOwn ? Boolean(originalOwn.enumerable) : true,
      writable: false,
      value: computerBluetooth,
    });
  };

  const api = {
    simulator,
    get mode() { return mode; },
    setMode(value) {
      const next = normalizeBluetoothMode(value);
      if (next === BLUETOOTH_MODES.MOCK) installMock();
      else installComputer();
      mode = next;
      return mode;
    },
    isComputerSupported() {
      let candidate = computerBluetooth;
      if (mode !== BLUETOOTH_MODES.MOCK) {
        try { candidate = navigatorRef.bluetooth; } catch { return false; }
      }
      return Boolean(candidate
        && (typeof candidate.requestDevice === 'function'
          || typeof candidate.scanDevices === 'function')
        && typeof candidate.getAvailability === 'function');
    },
    nativeBluetooth: () => originalValue,
    computerBluetooth: () => computerBluetooth,
    restore() {
      restoreOriginal();
      mode = null;
    },
    dispose() {
      try { simulator.dispose?.(); } finally { api.restore(); }
    },
  };

  return api;
}
