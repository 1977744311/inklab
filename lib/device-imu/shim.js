// __inklab__/imu.js — InkLab 推「模拟 IMU」调试包时注入的传感器替身。只进调试包，不进你的源码。
//
// 为什么是 import 而不是改全局：Ink 里页面和模块里直接写的 AbsoluteOrientationSensor 等名字绑定在
// 引擎原生类上，给 globalThis 赋值改不到它们（模拟器 0.20/0.21、RG1 真机实测）。InkLab 打调试包时
// 给用到这些名字的文件开头加一行 `import { … } from '<相对路径>/__inklab__/imu.js'`，同名导入在
// 模块作用域里遮住原生类；本模块自己没有这个导入，所以这里的裸名字仍是原生类，可以透传真数据。
// 另外也装一份到 globalThis 上，兼容「先读 globalThis.Accelerometer」的写法。
//
// 模式（imu-config.js 的 mode）：
//   replay  每次传感器 start 都从头放打进包里的轨迹；该传感器没有轨迹就透传真传感器。
//   live    经 adb reverse 用 WebSocket 连回 InkLab，由工作台随时下发轨迹 / 故障 / 清除；
//           没下发轨迹的传感器透传真传感器，轨迹放完（不循环）也回到真传感器。
//   record  全部透传真传感器，同时把读数分批写进日志（[inklab-imu] …），InkLab 从 logcat 收成轨迹。
//
// 回放的时间戳按轨迹自己的样本间隔（不按请求频率），和模拟器 caps.sensors 的回放规则一致。

/* global Magnetometer */
import wx from 'wx';
import config from './imu-config.js';

const PREFIX = '[inklab-imu] ';
const KINDS = ['absoluteOrientation', 'accelerometer', 'gyroscope', 'magnetometer'];
const AXES = { absoluteOrientation: ['x', 'y', 'z', 'w'], accelerometer: ['x', 'y', 'z'], gyroscope: ['x', 'y', 'z'], magnetometer: ['x', 'y', 'z'] };
const CLASS_NAMES = { absoluteOrientation: 'AbsoluteOrientationSensor', accelerometer: 'Accelerometer', gyroscope: 'Gyroscope', magnetometer: 'Magnetometer' };
// 本模块里的裸名字 = 引擎原生类（本模块不导入自己）。
const NATIVE = {
  absoluteOrientation: typeof AbsoluteOrientationSensor === 'function' ? AbsoluteOrientationSensor : null,
  accelerometer: typeof Accelerometer === 'function' ? Accelerometer : null,
  gyroscope: typeof Gyroscope === 'function' ? Gyroscope : null,
  magnetometer: typeof Magnetometer === 'function' ? Magnetometer : null,
};

