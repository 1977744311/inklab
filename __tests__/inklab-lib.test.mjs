// InkLab 纯逻辑层：引擎版本解析 + bundle 整理。零网络零 IO。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractEngineVersion, VERSION_ANCHOR, BUILD_ANCHOR,
} from '../lib/node/engine-version.mjs';
import {
  shouldInclude, buildManifest, validateManifest, isTextPath, DEFAULT_EXCLUDES,
} from '../lib/bundle.mjs';

// ── 引擎版本 ────────────────────────────────────────────────────────────

// 版本靠锚点定位:wasm 里有几十个第三方 crate 版本号,裸 semver 正则必误命中。
// 实测两处锚点分别挂语义版本与 daily 构建戳,不是同一处。
test('引擎版本:双锚点各取一样,正式版与 daily 都能解', () => {
  // daily 构建:两处锚点都在
  const daily = Buffer.from(
    `\0 0.17.0${VERSION_ANCHOR}_blank_widget\0 0.17.0-daily.202608180107${BUILD_ANCHOR}\0`, 'latin1');
  assert.deepEqual(extractEngineVersion(daily),
    { version: '0.17.0', build: '0.17.0-daily.202608180107' });

  // 正式版:只有语义版本锚点,build 锚点前没有版本串
  const release = Buffer.from(
    `\0 0.16.1${VERSION_ANCHOR}_blank_widget\0 must be one of \`_current\`.${BUILD_ANCHOR}\0`, 'latin1');
  assert.deepEqual(extractEngineVersion(release), { version: '0.16.1', build: null });

  assert.deepEqual(extractEngineVersion(Buffer.from('没有锚点')), { version: null, build: null });

  // 干扰项:锚点前不紧邻版本串时判 null,不能抓个无关 crate 的版本号
  const noisy = Buffer.from(`1.94.0-aarch64\0 0.45.1 \0${VERSION_ANCHOR}`, 'latin1');
  assert.equal(extractEngineVersion(noisy).version, null);
});

// 新布局的 daily（Studio 0.19.0-daily.202610080438 起）：两处静态文案前面不再紧挨版本串，
// 版本只剩引擎版本表里的 `ink<构建戳>skia`。正式版的版本表写的是 crate 版本 0.1.0（不是发行版本）。
test('引擎版本:新布局的 daily 靠版本表里的构建戳读出;正式版的 crate 版本不误判;锚点读得出时以锚点为准', () => {
  const newLayout = (table) => Buffer.from(`\0${VERSION_ANCHOR}\0\0${BUILD_ANCHOR}\0\0${table}\0`, 'latin1');
  assert.deepEqual(extractEngineVersion(newLayout('ink0.19.0-daily.202610080438skia')),
    { version: '0.19.0', build: '0.19.0-daily.202610080438' });
  assert.deepEqual(extractEngineVersion(newLayout('ink0.1.0skia')), { version: null, build: null },
    '读不出就是读不出：0.1.0 不是发行版本，不能当版本');

  const oldDaily = Buffer.from(
    `\0 0.17.0${VERSION_ANCHOR}\0 0.17.0-daily.202608180107${BUILD_ANCHOR}\0ink0.19.0-daily.209999999999skia\0`, 'latin1');
  assert.deepEqual(extractEngineVersion(oldDaily), { version: '0.17.0', build: '0.17.0-daily.202608180107' });
  const oldRelease = Buffer.from(`\0 0.16.1${VERSION_ANCHOR}\0\0${BUILD_ANCHOR}\0ink0.1.0skia\0`, 'latin1');
  assert.deepEqual(extractEngineVersion(oldRelease), { version: '0.16.1', build: null });
});

// ── bundle 整理 ─────────────────────────────────────────────────────────

test('排除口径对齐 .aixignore:测试/脚本/内容源/设计稿/点文件都不进 bundle', () => {
  for (const p of [
    'lib/__tests__/shell.test.mjs', 'lib/foo.test.mjs', 'scripts/build-pack.mjs',
    'data/packs/sample/items.json', 'assets/mockups-ai/p1-01.png', 'assets/app-icon.png',
    'package.json', 'README.md', '.DS_Store', 'node_modules/x/index.js', 'docs/a.md',
  ]) assert.equal(shouldInclude(p), false, `应排除 ${p}`);

  for (const p of [
    'app.json', 'app.js', 'app.wxss', 'AGENTS.md',
    'pages/home/index.ink', 'lib/shell.js', 'lib/compiled-pack.js',
    'assets/anim/squat/f00.png', 'assets/earcon-pr.wav',
  ]) assert.equal(shouldInclude(p), true, `应保留 ${p}`);
});

test('manifest:过滤 + 去重 + 归一化 + 排序(可 diff)', () => {
  const m = buildManifest([
    './pages/home/index.ink', 'app.json', 'pages/home/index.ink',
    'lib/__tests__/x.test.mjs', 'app.js', '.DS_Store',
  ]);
  assert.deepEqual(m, ['app.js', 'app.json', 'pages/home/index.ink']);
});

test('manifest 支持追加排除项(排障时临时屏蔽某页)', () => {
  const m = buildManifest(['app.json', 'app.js', 'pages/gear/index.ink'], [/^pages\/gear\//]);
  assert.deepEqual(m, ['app.js', 'app.json']);
});

test('文本/二进制分流:给错类型引擎解析会失败', () => {
  for (const p of ['a.ink', 'a.js', 'a.json', 'a.wxss', 'a.md']) assert.equal(isTextPath(p), true, p);
  for (const p of ['a.png', 'a.wav', 'a.webp', 'a.ttf']) assert.equal(isTextPath(p), false, p);
});

test('工程预检:缺入口与路由/文件不匹配都要在跑起来之前说人话', () => {
  const ok = validateManifest(
    ['app.json', 'app.js', 'pages/home/index.ink'],
    JSON.stringify({ pages: ['pages/home/index'] }),
  );
  assert.deepEqual(ok, []);

  const missingEntry = validateManifest(['pages/home/index.ink'], null);
  assert.ok(missingEntry.some((p) => p.includes('app.json')));
  assert.ok(missingEntry.some((p) => p.includes('app.js')));

  const routeGap = validateManifest(
    ['app.json', 'app.js'],
    JSON.stringify({ pages: ['pages/home/index'] }),
  );
  assert.ok(routeGap.some((p) => p.includes('pages/home/index.ink')), routeGap.join(' / '));

  const badJson = validateManifest(['app.json', 'app.js'], '{ oops');
  assert.ok(badJson.some((p) => p.includes('不是合法 JSON')));

  const noPages = validateManifest(['app.json', 'app.js'], JSON.stringify({ pages: [] }));
  assert.ok(noPages.some((p) => p.includes('空数组')));
});

test('排除表本身是正则数组(防手滑写成字符串导致全量放行)', () => {
  assert.ok(DEFAULT_EXCLUDES.length > 0);
  for (const re of DEFAULT_EXCLUDES) assert.ok(re instanceof RegExp);
});
