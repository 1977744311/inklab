import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceService, parseAdbDevices } from './device-service.mjs';
import { readAppConfig } from './app-config.mjs';
import { readRuntimeLock } from './runtime-lock-file.mjs';
import { GESTURES } from './device-input.mjs';
import { matchDeviceRuntime, normalizeRuntimeRegistry } from '../runtime-lock.mjs';
import { USAGE } from './cli-meta.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SUBCOMMANDS = ['info', 'push', 'open', 'exit', 'gesture', 'agents'];

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
  const opts = { command, serial: '', page: '', input: '', agent: '', gesture: '', holdMs: undefined, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--serial') opts.serial = rest[++i] || '';
    else if (arg === '--page') opts.page = rest[++i] || '';
    else if (arg === '--agent') opts.agent = rest[++i] || '';
    else if (arg === '--hold-ms') opts.holdMs = Number(rest[++i]);
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else if (command === 'gesture' && !opts.gesture) opts.gesture = arg;
    else if (!opts.input) opts.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (command === 'push' && !opts.input) throw new Error('用法: inklab-device push <应用目录|包.aix> [--page pages/x/index] [--serial SN]');
  if (command === 'open' && !opts.input && !opts.agent) throw new Error('用法: inklab-device open <应用目录> | --agent <agentId> [--page pages/x/index] [--serial SN]');
  if (command === 'gesture' && !GESTURES.includes(opts.gesture)) throw new Error(`用法: inklab-device gesture <${GESTURES.join('|')}> [--hold-ms 1000] [--serial SN]`);
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

async function runSubcommand(opts) {
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
