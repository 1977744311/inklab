import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceService, parseAdbDevices } from './device-service.mjs';
import { readAppConfig } from './app-config.mjs';
import { readRuntimeLock } from './runtime-lock-file.mjs';
import { GESTURES } from './device-input.mjs';
import { matchDeviceRuntime, normalizeRuntimeRegistry } from '../runtime-lock.mjs';
import { USAGE } from './cli-meta.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SUBCOMMANDS = ['info', 'push', 'open', 'exit', 'gesture', 'agents', 'imu-record', 'imu-guide'];
const IMU_MODE_ARGS = ['real', 'replay', 'live', 'record'];

export function parseDeviceArgs(argv) {
  const opts = { input: '', serial: '', output: '', scenarios: [], list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--serial') opts.serial = argv[++i];
    else if (argv[i] === '--out') opts.output = argv[++i];
    else if (argv[i] === '--scenario') opts.scenarios.push(argv[++i]);
    else if (argv[i] === '--list') opts.list = true;
    else if (!opts.input && !argv[i].startsWith('--')) opts.input = argv[i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!opts.input || (!opts.list && (!opts.serial || !opts.scenarios.length))) {
    throw new Error(USAGE['inklab-device']);
  }
  return opts;
}

/** inklab-device <子命令> …：info / push / open / exit / gesture / agents。 */
export function parseSubcommand(argv) {
  const [command, ...rest] = argv;
  const opts = { command, serial: '', page: '', input: '', agent: '', gesture: '', holdMs: undefined, json: false,
    imu: '', trace: '', loop: false, name: '', seconds: undefined, note: '', overwrite: false, push: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--serial') opts.serial = rest[++i] || '';
    else if (arg === '--page') opts.page = rest[++i] || '';
    else if (arg === '--agent') opts.agent = rest[++i] || '';
    else if (arg === '--hold-ms') opts.holdMs = Number(rest[++i]);
    else if (arg === '--json') opts.json = true;
    else if (arg === '--imu') opts.imu = rest[++i] || '';
    else if (arg === '--trace') opts.trace = rest[++i] || '';
    else if (arg === '--loop') opts.loop = true;
    else if (arg === '--name') opts.name = rest[++i] || '';
    else if (arg === '--seconds') opts.seconds = Number(rest[++i]);
    else if (arg === '--note') opts.note = rest[++i] || '';
    else if (arg === '--overwrite') opts.overwrite = true;
    else if (arg === '--push') opts.push = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else if (command === 'gesture' && !opts.gesture) opts.gesture = arg;
    else if (!opts.input) opts.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (command === 'push' && !opts.input) throw new Error('用法: inklab-device push <应用目录|包.aix> [--page pages/x/index] [--serial SN]');
  if (command === 'open' && !opts.input && !opts.agent) throw new Error('用法: inklab-device open <应用目录> | --agent <agentId> [--page pages/x/index] [--serial SN]');
  if (command === 'gesture' && !GESTURES.includes(opts.gesture)) throw new Error(`用法: inklab-device gesture <${GESTURES.join('|')}> [--hold-ms 1000] [--serial SN]`);
  if (opts.imu && !IMU_MODE_ARGS.includes(opts.imu)) throw new Error(`--imu 只能是 ${IMU_MODE_ARGS.join(' / ')}`);
  if (opts.imu === 'replay' && !opts.trace) throw new Error('用法: inklab-device push <应用目录> --imu replay --trace <轨迹名[#段落]> [--loop]');
  if (opts.imu === 'live') throw new Error('实时模式要在工作台里用（inklab <应用目录> --device）：设备得连回一个一直开着的 InkLab');
  if (command === 'imu-record' && (!opts.input || !opts.name)) {
    throw new Error('用法: inklab-device imu-record <应用目录> --name <轨迹名> [--seconds 30] [--push] [--note 说明] [--overwrite]');
  }
  if (opts.seconds !== undefined && !(opts.seconds > 0)) throw new Error('--seconds 必须是正数');
  return opts;
}

async function onlySerial(given, execute) {
  if (given) return given;
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const run = execute || promisify(execFile);
  const { stdout } = await run(process.env.ADB || 'adb', ['devices', '-l'], { timeout: 10000 });
  const ready = parseAdbDevices(stdout).filter((d) => d.state === 'device');
  if (ready.length !== 1) throw new Error(ready.length ? `连着 ${ready.length} 台设备，请用 --serial 指定` : '没有已授权的 USB 设备');
  return ready[0].serial;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

/** 等录制：到秒数、引导录制结束、或 Ctrl-C；期间把进度打到 stderr。 */
async function collect(service, { seconds, untilFinished = false, label = '' } = {}) {
  let stop = false;
  const onSigint = () => { stop = true; console.error('\n[imu] 收到 Ctrl-C，保存已经录到的部分'); };
  process.on('SIGINT', onSigint);
  const started = Date.now();
  let shown = '';
  try {
    while (!stop) {
      const stats = (await service.status()).imu.recording;
      const sensors = Object.entries(stats.sensors).map(([n, v]) => `${n} ${v.samples}`).join(' · ') || '还没收到数据';
      const line = untilFinished
        ? `[imu] ${label}已录段落 ${stats.segments.length}${stats.plan ? `/${stats.plan.length}` : ''}${stats.recording ? ` · 正在录 ${stats.recording}` : ''} · ${sensors}`
        : `[imu] ${label}${Math.round((Date.now() - started) / 1000)}s · ${sensors}`;
      if (line !== shown) { console.error(line); shown = line; }
      if (untilFinished && stats.finished) break;
      if (seconds && Date.now() - started >= seconds * 1000) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally { process.off('SIGINT', onSigint); }
}

/** inklab-device imu-guide [工程目录]：推引导录制包，逐段录完存到 <工程>/e2e/traces/。 */
async function runGuide(opts) {
  const serial = await onlySerial(opts.serial);
  const target = resolve(opts.input || process.cwd());
  if (!existsSync(target)) throw new Error(`没有这个目录：${target}`);
  const recorderDir = join(ROOT, 'fixtures', 'imu-recorder');
  const config = await readAppConfig(recorderDir);
  const service = createDeviceService({ appDir: recorderDir, enabled: true, serial, agentConfig: config.device || {}, autoPush: false,
    log: (line) => console.error(line) });
  try {
    await service.select(serial);
    const info = await service.info().catch(() => null);
    console.error('[imu] 推引导录制包到眼镜…');
    service.imu.followGuided();
    const pushed = await service.push({});
    if (pushed.status !== 'done') console.error(`[imu] 引导录制包没显示到前台（${pushed.note || pushed.status}）：在眼镜上手动打开「IMU 引导录制」`);
    console.error('[imu] 戴上眼镜，按屏幕提示逐段录：单击开始一段，向前滑跳过，向后滑重录上一段，双击退出');
    await collect(service, { untilFinished: true });
    const name = opts.name || `guided-${stamp()}`;
    const saved = await service.imu.save({ name, dir: join(target, 'e2e', 'traces'), source: 'guided', note: opts.note,
      overwrite: opts.overwrite, device: info ? { model: info.model, ink: info.ink?.version || null } : null });
    console.log(JSON.stringify(saved, null, 2));
    return 0;
  } finally { await service.close(); }
}

async function runSubcommand(opts) {
  if (opts.command === 'imu-guide') return runGuide(opts);
  const serial = await onlySerial(opts.serial);
  const appDir = opts.input ? resolve(opts.input) : process.cwd();
  const config = opts.input && !/\.aix$/i.test(appDir) ? await readAppConfig(appDir) : {};
  const registry = normalizeRuntimeRegistry(await readRuntimeLock(join(ROOT, 'runtimes.lock.json')), { allowEmpty: true });
  const service = createDeviceService({ appDir, enabled: true, serial, agentConfig: config.device || {},
    runtimeMatcher: (version) => matchDeviceRuntime(version, registry.runtimes),
    log: (line) => console.error(line) });
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  try {
    await service.select(serial);
    if (opts.command === 'info') {
      const status = await service.status();
      print({ serial, device: status.device, warnings: status.warnings, simulatorRuntime: status.runtimeMatch });
      return status.warnings.some((w) => w.level === 'warn') ? 2 : 0;
    }
    if (opts.command === 'agents') { print(await service.agents()); return 0; }
    if (opts.command === 'gesture') { print(await service.manual({ command: 'gesture', value: opts.gesture, waitMs: 0, holdMs: opts.holdMs })); return 0; }
    if (opts.command === 'exit') { const r = await service.exit(); print(r); return r.left ? 0 : 2; }
    if (opts.command === 'open') { const r = await service.open({ page: opts.page, agentId: opts.agent || undefined }); print(r); return r.presented ? 0 : 2; }
    if (opts.command === 'imu-record') {
      if (opts.push) {
        await service.imu.setMode({ mode: 'record' });
        const pushed = await service.push({ page: opts.page });
        console.error(`[imu] 已推录制模式的调试包（${pushed.agentName || ''}）${pushed.status === 'done' ? '' : `，但没显示到前台：${pushed.note || pushed.status}`}`);
      } else {
        service.imu.listen();
        console.error('[imu] 开始收录制行：眼镜上要开着「IMU 录制」模式的调试包（没有就加 --push）');
      }
      await collect(service, { seconds: opts.seconds });
      const info = await service.info().catch(() => null);
      const saved = await service.imu.save({ name: opts.name, note: opts.note, overwrite: opts.overwrite,
        device: info ? { model: info.model, ink: info.ink?.version || null } : null });
      print(saved);
      return 0;
    }
    if (opts.imu) await service.imu.setMode({ mode: opts.imu, trace: opts.trace, loop: opts.loop });
    const result = await service.push({ page: opts.page });
    print({ ...result, screenshot: result.screenshot?.file });
    return result.status === 'done' ? 0 : 2;
  } finally { await service.close(); }
}

export async function main(argv) {
  if (SUBCOMMANDS.includes(argv[0])) return runSubcommand(parseSubcommand(argv));
  const opts = parseDeviceArgs(argv);
  const service = createDeviceService({ appDir: resolve(opts.input), enabled: true,
    serial: opts.serial, ...(opts.output ? { outputDir: opts.output } : {}) });
  const status = await service.status();
  const scenes = await service.scenarios();
  if (opts.list) {
    console.log(JSON.stringify({ capabilities: status.capabilities, scenarios: scenes }, null, 2));
    return 0;
  }
  await service.select(opts.serial);
  let code = 0;
  try {
    for (const id of opts.scenarios) {
      if (!scenes.some((s) => s.id === id)) throw new Error(`Unknown device scenario: ${id}`);
      const started = await service.startRun(id);
      let seen = 0;
      let run;
      do {
        run = service.run(started.id);
        for (const event of run.events.slice(seen)) {
          if (event.phase === 'end') console.log(`[device] ${id} #${event.index + 1} ${event.label}: ${event.ok ? event.verification || 'dispatched' : event.reason}`);
        }
        seen = run.events.length;
        if (run.status === 'running') await new Promise((r) => setTimeout(r, 250));
      } while (run.status === 'running');
      console.log(JSON.stringify({ id, status: run.status, summary: run.report?.summary || run.error,
        report: run.reportFile, businessVerified: run.report?.businessVerified === true }));
      if (run.status === 'failed' || run.status === 'cancelled') code = 1;
      else if (run.status !== 'passed' && code === 0) code = 2;
      // A failed state is not a safe starting point for another scenario.
      if (run.status === 'failed' || run.status === 'cancelled') break;
    }
  } finally { await service.close(); }
  return code;
}
