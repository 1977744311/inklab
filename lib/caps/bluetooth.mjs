// bluetooth.mjs — InkLab 的确定性 Web Bluetooth / BLE 模拟器。
//
// 这条能力不能并进 InkView.setHostCapabilities()：当前 ink_web 的蓝牙是独立浏览器桥，
// 会直接读取 window.navigator.bluetooth。AIUI 的 scanDevices() 在 Web 宿主里会落到
// requestDevice()，随后继续走标准的 device.gatt → service → characteristic 对象树。
// 因此本模块提供一棵结构兼容的浏览器对象树，同时把设备、读写、通知与故障留成脚本控制面。
//
// 模拟只证明应用状态机与协议解析；射频、系统权限、配对、吞吐和持续通知仍要真机验收。

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

const SERVICE_ALIASES = Object.freeze({
  battery_service: '180f',
  device_information: '180a',
  generic_access: '1800',
  generic_attribute: '1801',
  heart_rate: '180d',
  running_speed_and_cadence: '1814',
});

const CHARACTERISTIC_ALIASES = Object.freeze({
  battery_level: '2a19',
  body_sensor_location: '2a38',
  heart_rate_control_point: '2a39',
  heart_rate_measurement: '2a37',
  measurement_interval: '2a21',
  rsc_feature: '2a54',
  rsc_measurement: '2a53',
  sensor_location: '2a5d',
});

const DESCRIPTOR_ALIASES = Object.freeze({
  characteristic_user_description: '2901',
  client_characteristic_configuration: '2902',
});

const DEFAULT_PROPERTIES = Object.freeze({
  broadcast: false,
  read: true,
  writeWithoutResponse: false,
  write: false,
  notify: false,
  indicate: false,
  authenticatedSignedWrites: false,
  reliableWrite: false,
  writableAuxiliaries: false,
  extendedProperties: false,
});

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  err.code = name;
  err.inklabInjected = true;
  return err;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Uint8Array.from(value);
  }
  throw new TypeError('蓝牙特征值必须是 Uint8Array / ArrayBuffer / TypedArray / 0-255 数组');
}

function dataViewOf(value) {
  const bytes = toBytes(value);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** UI/场景常用：把 `00 58`、`0x00,0x58` 或 `0058` 解析为字节。 */
export function parseBluetoothBytes(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return new Uint8Array();
  const compact = raw.replace(/0x/gi, '').replace(/[\s,;:_-]+/g, '');
  if (!/^[0-9a-f]+$/i.test(compact) || compact.length % 2 !== 0) {
    throw new TypeError('蓝牙字节必须是偶数位十六进制，例如 `00 58`');
  }
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 手动控制台用的通知 trace JSON 解析器。
 *
 * 接受：
 *   ["00 58", { "t": 20, "value": "00 59" }]
 *   { "serviceUuid": "180d", "characteristicUuid": "2a37", "intervalMs": 20,
 *     "frames": [...] }
 *
 * 一条 trace 要么每帧都有相对时间戳 t，要么全部使用 intervalMs；混用会让回放节奏含糊。
 */
export function parseBluetoothNotificationTraceJson(text, defaults = {}) {
  const parsed = JSON.parse(String(text));
  const envelope = Array.isArray(parsed) ? { frames: parsed } : parsed;
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.frames)
      || envelope.frames.length === 0) {
    throw new TypeError('BLE 通知 trace 必须是非空帧数组，或带 frames 数组的对象');
  }

  const serviceUuid = canonicalBluetoothUuid(
    envelope.serviceUuid ?? defaults.serviceUuid, 'service',
  );
  const characteristicUuid = canonicalBluetoothUuid(
    envelope.characteristicUuid ?? defaults.characteristicUuid, 'characteristic',
  );
  const rawDeviceId = envelope.deviceId ?? defaults.deviceId;
  const deviceId = rawDeviceId == null || String(rawDeviceId).trim() === ''
    ? undefined : String(rawDeviceId).trim();
  const intervalMs = Number(envelope.intervalMs ?? defaults.intervalMs ?? 20);
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError('BLE 通知 trace 的 intervalMs 必须是非负数');
  }
  const rawLoop = envelope.loop ?? defaults.loop ?? false;
  if (typeof rawLoop !== 'boolean') throw new TypeError('BLE 通知 trace 的 loop 必须是布尔值');

  let timestamped = null;
  let previousT = -Infinity;
  const frames = envelope.frames.map((frame, index) => {
    const objectFrame = frame && typeof frame === 'object' && !Array.isArray(frame);
    const hasTimestamp = objectFrame && Object.prototype.hasOwnProperty.call(frame, 't');
    if (timestamped === null) timestamped = hasTimestamp;
    if (timestamped !== hasTimestamp) {
      throw new TypeError('BLE 通知 trace 不能混用带 t 与不带 t 的帧');
    }
    const rawValue = objectFrame ? (frame.value ?? frame.data) : frame;
    if (rawValue == null) throw new TypeError(`BLE 通知 trace 第 ${index} 帧缺 value/data`);
    const value = typeof rawValue === 'string' ? parseBluetoothBytes(rawValue) : toBytes(rawValue);
    if (!hasTimestamp) return { value };

    const t = Number(frame.t);
    if (!Number.isFinite(t) || t < 0) {
      throw new TypeError(`BLE 通知 trace 第 ${index} 帧的 t 必须是非负毫秒数`);
    }
    if (t < previousT) {
      throw new RangeError(`BLE 通知 trace 第 ${index} 帧的 t 早于前一帧`);
    }
    previousT = t;
    return { t, value };
  });

  return {
    ...(deviceId ? { deviceId } : {}),
    serviceUuid,
    characteristicUuid,
    intervalMs,
    loop: rawLoop,
    frames,
  };
}