const MODE = config && config.mode;
// 这一版调试包的编号：眼镜上旧版本的实例不会因为装了新包而销毁（退回卡片后照样在跑），
// 录制行和实时通道都带上它，InkLab 只认当前这一版。
const BUILD = (config && config.build) || '';
const now = () => (typeof performance === 'object' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
const emit = (event) => { try { console.log(PREFIX + JSON.stringify({ v: 1, b: BUILD, ...event })); } catch (_e) { /* 日志失败不影响应用 */ } };
const r5 = (v) => Math.round(v * 100000) / 100000;
const r3 = (v) => Math.round(v * 1000) / 1000;

function makeError(name, message) {
  const err = new Error(String(message || name));
  try { err.name = String(name || 'NotReadableError'); } catch (_e) { /* 只读就算了 */ }
  return err;
}

/** 轨迹 → 播放计划：rows 是 [t, 轴…]，t 毫秒。 */
function planOf(kind, trace) {
  if (!trace || !Array.isArray(trace.rows) || !trace.rows.length) return null;
  const width = AXES[kind].length + 1;
  const rows = trace.rows.filter((r) => Array.isArray(r) && r.length === width);
  if (!rows.length) return null;
  const speed = Number(trace.speed) > 0 ? Number(trace.speed) : 1;
  const span = rows[rows.length - 1][0] - rows[0][0];
  const lastGap = rows.length > 1 ? rows[rows.length - 1][0] - rows[rows.length - 2][0] : 16;
  return { rows, speed, loop: trace.loop === true, span, lastGap, id: trace.id || '' };
}

// ── 录制：按传感器攒批，一行不超过 ~3.8KB ─────────────────────────────────

const recording = {};
let recordTimer = null;
function flushKind(kind) {
  const rec = recording[kind];
  if (!rec || !rec.rows.length) return;
  const rows = rec.rows;
  rec.rows = [];
  const write = (part) => {
    const line = JSON.stringify({ v: 1, b: BUILD, s: kind, f: rec.frequency, r: part });
    if (line.length > 3800 && part.length > 1) {
      const half = part.length >> 1;
      write(part.slice(0, half));
      write(part.slice(half));
    } else {
      try { console.log(PREFIX + line); } catch (_e) { /* ignore */ }
    }
  };
  write(rows);
}
function flushAll() { for (const kind of KINDS) flushKind(kind); }
function recordReading(kind, values, ts, frequency) {
  if (!recording[kind]) recording[kind] = { rows: [], frequency };
  const rec = recording[kind];
  rec.frequency = frequency;
  rec.rows.push([r3(ts), ...values.map(r5)]);
  if (rec.rows.length >= (kind === 'absoluteOrientation' ? 50 : 60)) flushKind(kind);
  if (!recordTimer) recordTimer = setTimeout(() => { recordTimer = null; flushAll(); }, 250);
}

// ── 中枢：轨迹、故障、活动会话、实时通道 ─────────────────────────────────

const hub = {
  traces: {},
  faults: {},
  sessions: new Set(),
  socket: null,
  send(message) {
    const ws = hub.socket;
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(message)); } catch (_e) { /* 断了等重连 */ } }
  },
  sessionsOf(kind) { return [...hub.sessions].filter((s) => s._kind === kind); },
  /** 换轨迹：立刻切给正在跑的会话（mode='play'），或只给之后新开的会话（'load'）。 */
  setTrace(kind, trace, mode) {
    hub.traces[kind] = planOf(kind, trace);
    if (mode === 'play') for (const s of hub.sessionsOf(kind)) s._restart();
  },
  clearTrace(kind) {
    delete hub.traces[kind];
    for (const s of hub.sessionsOf(kind)) if (s._play) s._restart();
  },
};

if (MODE === 'replay' && config.traces) {
  for (const kind of KINDS) if (config.traces[kind]) hub.traces[kind] = planOf(kind, config.traces[kind]);
}
if (config && config.faults) for (const kind of KINDS) if (config.faults[kind]) hub.faults[kind] = { ...config.faults[kind] };

// ── 传感器替身 ───────────────────────────────────────────────────────────

class InkLabSensor {
  constructor(kind, options) {
    this._kind = kind;
    this._options = options && typeof options === 'object' ? { ...options } : {};
    this._frequency = Number(this._options.frequency) > 0 ? Number(this._options.frequency) : 60;
    this._listeners = {};
    this._activated = false;
    this._hasReading = false;
    this._timestamp = null;
    this._values = null;
    this._native = null;
    this._play = null;
    this._timer = null;
    this._readings = 0;
    this._started = false;
    this.onreading = null;
    this.onactivate = null;
    this.onerror = null;
  }

  get activated() { return this._activated; }
  get hasReading() { return this._hasReading; }
  get timestamp() { return this._timestamp; }

  addEventListener(type, listener) {
    if (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function')) return;
    const list = this._listeners[type] || (this._listeners[type] = []);
    if (!list.includes(listener)) list.push(listener);
  }
  removeEventListener(type, listener) {
    const list = this._listeners[type];
    if (list) this._listeners[type] = list.filter((l) => l !== listener);
  }
  dispatchEvent(event) {
    const type = event && event.type;
    for (const listener of (this._listeners[type] || []).slice()) {
      try { if (typeof listener === 'function') listener.call(this, event); else listener.handleEvent(event); } catch (e) { console.error(e); }
    }
    const handler = this['on' + type];
    if (typeof handler === 'function') { try { handler.call(this, event); } catch (e) { console.error(e); } }
    return true;
  }
  _fire(type, extra) { this.dispatchEvent({ type, target: this, currentTarget: this, timeStamp: now(), ...(extra || {}) }); }

  start() {
    if (this._started) return;
    this._started = true;
    this._readings = 0;
    hub.sessions.add(this);
    if (MODE === 'record') emit({ ev: 'start', s: this._kind, f: this._frequency });
    hub.send({ type: 'session', sensor: this._kind, state: 'start', frequency: this._frequency });
    this._begin();
  }
  stop() {
    if (!this._started) return;
    this._started = false;
    this._halt();
    this._activated = false;
    hub.sessions.delete(this);
    if (MODE === 'record') { flushKind(this._kind); emit({ ev: 'stop', s: this._kind }); }
    hub.send({ type: 'session', sensor: this._kind, state: 'stop' });
  }

  _begin() {
    const fault = hub.faults[this._kind];
    if (fault && !(fault.afterReadings > 0)) { setTimeout(() => this._fail(fault.error || 'NotReadableError', fault.message || ''), 0); return; }
    const plan = hub.traces[this._kind];
    if (plan) this._startTrace(plan); else this._startNative();
  }
  _halt() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._play = null;
    const native = this._native;
    this._native = null;
    if (native) { try { native.stop(); } catch (_e) { /* 已停 */ } }
  }
  _restart() { if (this._started) { this._halt(); this._begin(); } }

