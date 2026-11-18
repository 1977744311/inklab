// device-imu.mjs — 真机「模拟 IMU」的控制面：选模式、读写工程轨迹、收录制、实时下发。
//
// 模式在推送时生效（见 device-service 的 pushNow 与 imu-build.mjs）：
//   real    正常调试包，真传感器
//   replay  把选中的轨迹（或其中一段）打进包里，传感器每次 start 都从头放
//   live    包里不带轨迹，经 adb reverse 用 WebSocket 连回 InkLab，工作台随时下发
//   record  真传感器照常给应用，读数写进日志，这里从 logcat 收下来，可以存成轨迹
// 轨迹存在工程的 e2e/traces/<名>.json（格式见 lib/imu-trace.mjs），模拟器场景里用 lab.imu 读同一批文件。

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createRecordingAssembler, decodeRecordLine, encodeTrace, normalizeTrace, sliceTrace, traceFileName, traceSummary, TRACE_SENSORS,
} from '../imu-trace.mjs';
import { IMU_MODES, MODE_LABELS, bakeTraces } from './imu-build.mjs';

export const TRACES_DIR = 'e2e/traces';

/** 「名字」或「名字#段落」→ { name, segment }。 */
export function parseTraceRef(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('#');
  return at < 0 ? { name: text, segment: '' } : { name: text.slice(0, at), segment: text.slice(at + 1) };
}

/** 调试包身份按模式改名：「整活（调试）」→「整活（调试·IMU 回放）」；实时模式补上网络权限。 */
export function imuAgent(agent, mode) {
  if (!mode || mode === 'real') return agent;
  const label = MODE_LABELS[mode];
  const agentName = /（调试）$/.test(agent.agentName)
    ? agent.agentName.replace(/（调试）$/, `（调试·${label}）`)
    : `${agent.agentName}·${label}`;
  const permissions = mode === 'live' && !agent.permissions.includes('network') ? [...agent.permissions, 'network'] : agent.permissions;
  return { ...agent, agentName, permissions };
}

