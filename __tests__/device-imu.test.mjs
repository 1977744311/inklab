import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImuControl, imuAgent, parseTraceRef } from '../lib/node/device-imu.mjs';
import { acceptWebSocket } from '../lib/node/ws-lite.mjs';
import { createDeviceLogs, parseLogLine } from '../lib/node/device-logs.mjs';
import { createDeviceService } from '../lib/node/device-service.mjs';
import { createSensorCapabilities } from '../lib/caps/sensors.mjs';
import { readAppConfig } from '../lib/node/app-config.mjs';
import { RECORD_PREFIX, encodeTrace, normalizeTrace } from '../lib/imu-trace.mjs';

const TRACE = encodeTrace(normalizeTrace({
  name: 'guided', device: { model: 'RG_glasses', source: 'guided' },
  sensors: { absoluteOrientation: { frequency: 60, rows: [[0, 0, 0, 0, 1], [16.667, 0.1, 0, 0, 0.995], [33.333, 0, 0, 0, 1]] } },
  segments: [{ id: 'nod', label: '点头', from: 0, to: 33.333, expect: { nod: 1 } }],
}));

async function appWithTraces(t) {
  const root = await mkdtemp(join(tmpdir(), 'inklab-device-imu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, 'aiui-demo', 'app');
  await mkdir(join(appDir, 'e2e', 'traces'), { recursive: true });
  await mkdir(join(appDir, 'pages', 'home'), { recursive: true });
  await writeFile(join(appDir, 'app.json'), JSON.stringify({ pages: ['pages/home/index'], permissions: [] }));
  await writeFile(join(appDir, 'pages', 'home', 'index.ink'), '<script setup>\nconst s = new AbsoluteOrientationSensor({});\n</script>\n');
  await writeFile(join(appDir, 'e2e', 'traces', 'guided.json'), JSON.stringify(TRACE));
  return appDir;
}

/** 假日志流：测试直接往 onImu 里灌录制行。 */
function fakeLogs() {
  const listeners = new Set();
  return { start() {}, stop() {}, mark: () => 0, since: () => [], recent: () => [], close() {}, subscribe() {},
    onImu(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(obj) { for (const fn of listeners) fn({ source: 'imu', text: RECORD_PREFIX + JSON.stringify({ v: 1, ...obj }) }); } };
}

test('调试包按模式改名：（调试）→（调试·IMU 回放）；实时模式补网络权限', () => {
  const agent = { agentName: '整活（调试）', permissions: ['audio', 'accelerometer'] };
  assert.equal(imuAgent(agent, 'real'), agent);
  assert.equal(imuAgent(agent, 'replay').agentName, '整活（调试·IMU 回放）');
  assert.deepEqual(imuAgent(agent, 'live').permissions, ['audio', 'accelerometer', 'network']);
  assert.equal(imuAgent({ agentName: '自定义', permissions: [] }, 'record').agentName, '自定义·IMU 录制');
  assert.deepEqual(parseTraceRef('guided#nod'), { name: 'guided', segment: 'nod' });
});

test('IMU 控制：选模式要有轨迹和段落；录制收进来能存成工程轨迹，不覆盖已有文件', async (t) => {
  const appDir = await appWithTraces(t);
  const logs = fakeLogs();
  const imu = createImuControl({ appDir, logs, now: () => Date.parse('2026-11-17T10:00:00Z') });
  await assert.rejects(imu.setMode({ mode: 'fly' }), /IMU 模式只能是/);
  await assert.rejects(imu.setMode({ mode: 'replay' }), /要选一条轨迹/);
  await assert.rejects(imu.setMode({ mode: 'replay', trace: 'nope' }), /没有这条轨迹/);
  await assert.rejects(imu.setMode({ mode: 'replay', trace: 'guided#zzz' }), /没有段落 zzz/);
  const status = await imu.setMode({ mode: 'replay', trace: 'guided#nod', loop: true });
  assert.deepEqual(status.settings, { mode: 'replay', trace: 'guided', segment: 'nod', loop: true });
  assert.equal(status.traces[0].id, 'guided');
  assert.deepEqual(status.traces[0].segments.map((s) => s.id), ['nod']);
  const plan = await imu.buildPlan();
  assert.equal(plan.mode, 'replay');
  assert.equal(plan.traces.absoluteOrientation.loop, true);
  assert.equal(plan.traces.absoluteOrientation.rows.length, 3);
  await imu.setMode({ mode: 'real' });
  assert.equal(await imu.buildPlan(), null);

  imu.installedAs('record');
  assert.throws(() => imu.mark('x'), /还没有收到/);
  logs.emit({ s: 'absoluteOrientation', f: 60, r: [[5000, 0, 0, 0, 1], [5016.667, 0.1, 0, 0, 0.995]] });
  logs.emit({ s: 'accelerometer', f: 60, r: [[5005, 0, -9.7, -1.2]] });
  assert.equal(imu.mark('点头').ts, 5016.667);
  const saved = await imu.saveRecording({ name: 'rec-1', note: '测试' });
  assert.equal(saved.id, 'rec-1');
  const file = JSON.parse(await readFile(join(appDir, 'e2e', 'traces', 'rec-1.json'), 'utf8'));
  assert.equal(file.format, 'inklab-imu-trace');
  assert.equal(file.recordedAt, '2026-11-17T10:00:00.000Z');
  assert.deepEqual(file.sensors.absoluteOrientation.rows[0], [0, 0, 0, 0, 1]);
  assert.deepEqual(file.marks, [{ t: 16.667, label: '点头' }]);
  await assert.rejects(imu.saveRecording({ name: 'rec-1' }), /已经有 e2e\/traces\/rec-1\.json/);
  await imu.saveRecording({ name: 'rec-1', overwrite: true, lastSeconds: 1 });
  await assert.rejects(imu.saveRecording({ name: 'Bad Name' }), /轨迹名/);
});

test('实时下发：没连上就说；连上后按轨迹（可截段、可只要部分传感器）发给真机，收真机的状态', async (t) => {
  const appDir = await appWithTraces(t);
  const imu = createImuControl({ appDir, logs: fakeLogs() });
  await assert.rejects(imu.sendLive({ type: 'play', trace: 'guided' }), /还没连上/);
  const sent = [];
  const socket = { send: (text) => sent.push(JSON.parse(text)), close() {} };
  imu.attachLive(socket);
  await assert.rejects(imu.sendLive({ type: 'clear' }), /还没连上/, '报版本之前不算连上');
  socket.onMessage(JSON.stringify({ type: 'hello', build: '' }));
  assert.deepEqual(await imu.sendLive({ type: 'play', trace: 'guided#nod', loop: true }), { sent: 'play', sensors: ['absoluteOrientation'] });
  assert.equal(sent[0].type, 'play');
  assert.equal(sent[0].traces.absoluteOrientation.loop, true);
  await imu.sendLive({ type: 'error', sensor: 'gyroscope', error: 'NotReadableError', afterReadings: 20 });
  assert.deepEqual(sent[1], { type: 'error', sensor: 'gyroscope', error: 'NotReadableError', message: '', afterReadings: 20 });
  await assert.rejects(imu.sendLive({ type: 'clear', sensor: 'compass' }), /不认识的传感器/);
  await assert.rejects(imu.sendLive({ type: 'dance' }), /不支持的实时命令/);
  socket.onMessage(JSON.stringify({ type: 'state', sessions: [{ sensor: 'absoluteOrientation', source: 'trace' }] }));
  socket.onMessage(JSON.stringify({ type: 'ended', sensor: 'absoluteOrientation' }));
  const status = await imu.status();
  assert.equal(status.live.connected, true);
  assert.equal(status.live.state.sessions[0].source, 'trace');
  assert.equal(status.live.events.at(-1).type, 'ended');
  socket.onClose();
  assert.equal((await imu.status()).live.connected, false);
});

test('旧版本实例：装新包不会销毁旧实例；它们的录制行挡在外面，实时连接请它退出', async (t) => {
  const appDir = await appWithTraces(t);
  const logs = fakeLogs();
  const imu = createImuControl({ appDir, logs });
  await imu.setMode({ mode: 'record' });
  const first = (await imu.buildPlan()).build;
  imu.installedAs('record');
  logs.emit({ b: first, s: 'absoluteOrientation', r: [[1000, 0, 0, 0, 1]] });
  const second = (await imu.buildPlan()).build;
  assert.notEqual(first, second);
  imu.installedAs('record');
  logs.emit({ b: first, s: 'absoluteOrientation', r: [[2000, 0, 0, 0, 1]] });
  logs.emit({ b: second, s: 'absoluteOrientation', r: [[2016, 0, 0, 0, 1]] });
  const status = await imu.status();
  assert.equal(status.recording.sensors.absoluteOrientation.samples, 1, '只收当前这一版的');
  assert.deepEqual(status.staleBuilds, [first]);

  await imu.setMode({ mode: 'live' });
  const liveA = (await imu.buildPlan({ liveUrl: 'ws://x' })).build;
  imu.installedAs('live');
  const sentA = [];
  const a = { send: (text) => sentA.push(JSON.parse(text)), close() {} };
  imu.attachLive(a);
  a.onMessage(JSON.stringify({ type: 'hello', build: liveA }));
  assert.equal((await imu.status()).live.connected, true);
  await imu.buildPlan({ liveUrl: 'ws://x' });
  imu.installedAs('live');
  assert.deepEqual(sentA, [{ type: 'exit', reason: 'replaced' }], '换包后旧实例被请退出');
  assert.equal((await imu.status()).live.connected, false);
  const sentOld = [];
  const old = { send: (text) => sentOld.push(JSON.parse(text)), close() {} };
  imu.attachLive(old);
  old.onMessage(JSON.stringify({ type: 'hello', build: liveA }));
  assert.deepEqual(sentOld, [{ type: 'exit', reason: 'replaced' }], '旧版本重连上来也请它退出');
  old.onMessage(JSON.stringify({ type: 'exit', reason: 'replaced', result: 'exitMiniProgram:ok' }));
  assert.equal((await imu.status()).live.events.at(-1).result, 'exitMiniProgram:ok');
});

test('引导录制：只收这次打开的实例（hello 报编号），别的实例和没编号的旧行都挡掉', async (t) => {
  const appDir = await appWithTraces(t);
  const logs = fakeLogs();
  const imu = createImuControl({ appDir, logs });
  imu.followGuided();
  logs.emit({ b: 'old-record', s: 'accelerometer', r: [[1, 0, 9.8, 0]] });
  logs.emit({ s: 'accelerometer', r: [[2, 0, 9.8, 0]] });
  logs.emit({ b: 'guided-1', ev: 'hello', mode: 'guided', segments: [{ id: 'still' }] });
  imu.installedAs('real'); // 推送流程结束时会记一次「装好了」：不能把跟住的编号盖掉
  logs.emit({ b: 'guided-1', ev: 'segment', phase: 'begin', id: 'still', ts: 10 });
  logs.emit({ b: 'guided-1', s: 'accelerometer', r: [[10, 0, 9.8, 0], [20, 0, 9.8, 0]] });
  logs.emit({ b: 'old-record', s: 'accelerometer', r: [[15, 1, 1, 1]] });
  logs.emit({ b: 'guided-1', ev: 'segment', phase: 'end', id: 'still', ts: 20 });
  logs.emit({ b: 'guided-1', ev: 'guide-done' });
  const stats = (await imu.status()).recording;
  assert.equal(stats.sensors.accelerometer.samples, 2);
  assert.deepEqual(stats.segments, ['still']);
  assert.equal(stats.finished, 'guide-done');
  assert.deepEqual(stats.plan, [{ id: 'still' }]);
});

test('ws-lite：握手、收发文本帧、关闭（用 Node 自带的 WebSocket 客户端）', async (t) => {
  const server = createServer();
  const received = [];
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head);
    conn.onMessage = (text) => { received.push(text); conn.send(`echo ${text}`); };
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/x`);
  const echoes = [];
  await new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onopen = () => { ws.send('hi'); ws.send('x'.repeat(70000)); };
    ws.onmessage = (event) => { echoes.push(String(event.data)); if (echoes.length === 2) resolve(); };
  });
  assert.deepEqual(received.map((r) => r.length), [2, 70000]);
  assert.equal(echoes[0], 'echo hi');
  assert.equal(echoes[1].length, 70005);
  await new Promise((resolve) => { ws.onclose = resolve; ws.close(); });
});

test('日志：录制行单独交给 onImu，不进日志面板', async () => {
  const entry = parseLogLine(`  1794927391.297  2009  9153 I Ink     : ink_script::console: ${RECORD_PREFIX}{"v":1,"ev":"hello"}`);
  assert.equal(entry.source, 'imu');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const logs = createDeviceLogs({ spawnProcess: () => child });
  const got = [];
  logs.onImu((e) => got.push(e.text));
  logs.start('SN1');
  child.stdout.emit('data', `  1.0  1 1 I Ink     : ink_script::console: ${RECORD_PREFIX}{"v":1,"ev":"hello"}\n  1.1  1 1 W Ink     : ink_script::console: [app] 普通日志\n`);
  assert.equal(got.length, 1);
  assert.deepEqual(logs.recent().map((e) => e.text), ['[app] 普通日志']);
});

test('模拟器传感器档案 rokid-rg1：没有磁力计（start 回错误）、加速度计按 ~101Hz、姿态请求 10Hz 给 50Hz', async () => {
  const events = [];
  const timers = [];
  const caps = createSensorCapabilities({
    dispatchEvent: (name, detail) => events.push([name, detail]),
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    profile: 'rokid-rg1',
  });
  const route = (id) => ({ targetId: `t${id}`, sessionId: `s${id}` });
  await caps.capabilities.magnetometer.start({ ...route(1), frequency: 60 });
  await caps.capabilities.accelerometer.start({ ...route(2), frequency: 60 });
  await caps.capabilities.absoluteOrientation.start({ ...route(3), frequency: 10 });
  timers.splice(0).forEach((fn) => fn());
  assert.deepEqual(events.find(([name]) => name === 'magnetometer.error')[1].error, 'OperationError');
  assert.ok(!events.some(([name]) => name === 'magnetometer.activate'));
  const sessions = Object.fromEntries(caps.activeSessions().map((s) => [s.sensor, s.frequency]));
  assert.deepEqual(sessions, { accelerometer: 101.1, absoluteOrientation: 50.55 });
  assert.equal(caps.profile().id, 'rokid-rg1');
  const generic = createSensorCapabilities({ dispatchEvent: () => {}, setTimeout: () => 0, clearTimeout: () => {} });
  await generic.capabilities.accelerometer.start({ ...route(4), frequency: 60 });
  assert.equal(generic.activeSessions()[0].frequency, 60);
  assert.throws(() => createSensorCapabilities({ dispatchEvent: () => {}, profile: 'nokia' }), /没有这个传感器档案/);
});

test('inklab.config.json：sensorProfile 与 device.imu 校验', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-imu-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ sensorProfile: 'rokid-rg1', device: { imu: 'record' } }));
  assert.deepEqual(await readAppConfig(dir), { allowExternal: [], sensorProfile: 'rokid-rg1', device: { imu: 'record' } });
  await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ sensorProfile: 'x' }));
  await assert.rejects(readAppConfig(dir), /sensorProfile 只能是/);
  await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ device: { imu: 'fake' } }));
  await assert.rejects(readAppConfig(dir), /device\.imu 只能是/);
});

// ── 推送：模拟 IMU 模式走临时副本 ───────────────────────────────────────────

function fakeAdb() {
  const calls = [];
  const pushed = {};
  const aiui = (sec, fields) => `${sec}.000 1 1 I AIUI: [AIUI] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const execute = async (file, args) => {
    calls.push(args);
    const script = args[2] === 'shell' ? args[3] : '';
    if (args[0] === 'devices' || args[1] === 'devices') return { stdout: 'List of devices attached\nSN1 device model:RG_glasses\n' };
    if (args[2] === 'push') {
      if (args[3].endsWith('agent.json')) Object.assign(pushed, JSON.parse(await readFile(args[3], 'utf8')));
      return { stdout: '1 file pushed' };
    }
    if (args[2] === 'exec-out') return { stdout: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex') };
    if (script.startsWith('settings get global')) return { stdout: '1\n' };
    if (script.startsWith('cat /sdcard/aiui/package/developer_manifest.json')) return { stdout: `{"packages":[{"agentId":"develop.rokid.inklab.demo","fileMd5":"md5"}]}` };
    const method = /'--method' '(\w+)'/.exec(script)?.[1];
    if (method === 'prepare') return { stdout: `Result: Bundle[{result_data=${JSON.stringify({ errorCode: '', ready: true, inboxPath: '/sdcard/aiui/package/.staging/adb/' })}}]` };
    if (method === 'apply') return { stdout: `Result: Bundle[{result_data=${JSON.stringify({ errorCode: '', agentId: pushed.agentId, outcome: 'UPDATED', operationId: 'ap-1' })}}]` };
    if (method === 'status') return { stdout: 'Result: Bundle[{result_data={"errorCode":"","publishState":"QUEUED"}}]' };
    if (method === 'open') return { stdout: 'Result: Bundle[{result_data={"ok":true,"operationId":"op-9"}}]' };
    if (script.includes("grep -F '[AIUI]'") || script.includes('event=ink_performance')) {
      return { stdout: [aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }),
        aiui(102, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.inklab.demo', outcome: 'COMMITTED' }),
        aiui(200, { event: 'ink_performance', agent_id: 'develop.rokid.inklab.demo' })].join('\n') };
    }
    if (script.startsWith('date')) return { stdout: '100.5\n' };
    return { stdout: '' };
  };
  return { calls, execute, pushed };
}

async function pushFixture(t, { port = 0 } = {}) {
  const appDir = await appWithTraces(t);
  const adb = fakeAdb();
  const builds = [];
  const build = async (dir, opts) => {
    builds.push({ dir, opts, injected: await readFile(join(dir, 'pages', 'home', 'index.ink'), 'utf8'),
      config: await readFile(join(dir, '__inklab__', 'imu-config.js'), 'utf8').catch(() => null) });
    return { aixPath: join(appDir, 'x.aix'), md5: 'md5', bytes: 10, cleanup: async () => {} };
  };
  const service = createDeviceService({ appDir, enabled: true, serial: 'SN1', execute: adb.execute, outputDir: join(appDir, '..', 'out'),
    vision: { status: async () => ({ available: false }), read: async () => ({}) }, sleepFn: async () => {}, build,
    logStream: fakeLogs(), hostPort: () => port });
  return { service, adb, builds, appDir };
}

test('推送回放模式：从临时副本打包（放行调试注入），轨迹打进包里，名字标明模式', async (t) => {
  const { service, adb, builds, appDir } = await pushFixture(t);
  await service.imu.setMode({ mode: 'replay', trace: 'guided#nod' });
  const result = await service.push();
  assert.equal(result.status, 'done');
  assert.equal(result.imu, 'replay');
  assert.equal(builds.length, 1);
  assert.notEqual(builds[0].dir, appDir);
  assert.deepEqual(builds[0].opts.debugBuild, true);
  assert.equal(builds[0].opts.name, 'demo');
  assert.match(builds[0].injected, /import \{ AbsoluteOrientationSensor \} from '\.\.\/\.\.\/__inklab__\/imu\.js'/);
  assert.match(builds[0].config, /"mode":"replay"/);
  assert.equal(adb.pushed.agentName, 'demo（调试·IMU 回放）');
  assert.deepEqual(result.injected, [{ file: 'pages/home/index.ink', names: ['AbsoluteOrientationSensor'] }]);
  assert.equal((await service.status()).imu.settings.mode, 'replay');
  // 切回真实：直接从源码目录打包
  await service.imu.setMode({ mode: 'real' });
  await service.push();
  assert.equal(builds[1].dir, appDir);
  assert.equal(builds[1].opts.debugBuild, undefined);
});

test('推送实时模式：要有 InkLab 服务端口；做 adb reverse，包里写连回来的地址；网络权限补上', async (t) => {
  const noPort = await pushFixture(t);
  await noPort.service.imu.setMode({ mode: 'live' });
  await assert.rejects(noPort.service.push(), /工作台在跑/);
  const { service, adb, builds } = await pushFixture(t, { port: 4567 });
  await service.imu.setMode({ mode: 'live' });
  await service.push();
  assert.ok(adb.calls.some((args) => args.join(' ') === '-s SN1 reverse tcp:4567 tcp:4567'));
  assert.match(builds[0].config, /ws:\/\/127\.0\.0\.1:4567\/api\/device\/imu\/live\/[0-9a-f]{32}/);
  assert.ok(adb.pushed.permissions.includes('network'));
  await service.close();
  assert.ok(adb.calls.some((args) => args.join(' ') === '-s SN1 reverse --remove tcp:4567'));
});

test('实时通道的 upgrade 只认本次会话的令牌和本机地址', async (t) => {
  const { service } = await pushFixture(t, { port: 4567 });
  const ended = [];
  const socket = { end: (text) => ended.push(text), write() {}, on() {}, setNoDelay() {} };
  const req = (host) => ({ headers: { host, upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
  service.imu.upgrade(req('127.0.0.1:4567'), socket, Buffer.alloc(0), new URL('http://x/api/device/imu/live/wrong'));
  service.imu.upgrade(req('evil.example:4567'), socket, Buffer.alloc(0), new URL('http://x/api/device/imu/live/wrong'));
  assert.equal(ended.length, 2);
  assert.match(ended[0], /403/);
});

test('模拟器回放对准绝对时刻：计时器每次晚到 3ms 也不会把 60Hz 放成 50Hz', async () => {
  let clock = 0;
  let queue = [];
  const events = [];
  const caps = createSensorCapabilities({
    dispatchEvent: (name, detail) => events.push([name, detail]),
    now: () => clock,
    setTimeout: (fn, ms) => { const timer = { fn, at: clock + ms }; queue.push(timer); return timer; },
    clearTimeout: (timer) => { queue = queue.filter((t) => t !== timer); },
  });
  const rows = Array.from({ length: 101 }, (_, i) => ({ t: i * 10, x: 0, y: 0, z: 0, w: 1 }));
  caps.loadTrace('absoluteOrientation', rows);
  await caps.capabilities.absoluteOrientation.start({ targetId: 't1', sessionId: 's1', frequency: 60 });
  await caps.capabilities.accelerometer.start({ targetId: 't2', sessionId: 's2', frequency: 60 });
  while (queue.length && clock < 1000) {
    queue.sort((a, b) => a.at - b.at);
    const next = queue.shift();
    clock = Math.max(clock, next.at + 3); // 每次都晚 3ms
    next.fn();
  }
  const count = (name) => events.filter(([n, d]) => n === name && d.timestamp <= 1000).length;
  assert.ok(count('accelerometer.reading') >= 58, `基线 60Hz 只放出 ${count('accelerometer.reading')} 条`);
  assert.ok(count('absoluteOrientation.reading') >= 98, `100Hz 轨迹只放出 ${count('absoluteOrientation.reading')} 条`);
});
