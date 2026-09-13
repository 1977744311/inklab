#!/usr/bin/env node
// matrix.mjs — 同一输入/场景在多个锁定 runtime × 光照环境上逐 lane 取证并汇总差异。
// UI 负责“同时看”，本命令负责“同一条命令可重复跑、报告可 diff”。

import { realpathSync as cliRealpath } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRuntimeRegistry, runtimeDisplayVersion } from './lib/runtime-lock.mjs';
import { LIGHTING_PROFILES } from './lib/lighting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseMatrixArgs(argv) {
  const opts = {
    input: null, scenarios: [], runtimes: [], lighting: [], allLighting: false,
    out: null, video: false, llm: null, cassette: null, netGuard: true,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (arg === '--scenario') opts.scenarios.push(...String(next()).split(',').filter(Boolean));
    else if (arg === '--runtime') opts.runtimes.push(...String(next()).split(',').filter(Boolean));
    else if (arg === '--lighting') opts.lighting.push(...String(next()).split(',').filter(Boolean));
    else if (arg === '--all-lighting') opts.allLighting = true;
    else if (arg === '--out') opts.out = next();
    else if (arg === '--video') opts.video = true;
    else if (arg === '--llm') opts.llm = next();
    else if (arg === '--cassette') opts.cassette = next();
    else if (arg === '--no-netguard') opts.netGuard = false;
    else if (arg.startsWith('--')) throw new Error(`不认识的参数 ${arg}`);
    else rest.push(arg);
  }
  opts.input = rest[0] || null;
  opts.runtimes = [...new Set(opts.runtimes)];
  opts.lighting = [...new Set(opts.lighting)];
  return opts;
}

export function conformanceTable(runs) {
  const features = [...new Set((runs || []).flatMap((run) => (run.conformance || []).map((r) => r.feature)))].sort();
  return features.map((feature) => ({
    feature,
    values: Object.fromEntries(runs.map((run) => {
      const result = (run.conformance || []).find((item) => item.feature === feature);
      return [run.id, result?.status || 'not-observed'];
    })),
  }));
}

