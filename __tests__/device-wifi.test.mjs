import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceLogs, isNetworkSerial } from '../lib/node/device-logs.mjs';
import { soleDeviceSerial } from '../lib/node/device-service.mjs';
import { disableWifiAdb, enableWifiAdb, parseWifiStatus, recallWifiTarget, reconnectRemembered } from '../lib/node/device-wifi.mjs';
import { parseSubcommand } from '../lib/node/device-e2e.mjs';
import { normalizeTrace, traceSummary } from '../lib/imu-trace.mjs';

const WIFI = '192.168.31.229:5555';
const line = (at, text) => `  ${at}  2009  9153 I Ink     : ink_script::console: ${text}`;

function fakeSpawner() {
  const spawned = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.args = args;
    child.kill = () => child.emit('close');
    spawned.push(child);
    if (args[0] === 'connect') setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { spawn, spawned, logcats: () => spawned.filter((c) => c.args.includes('logcat')) };
}

test('日志流：logcat 意外断开后重连，从最后一行的时刻续读，同一时刻收过的行不重复', async () => {
  const { spawn, spawned, logcats } = fakeSpawner();
  const timers = [];
  let clock = 1000;
  const logs = createDeviceLogs({ spawnProcess: spawn, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {}, now: () => clock });
  const got = [];
  logs.start(WIFI);
  logs.subscribe({ writeHead() {}, write(data) { if (data.startsWith('data:')) got.push(JSON.parse(data.slice(6)).text); }, on() {} });
  assert.deepEqual(logcats()[0].args.slice(-2), ['-T', '1']);
  logcats()[0].stdout.emit('data', `${line('100.100', 'a')}\n${line('100.200', 'b')}\n`);
  logcats()[0].emit('close'); // Wi-Fi 抖了一下
  assert.equal(logs.running(), false);
  clock = 4000;
  assert.equal(logs.state().down, 3000);
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.deepEqual(spawned.find((c) => c.args[0] === 'connect').args, ['connect', WIFI], '网络序列号重连前先 adb connect');
  const resumed = logcats()[1];
  assert.deepEqual(resumed.args.slice(-2), ['-T', '100.200']);
  resumed.stdout.emit('data', `${line('100.100', 'a')}\n${line('100.200', 'b')}\n${line('100.200', 'c')}\n${line('100.300', 'd')}\n`);
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
  assert.deepEqual(logs.state().drops, [{ at: 1000, ms: 3000 }]);
  assert.equal(logs.state().down, null);
  logs.stop();
  assert.equal(timers.length, 0, '主动停下不重连');
});