  _activate() {
    if (this._activated) return;
    this._activated = true;
    this._fire('activate');
  }
  _fail(name, message) {
    this._halt();
    this._activated = false;
    if (MODE === 'record') emit({ ev: 'error', s: this._kind, error: name, message });
    hub.send({ type: 'error', sensor: this._kind, error: name, message });
    this._fire('error', { error: makeError(name, message) });
  }
  _reading(values, ts, source) {
    this._values = values;
    this._timestamp = ts;
    this._hasReading = true;
    this._readings += 1;
    if (MODE === 'record' && source === 'native') recordReading(this._kind, values, ts, this._frequency);
    const fault = hub.faults[this._kind];
    if (fault && fault.afterReadings > 0 && this._readings > fault.afterReadings) { this._fail(fault.error || 'NotReadableError', fault.message || ''); return; }
    this._fire('reading');
  }

  _startNative() {
    const Native = NATIVE[this._kind];
    if (!Native) { setTimeout(() => this._fail('NotReadableError', `${CLASS_NAMES[this._kind]} 不可用`), 0); return; }
    let sensor;
    try { sensor = new Native(this._options); } catch (e) { setTimeout(() => this._fail((e && e.name) || 'NotReadableError', String((e && e.message) || e)), 0); return; }
    this._native = sensor;
    const axes = AXES[this._kind];
    sensor.addEventListener('activate', () => { if (this._native === sensor) this._activate(); });
    sensor.addEventListener('error', (event) => {
      if (this._native !== sensor) return;
      const err = event && event.error;
      this._fail((err && err.name) || 'NotReadableError', (err && err.message) || '');
    });
    sensor.addEventListener('reading', () => {
      if (this._native !== sensor) return;
      const values = this._kind === 'absoluteOrientation'
        ? Array.from(sensor.quaternion || [])
        : axes.map((axis) => sensor[axis]);
      if (values.length !== axes.length || !values.every((v) => typeof v === 'number')) return;
      this._activate();
      this._reading(values, sensor.timestamp, 'native');
    });
    try { sensor.start(); } catch (e) { this._fail((e && e.name) || 'NotReadableError', String((e && e.message) || e)); }
  }

  _startTrace(plan) {
    const play = { plan, index: 0, epoch: 0, loops: 0 };
    this._play = play;
    const first = plan.rows[0][0];
    const target = (i) => play.epoch + play.loops * ((plan.span + plan.lastGap) / plan.speed) + (plan.rows[i][0] - first) / plan.speed;
    const tick = () => {
      this._timer = null;
      if (this._play !== play) return;
      const row = plan.rows[play.index];
      this._reading(row.slice(1), target(play.index), 'trace');
      if (this._play !== play) return;
      play.index += 1;
      if (play.index >= plan.rows.length) {
        if (!plan.loop) {
          this._play = null;
          hub.send({ type: 'ended', sensor: this._kind, trace: plan.id });
          if (MODE === 'live') this._startNative(); // 放完回到真传感器
          return;
        }
        play.index = 0;
        play.loops += 1;
      }
      this._timer = setTimeout(tick, Math.max(0, target(play.index) - now()));
    };
    this._timer = setTimeout(() => {
      if (this._play !== play) return;
      play.epoch = now();
      this._activate();
      tick();
    }, 0);
  }
}

