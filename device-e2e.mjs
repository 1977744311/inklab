#!/usr/bin/env node
import { realpathSync as cliRealpath } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceService } from './lib/device-service.mjs';

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
    throw new Error('Usage: device-e2e.mjs <app-dir> --serial SN --scenario ID [--scenario ID] [--out DIR] | <app-dir> --list');
  }
  return opts;
}

export async function main(argv) {
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

if (process.argv[1] && cliRealpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`[device] ${err.message}`); process.exitCode = 1; });
}
