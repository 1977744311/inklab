import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, access, chmod, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createDeviceDriver, deviceScenarioSupport, DEVICE_CAPABILITIES } from './device-driver.mjs';
import { createDeviceMirror } from './device-mirror.mjs';
import { adbShell, deviceWarnings, readDeviceInfo } from './device-info.mjs';
import { createDeviceLogs, isNetworkSerial, notableLogs } from './device-logs.mjs';
import { GESTURES, KEY_TO_GESTURE, gestureDurationMs, gestureScript, profileById } from './device-input.mjs';
import {
  buildPackage, closeAssistant, firstPageOf, installAgent, listDeveloperAgents, openAgent, projectSlug, readProjectAgent,
  waitForFirstFrame, withDeveloperMode,
} from './device-agent.mjs';
import { createImuControl, imuAgent } from './device-imu.mjs';
import { stageImuBuild } from './imu-build.mjs';
import { acceptWebSocket } from './ws-lite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
export function readDeviceConfig(appDir) {
  try { return JSON.parse(readFileSync(join(appDir, 'inklab.device.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}; throw error; }
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ADB_KEYS = { left: '21', right: '22', up: '19', down: '20', enter: '66', back: '4', wake: '224' };
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

/**
 * 只有一台眼镜时该用哪个序列号。无线调试开着又插着线，adb devices 里同一台会出现两行（USB 和 host:port）：
 * 把网络那行按 ro.serialno 对回去，确认是同一台就用网络连接（录制中途拔线也不断）。
 * @returns {Promise<string|null>} 多台不同的设备时为 null。
 */
export async function soleDeviceSerial(ready, { execute = exec } = {}) {
  if (ready.length === 1) return ready[0].serial;
  const network = ready.filter((d) => isNetworkSerial(d.serial));
  if (!network.length) return null;
  const ids = new Set();
  for (const d of ready) {
    if (!isNetworkSerial(d.serial)) { ids.add(d.serial); continue; }
    const id = (await adbShell(execute, d.serial, 'getprop ro.serialno', { timeout: 5000 }).catch(() => '')).trim();
    ids.add(id || d.serial);
  }
  return ids.size === 1 ? network[0].serial : null;
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

/**
 * 模拟器的 .mjs 场景也拿来在真机上跑：调用 build() 拿到步骤，原样交给真机驱动。
 * 能在真机上做的只有按键（方向键按触控板手势做）、等待、截图、长按唤醒；
 * 用到 do / expect 函数、模拟硬件的场景会被标成不支持并说明原因，不会去猜它想观测什么。
 */
const hookedRoots = new Set();
/** 让 Node 认得场景里的 /app/… 引入（每个应用目录注册一次）。 */
async function mapAppImports(appDir) {
  // 用真实路径：模块的 parentURL 是解析过软链的（macOS 的临时目录在 /private 下）。
  const root = pathToFileURL(`${realpathSync(resolve(appDir))}/`).href;
  if (hookedRoots.has(root)) return;
  hookedRoots.add(root);
  const { register } = await import('node:module');
  register(new URL('./scenario-hooks.mjs', import.meta.url), { data: { roots: [root] } });
}

export async function loadSimulatorScenarios(appDir, { timeoutMs = 3000 } = {}) {
  const directory = join(appDir, 'e2e/scenarios');
  let files;
  try { files = (await readdir(directory)).filter((f) => /^[\w.-]+\.mjs$/.test(f)).sort(); } catch { return []; }
  const out = [];
  if (files.length) await mapAppImports(appDir);
  for (const file of files) {
    const path = join(directory, file);
    try {
      const { mtimeMs } = await (await import('node:fs/promises')).stat(path);
      const mod = await import(`${pathToFileURL(path).href}?t=${Math.round(mtimeMs)}`);
      const scene = mod.default || {};
      if (!scene.id || !/^[\w.-]+$/.test(String(scene.id))) throw new Error('缺少合法的 id');
      const built = typeof scene.build === 'function'
        ? await Promise.race([Promise.resolve().then(() => scene.build()), new Promise((_, reject) => setTimeout(() => reject(new Error('build() 超时')), timeoutMs))])
        : scene.steps;
      if (!Array.isArray(built)) throw new Error('build() 没有返回步骤数组');
      const steps = built.map((step) => (step && typeof step.shot === 'object' && step.shot && typeof step.shot.name === 'string'
        ? { ...step, shot: step.shot.name } : step));
      out.push({ id: String(scene.id), title: scene.title || scene.id, summary: scene.summary,
        source: 'project-simulator', file: `e2e/scenarios/${file}`, device: { readOnly: false, steps } });
    } catch (err) {
      const needsContext = /destructure|undefined/.test(err.message);
      out.push({ id: `invalid-${file}`, title: file, source: 'project-simulator',
        error: needsContext ? `build() 需要模拟器提供的上下文（${err.message}），不能直接在真机上跑`
          : `模拟器场景装载失败（${err.message}）；在真机上跑需要能在 Node 里直接调用 build()` });
    }
  }
  return out;
}

export async function loadDeviceScenarios(appDir) {
  const directory = join(appDir, 'e2e/device-scenarios');
  const scenarios = [];
  let files;
  try { files = await readdir(directory); } catch { return mergeSimulator(scenarios, appDir); }
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
  return mergeSimulator(scenarios, appDir);
}

/** 专门写的真机场景优先：同 id 的模拟器场景不再列出。 */
async function mergeSimulator(scenarios, appDir) {
  const taken = new Set(scenarios.map((s) => s.id));
  return [...scenarios, ...(await loadSimulatorScenarios(appDir)).filter((s) => !taken.has(s.id))];
}

/**
 * 同名截图配对成「模拟器 vs 真机」对照页（图片内嵌，单文件可直接打开）。
 * 模拟器那边先找截图基线（e2e/baselines/<场景>/<名>.png），没有再找最近一次报告（e2e/report/<场景>/<名>.png）。
 */
export async function writeCompareReport({ appDir, scenarioId, title, shots, directory }) {
  const latest = new Map();
  for (const shot of shots) latest.set(shot.name, shot);
  const rows = [];
  for (const [name, shot] of latest) {
    let simulator = null;
    for (const candidate of [join(appDir, 'e2e/baselines', scenarioId, `${name}.png`), join(appDir, 'e2e/report', scenarioId, `${name}.png`)]) {
      if (existsSync(candidate)) { simulator = candidate; break; }
    }
    rows.push({ name, simulator, device: shot.file });
  }
  const img = async (path) => (path ? `<img src="data:image/png;base64,${(await readFile(path)).toString('base64')}" alt="">` : '<p class="missing">模拟器没有这张图（先在模拟器跑一次场景，或接受基线）</p>');
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const body = [];
  for (const row of rows) body.push(`<tr><th>${esc(row.name)}</th><td>${await img(row.simulator)}</td><td>${await img(row.device)}</td></tr>`);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title || scenarioId)} · 模拟器 vs 真机</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}table{border-collapse:collapse}th,td{border:1px solid #333;padding:8px;vertical-align:top}
th{text-align:left;white-space:nowrap}img{max-width:360px;display:block}.missing{color:#a87;max-width:240px}</style></head>
<body><h1>${esc(title || scenarioId)}</h1><p>同名截图并排：左边模拟器（基线或最近一次报告），右边真机原图。真机上方向键按触控板手势执行（前滑同时发右和下）。</p>
<table><thead><tr><th>截图</th><th>模拟器</th><th>真机</th></tr></thead><tbody>${body.join('')}</tbody></table></body></html>`;
  const file = join(directory, 'compare.html');
  await writeFile(file, html);
  return { file, pairs: rows.filter((r) => r.simulator).length, missing: rows.filter((r) => !r.simulator).map((r) => r.name) };
}

export function createDeviceService({ appDir, enabled = false, serial: configuredSerial = '',
  outputDir = join(tmpdir(), 'inklab-device-runs'), execute = exec, vision = createVisionOcr(),
  deviceConfig = readDeviceConfig(appDir), profile = deviceConfig.profile || 'generic',
  controlScript = deviceConfig.controlScript && resolve(appDir, deviceConfig.controlScript),
  asrText = deviceConfig.asrText === true, now = Date.now,
  sleepFn = sleep, mirror, agentConfig = {}, runtimeMatcher = null, autoPush = agentConfig.autoPush !== false,
  build = buildPackage, log = () => {}, logStream, hostPort = () => 0 } = {}) {
  const token = randomBytes(24).toString('hex');
  const artifacts = new Map();
  const runs = new Map();
  let serial = configuredSerial;
  let busy = false;
  let cancelled = false;
  const screenMirror = mirror || createDeviceMirror({ execute, now, inputBusy: () => busy });
  const output = resolve(outputDir);
  const adapterPath = controlScript || resolve(appDir, 'scripts/glasses-control.mjs');
  const hasAdapter = Boolean(controlScript || asrText || existsSync(adapterPath));
  const capabilities = { asrText, ocr: false, wakeAssistant: hasAdapter };
  let info = null; // 选中设备的识别结果：{ serial, at, value }
  let pushEnabled = autoPush;
  let pushState = { status: 'idle' };
  let pushPending = false;
  let lastPage = null;
  const logs = logStream || createDeviceLogs();
  const imu = createImuControl({ appDir, logs, now, mode: agentConfig.imu });
  const reversed = new Set(); // 「serial port」：实时模式下做过的 adb reverse，关服务时撤掉

  async function deviceInfo({ force = false } = {}) {
    if (!enabled || !serial) return null;
    if (!force && info && info.serial === serial && now() - info.at < 15000) return info.value;
    const value = await readDeviceInfo({ serial, execute });
    info = { serial, at: now(), value };
    capabilities.wakeAssistant = hasAdapter || Boolean(value.touchpad);
    return value;
  }
  function projectAgent() {
    try { return { agent: readProjectAgent(appDir, agentConfig) }; } catch (err) { return { error: err.message }; }
  }
  function appPages() {
    try { return JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')).pages || []; } catch { return []; }
  }
  /** 在真机上做一个手势：有触控板档案就写原始事件，没有就退回 input keyevent。 */
  async function gesture(chosen, name, { holdMs } = {}) {
    if (!GESTURES.includes(name)) throw new Error(`不支持的手势：${name}`);
    const touchpad = (await deviceInfo())?.touchpad;
    await adbShell(execute, chosen, gestureScript(profileById(touchpad?.profile), name, { path: touchpad?.path, holdMs }),
      { timeout: 15000 + gestureDurationMs(name, { holdMs }) });
    return touchpad ? 'touchpad' : 'keyevent';
  }

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
    if (!['key', 'say', 'capture', 'wake-assistant', 'gesture'].includes(args.command)) throw new Error('不支持的真机命令');
    if (args.command === 'say' && !capabilities.asrText) throw new Error('当前工程没有 ASR 文本调试适配器');
    if (args.command === 'say' && (typeof args.value !== 'string' || !args.value.trim()
      || Buffer.byteLength(args.value, 'utf8') > 180)) throw new Error('ASR 文本必须为 1–180 UTF-8 字节');
    if (args.command === 'key' && (typeof args.value !== 'string' || !Object.hasOwn(ADB_KEYS, args.value))) throw new Error('不支持的按键');
    const waitMs = args.waitMs == null ? (args.command === 'say' ? 6000 : 900) : Number(args.waitMs);
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('waitMs 必须为 0–60000');
    let receipt;
    const touchpad = args.command === 'gesture' || args.command === 'key' || args.command === 'wake-assistant'
      ? (await deviceInfo())?.touchpad : null;
    if (args.command === 'gesture' || (touchpad && (args.command === 'key' || args.command === 'wake-assistant'))) {
      // 真触控板手势：方向键、确认、返回按触控板上对应的手势做；长按唤醒不再需要应用适配器。
      const name = args.command === 'gesture' ? args.value
        : args.command === 'wake-assistant' ? 'long-press' : KEY_TO_GESTURE[args.value];
      const via = await gesture(chosen, name, { holdMs: args.holdMs });
      if (waitMs) await sleepFn(waitMs);
      if (args.capturePath) {
        const { stdout } = await execute(process.env.ADB || 'adb', ['-s', chosen, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        await writeFile(args.capturePath, stdout);
      }
      receipt = { dispatched: true, note: via === 'touchpad' ? `触控板手势 ${name}` : `input keyevent（没有触控板档案）· ${name}` };
    } else if (hasAdapter) {
      const cliArgs = [adapterPath, args.command];
      if (args.command === 'say' || args.command === 'key') cliArgs.push(args.value);
      cliArgs.push('--serial', chosen, '--wait-ms', String(waitMs));
      if (args.capturePath) cliArgs.push('--capture', args.capturePath);
      const { stdout } = await execute(process.execPath, cliArgs, { timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      receipt = JSON.parse(stdout);
    } else {
      const adb = process.env.ADB || 'adb';
      if (args.command === 'wake-assistant') throw new Error('当前工程没有真机长按唤醒适配器');
      if (args.command === 'capture' && !args.capturePath) throw new Error('请通过截图接口截取真机原图');
      if (args.command === 'key') await execute(adb, ['-s', chosen, 'shell', 'input', 'keyevent', ADB_KEYS[args.value]], { timeout: 10000 });
      if (waitMs) await sleepFn(waitMs);
      if (args.capturePath) {
        const { stdout } = await execute(adb, ['-s', chosen, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        await writeFile(args.capturePath, stdout);
      }
      receipt = { dispatched: true };
    }
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
    try { return await action(); } finally { busy = false; queueMicrotask(() => { drainPending().catch(() => {}); }); }
  }
  async function status() {
    const ocr = enabled ? await vision.status() : { available: false };
    capabilities.ocr = ocr.available;
    let inventory = [];
    let error = null;
    try { inventory = await devices(); } catch (err) { error = err.message; }
    let device = null;
    let deviceError = null;
    try { device = await deviceInfo(); } catch (err) { deviceError = `读取设备信息失败：${err.message}`; }
    const { agent, error: agentError } = projectAgent();
    return { enabled, token, serial, devices: inventory, busy, profile, capabilities: { ...capabilities },
      device, deviceError, warnings: device ? deviceWarnings(device) : [],
      runtimeMatch: device?.ink?.version && runtimeMatcher ? runtimeMatcher(device.ink.version) : null,
      agent, agentError, pages: appPages(), push: { ...pushState, auto: pushEnabled, pending: pushPending },
      imu: { settings: imu.settings(), recording: imu.recorder.stats() }, logStream: logs.state?.() || null,
      capabilityLevels: DEVICE_CAPABILITIES, ocr, outputDir: output, error,
      recentRuns: [...runs.values()].slice(-10).reverse().map((r) => ({ id: r.id, scenarioId: r.scenarioId, status: r.status })),
      mirror: screenMirror.snapshot(),
      startup: '接上已授权 USB 并选择设备；「推到真机」会打包、装上调试包并打开（保存源码时自动推送，可关闭）' };
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
    if (serial) logs.start(serial);
    const logMark = logs.mark();
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
        current.report = { ...report, id: runId, serial, profile, logs: notableLogs(logs.since(logMark), 200),
          package: { verification: 'not-observed-by-inklab', note: '本机源码不证明眼镜已安装同一包；以实际设备安装日志或人工核验为准' } };
        const directory = join(output, runId);
        await mkdir(directory, { recursive: true });
        if (scene.source === 'project-simulator' && report.shots?.length) {
          const compare = await writeCompareReport({ appDir, scenarioId: scene.id, title: scene.title, shots: report.shots, directory });
          const id = randomUUID();
          artifacts.set(id, { path: compare.file, type: 'text/html; charset=utf-8' });
          current.report.compare = { ...compare, url: `/api/device/artifact/${id}` };
        }
        const path = join(directory, 'run.json');
        await writeFile(path, JSON.stringify(current.report, null, 2));
        current.reportFile = path;
        current.status = report.status;
      } catch (err) {
        current.status = 'failed';
        current.error = err.message;
      } finally { busy = false; drainPending().catch(() => {}); }
    })();
    return { id: runId, status: current.status };
  }
  function run(id) {
    const current = runs.get(id);
    if (!current) throw new Error('没有这个运行记录');
    const { promise: _promise, ...publicRun } = current;
    return publicRun;
  }
  /**
   * 推到真机：打包 → 安装调试包 → 关掉助手（回收旧实例）→ 打开（还被挡着就做真双击让它退下，最多 4 次）→ 等第一帧 → 截图。
   * 关掉助手这一步：旧实例退回卡片后会一直在后台跑，只有助手整个关掉才销毁，所以每次推之前先关。
   * 全程独占设备；开发者模式按借用处理，用完恢复。
   */
  async function pushNow({ page, trigger = 'manual' } = {}) {
    const chosen = await checkedSerial();
    const { agent: baseAgent, error } = projectAgent();
    if (error) throw new Error(error);
    const imuMode = imu.settings().mode;
    const agent = imuAgent(baseAgent, imuMode);
    const target = page || lastPage || agentConfig.page || appPages()[0];
    if (!target) throw new Error('app.json 里没有页面，不知道打开哪一页');
    const started = now();
    const stage = (name) => { pushState = { ...pushState, stage: name }; log(`[device] ${name}`); };
    pushState = { status: 'running', trigger, startedAt: started, stage: '打包', agentId: agent.agentId, page: target, imu: imuMode };
    logs.start(chosen);
    const logMark = logs.mark();
    let pkg = null;
    let staged = null;
    try {
      const port = hostPort();
      const plan = await imu.buildPlan({ liveUrl: port ? imu.liveUrl(port) : '' });
      if (plan) {
        if (/\.aix$/i.test(appDir)) throw new Error('模拟 IMU 要从源码目录打包，.aix 包没法注入');
        stage('注入模拟 IMU');
        staged = await stageImuBuild(appDir, plan);
        pkg = await build(staged.dir, { execute, log: () => {}, name: projectSlug(appDir), debugBuild: true });
      } else {
        pkg = await build(appDir, { execute, log: () => {} });
      }
      if (imuMode === 'live') {
        // 眼镜上的 127.0.0.1:<port> 经 USB 转到这台电脑上的 InkLab。
        await execute(process.env.ADB || 'adb', ['-s', chosen, 'reverse', `tcp:${port}`, `tcp:${port}`], { timeout: 10000 });
        reversed.add(`${chosen} ${port}`);
      }
      stage('安装');
      const result = await withDeveloperMode(execute, chosen, async () => {
        const installed = await installAgent({ execute, serial: chosen, aixPath: pkg.aixPath, md5: pkg.md5, agent, wait: sleepFn });
        await adbShell(execute, chosen, 'input keyevent 224');
        const touchpad = (await deviceInfo())?.touchpad;
        stage('关掉助手，回收旧实例');
        const reclaimed = await closeAssistant({ execute, serial: chosen, touchpad, wait: sleepFn });
        stage('打开');
        const opened = await openAgent({ execute, serial: chosen, agentId: agent.agentId, page: target, wait: sleepFn,
          bringToFront: true, touchpad });
        if (opened.presented) {
          stage('等第一帧');
          opened.firstFrame = await waitForFirstFrame({ execute, serial: chosen, agentId: agent.agentId, since: opened.since, wait: sleepFn });
        }
        return { installed, reclaimed, opened };
      });
      lastPage = target;
      stage('截图');
      await sleepFn(600);
      // 黑屏或只有系统提示的帧很小（实测 3–8 KB，画出来的画面 40 KB 起）：还没画出来就再等等重拍。
      let screenshot = await capture(`push-${agent.agentId}`, { runId: 'push' });
      for (let i = 0; i < 6 && result.opened.presented && screenshot.bytes < 12000; i += 1) {
        await sleepFn(800);
        screenshot = await capture(`push-${agent.agentId}`, { runId: 'push' });
      }
      imu.installedAs(imuMode);
      pushState = { status: result.opened.presented ? 'done' : 'queued', trigger, startedAt: started, finishedAt: now(),
        agentId: agent.agentId, agentName: agent.agentName, page: target, md5: pkg.md5, bytes: pkg.bytes, imu: imuMode,
        ...(staged ? { injected: staged.transformed } : {}),
        installed: { fileMd5: result.installed.fileMd5, outcome: result.installed.outcome, publishState: result.installed.publishState },
        reclaimed: result.reclaimed, opened: result.opened, screenshot, logs: notableLogs(logs.since(logMark), 30),
        note: [result.reclaimed.note, result.opened.note].filter(Boolean).join('；')
          || '本机调试安装（开发者接口 apply，和 aix install 同一协议），不代表 Studio 已发布' };
      return pushState;
    } catch (err) {
      pushState = { status: 'failed', trigger, startedAt: started, finishedAt: now(), agentId: agent.agentId, page: target,
        stage: pushState.stage, error: err.message };
      throw err;
    } finally {
      await pkg?.cleanup?.().catch(() => {});
      await staged?.cleanup?.().catch(() => {});
    }
  }
  async function drainPending() {
    while (pushPending && pushEnabled && !busy && serial) {
      pushPending = false;
      busy = true;
      try { await pushNow({ trigger: 'save' }); } catch { /* 状态里已记下失败原因 */ } finally { busy = false; }
    }
  }
  /** 源码变了：开着「保存即推送」就排一次推送；正忙就等手头的操作结束再推（多次保存合成一次）。 */
  function sourceChanged() {
    if (!enabled || !pushEnabled || !serial || /\.aix$/i.test(appDir)) return false;
    pushPending = true;
    drainPending().catch(() => {});
    return true;
  }

  return { token, status, scenarios, run, startRun, artifacts, saveRecording, sourceChanged,
    push(args = {}) { return exclusive(() => pushNow({ page: args.page })); },
    async open(args = {}) {
      return exclusive(async () => {
        const chosen = await checkedSerial();
        const { agent: project, error } = projectAgent();
        if (error && !args.agentId) throw new Error(error);
        const agent = project || { agentId: '' };
        const other = args.agentId && args.agentId !== agent.agentId;
        const page = args.page || (other ? await firstPageOf({ execute, serial: chosen, agentId: args.agentId })
          : lastPage || agentConfig.page || appPages()[0]);
        return withDeveloperMode(execute, chosen, async () => {
          await adbShell(execute, chosen, 'input keyevent 224');
          const touchpad = (await deviceInfo())?.touchpad;
          const target = args.agentId || agent.agentId;
          const reclaimed = await closeAssistant({ execute, serial: chosen, touchpad, wait: sleepFn });
          const opened = await openAgent({ execute, serial: chosen, agentId: target, page, wait: sleepFn, bringToFront: true, touchpad });
          if (!other) lastPage = page;
          return { ...opened, page, reclaimed, ...(reclaimed.note && !opened.note ? { note: reclaimed.note } : {}) };
        });
      });
    },
    /** 退出：把助手整个关掉回到桌面，助手里的实例（包括推送留下的旧实例）一起销毁。 */
    exit() {
      return exclusive(async () => {
        const result = await closeAssistant({ execute, serial: await checkedSerial(), touchpad: (await deviceInfo())?.touchpad, wait: sleepFn });
        return { left: result.closed, ...result,
          ...(result.closed ? { note: result.already ? '助手本来就没开' : `已关掉助手，销毁了 ${result.dropped} 个实例` } : {}) };
      });
    },
    async agents() { return listDeveloperAgents({ execute, serial: await checkedSerial() }); },
    setAutoPush(value) { pushEnabled = value === true; if (!pushEnabled) pushPending = false; return { auto: pushEnabled }; },
    info: (options) => deviceInfo(options),
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
      if (value !== serial) { await screenMirror.stop(); info = null; logs.stop(); }
      serial = value;
      return { serial };
    },
    manual(args) { return exclusive(() => command(args)); },
    screenshot(name, options) { return exclusive(() => capture(name, options)); },
    cancel() { cancelled = true; return { requested: true, note: '当前 ADB 命令结束后停止，不执行后续步骤' }; },
    logs: {
      subscribe(res) { if (serial) logs.start(serial); logs.subscribe(res); },
      recent: (n) => logs.recent(n),
    },
    imu: {
      status: () => imu.status(),
      traces: () => imu.listTraces(),
      setMode: (args) => imu.setMode(args),
      /** 开始收录制行（录制模式的包已经装好、应用开着时）。 */
      listen() { if (!enabled || !serial) throw new Error('先选一台设备'); logs.start(serial); return imu.recorder.stats(); },
      save: (args) => imu.saveRecording(args),
      followGuided: () => imu.followGuided(),
      mark: (label) => imu.mark(label),
      clear: () => imu.clearRecording(),
      live: (command) => imu.sendLive(command),
      /** serve.mjs 的 upgrade：真机调试包经 adb reverse 连进来。只认本机地址和本次会话的令牌。 */
      upgrade(req, socket, head, url) {
        const token = url.pathname.slice('/api/device/imu/live/'.length);
        if (!enabled || token !== imu.token || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        const conn = acceptWebSocket(req, socket, head);
        if (conn) imu.attachLive(conn);
      },
      loadTrace: (name) => imu.loadTrace(name),
    },
    async close() {
      cancelled = true; logs.close(); imu.close(); await screenMirror.close();
      for (const entry of reversed) {
        const [device, port] = entry.split(' ');
        await execute(process.env.ADB || 'adb', ['-s', device, 'reverse', '--remove', `tcp:${port}`], { timeout: 5000 }).catch(() => {});
      }
      await Promise.allSettled([...runs.values()].map((r) => r.promise));
    },
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
      if (req.method === 'GET' && route.startsWith('logs/events/')) {
        if (route.slice('logs/events/'.length) !== service.token) { json(res, 403, { error: '真机 session token 无效，请刷新页面' }); return true; }
        service.logs.subscribe(res); return true;
      }
      if (req.headers['x-inklab-device-token'] !== service.token && !route.startsWith('artifact/') && !route.startsWith('mirror/events/')) {
        json(res, 403, { error: '真机 session token 无效，请刷新页面' }); return true;
      }
      if (req.method === 'GET' && route === 'scenarios') { json(res, 200, await service.scenarios()); return true; }
      if (req.method === 'GET' && route === 'mirror/status') { json(res, 200, service.mirror.snapshot()); return true; }
      if (req.method === 'GET' && route === 'agents') { json(res, 200, await service.agents()); return true; }
      if (req.method === 'GET' && route === 'imu') { json(res, 200, await service.imu.status()); return true; }
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
      else if (route === 'command') result = await service.manual({ command: args.command, value: args.value, waitMs: args.waitMs, holdMs: args.holdMs });
      else if (route === 'push') result = await service.push({ page: args.page });
      else if (route === 'open') result = await service.open({ page: args.page, agentId: args.agentId });
      else if (route === 'exit') result = await service.exit();
      else if (route === 'auto-push') result = service.setAutoPush(args.enabled);
      else if (route === 'imu/mode') result = await service.imu.setMode(args);
      else if (route === 'imu/listen') result = service.imu.listen();
      else if (route === 'imu/save') result = await service.imu.save(args);
      else if (route === 'imu/mark') result = service.imu.mark(args.label);
      else if (route === 'imu/clear') result = service.imu.clear();
      else if (route === 'imu/live') result = await service.imu.live(args);
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