/** 标准别名 / 16-bit / 32-bit UUID → 小写 128-bit UUID。自定义 128-bit UUID 原样规范化。 */
export function canonicalBluetoothUuid(value, kind = 'any') {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) throw new TypeError('Bluetooth UUID 不能为空');
  const aliases = kind === 'service' ? SERVICE_ALIASES
    : kind === 'characteristic' ? CHARACTERISTIC_ALIASES
      : kind === 'descriptor' ? DESCRIPTOR_ALIASES
        : { ...SERVICE_ALIASES, ...CHARACTERISTIC_ALIASES, ...DESCRIPTOR_ALIASES };
  const aliased = aliases[raw] || raw;
  if (/^[0-9a-f]{4}$/.test(aliased)) return `0000${aliased}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(aliased)) return `${aliased}${BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(aliased)) return aliased;
  throw new TypeError(`不认识 Bluetooth UUID：${value}`);
}

function normalizeDescriptor(spec, index) {
  if (!spec || typeof spec !== 'object') throw new TypeError(`descriptor[${index}] 必须是对象`);
  return {
    ...spec,
    uuid: canonicalBluetoothUuid(spec.uuid, 'descriptor'),
    value: toBytes(spec.value || []),
  };
}

function normalizeCharacteristic(spec, index) {
  if (!spec || typeof spec !== 'object') throw new TypeError(`characteristic[${index}] 必须是对象`);
  const properties = { ...DEFAULT_PROPERTIES, ...(spec.properties || {}) };
  for (const key of Object.keys(DEFAULT_PROPERTIES)) properties[key] = Boolean(properties[key]);
  return {
    ...spec,
    uuid: canonicalBluetoothUuid(spec.uuid, 'characteristic'),
    value: toBytes(spec.value || []),
    properties,
    descriptors: (spec.descriptors || []).map(normalizeDescriptor),
  };
}

function normalizeService(spec, index) {
  if (!spec || typeof spec !== 'object') throw new TypeError(`service[${index}] 必须是对象`);
  const characteristics = (spec.characteristics || []).map(normalizeCharacteristic);
  const ids = characteristics.map((c) => c.uuid);
  if (new Set(ids).size !== ids.length) throw new TypeError(`service ${spec.uuid} 里 characteristic UUID 重复`);
  return {
    ...spec,
    uuid: canonicalBluetoothUuid(spec.uuid, 'service'),
    primary: spec.primary !== false,
    characteristics,
  };
}

function normalizeDevice(spec, index) {
  if (!spec || typeof spec !== 'object') throw new TypeError(`device[${index}] 必须是对象`);
  const id = String(spec.id || '').trim();
  if (!id) throw new TypeError(`device[${index}] 缺 id`);
  const services = (spec.services || []).map(normalizeService);
  const ids = services.map((s) => s.uuid);
  if (new Set(ids).size !== ids.length) throw new TypeError(`device ${id} 里 service UUID 重复`);
  const advertisedServices = (spec.advertisedServices || ids)
    .map((uuid) => canonicalBluetoothUuid(uuid, 'service'));
  return {
    ...spec,
    id,
    name: spec.name == null ? null : String(spec.name),
    available: spec.available !== false,
    remembered: Boolean(spec.remembered),
    advertisedServices,
    services,
  };
}