test('日志流：USB 序列号断开也重连，但不 adb connect；换设备时不重连旧的', async () => {
  const { spawn, spawned, logcats } = fakeSpawner();
  const timers = [];
  const logs = createDeviceLogs({ spawnProcess: spawn, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  logs.start('SN1');
  logcats()[0].emit('close');
  await timers.shift()();
  assert.equal(spawned.filter((c) => c.args[0] === 'connect').length, 0);
  assert.deepEqual(logcats()[1].args.slice(0, 2), ['-s', 'SN1']);
  assert.deepEqual(logcats()[1].args.slice(-2), ['-T', '1'], '一行都没收到过就只看新的');
  logcats()[1].emit('close');
  logs.start('SN2');
  await timers.shift()();
  assert.deepEqual(logcats().map((c) => c.args[1]), ['SN1', 'SN1', 'SN2']);
});

test('同一台眼镜同时连着 USB 和 Wi-Fi：用 Wi-Fi；两台不同的设备就要 --serial', async () => {
  assert.equal(isNetworkSerial(WIFI), true);
  assert.equal(isNetworkSerial('1901092534007858'), false);
  const execute = (id) => async (bin, args) => ({ stdout: args.includes('getprop ro.serialno') ? `${id}\n` : '' });
  const both = [{ serial: '1901092534007858', state: 'device' }, { serial: WIFI, state: 'device' }];
  assert.equal(await soleDeviceSerial(both, { execute: execute('1901092534007858') }), WIFI);
  assert.equal(await soleDeviceSerial(both, { execute: execute('OTHER') }), null);
  assert.equal(await soleDeviceSerial([both[0]]), '1901092534007858');
  assert.equal(await soleDeviceSerial([both[0], { serial: 'SN2', state: 'device' }]), null);
});

function fakeAdb({ status, port = '' }) {
  const calls = [];
  const execute = async (bin, args) => {
    calls.push(args);
    const script = args[args.length - 1];
    if (args.includes('shell') && script.includes('cmd wifi status')) return { stdout: `${status}\n@ip=${status.includes('connected to') ? '192.168.31.229' : ''}\n@port=${port}\n` };
    if (args.includes('shell')) return { stdout: 'ok\n' };
    if (args[0] === 'connect') return { stdout: `connected to ${args[1]}\n` };
    return { stdout: '' };
  };
  return { execute, calls };
}

test('无线调试：眼镜连着 Wi-Fi 才开；开了 tcpip 再 adb connect 并核对，记下地址', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-wifi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = join(dir, 'wifi-adb.json');
  assert.deepEqual(parseWifiStatus('Wifi is enabled\nWifi is connected to "Xiaomi_FEE7_5G"\n@ip=192.168.31.229\n@port=5555'),
    { enabled: true, ssid: 'Xiaomi_FEE7_5G', ip: '192.168.31.229', port: 5555 });
  assert.equal(parseWifiStatus('Wifi is disabled\n@ip=\n@port=').enabled, false);

  const off = fakeAdb({ status: 'Wifi is disabled' });
  await assert.rejects(enableWifiAdb({ execute: off.execute, serial: 'SN1', wait: async () => {}, memory }), /Wi-Fi 关着/);
  assert.ok(!off.calls.some((a) => a.includes('tcpip')), '不替你开 Wi-Fi，也不切 TCP');

  const on = fakeAdb({ status: 'Wifi is enabled\nWifi is connected to "Xiaomi_FEE7_5G"' });
  const result = await enableWifiAdb({ execute: on.execute, serial: 'SN1', wait: async () => {}, memory });
  assert.deepEqual(await recallWifiTarget({ file: memory }), { serial: WIFI, device: 'SN1' });
  assert.equal(result.serial, WIFI);
  assert.equal(result.already, false);
  assert.match(result.note, /可以拔线/);
  const order = on.calls.map((a) => (a.includes('tcpip') ? 'tcpip' : a[0] === 'connect' ? 'connect' : a.includes('wait-for-device') ? 'wait' : a[1] === WIFI ? 'check' : 'status'));
  assert.deepEqual(order, ['status', 'tcpip', 'wait', 'connect', 'check']);

  const again = fakeAdb({ status: 'Wifi is connected to "Xiaomi_FEE7_5G"', port: '5555' });
  assert.equal((await enableWifiAdb({ execute: again.execute, serial: 'SN1', wait: async () => {}, memory })).already, true);
  assert.ok(!again.calls.some((a) => a.includes('tcpip')), '已经是 TCP 模式就不再重启 adbd');

  const back = fakeAdb({ status: 'Wifi is connected to "Xiaomi_FEE7_5G"', port: '5555' });
  const offResult = await disableWifiAdb({ execute: back.execute, serial: 'SN1', memory });
  assert.equal(await recallWifiTarget({ file: memory }), null, '关掉就忘掉地址');
  assert.equal(offResult.disconnected, WIFI);
  assert.ok(back.calls.some((a) => a.includes('usb')) && back.calls.some((a) => a[0] === 'disconnect'));

  assert.equal(parseSubcommand(['wifi', '--off']).off, true);
  assert.throws(() => parseSubcommand(['push', 'app', '--off']), /Unknown argument/);
});

test('存轨迹：段落里的断档报出来，段落之间不算', () => {
  const samples = (ts) => ts.map((t) => ({ t, x: 0, y: 0, z: 0 }));
  const trace = normalizeTrace({
    format: 'inklab-imu-trace', version: 2, name: 'gappy',
    sensors: { accelerometer: { frequency: 100, samples: samples([0, 10, 20, 700, 710, 2000, 2010]) } },
    segments: [{ id: 'a', label: 'A', from: 0, to: 710 }, { id: 'b', label: 'B', from: 2000, to: 2010 }],
  });
  const summary = traceSummary(trace);
  assert.deepEqual(summary.sensors.accelerometer.gaps, { count: 1, longestMs: 680 });
  assert.match(summary.warnings[0], /accelerometer 有 1 处断档，最长 680 ms/);
  const clean = traceSummary(normalizeTrace({ format: 'inklab-imu-trace', version: 2, name: 'ok',
    sensors: { accelerometer: { frequency: 100, samples: samples([0, 10, 20]) } } }));
  assert.equal(clean.warnings, undefined);
});

test('adb 服务重启后忘了无线连接：按记下的地址重连一次；插着别的设备时不动', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-wifi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = join(dir, 'wifi-adb.json');
  const calls = [];
  const execute = (reply) => async (bin, args) => { calls.push(args); return { stdout: reply }; };
  const connected = execute(`connected to ${WIFI}\n`);
  assert.deepEqual(await reconnectRemembered({ execute: connected, file: memory }), { serial: null, target: null });
  assert.equal(calls.length, 0, '没记过地址就不连');
  const on = fakeAdb({ status: 'Wifi is connected to "Xiaomi_FEE7_5G"', port: '5555' });
  await enableWifiAdb({ execute: on.execute, serial: 'SN1', wait: async () => {}, memory });
  assert.deepEqual(await reconnectRemembered({ execute: connected, file: memory }), { serial: WIFI, target: WIFI });
  assert.deepEqual(calls.at(-1), ['connect', WIFI]);
  assert.deepEqual(await reconnectRemembered({ execute: connected, file: memory, ready: [{ serial: 'SN1', state: 'device' }] }),
    { serial: WIFI, target: WIFI }, '只插着同一副眼镜的 USB：连回 Wi-Fi，录制中途好拔线');
  const before = calls.length;
  assert.deepEqual(await reconnectRemembered({ execute: connected, file: memory, ready: [{ serial: 'OTHER', state: 'device' }] }),
    { serial: null, target: WIFI });
  assert.deepEqual(await reconnectRemembered({ execute: connected, file: memory, ready: [{ serial: WIFI, state: 'device' }] }),
    { serial: WIFI, target: WIFI });
  assert.equal(calls.length, before, '插着别的设备、或已经连着时不发 connect');
  assert.deepEqual(await reconnectRemembered({ execute: execute(`failed to connect to '${WIFI}': No route to host\n`), file: memory }),
    { serial: null, target: WIFI });
});