class InkLabOrientation extends InkLabSensor {
  constructor(options) { super('absoluteOrientation', options); }
  get quaternion() { return this._values ? this._values.slice() : null; }
  populateMatrix(target) {
    if (!this._values) throw makeError('NotReadableError', '还没有读数');
    const [x, y, z, w] = this._values;
    const m = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1,
    ];
    for (let i = 0; i < 16; i += 1) target[i] = m[i];
  }
}
class InkLabMotion extends InkLabSensor {
  get x() { return this._values ? this._values[0] : null; }
  get y() { return this._values ? this._values[1] : null; }
  get z() { return this._values ? this._values[2] : null; }
}
class InkLabAccelerometer extends InkLabMotion { constructor(options) { super('accelerometer', options); } }
class InkLabGyroscope extends InkLabMotion { constructor(options) { super('gyroscope', options); } }
class InkLabMagnetometer extends InkLabMotion { constructor(options) { super('magnetometer', options); } }

const MOCKS = { absoluteOrientation: InkLabOrientation, accelerometer: InkLabAccelerometer, gyroscope: InkLabGyroscope, magnetometer: InkLabMagnetometer };
for (const kind of KINDS) {
  try { globalThis[CLASS_NAMES[kind]] = MOCKS[kind]; } catch (_e) { /* 只读就只靠 import 遮蔽 */ }
}

// ── 实时通道 ─────────────────────────────────────────────────────────────

function handleLive(message) {
  if (!message || typeof message !== 'object') return;
  const kinds = message.sensor ? [message.sensor] : Object.keys(message.traces || {});
  if (message.type === 'play' || message.type === 'load') {
    for (const kind of kinds) if (KINDS.includes(kind)) hub.setTrace(kind, message.traces ? message.traces[kind] : message.trace, message.type);
  } else if (message.type === 'clear') {
    for (const kind of message.sensor ? [message.sensor] : KINDS) hub.clearTrace(kind);
  } else if (message.type === 'error' && KINDS.includes(message.sensor)) {
    hub.faults[message.sensor] = { error: message.error || 'NotReadableError', message: message.message || '', afterReadings: Number(message.afterReadings) || 0 };
    for (const s of hub.sessionsOf(message.sensor)) if (!(hub.faults[message.sensor].afterReadings > 0)) s._fail(hub.faults[message.sensor].error, hub.faults[message.sensor].message);
  } else if (message.type === 'clearError') {
    for (const kind of message.sensor ? [message.sensor] : KINDS) delete hub.faults[kind];
  } else if (message.type === 'exit') {
    // 旧版本的实例：请求退出（双击只会把它退回卡片，实例不销毁）。
    exitInstance(message.reason || 'replaced');
    return;
  }
  hub.send({ type: 'state', sessions: [...hub.sessions].map((s) => ({ sensor: s._kind, frequency: s._frequency, source: s._play ? 'trace' : 'native', readings: s._readings })),
    traces: Object.keys(hub.traces), faults: Object.keys(hub.faults) });
}

let exiting = false;
function exitInstance(reason) {
  if (exiting) return;
  exiting = true;
  for (const s of [...hub.sessions]) s.stop();
  const done = (result) => { emit({ ev: 'exit', reason, result }); hub.send({ type: 'exit', reason, result }); };
  if (wx && typeof wx.exitMiniProgram === 'function') {
    try {
      wx.exitMiniProgram({ success: () => done('ok'), fail: (r) => { exiting = false; done(`fail ${(r && r.errMsg) || ''}`); } });
    } catch (e) { exiting = false; done(`throw ${e && e.message}`); }
  } else done('exitMiniProgram 不可用');
}

function connectLive() {
  if (typeof WebSocket !== 'function' || !config.live || !config.live.url) { emit({ ev: 'live-unavailable' }); return; }
  let ws;
  try { ws = new WebSocket(config.live.url); } catch (_e) { setTimeout(connectLive, 3000); return; }
  hub.socket = ws;
  ws.onopen = () => hub.send({ type: 'hello', build: BUILD, label: config.label || '', sessions: [...hub.sessions].map((s) => s._kind) });
  ws.onmessage = (event) => { try { handleLive(JSON.parse(String(event.data))); } catch (e) { console.error('[inklab-imu] 实时消息处理失败', e); } };
  ws.onclose = () => { if (hub.socket === ws) hub.socket = null; if (!exiting) setTimeout(connectLive, 3000); };
  ws.onerror = () => { /* onclose 里重连 */ };
}

emit({ ev: 'hello', mode: MODE, label: (config && config.label) || '' });
if (MODE === 'live') connectLive();

export {
  InkLabOrientation as AbsoluteOrientationSensor,
  InkLabAccelerometer as Accelerometer,
  InkLabGyroscope as Gyroscope,
  InkLabMagnetometer as Magnetometer,
};
export const inklabImu = { mode: MODE, hub };