/** 默认设备让上游 Bluetooth 心率样例打开 InkLab 就能扫到；业务场景可 replaceDevices()。 */
export function defaultBluetoothDeviceSpecs() {
  return [{
    id: 'inklab-heart-rate-1',
    name: 'InkLab Heart Rate',
    advertisedServices: ['heart_rate', 'battery_service'],
    services: [
      {
        uuid: 'heart_rate',
        characteristics: [{
          uuid: 'heart_rate_measurement',
          properties: { read: true, notify: true },
          value: [0x00, 72],
        }],
      },
      {
        uuid: 'battery_service',
        characteristics: [{
          uuid: 'battery_level',
          properties: { read: true, notify: true },
          value: [86],
        }],
      },
    ],
  }];
}

function matchFilter(spec, filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.name != null && spec.name !== String(filter.name)) return false;
  if (filter.namePrefix != null && !String(spec.name || '').startsWith(String(filter.namePrefix))) return false;
  const services = Array.isArray(filter.services) ? filter.services : [];
  if (services.length) {
    const wanted = services.map((uuid) => canonicalBluetoothUuid(uuid, 'service'));
    if (!wanted.every((uuid) => spec.advertisedServices.includes(uuid))) return false;
  }
  return true;
}

function matchesRequest(spec, options) {
  if (!spec.available) return false;
  if (options && options.acceptAllDevices === true) return true;
  const filters = options && Array.isArray(options.filters) ? options.filters : [];
  return filters.some((filter) => matchFilter(spec, filter));
}

function failureError(spec, operation) {
  if (spec instanceof Error) return spec;
  if (typeof spec === 'string') return namedError(spec, `${operation} 失败（InkLab 注入）`);
  const name = String((spec && spec.name) || 'NetworkError');
  const message = String((spec && spec.message) || `${operation} 失败（InkLab 注入）`);
  return namedError(name, message);
}

/**
 * 创建一套浏览器结构兼容的 BLE 模拟器。
 * `bluetooth` 属性可直接装到 navigator.bluetooth；其余属性是场景/控制台控制面。
 */
