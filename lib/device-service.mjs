import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, access, chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createDeviceDriver, deviceScenarioSupport, DEVICE_CAPABILITIES } from './device-driver.mjs';
import { createDeviceMirror } from './device-mirror.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
export function readDeviceConfig(appDir) {
  try { return JSON.parse(readFileSync(join(appDir, 'inklab.device.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}; throw error; }
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MAX_DEVICE_RECORDING_BYTES = 64 * 1024 * 1024;
const requestError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function recordingType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'video/webm'].includes(type)) throw requestError('录像只接受 video/mp4 或 video/webm', 415);
  return type;
}

function readRecordingBody(req, { maxBytes, timeoutMs }) {
  const length = req.headers['content-length'];
  if (length !== undefined && !/^\d+$/.test(length)) throw requestError('无效 Content-Length');
  if (length !== undefined && Number(length) > maxBytes) throw requestError('录像超过上传大小上限', 413);
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    const clean = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const fail = (err) => { clean(); req.pause(); reject(err); };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(requestError('录像超过上传大小上限', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      if (!bytes || (length !== undefined && Number(length) !== bytes)) {
        fail(requestError('录像为空或传输长度不完整')); return;
      }
      clean(); resolveBody(Buffer.concat(chunks, bytes));
    };
    const error = (err) => fail(err);
    const aborted = () => fail(requestError('录像上传中断'));
    const timer = setTimeout(() => fail(requestError('录像上传超时', 408)), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

export function parseAdbDevices(stdout) {
  return String(stdout).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => {
      const [serial, state, ...fields] = line.split(/\s+/);
      return { serial, state, ...Object.fromEntries(fields.filter((p) => p.includes(':')).map((p) => p.split(/:(.*)/s).slice(0, 2))) };
    }).filter((d) => d.serial && d.state);
}

export function pngMetadata(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || !png.subarray(0, 8).equals(PNG)
    || png.subarray(12, 16).toString() !== 'IHDR') throw new Error('ADB 未返回完整 PNG 头');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex') };
}

export function createVisionOcr({ execute = exec, platform = process.platform } = {}) {
  let compiler = null;
  async function prepare() {
    if (platform !== 'darwin') return { available: false, reason: '自动 OCR 当前需要 macOS Vision；原图仍可保存并人工复核' };
    if (!compiler) compiler = (async () => {
      const source = join(HERE, 'device-ocr.swift');
      const digest = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
      const binary = join(tmpdir(), `inklab-vision-${digest}`);
      try { await access(binary); }
      catch { await execute('xcrun', ['swiftc', source, '-O', '-o', binary], { timeout: 120000, maxBuffer: 1024 * 1024 }); }
      return { available: true, binary };
    })().catch((err) => ({ available: false, reason: `Vision OCR 编译不可用：${err.message}` }));
    return compiler;
  }
  return {
    async status() { const { binary: _binary, ...status } = await prepare(); return status; },
    async read(path) {
      const status = await prepare();
      if (!status.available) return { status: 'unavailable', reason: status.reason };
      try {
        const { stdout } = await execute(status.binary, [path], { timeout: 30000, maxBuffer: 1024 * 1024 });
        return JSON.parse(stdout);
      } catch (err) { return { status: 'unavailable', reason: `OCR 失败：${err.message}` }; }
    },
  };
}

export async function loadDeviceScenarios(appDir) {
  const directory = join(appDir, 'e2e/device-scenarios');
  const scenarios = [];
  let files = [];
  try { files = await readdir(directory); } catch { return scenarios; }
  for (const file of files.filter((f) => /^[a-zA-Z0-9._-]+\.json$/.test(f)).sort()) {
    try {
      const body = await readFile(join(directory, file), 'utf8');
      if (body.length > 256 * 1024) throw new Error('场景文件超过 256 KiB');
      const scene = JSON.parse(body);
      if (!scene.id || typeof scene.id !== 'string' || !/^[\w.-]+$/.test(scene.id)) throw new Error('id 必须由字母、数字、点、下划线或连字符组成');
      if (scenarios.some((s) => s.id === scene.id)) throw new Error('重复场景 id');
      scenarios.push({ ...scene, source: 'project-device', file: `e2e/device-scenarios/${file}` });
    } catch (err) { scenarios.push({ id: `invalid-${file}`, title: file, source: 'project-device', error: err.message }); }
  }
  return scenarios;
}

export function createDeviceService({ appDir, enabled = false, serial: configuredSerial = '',
  outputDir = join(tmpdir(), 'inklab-device-runs'), execute = exec, vision = createVisionOcr(),
  deviceConfig = readDeviceConfig(appDir), profile = deviceConfig.profile || 'generic',
  controlScript = resolve(appDir, deviceConfig.controlScript || 'scripts/glasses-control.mjs'),
  asrText = deviceConfig.asrText === true, now = Date.now,
  sleepFn = sleep, mirror } = {}) {
  const token = randomBytes(24).toString('hex');
  const artifacts = new Map();
  const runs = new Map();
  let serial = configuredSerial;
  let busy = false;
  let cancelled = false;
  const screenMirror = mirror || createDeviceMirror({ execute, now, inputBusy: () => busy });
  const output = resolve(outputDir);
  const capabilities = { asrText, ocr: false };

  async function devices() {
    if (!enabled) return [];
    const { stdout } = await execute(process.env.ADB || 'adb', ['devices', '-l'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    return parseAdbDevices(stdout);
  }
  async function checkedSerial() {
    const inventory = await devices();
    const selected = inventory.find((d) => d.serial === serial && d.state === 'device');
    if (!selected) throw new Error('请选择状态为 device 的已授权眼镜；离线或未授权设备不能执行');
    return serial;
  }
  async function command(args) {
    if (!enabled) throw new Error('真机服务未启用，请使用 --device 启动 InkLab');
    const chosen = await checkedSerial();
    if (!['key', 'say', 'capture', 'wake-assistant'].includes(args.command)) throw new Error('不支持的真机命令');
    if (args.command === 'say' && !capabilities.asrText) throw new Error('当前工程没有 ASR 文本调试适配器');
    if (args.command === 'say' && (typeof args.value !== 'string' || !args.value.trim()
      || Buffer.byteLength(args.value, 'utf8') > 180)) throw new Error('ASR 文本必须为 1–180 UTF-8 字节');
    if (args.command === 'key' && !['left', 'right', 'up', 'down', 'enter', 'back', 'wake'].includes(args.value)) throw new Error('不支持的按键');
    const waitMs = args.waitMs == null ? (args.command === 'say' ? 6000 : 900) : Number(args.waitMs);
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('waitMs 必须为 0–60000');
    const cliArgs = [controlScript, args.command];
    if (args.command === 'say' || args.command === 'key') cliArgs.push(args.value);
    cliArgs.push('--serial', chosen, '--wait-ms', String(waitMs));
    if (args.capturePath) cliArgs.push('--capture', args.capturePath);
    const { stdout } = await execute(process.execPath, cliArgs, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const receipt = JSON.parse(stdout);
    if (receipt.dispatched !== true) throw new Error('ADB 控制脚本未确认命令发送完成');
    return { serial: chosen, command: args.command, dispatched: receipt.dispatched === true,
      resultVerified: false, at: now(), note: receipt.note };
  }
  async function capture(name = 'screen', { ocr = false, runId = 'manual' } = {}) {
    const id = randomUUID();
    const dir = join(output, runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.png`);
    await command({ command: 'capture', waitMs: 0, capturePath: path });
    const data = await readFile(path);
    const meta = pngMetadata(data);
    const screenshot = { id, name: String(name).slice(0, 120), at: now(), serial,
      ...meta, source: 'adb-raw-png', modified: false, file: path,
      url: `/api/device/artifact/${id}` };
    if (ocr) screenshot.ocr = await vision.read(path);
    artifacts.set(id, { path, type: 'image/png' });
    return screenshot;
  }
  async function saveRecording(data, contentType) {
    if (!enabled) throw requestError('真机服务未启用，请使用 --device 启动 InkLab', 403);
    const mimeType = recordingType(contentType);
    if (!Buffer.isBuffer(data) || !data.length) throw requestError('录像为空');
    if (data.length > MAX_DEVICE_RECORDING_BYTES) throw requestError('录像超过 64 MiB', 413);
    const validHeader = mimeType === 'video/mp4'
      ? data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp'
      : data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3;
    if (!validHeader) throw requestError('录像容器头与 Content-Type 不匹配');
    const id = randomUUID();
    const filename = `inklab-real-glasses-${id}.${mimeType === 'video/mp4' ? 'mp4' : 'webm'}`;
    const dir = join(output, 'recordings');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const path = join(dir, filename);
    try { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
    catch (err) {
      if (err.code !== 'EEXIST') await rm(path, { force: true }).catch(() => {});
      throw err;
    }
    const result = { id, filename, path, url: `/api/device/artifact/${id}`, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), mimeType,
      source: 'browser-mediarecorder', at: now() };
    artifacts.set(id, { path, type: mimeType, filename });
    return result;
  }
  async function exclusive(action) {
    if (busy) throw Object.assign(new Error('真机正在执行另一个操作或场景'), { statusCode: 409 });
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function status() {
    const ocr = enabled ? await vision.status() : { available: false };
    capabilities.ocr = ocr.available;
    let inventory = [];
    let error = null;
    try { inventory = await devices(); } catch (err) { error = err.message; }
    return { enabled, token, serial, devices: inventory, busy, profile, capabilities: { ...capabilities },
      capabilityLevels: DEVICE_CAPABILITIES, ocr, outputDir: output, error,
      recentRuns: [...runs.values()].slice(-10).reverse().map((r) => ({ id: r.id, scenarioId: r.scenarioId, status: r.status })),
      mirror: screenMirror.snapshot(),
      startup: '接上已授权 USB，保持手机连接并手动打开一次 AIUI 沉浸应用；InkLab 不自动下载安装包' };
  }
  async function scenarios() {
    const list = await loadDeviceScenarios(appDir);
    return list.map((scene) => ({ ...scene, support: scene.error
      ? { supported: false, reasons: [scene.error] } : deviceScenarioSupport(scene, capabilities) }));
  }
  async function startRun(id) {
    if (busy) throw Object.assign(new Error('真机正忙，请等待当前操作或停止场景'), { statusCode: 409 });
    const scene = (await loadDeviceScenarios(appDir)).find((s) => s.id === id);
    if (!scene) throw new Error('没有这个真机场景');
    const runId = `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const current = { id: runId, scenarioId: id, status: 'running', events: [], report: null };
    runs.set(runId, current);
    busy = true;
    cancelled = false;
    const driver = createDeviceDriver({ command,
      capture: (name, opts) => capture(name, { ...opts, runId }), capabilities,
      now, sleep: sleepFn, shouldStop: () => cancelled,
      onStep: (event) => { current.events.push(event); },
    });
    // The request returns immediately; one local run owns the device until finally.
    current.promise = (async () => {
      try {
        const report = await driver.runScenario(scene);
        current.report = { ...report, id: runId, serial, profile,
          package: { verification: 'not-observed-by-inklab', note: '本机源码不证明眼镜已安装同一包；以实际设备安装日志或人工核验为准' } };
        const directory = join(output, runId);
        await mkdir(directory, { recursive: true });
        const path = join(directory, 'run.json');
        await writeFile(path, JSON.stringify(current.report, null, 2));
        current.reportFile = path;
        current.status = report.status;
      } catch (err) {
        current.status = 'failed';
        current.error = err.message;
      } finally { busy = false; }
    })();
    return { id: runId, status: current.status };
  }
  function run(id) {
    const current = runs.get(id);
    if (!current) throw new Error('没有这个运行记录');
    const { promise: _promise, ...publicRun } = current;
    return publicRun;
  }
  return { token, status, scenarios, run, startRun, artifacts, saveRecording,
    mirror: {
      async start(options) { return screenMirror.start(await checkedSerial(), options); },
      stop: () => screenMirror.stop(), snapshot: () => screenMirror.snapshot(),
      subscribe: (id, res) => screenMirror.subscribe(id, res),
    },
    async select(value) {
      if (busy) throw Object.assign(new Error('运行期间不能更换设备'), { statusCode: 409 });
      if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('无效设备序列号');
      const inventory = await devices();
      if (!inventory.some((d) => d.serial === value && d.state === 'device')) throw new Error('设备未连接或尚未授权 USB 调试');
      if (value !== serial) await screenMirror.stop();
      serial = value;
      return { serial };
    },
    manual(args) { return exclusive(() => command(args)); },
    screenshot(name, options) { return exclusive(() => capture(name, options)); },
    cancel() { cancelled = true; return { requested: true, note: '当前 ADB 命令结束后停止，不执行后续步骤' }; },
    async close() { cancelled = true; await screenMirror.close(); await Promise.allSettled([...runs.values()].map((r) => r.promise)); },
  };
}

export function createDeviceHandler(service, { recordingMaxBytes = MAX_DEVICE_RECORDING_BYTES, recordingTimeoutMs = 30000 } = {}) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/device/')) return false;
    try {
      // Block cross-origin requests and DNS rebinding before touching ADB or logs.
      const expected = `http://${req.headers.host}`;
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')
        || (req.headers.origin && req.headers.origin !== expected)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        json(res, 403, { error: 'InkLab 真机接口只允许本机同源调用' }); return true;
      }
      const route = url.pathname.slice('/api/device/'.length);
      if (req.method === 'GET' && route === 'status') { json(res, 200, await service.status()); return true; }
      if (req.headers['x-inklab-device-token'] !== service.token && !route.startsWith('artifact/') && !route.startsWith('mirror/events/')) {
        json(res, 403, { error: '真机 session token 无效，请刷新页面' }); return true;
      }
      if (req.method === 'GET' && route === 'scenarios') { json(res, 200, await service.scenarios()); return true; }
      if (req.method === 'GET' && route === 'mirror/status') { json(res, 200, service.mirror.snapshot()); return true; }
      if (req.method === 'GET' && route.startsWith('mirror/events/')) { service.mirror.subscribe(route.slice('mirror/events/'.length), res); return true; }
      if (req.method === 'GET' && route.startsWith('run/')) { json(res, 200, service.run(route.slice(4))); return true; }
      if (req.method === 'GET' && route.startsWith('artifact/')) {
        const artifact = service.artifacts.get(route.slice(9));
        if (!artifact) { json(res, 404, { error: '没有这份素材' }); return true; }
        res.writeHead(200, { 'content-type': artifact.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          ...(artifact.filename ? { 'content-disposition': `inline; filename="${artifact.filename}"` } : {}) });
        res.end(await readFile(artifact.path)); return true;
      }
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
      if (route === 'recording') {
        const type = recordingType(req.headers['content-type']);
        const data = await readRecordingBody(req, { maxBytes: Math.min(recordingMaxBytes, MAX_DEVICE_RECORDING_BYTES), timeoutMs: recordingTimeoutMs });
        json(res, 201, await service.saveRecording(data, type)); return true;
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('需要 application/json');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) throw new Error('请求过大');
        chunks.push(chunk);
      }
      const args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let result;
      if (route === 'select') result = await service.select(args.serial);
      else if (route === 'command') result = await service.manual({ command: args.command, value: args.value, waitMs: args.waitMs });
      else if (route === 'capture') result = await service.screenshot(args.name, { ocr: args.ocr === true });
      else if (route === 'run') result = await service.startRun(args.id);
      else if (route === 'stop') result = service.cancel();
      else if (route === 'mirror/start') result = await service.mirror.start({ keepAwake: args.keepAwake !== false });
      else if (route === 'mirror/stop') result = await service.mirror.stop();
      else { json(res, 404, { error: 'unknown route' }); return true; }
      json(res, 200, result);
    } catch (err) {
      // Do not keep accepting a slow/oversized upload after its early rejection.
      if (req.method === 'POST' && url.pathname === '/api/device/recording' && !req.complete) {
        res.setHeader('connection', 'close');
      }
      if (!res.destroyed) json(res, err.statusCode || 400, { error: err.message || String(err) });
    }
    return true;
  };
}