export function createImuControl({ appDir, logs, now = Date.now, mode: initialMode = 'real' } = {}) {
  const tracesDir = join(appDir, TRACES_DIR);
  const recorder = createRecordingAssembler();
  const token = randomBytes(16).toString('hex');
  const cache = new Map(); // 文件名 → { mtimeMs, trace }
  let settings = { mode: IMU_MODES.includes(initialMode) ? initialMode : 'real', trace: '', segment: '', loop: false };
  let installed = { mode: 'real' }; // 设备上现在装的是哪种包（推送成功后更新）
  let pendingBuild = '';
  const live = { socket: null, connectedAt: null, state: null, events: [], sockets: new Set() };
  // 眼镜上旧版本的实例不会因为装了新包而销毁（双击只把它退回卡片，卸载也不回收），
  // 它们的录制行要挡在外面，不然新旧两份读数会混进同一条轨迹。
  const stale = new Map(); // 旧版本编号 → 最后一次见到的时间

  // 当前这一版：已装好的，或者正在推的（新实例在推送流程走完之前就开始出数、连回来了）。
  // 还不知道当前是哪一版时（只收不推）什么都收。
  const isCurrent = (build) => (!installed.build && !pendingBuild) || (Boolean(build) && (build === installed.build || build === pendingBuild));
  let followGuided = false;
  logs?.onImu?.((entry) => {
    const event = decodeRecordLine(entry.text);
    if (!event) return;
    // 引导录制：跟住这次打开的那个实例（它在 hello 里报自己的编号）
    if (followGuided && event.ev === 'hello' && event.mode === 'guided' && event.b) {
      installed = { mode: 'guided', at: now(), build: event.b };
      recorder.clear();
    }
    if (!isCurrent(event.b)) { if (event.b) stale.set(event.b, now()); return; }
    recorder.push(event);
  });
  const liveEvent = (event) => {
    live.events.push({ at: now(), ...event });
    if (live.events.length > 50) live.events.splice(0, live.events.length - 50);
  };
  /** 旧版本实例：请它退出（wx.exitMiniProgram），连接留着等它自己断。 */
  function retire(socket, build) {
    stale.set(build, now());
    try { socket.send(JSON.stringify({ type: 'exit', reason: 'replaced' })); } catch { /* 已断 */ }
    liveEvent({ type: 'retire', build });
  }

  async function listTraces() {
    let names;
    try { names = (await readdir(tracesDir)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
    const out = [];
    for (const file of names) {
      try {
        const trace = await loadFile(file);
        out.push({ id: file.replace(/\.json$/, ''), ...traceSummary(trace) });
      } catch (err) { out.push({ id: file.replace(/\.json$/, ''), error: err.message }); }
    }
    return out;
  }
  async function loadFile(file) {
    const path = join(tracesDir, file);
    const info = await stat(path);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === info.mtimeMs) return hit.trace;
    const trace = normalizeTrace(await readFile(path, 'utf8'), { name: file.replace(/\.json$/, '') });
    cache.set(file, { mtimeMs: info.mtimeMs, trace });
    return trace;
  }
  async function loadTrace(name) {
    try { return await loadFile(traceFileName(name)); } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`没有这条轨迹：${TRACES_DIR}/${name}.json`, { cause: err });
      throw err;
    }
  }

  return {
    token,
    recorder,
    listTraces,
    loadTrace,
    settings: () => ({ ...settings }),
    /** 引导录制：之后只收新打开的引导录制实例（hello 里报编号）的数据。 */
    followGuided() {
      followGuided = true;
      installed = { mode: 'guided', at: now(), build: 'pending' };
      recorder.clear();
    },
    async setMode({ mode, trace = '', segment = '', loop = false } = {}) {
      if (!IMU_MODES.includes(mode)) throw new Error(`IMU 模式只能是 ${IMU_MODES.join(' / ')}`);
      let ref = parseTraceRef(trace);
      if (segment) ref = { ...ref, segment };
      if (mode === 'replay') {
        if (!ref.name) throw new Error('回放模式要选一条轨迹');
        const loaded = await loadTrace(ref.name);
        if (ref.segment) sliceTrace(loaded, { segment: ref.segment });
      }
      settings = { mode, trace: ref.name, segment: ref.segment, loop: loop === true };
      return this.status();
    },
    /** 推送前：返回要交给 stageImuBuild 的东西；real 模式返回 null。 */
    async buildPlan({ liveUrl = '' } = {}) {
      pendingBuild = '';
      if (settings.mode === 'real') return null;
      pendingBuild = randomBytes(6).toString('hex');
      if (settings.mode === 'record') recorder.clear();
      const plan = { mode: settings.mode, label: MODE_LABELS[settings.mode], build: pendingBuild };
      if (settings.mode === 'replay') {
        plan.traces = bakeTraces(await loadTrace(settings.trace), { segment: settings.segment || undefined, loop: settings.loop });
        plan.label = `${plan.label} · ${settings.trace}${settings.segment ? `#${settings.segment}` : ''}`;
      }
      if (settings.mode === 'live') plan.liveUrl = liveUrl;
      return plan;
    },
    installedAs(mode) {
      if (followGuided) return; // 引导录制包是普通调试包，跟的是它在 hello 里报的编号，别被推送结果盖掉
      const build = mode === 'real' ? '' : pendingBuild;
      installed = { mode, at: now(), ...(build ? { build } : {}),
        ...(mode === 'replay' ? { trace: settings.trace, segment: settings.segment, loop: settings.loop } : {}) };
      pendingBuild = '';
      // 换了包：之前连着的实时实例都成了旧版本
      for (const socket of live.sockets) if (socket.build && socket.build !== installed.build) retire(socket, socket.build);
      if (live.socket && live.socket.build !== installed.build) live.socket = null;
    },
    async status() {
      return {
        settings: { ...settings },
        installed: { ...installed },
        modes: IMU_MODES,
        traces: await listTraces(),
        recording: recorder.stats(),
        live: { connected: Boolean(live.socket), connectedAt: live.connectedAt, state: live.state, events: live.events.slice(-8) },
        // 最近 2 分钟还在出声的旧版本实例（装新包不会销毁旧实例；重启眼镜或助手才清掉）
        staleBuilds: [...stale].filter(([, at]) => now() - at < 120000).map(([build]) => build),
      };
    },
    // ── 录制 ──
    /** 存成轨迹：缺省存到本工程的 e2e/traces/；dir 给绝对路径时存到那里（引导录制存到你指定的工程）。 */
    async saveRecording({ name, lastSeconds, note = '', overwrite = false, device = null, dir = tracesDir, source = 'record' } = {}) {
      const file = traceFileName(name);
      const seconds = lastSeconds === undefined || lastSeconds === null || lastSeconds === '' ? undefined : Number(lastSeconds);
      if (seconds !== undefined && !(seconds > 0)) throw new Error('lastSeconds 必须是正数');
      const trace = recorder.toTrace({ lastSeconds: seconds, name: String(name), note, device, source, recordedAt: new Date(now()).toISOString() });
      await mkdir(dir, { recursive: true });
      const path = join(dir, file);
      await writeFile(path, `${JSON.stringify(encodeTrace(trace))}\n`, { flag: overwrite ? 'w' : 'wx' }).catch((err) => {
        if (err.code === 'EEXIST') throw new Error(`已经有 ${TRACES_DIR}/${file}，换个名字或勾选覆盖`, { cause: err });
        throw err;
      });
      cache.delete(file);
      return { path, id: String(name), ...traceSummary(trace) };
    },
    mark(label) {
      const ts = recorder.latest();
      if (ts === null) throw new Error('还没有收到真机的 IMU 数据，标记无处安放');
      recorder.mark(ts, label);
      return { ts, label: String(label || '') };
    },
    clearRecording() { recorder.clear(); return recorder.stats(); },
    // ── 实时 ──
    liveUrl: (port) => `ws://127.0.0.1:${port}/api/device/imu/live/${token}`,
    /**
     * 真机实时调试包连进来。先等它报版本（hello 里的 build）：是当前这一版就当活动连接；
     * 是旧版本（之前推的包留下的实例）就请它退出。
     */
    attachLive(socket) {
      live.sockets.add(socket);
      socket.onMessage = (text) => {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (message.type === 'hello') {
          socket.build = String(message.build || '');
          if (!isCurrent(socket.build)) { retire(socket, socket.build); return; }
          live.socket = socket;
          live.connectedAt = now();
          liveEvent({ type: 'connected', build: socket.build });
          return;
        }
        if (socket !== live.socket) { if (message.type === 'exit') liveEvent({ ...message, build: socket.build }); return; }
        if (message.type === 'state') live.state = message;
        else liveEvent(message);
      };
      socket.onClose = () => {
        live.sockets.delete(socket);
        if (live.socket === socket) { live.socket = null; liveEvent({ type: 'disconnected' }); }
      };
    },
    /**
     * 往真机下发：{ type: 'play'|'load', trace, segment?, sensors?, loop?, speed? } / { type: 'clear', sensor? }
     *            / { type: 'error', sensor, error?, message?, afterReadings? } / { type: 'clearError', sensor? }
     */
    async sendLive(command = {}) {
      if (!live.socket) throw new Error('真机上的实时调试包还没连上（推送实时模式的包并打开应用）');
      const type = command.type;
      let message;
      if (type === 'play' || type === 'load') {
        const ref = parseTraceRef(command.trace);
        const trace = await loadTrace(ref.name);
        const segment = command.segment || ref.segment || undefined;
        const picked = Array.isArray(command.sensors) && command.sensors.length ? sliceTrace(trace, { segment, sensors: command.sensors })
          : segment ? sliceTrace(trace, { segment }) : trace;
        message = { type, traces: bakeTraces(picked, { loop: command.loop === true, speed: Number(command.speed) || undefined }) };
      } else if (type === 'clear' || type === 'clearError') {
        if (command.sensor && !TRACE_SENSORS.includes(command.sensor)) throw new Error(`不认识的传感器：${command.sensor}`);
        message = { type, ...(command.sensor ? { sensor: command.sensor } : {}) };
      } else if (type === 'error') {
        if (!TRACE_SENSORS.includes(command.sensor)) throw new Error(`不认识的传感器：${command.sensor}`);
        message = { type, sensor: command.sensor, error: String(command.error || 'NotReadableError'), message: String(command.message || ''),
          afterReadings: Number(command.afterReadings) || 0 };
      } else throw new Error(`不支持的实时命令：${type}`);
      live.socket.send(JSON.stringify(message));
      return { sent: type, sensors: message.traces ? Object.keys(message.traces) : message.sensor ? [message.sensor] : [] };
    },
    close() { for (const socket of live.sockets) { try { socket.close(1001, 'closing'); } catch { /* 已断 */ } } },
  };
}