export function createBluetoothSimulator({
  devices = defaultBluetoothDeviceSpecs(),
  available = true,
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearT = (handle) => clearTimeout(handle),
} = {}) {
  let adapterAvailable = Boolean(available);
  let specs = devices.map(normalizeDevice);
  let runtime = new Map();
  let runtimeGeneration = 0;
  let preferredDeviceId = null;
  const remembered = new Set(specs.filter((d) => d.remembered).map((d) => d.id));
  const failures = new Map();
  const calls = [];
  const traceStops = new Set();
  const traceStates = new Map();

  const log = (operation, detail = {}) => {
    const rec = { at: now(), operation, ...detail };
    calls.push(rec);
    return rec;
  };

  const takeFailure = (operation) => {
    const queue = failures.get(operation);
    if (!queue || !queue.length) return;
    const spec = queue.shift();
    if (!queue.length) failures.delete(operation);
    throw failureError(spec, operation);
  };

  const ensureAdapter = (operation) => {
    if (!adapterAvailable) throw namedError('NotFoundError', `${operation}: Bluetooth adapter 不可用（InkLab 模拟）`);
  };

  const requireConnected = (server, operation) => {
    ensureAdapter(operation);
    if (!server.connected) throw namedError('NetworkError', `${operation}: GATT 未连接（InkLab 模拟）`);
  };

  const requireCurrent = (context, operation) => {
    if (!context || typeof context.isCurrent !== 'function' || context.isCurrent()) return;
    throw namedError('InvalidStateError', `${operation}: GATT 对象已失效（InkLab 模拟器已重置）`);
  };

  const event = (type) => new Event(type);

  const buildDescriptor = (spec, characteristic, context) => {
    const descriptor = {
      uuid: spec.uuid,
      characteristic,
      value: dataViewOf(spec.value),
      async readValue() {
        const operation = 'descriptor.readValue';
        requireCurrent(context, operation);
        log(operation, { deviceId: context.device.id, serviceUuid: context.service.uuid, characteristicUuid: characteristic.uuid, descriptorUuid: spec.uuid });
        requireConnected(context.server, operation); takeFailure(operation);
        const next = typeof spec.onRead === 'function' ? await spec.onRead({ ...context, characteristic, descriptor, simulator: api }) : null;
        if (next != null) descriptor.value = dataViewOf(next);
        return descriptor.value;
      },
      async writeValue(value) {
        const operation = 'descriptor.writeValue';
        const bytes = toBytes(value);
        requireCurrent(context, operation);
        log(operation, { deviceId: context.device.id, descriptorUuid: spec.uuid, data: [...bytes] });
        requireConnected(context.server, operation); takeFailure(operation);
        descriptor.value = dataViewOf(bytes);
        if (typeof spec.onWrite === 'function') await spec.onWrite(bytes, { ...context, characteristic, descriptor, simulator: api });
      },
    };
    return descriptor;
  };

  const buildCharacteristic = (spec, service, context) => {
    const characteristic = new EventTarget();
    characteristic.uuid = spec.uuid;
    characteristic.service = service;
    characteristic.properties = { ...spec.properties };
    characteristic.value = dataViewOf(spec.value);
    characteristic.notifying = false;
    characteristic.writes = [];
    const descriptors = new Map();

    characteristic.readValue = async () => {
      const operation = 'characteristic.readValue';
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, serviceUuid: service.uuid, characteristicUuid: spec.uuid });
      requireConnected(context.server, operation); takeFailure(operation);
      if (!characteristic.properties.read) throw namedError('NotSupportedError', `${spec.uuid} 不支持 read`);
      const next = typeof spec.onRead === 'function'
        ? await spec.onRead({ ...context, service, characteristic, simulator: api }) : null;
      if (next != null) characteristic.value = dataViewOf(next);
      return characteristic.value;
    };

    const write = async (value, writeType) => {
      const operation = `characteristic.${writeType}`;
      const bytes = toBytes(value);
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, serviceUuid: service.uuid, characteristicUuid: spec.uuid, data: [...bytes] });
      requireConnected(context.server, operation); takeFailure(operation);
      const allowed = writeType === 'writeValueWithoutResponse'
        ? characteristic.properties.writeWithoutResponse
        : writeType === 'writeValueWithResponse'
          ? characteristic.properties.write
          : characteristic.properties.write || characteristic.properties.writeWithoutResponse;
      if (!allowed) throw namedError('NotSupportedError', `${spec.uuid} 不支持 write`);
      characteristic.writes.push(bytes);
      if (typeof spec.onWrite === 'function') {
        await spec.onWrite(bytes, { ...context, service, characteristic, writeType, simulator: api });
      }
    };
    characteristic.writeValue = (value) => write(value, 'writeValue');
    characteristic.writeValueWithResponse = (value) => write(value, 'writeValueWithResponse');
    characteristic.writeValueWithoutResponse = (value) => write(value, 'writeValueWithoutResponse');

    characteristic.startNotifications = async () => {
      const operation = 'characteristic.startNotifications';
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, serviceUuid: service.uuid, characteristicUuid: spec.uuid });
      requireConnected(context.server, operation); takeFailure(operation);
      if (!characteristic.properties.notify && !characteristic.properties.indicate) {
        throw namedError('NotSupportedError', `${spec.uuid} 不支持 notify/indicate`);
      }
      characteristic.notifying = true;
      if (typeof spec.onStartNotifications === 'function') {
        await spec.onStartNotifications({ ...context, service, characteristic, simulator: api });
      }
      return characteristic;
    };
    characteristic.stopNotifications = async () => {
      const operation = 'characteristic.stopNotifications';
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, serviceUuid: service.uuid, characteristicUuid: spec.uuid });
      requireConnected(context.server, operation); takeFailure(operation);
      characteristic.notifying = false;
      if (typeof spec.onStopNotifications === 'function') {
        await spec.onStopNotifications({ ...context, service, characteristic, simulator: api });
      }
      return characteristic;
    };
    characteristic.getDescriptor = async (uuid) => {
      const operation = 'characteristic.getDescriptor';
      const wanted = canonicalBluetoothUuid(uuid, 'descriptor');
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, characteristicUuid: spec.uuid, descriptorUuid: wanted });
      requireConnected(context.server, operation); takeFailure(operation);
      const found = descriptors.get(wanted);
      if (!found) throw namedError('NotFoundError', `找不到 descriptor ${wanted}`);
      return found;
    };
    characteristic.getDescriptors = async (uuid) => {
      const operation = 'characteristic.getDescriptors';
      requireCurrent(context, operation);
      log(operation, { deviceId: context.device.id, characteristicUuid: spec.uuid, descriptorUuid: uuid == null ? null : String(uuid) });
      requireConnected(context.server, operation); takeFailure(operation);
      if (uuid == null) return [...descriptors.values()];
      const wanted = canonicalBluetoothUuid(uuid, 'descriptor');
      return [...descriptors.values()].filter((d) => d.uuid === wanted);
    };

    for (const descriptorSpec of spec.descriptors) {
      const descriptor = buildDescriptor(descriptorSpec, characteristic, { ...context, service });
      descriptors.set(descriptor.uuid, descriptor);
    }
    characteristic.__inklabSpec = spec;
    characteristic.__inklabDescriptors = descriptors;
    return characteristic;
  };

  const buildDevice = (spec, generation) => {
    const device = new EventTarget();
    device.id = spec.id;
    device.name = spec.name;
    device.watchingAdvertisements = false;
    const services = new Map();
    const isCurrent = () => generation === runtimeGeneration && runtime.get(device.id) === device;
    const clearServerState = () => {
      server.connected = false;
      for (const service of services.values()) {
        for (const characteristic of service.__inklabCharacteristics.values()) characteristic.notifying = false;
      }
    };
    const server = {
      device,
      connected: false,
      async connect() {
        const operation = 'gatt.connect';
        requireCurrent({ isCurrent }, operation);
        log(operation, { deviceId: device.id });
        ensureAdapter(operation); takeFailure(operation);
        if (!spec.available) throw namedError('NotFoundError', `设备 ${device.id} 不可用`);
        server.connected = true;
        return server;
      },
      disconnect() {
        const operation = 'gatt.disconnect';
        // Engine teardown is lazy.  After resetRuntime it can still call disconnect()
        // on the previous generation.  The Web Bluetooth bridge keys wrappers by
        // device id, so dispatching that stale event would tear down the new same-id
        // connection.  Retire only the old JS object and leave the current ledger/event
        // stream untouched.
        if (!isCurrent()) {
          clearServerState();
          return;
        }
        log(operation, { deviceId: device.id });
        takeFailure(operation);
        if (!server.connected) return;
        clearServerState();
        device.dispatchEvent(event('gattserverdisconnected'));
      },
      async getPrimaryService(uuid) {
        const operation = 'gatt.getPrimaryService';
        const wanted = canonicalBluetoothUuid(uuid, 'service');
        requireCurrent({ isCurrent }, operation);
        log(operation, { deviceId: device.id, serviceUuid: wanted });
        requireConnected(server, operation); takeFailure(operation);
        const found = services.get(wanted);
        if (!found || !found.isPrimary) throw namedError('NotFoundError', `找不到 primary service ${wanted}`);
        return found;
      },
      async getPrimaryServices(uuid) {
        const operation = 'gatt.getPrimaryServices';
        requireCurrent({ isCurrent }, operation);
        log(operation, { deviceId: device.id, serviceUuid: uuid == null ? null : String(uuid) });
        requireConnected(server, operation); takeFailure(operation);
        const primary = [...services.values()].filter((s) => s.isPrimary);
        if (uuid == null) return primary;
        const wanted = canonicalBluetoothUuid(uuid, 'service');
        return primary.filter((s) => s.uuid === wanted);
      },
    };
    device.gatt = server;
    device.forget = async () => {
      requireCurrent({ isCurrent }, 'device.forget');
      remembered.delete(spec.id); log('device.forget', { deviceId: device.id });
    };
    device.watchAdvertisements = async () => {
      requireCurrent({ isCurrent }, 'device.watchAdvertisements');
      device.watchingAdvertisements = true; log('device.watchAdvertisements', { deviceId: device.id });
    };
    device.unwatchAdvertisements = () => {
      requireCurrent({ isCurrent }, 'device.unwatchAdvertisements');
      device.watchingAdvertisements = false; log('device.unwatchAdvertisements', { deviceId: device.id });
    };

    for (const serviceSpec of spec.services) {
      const service = {
        uuid: serviceSpec.uuid,
        isPrimary: serviceSpec.primary,
        device,
      };
      const characteristics = new Map();
      service.getCharacteristic = async (uuid) => {
        const operation = 'service.getCharacteristic';
        const wanted = canonicalBluetoothUuid(uuid, 'characteristic');
        requireCurrent({ isCurrent }, operation);
        log(operation, { deviceId: device.id, serviceUuid: service.uuid, characteristicUuid: wanted });
        requireConnected(server, operation); takeFailure(operation);
        const found = characteristics.get(wanted);
        if (!found) throw namedError('NotFoundError', `找不到 characteristic ${wanted}`);
        return found;
      };
      service.getCharacteristics = async (uuid) => {
        const operation = 'service.getCharacteristics';
        requireCurrent({ isCurrent }, operation);
        log(operation, { deviceId: device.id, serviceUuid: service.uuid, characteristicUuid: uuid == null ? null : String(uuid) });
        requireConnected(server, operation); takeFailure(operation);
        if (uuid == null) return [...characteristics.values()];
        const wanted = canonicalBluetoothUuid(uuid, 'characteristic');
        return [...characteristics.values()].filter((c) => c.uuid === wanted);
      };
      for (const characteristicSpec of serviceSpec.characteristics) {
        const characteristic = buildCharacteristic(characteristicSpec, service, { device, server, isCurrent });
        characteristics.set(characteristic.uuid, characteristic);
      }
      service.__inklabCharacteristics = characteristics;
      services.set(service.uuid, service);
    }
    device.__inklabServices = services;
    device.__inklabSpec = spec;
    return device;
  };

  const rebuild = () => {
    for (const stop of [...traceStops]) stop();
    runtimeGeneration += 1;
    const generation = runtimeGeneration;
    runtime = new Map(specs.map((spec) => [spec.id, buildDevice(spec, generation)]));
  };

  const bluetooth = new EventTarget();
  bluetooth.referringDevice = null;
  bluetooth.onavailabilitychanged = null;
  bluetooth.getAvailability = async () => {
    const operation = 'bluetooth.getAvailability';
    log(operation); takeFailure(operation);
    return adapterAvailable;
  };
  bluetooth.getDevices = async () => {
    const operation = 'bluetooth.getDevices';
    log(operation); takeFailure(operation);
    return [...remembered].map((id) => runtime.get(id)).filter(Boolean);
  };
  bluetooth.requestDevice = async (options = {}) => {
    const operation = 'bluetooth.requestDevice';
    log(operation, { options });
    ensureAdapter(operation); takeFailure(operation);
    if (options.acceptAllDevices !== true && (!Array.isArray(options.filters) || !options.filters.length)) {
      throw namedError('TypeError', 'requestDevice 需要 filters 或 acceptAllDevices:true');
    }
    const matches = specs.filter((spec) => matchesRequest(spec, options));
    const chosen = (preferredDeviceId && matches.find((spec) => spec.id === preferredDeviceId)) || matches[0];
    if (!chosen) throw namedError('NotFoundError', '没有匹配的模拟蓝牙设备');
    remembered.add(chosen.id);
    return runtime.get(chosen.id);
  };

  const runtimeDevice = (id) => {
    const key = String(id);
    return runtime.get(key) || [...runtime.values()].find((device) => device.id === key) || null;
  };

  const runtimeLogicalId = (id) => {
    const found = runtimeDevice(id);
    return found ? found.id : null;
  };

  const resolveCharacteristic = ({ deviceId, serviceUuid, characteristicUuid }) => {
    let devicesToTry = deviceId ? [runtimeDevice(deviceId)] : [...runtime.values()];
    devicesToTry = devicesToTry.filter(Boolean).sort((a, b) => Number(b.gatt.connected) - Number(a.gatt.connected));
    const serviceId = canonicalBluetoothUuid(serviceUuid, 'service');
    const characteristicId = canonicalBluetoothUuid(characteristicUuid, 'characteristic');
    for (const device of devicesToTry) {
      const characteristic = device.__inklabServices.get(serviceId)?.__inklabCharacteristics.get(characteristicId);
      if (characteristic) return { device, characteristic, serviceId, characteristicId };
    }
    throw namedError('NotFoundError', `找不到模拟特征 ${serviceId} / ${characteristicId}`);
  };

  const api = {
    bluetooth,
    calls,
    isAvailable: () => adapterAvailable,
    setAvailability(value) {
      const next = Boolean(value);
      if (next === adapterAvailable) return next;
      adapterAvailable = next;
      log('bluetooth.setAvailability', { available: next });
      if (!next) {
        for (const device of runtime.values()) if (device.gatt.connected) device.gatt.disconnect();
      }
      const ev = event('availabilitychanged');
      bluetooth.dispatchEvent(ev);
      if (typeof bluetooth.onavailabilitychanged === 'function') bluetooth.onavailabilitychanged(ev);
      return next;
    },
    replaceDevices(nextDevices) {
      if (!Array.isArray(nextDevices)) throw new TypeError('replaceDevices 需要设备数组');
      specs = nextDevices.map(normalizeDevice);
      remembered.clear();
      for (const spec of specs) if (spec.remembered) remembered.add(spec.id);
      preferredDeviceId = null;
      rebuild();
      log('bluetooth.replaceDevices', { count: specs.length });
      return api.devices();
    },
    devices: () => [...runtime.values()],
    device: (id) => runtimeDevice(id),
    preferDevice(id) {
      const logicalId = id == null ? null : runtimeLogicalId(id);
      if (id != null && !logicalId) throw namedError('NotFoundError', `没有模拟设备 ${id}`);
      preferredDeviceId = logicalId;
      return preferredDeviceId;
    },
    setRemembered(id, value = true) {
      const key = runtimeLogicalId(id);
      if (!key) throw namedError('NotFoundError', `没有模拟设备 ${id}`);
      if (value) remembered.add(key); else remembered.delete(key);
    },
    characteristic(query) {
      return resolveCharacteristic(query).characteristic;
    },
    setCharacteristicValue(query, value) {
      const found = resolveCharacteristic(query);
      found.characteristic.value = dataViewOf(value);
      log('characteristic.setValue', { deviceId: found.device.id, serviceUuid: found.serviceId, characteristicUuid: found.characteristicId, data: [...toBytes(value)] });
      return found.characteristic.value;
    },
    emitNotification(query, value) {
      const found = resolveCharacteristic(query);
      if (!found.device.gatt.connected) throw namedError('NetworkError', `设备 ${found.device.id} 尚未连接`);
      if (!found.characteristic.notifying) throw namedError('InvalidStateError', `特征 ${found.characteristicId} 尚未 startNotifications`);
      const bytes = toBytes(value);
      found.characteristic.value = dataViewOf(bytes);
      found.characteristic.dispatchEvent(event('characteristicvaluechanged'));
      log('characteristic.notification', { deviceId: found.device.id, serviceUuid: found.serviceId, characteristicUuid: found.characteristicId, data: [...bytes] });
      return { deviceId: found.device.id, serviceUuid: found.serviceId, characteristicUuid: found.characteristicId, bytes };
    },
    disconnect(id) {
      const device = runtimeDevice(id);
      if (!device) throw namedError('NotFoundError', `没有模拟设备 ${id}`);
      device.gatt.disconnect();
    },
    disconnectAll() {
      for (const device of runtime.values()) if (device.gatt.connected) device.gatt.disconnect();
    },
    failNext(operation, error = { name: 'NetworkError' }) {
      const key = String(operation || '').trim();
      if (!key) throw new TypeError('failNext 需要 operation');
      const queue = failures.get(key) || [];
      queue.push(error);
      failures.set(key, queue);
    },
    clearFailures() { failures.clear(); },
    resetRuntime({ clearCalls = true, clearFailures = true } = {}) {
      if (clearCalls) calls.length = 0;
      if (clearFailures) failures.clear();
      remembered.clear();
      for (const spec of specs) if (spec.remembered) remembered.add(spec.id);
      preferredDeviceId = null;
      rebuild();
      return api.devices();
    },
    reset() {
      specs = defaultBluetoothDeviceSpecs().map(normalizeDevice);
      adapterAvailable = true;
      return api.resetRuntime();
    },
    snapshot() {
      return {
        available: adapterAvailable,
        devices: [...runtime.values()].map((device) => ({
          id: device.id,
          name: device.name,
          remembered: remembered.has(device.id),
          connected: device.gatt.connected,
          services: [...device.__inklabServices.values()].map((service) => ({
            uuid: service.uuid,
            characteristics: [...service.__inklabCharacteristics.values()].map((characteristic) => ({
              uuid: characteristic.uuid,
              notifying: characteristic.notifying,
              value: [...new Uint8Array(characteristic.value.buffer, characteristic.value.byteOffset, characteristic.value.byteLength)],
              writes: characteristic.writes.map((bytes) => [...bytes]),
            })),
          })),
        })),
        calls: calls.map((rec) => ({ ...rec })),
        notificationTraces: api.activeNotificationTraces(),
      };
    },
    activeNotificationTraces() {
      return [...traceStates.values()].map((state) => ({
        ...state,
        error: state.error ? { ...state.error } : null,
      }));
    },
    stopNotificationTraces(query = {}) {
      const serviceUuid = query.serviceUuid == null
        ? null : canonicalBluetoothUuid(query.serviceUuid, 'service');
      const characteristicUuid = query.characteristicUuid == null
        ? null : canonicalBluetoothUuid(query.characteristicUuid, 'characteristic');
      const deviceId = query.deviceId == null ? null : String(query.deviceId);
      let stoppedCount = 0;
      for (const [stop, state] of [...traceStates.entries()]) {
        if (deviceId && state.deviceId !== deviceId && state.requestedDeviceId !== deviceId) continue;
        if (serviceUuid && state.serviceUuid !== serviceUuid) continue;
        if (characteristicUuid && state.characteristicUuid !== characteristicUuid) continue;
        stop();
        stoppedCount += 1;
      }
      return stoppedCount;
    },
    playNotificationTrace({
      deviceId, serviceUuid, characteristicUuid, frames, intervalMs = 20, loop = false,
    } = {}) {
      if (!Array.isArray(frames) || !frames.length) throw new TypeError('playNotificationTrace 需要非空 frames');
      if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) < 0) throw new TypeError('intervalMs 必须是非负数');
      const serviceId = canonicalBluetoothUuid(serviceUuid, 'service');
      const characteristicId = canonicalBluetoothUuid(characteristicUuid, 'characteristic');
      let index = 0;
      let timer = null;
      let stopped = false;
      let resolveDone;
      let rejectDone;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const state = {
        requestedDeviceId: deviceId == null ? null : String(deviceId),
        deviceId: deviceId == null ? null : String(deviceId),
        serviceUuid: serviceId,
        characteristicUuid: characteristicId,
        totalFrames: frames.length,
        emittedFrames: 0,
        loops: 0,
        intervalMs: Number(intervalMs),
        loop: Boolean(loop),
        status: 'running',
        running: true,
        startedAt: now(),
        endedAt: null,
        error: null,
      };
      const stats = () => ({ ...state, error: state.error ? { ...state.error } : null });
      const finish = (status) => {
        state.status = status;
        state.running = false;
        state.endedAt = now();
        traceStops.delete(stop);
        traceStates.delete(stop);
      };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer != null) clearT(timer);
        finish('stopped');
        resolveDone({ stopped: true, frames: index });
      };
      const tick = () => {
        if (stopped) return;
        const frame = frames[index];
        const value = frame && typeof frame === 'object' && !ArrayBuffer.isView(frame) && !Array.isArray(frame)
          ? (frame.value ?? frame.data) : frame;
        try {
          const emitted = api.emitNotification({
            deviceId, serviceUuid: serviceId, characteristicUuid: characteristicId,
          }, value);
          state.deviceId = emitted.deviceId;
          state.emittedFrames += 1;
        } catch (err) {
          stopped = true;
          state.error = { name: String(err && err.name || 'Error'), message: String(err && err.message || err) };
          finish('failed');
          rejectDone(err);
          return;
        }
        index += 1;
        if (index >= frames.length) {
          if (loop) { index = 0; state.loops += 1; }
          else {
            stopped = true;
            finish('completed');
            resolveDone({ stopped: false, frames: index });
            return;
          }
        }
        const current = frames[index - 1];
        const next = frames[index];
        const delta = current && next && Number.isFinite(Number(current.t)) && Number.isFinite(Number(next.t))
          ? Math.max(0, Number(next.t) - Number(current.t)) : Number(intervalMs);
        timer = setT(tick, delta);
      };
      traceStops.add(stop);
      traceStates.set(stop, state);
      timer = setT(tick, 0);
      return { stop, done, stats };
    },
    dispose() {
      for (const stop of [...traceStops]) stop();
      api.disconnectAll();
    },
  };

  rebuild();
  return api;
}
