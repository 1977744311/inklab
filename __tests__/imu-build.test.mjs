import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_BAKED_TRACE_BYTES, bakeTraces, codeOnly, sensorReferences, stageImuBuild, transformInk, transformModule,
} from '../lib/node/imu-build.mjs';
import { normalizeTrace } from '../lib/imu-trace.mjs';

test('找引用：注释、字符串里的类名不算，globalThis.X 不算，自己声明了的不导入', () => {
  assert.equal(codeOnly('a // Accelerometer\nb').length, 'a // Accelerometer\nb'.length);
  const refs = sensorReferences(`
    // new Gyroscope() 只是注释
    const label = 'Magnetometer';
    const s = new AbsoluteOrientationSensor({ frequency: 60 });
    const A = typeof globalThis.Accelerometer === 'function' ? globalThis.Accelerometer : null;
    const t = \`\${typeof Gyroscope}\`;
  `);
  assert.deepEqual(refs.used, ['AbsoluteOrientationSensor', 'Gyroscope']);
  const declared = sensorReferences('class Accelerometer {}\nnew Accelerometer();');
  assert.deepEqual(declared, { used: [], declared: ['Accelerometer'] });
  assert.deepEqual(sensorReferences("import { Gyroscope } from './x.js';\nnew Gyroscope();").used, []);
});

test('改写：模块开头加 import；.ink 只改脚本块，JSON 块不动', () => {
  assert.deepEqual(transformModule('export const x = 1;\n', '../__inklab__/imu.js'), { code: 'export const x = 1;\n', names: [] });
  const mod = transformModule('export const make = () => new Accelerometer();\n', '../__inklab__/imu.js');
  assert.deepEqual(mod.names, ['Accelerometer']);
  assert.match(mod.code, /^import \{ Accelerometer \} from '\.\.\/__inklab__\/imu\.js';/);
  const ink = transformInk(`<script type="application/json" def>
{ "description": "AbsoluteOrientationSensor" }
</script>

<script setup>
import wx from 'wx';
const s = new AbsoluteOrientationSensor({});
</script>

<page><view /></page>`, '../../__inklab__/imu.js');
  assert.deepEqual(ink.names, ['AbsoluteOrientationSensor']);
  assert.match(ink.code, /"description": "AbsoluteOrientationSensor"/);
  assert.match(ink.code, /<script setup>\nimport \{ AbsoluteOrientationSensor \} from '\.\.\/\.\.\/__inklab__\/imu\.js';.*\nimport wx from 'wx';/);
});

test('轨迹打进包：可以只放一段，记下循环与速度', () => {
  const trace = normalizeTrace({ name: 'g', sensors: { absoluteOrientation: { rows: [[0, 0, 0, 0, 1], [10, 0.1, 0, 0, 0.99], [20, 0, 0, 0, 1]] } },
    segments: [{ id: 'nod', from: 10, to: 20 }] });
  const baked = bakeTraces(trace, { segment: 'nod', loop: true });
  assert.deepEqual(baked, { absoluteOrientation: { id: 'g#nod', speed: 1, loop: true, rows: [[0, 0.1, 0, 0, 0.99], [10, 0, 0, 0, 1]] } });
});

async function demoApp(t) {
  const root = await mkdtemp(join(tmpdir(), 'inklab-imu-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'aiui-demo', 'app');
  await mkdir(join(app, 'pages', 'index'), { recursive: true });
  await mkdir(join(app, 'src'), { recursive: true });
  await mkdir(join(app, 'node_modules', 'x'), { recursive: true });
  await mkdir(join(app, 'e2e', 'traces'), { recursive: true });
  await writeFile(join(app, 'app.json'), '{"pages":["pages/index/index"]}');
  await writeFile(join(app, 'app.js'), 'export default {};\n');
  await writeFile(join(app, 'src', 'head.js'), 'export const open = () => new AbsoluteOrientationSensor({ frequency: 60 });\n');
  await writeFile(join(app, 'src', 'plain.js'), 'export const n = 1;\n');
  await writeFile(join(app, 'pages', 'index', 'index.ink'), '<script setup>\nconst a = new Accelerometer();\n</script>\n<page />\n');
  await writeFile(join(app, 'node_modules', 'x', 'index.js'), 'new Accelerometer();\n');
  return app;
}

test('准备临时副本：源码不动，注入替身和配置，改写引用文件，app.js 先求值替身', async (t) => {
  const app = await demoApp(t);
  const staged = await stageImuBuild(app, { mode: 'replay', label: 'IMU 回放 · g', traces: { absoluteOrientation: { rows: [[0, 0, 0, 0, 1]] } } });
  t.after(() => staged.cleanup());
  assert.deepEqual(staged.transformed.map((f) => [f.file, f.names]).sort(), [
    ['pages/index/index.ink', ['Accelerometer']], ['src/head.js', ['AbsoluteOrientationSensor']],
  ]);
  assert.equal(await readFile(join(app, 'src', 'head.js'), 'utf8'), 'export const open = () => new AbsoluteOrientationSensor({ frequency: 60 });\n', '源码不动');
  assert.match(await readFile(join(staged.dir, 'src', 'head.js'), 'utf8'), /^import \{ AbsoluteOrientationSensor \} from '\.\.\/__inklab__\/imu\.js';/);
  assert.match(await readFile(join(staged.dir, 'pages', 'index', 'index.ink'), 'utf8'), /from '\.\.\/\.\.\/__inklab__\/imu\.js'/);
  assert.match(await readFile(join(staged.dir, 'app.js'), 'utf8'), /^import '\.\/__inklab__\/imu\.js';/);
  assert.equal(await readFile(join(staged.dir, 'src', 'plain.js'), 'utf8'), 'export const n = 1;\n');
  assert.equal(existsSync(join(staged.dir, 'node_modules')), false);
  const config = await readFile(join(staged.dir, '__inklab__', 'imu-config.js'), 'utf8');
  assert.match(config, /"mode":"replay"/);
  assert.match(config, /"rows":\[\[0,0,0,0,1\]\]/);
  assert.match(await readFile(join(staged.dir, '__inklab__', 'imu.js'), 'utf8'), /import config from '\.\/imu-config\.js'/);
  await staged.cleanup();
  assert.equal(existsSync(staged.dir), false);
});

test('准备临时副本：回放没轨迹、实时没地址、轨迹太大都直接说', async (t) => {
  const app = await demoApp(t);
  await assert.rejects(stageImuBuild(app, { mode: 'real' }), /不是模拟 IMU 模式/);
  await assert.rejects(stageImuBuild(app, { mode: 'replay' }), /先选一条轨迹/);
  await assert.rejects(stageImuBuild(app, { mode: 'live' }), /工作台在跑/);
  const rows = Array.from({ length: Math.ceil(MAX_BAKED_TRACE_BYTES / 20) }, (_, i) => [i, 0.123456, 0.123456, 0.123456, 0.99]);
  await assert.rejects(stageImuBuild(app, { mode: 'replay', traces: { absoluteOrientation: { rows } } }), /轨迹太大/);
  const live = await stageImuBuild(app, { mode: 'live', liveUrl: 'ws://127.0.0.1:9/api/device/imu/live/abc' });
  t.after(() => live.cleanup());
  assert.match(await readFile(join(live.dir, '__inklab__', 'imu-config.js'), 'utf8'), /"live":\{"url":"ws:\/\/127\.0\.0\.1:9\/api\/device\/imu\/live\/abc"\}/);
});