export function visualDiffs(runs) {
  const groups = new Map();
  for (const run of runs || []) {
    for (const shot of run.shots || []) {
      const key = `${run.lighting}\0${shot.scenario}\0${shot.name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ run: run.id, runtime: run.runtime, sha256: shot.sha256, bytes: shot.bytes });
    }
  }
  return [...groups.entries()].map(([key, samples]) => {
    const [lighting, scenario, name] = key.split('\0');
    return {
      lighting, scenario, name, samples,
      status: new Set(samples.map((sample) => sample.sha256)).size <= 1 ? 'same' : 'visual-changed',
    };
  });
}

function runChild(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(HERE, 'e2e.mjs'), ...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolveRun({ code: code ?? 1, signal: signal || null }));
  });
}

function markdownReport(report) {
  const ids = report.runs.map((run) => run.id);
  const lines = [
    '# InkLab runtime matrix', '',
    `- Input: \`${report.input}\``,
    `- Preview: \`${report.preview}\``,
    `- Generated: ${report.generatedAt}`,
    `- Result: ${report.ok ? 'PASS' : 'FAIL'}`,
    '', '## Conformance', '',
    `| Feature | ${ids.join(' | ')} |`,
    `| --- | ${ids.map(() => '---').join(' | ')} |`,
  ];
  for (const row of report.conformance) {
    lines.push(`| ${row.feature} | ${ids.map((id) => row.values[id]).join(' | ')} |`);
  }
  lines.push('', '## Visual evidence', '', '| Lighting | Scenario / shot | Result |', '| --- | --- | --- |');
  for (const row of report.visual) lines.push(`| ${row.lighting} | ${row.scenario} / ${row.name} | ${row.status} |`);
  lines.push('', '“visual-changed” 表示 PNG 内容哈希不同；它是差异报警，不等价于视觉回归判定。');
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const opts = parseMatrixArgs(argv);
  if (!opts.input) throw new Error('用法: node matrix.mjs <app-dir|package.aix> [--scenario id] [--runtime id] [--all-lighting]');
  const input = resolve(ROOT, opts.input);
  const lock = JSON.parse(await readFile(join(HERE, 'runtimes.lock.json'), 'utf8'));
  const registry = normalizeRuntimeRegistry(lock);
  const runtimeIds = opts.runtimes.length
    ? opts.runtimes
    : registry.runtimes.filter((runtime) => !runtime.cacheOnly).map((runtime) => runtime.id);
  const unknown = runtimeIds.filter((id) => !registry.runtimes.some((runtime) => runtime.id === id));
  if (unknown.length) throw new Error(`lock 里没有运行时：${unknown.join('、')}`);
  const lightingIds = opts.allLighting
    ? LIGHTING_PROFILES.map((profile) => profile.id)
    : (opts.lighting.length ? opts.lighting : ['absolute-dark']);
  const badLight = lightingIds.filter((id) => !LIGHTING_PROFILES.some((profile) => profile.id === id));
  if (badLight.length) throw new Error(`未知光照：${badLight.join('、')}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = opts.out ? resolve(ROOT, opts.out) : join(HERE, '.runs', `matrix-${basename(input, extname(input))}-${stamp}`);
  await mkdir(out, { recursive: true });
  const runs = [];

  for (const runtimeId of runtimeIds) {
    const runtime = registry.runtimes.find((row) => row.id === runtimeId);
    for (const lighting of lightingIds) {
      const id = `${runtimeId}@${lighting}`;
      const runDir = join(out, id);
      console.log(`\n[matrix] ▶ ${id} · ${runtimeDisplayVersion(runtime)}`);
      // 光照矩阵是 InkLab 的 optical 扩展；Studio 黑底是另一个明确的默认口径。
      const args = [
        input, '--runtime', runtimeId, '--preview', 'optical', '--lighting', lighting,
        '--report-dir', runDir, '--no-video',
      ];
      for (const scenario of opts.scenarios) args.push('--scenario', scenario);
      if (opts.video) args.splice(args.indexOf('--no-video'), 1);
      if (opts.llm) args.push('--llm', opts.llm);
      if (opts.cassette) args.push('--cassette', opts.cassette);
      if (!opts.netGuard) args.push('--no-netguard');
      const child = await runChild(args);
      let e2e = null;
      try { e2e = JSON.parse(await readFile(join(runDir, 'last-run.json'), 'utf8')); } catch { /* child failure may precede report */ }
      const shots = [];
      for (const scenario of e2e?.scenarios || []) {
        for (const rel of scenario.shots || []) {
          const path = resolve(runDir, rel);
          const bytes = await readFile(path).catch(() => null);
          if (bytes) shots.push({ scenario: scenario.id, name: basename(rel), path, bytes: bytes.length, sha256: sha256(bytes) });
        }
      }
      const conformance = (e2e?.scenarios || []).flatMap((scenario) => scenario.conformance?.results || []);
      runs.push({
        id, runtime: runtimeId, version: runtimeDisplayVersion(runtime), preview: 'optical', lighting,
        ok: child.code === 0 && e2e?.ok === true, exitCode: child.code, report: join(runDir, 'last-run.json'),
        conformance, shots,
      });
    }
  }

  const report = {
    schemaVersion: 1,
    input,
    preview: 'optical',
    generatedAt: new Date().toISOString(),
    ok: runs.every((run) => run.ok),
    runs,
    conformance: conformanceTable(runs),
    visual: visualDiffs(runs),
  };
  await writeFile(join(out, 'matrix-run.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, 'README.md'), markdownReport(report));
  console.log(`\n[matrix] ${report.ok ? 'PASS' : 'FAIL'} · ${runs.length} runs`);
  for (const row of report.conformance) {
    console.log(`[matrix] ${row.feature}: ${runs.map((run) => `${run.id}=${row.values[run.id]}`).join(' · ')}`);
  }
  for (const row of report.visual.filter((item) => item.status !== 'same')) {
    console.log(`[matrix] visual-changed: ${row.lighting} · ${row.scenario}/${row.name}`);
  }
  console.log(`[matrix] 报告 ${join(out, 'README.md')}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && cliRealpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`[matrix] ${error.message}`); process.exitCode = 1; });
}
