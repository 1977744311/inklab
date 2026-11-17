// serve 对「清单里的默认运行时 lane（第一条）本机没有」的处理：改用第一个可用的 lane，并且说出来。
//
// runtimes.lock.json 是每个人的本机清单，测试不能依赖它。
// 所以把 lib/ 复制到临时目录，每个用例写一份自己的清单（清单在每次起服务时才读；
// 只有引擎缓存目录是 import 时就定下的，所以缓存目录固定、只放 other 这一条 lane）。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let scratch;
let tool;
let appDir;
let serve;

const lane = (id, extra = {}) => ({
  id, label: id, channel: 'custom', engineVersion: '9.9.9',
  glueSha256: 'a'.repeat(64), wasmSha256: 'b'.repeat(64), ...extra,
});

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inklab-serve-runtimes-'));
  tool = join(scratch, 'tool');
  await cp(new URL('../lib', import.meta.url), join(tool, 'lib'), { recursive: true });

  const engineDir = join(scratch, 'engine');
  await mkdir(join(engineDir, 'runtimes/other'), { recursive: true });
  await writeFile(join(engineDir, 'runtimes/other/ink-glue.js'), '// stub');
  await writeFile(join(engineDir, 'runtimes/other/engine.wasm'), 'stub');
  process.env.INKLAB_ENGINE_DIR = engineDir; // 必须在 import serve.mjs 之前

  appDir = join(scratch, 'app');
  await mkdir(appDir);
  await writeFile(join(appDir, 'app.json'), JSON.stringify({ appId: 'serve-runtimes' }));

  serve = await import(pathToFileURL(join(tool, 'lib/node/serve.mjs')).href);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** 用这份清单（lane 数组，第一条是默认）起一个服务，返回启动期间的日志和 manifest 里的默认 lane。 */
async function startWith(lanes, env = {}) {
  await writeFile(join(tool, 'runtimes.lock.json'), JSON.stringify(lanes));
  const lines = [];
  const lab = await serve.createInkLabServer({ input: appDir, port: 0, env, log: (line) => lines.push(line) });
  try {
    const manifest = await (await fetch(new URL('/api/manifest', lab.url))).json();
    return { lines, runtimeDefault: manifest.runtimeDefault, runtimeAliases: manifest.runtimeAliases };
  } finally {
    await lab.close();
  }
}

test('默认 lane 是 cache-only 且本机没有：改用可用的 lane，并说明它无法下载', async () => {
  const { lines, runtimeDefault } = await startWith([lane('legacy', { cacheOnly: true }), lane('other')]);
  assert.equal(runtimeDefault, 'other');
  assert.ok(lines.includes('[inklab] 默认运行时 legacy 本机没有缓存（cache-only 历史 lane，无法下载），本次默认用 other'), lines.join('\n'));
});

test('默认 lane 可下载但本机还没取：改用可用的 lane，并给出取这条 lane 的命令', async () => {
  const { lines, runtimeDefault } = await startWith([lane('fake'), lane('other')]);
  assert.equal(runtimeDefault, 'other');
  assert.ok(lines.includes('[inklab] 默认运行时 fake 本机没有缓存（inklab-engine fake 可拉取），本次默认用 other'), lines.join('\n'));
});

test('默认 lane 就在缓存里：不打这条提示', async () => {
  const { lines, runtimeDefault } = await startWith([lane('other'), lane('fake')]);
  assert.equal(runtimeDefault, 'other');
  assert.deepEqual(lines.filter((line) => line.includes('默认运行时')), []);
});

test('通道名只在本机有缓存的 lane 里算；INKLAB_RUNTIME 可临时换默认（lane id 或通道名）', async () => {
  const newer = lane('newer', { engineVersion: '10.0.0' });
  const plain = await startWith([newer, lane('other')]);
  assert.equal(plain.runtimeDefault, 'other', '版本更高的 newer 本机没缓存，latest 落在 other');
  assert.deepEqual(plain.runtimeAliases, { latest: 'other', daily: 'other', studio: null });
  assert.ok(plain.lines.some((line) => line.includes('默认运行时 newer 本机没有缓存')), plain.lines.join('\n'));

  const byAlias = await startWith([lane('other')], { INKLAB_RUNTIME: 'daily' });
  assert.equal(byAlias.runtimeDefault, 'other');
  const bad = await startWith([lane('other')], { INKLAB_RUNTIME: 'craft-stable' });
  assert.equal(bad.runtimeDefault, 'other');
  assert.ok(bad.lines.includes('[inklab] INKLAB_RUNTIME=craft-stable 不是本机可用的 lane 或通道名，忽略；本次默认用 other'), bad.lines.join('\n'));
});

test('应用的 inklab.config.json 可写 runtime 当项目默认；INKLAB_RUNTIME 比它优先；写错了说出来', async () => {
  const config = join(appDir, 'inklab.config.json');
  try {
    await writeFile(config, JSON.stringify({ runtime: 'daily' }));
    const ok = await startWith([lane('other')]);
    assert.equal(ok.runtimeDefault, 'other');
    assert.deepEqual(ok.lines.filter((line) => line.includes('runtime')), []);

    await writeFile(config, JSON.stringify({ runtime: 'craft-stable' }));
    const bad = await startWith([lane('other')]);
    assert.ok(bad.lines.includes('[inklab] inklab.config.json 的 runtime=craft-stable 不是本机可用的 lane 或通道名，忽略；本次默认用 other'), bad.lines.join('\n'));

    const env = await startWith([lane('other')], { INKLAB_RUNTIME: 'latest' });
    assert.deepEqual(env.lines.filter((line) => line.includes('runtime')), [], '环境变量优先，不再看配置里写错的值');
  } finally {
    await rm(config, { force: true });
  }
});

test('没有清单（全新 clone 还没跑过 npm run engine）：起不来，并说怎么生成', async () => {
  await rm(join(tool, 'runtimes.lock.json'), { force: true });
  await assert.rejects(
    serve.createInkLabServer({ input: appDir, port: 0, env: {}, log: () => {} }),
    /runtimes\.lock\.json 里还没有运行时：联网后运行 inklab-engine/,
  );
});
