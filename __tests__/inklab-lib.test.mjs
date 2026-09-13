// InkLab 纯逻辑层：引擎定位 + bundle 整理。零网络零 IO。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMainBundlePath, extractChunkNames, rankGlueCandidates, looksLikeGlue,
  extractWasmPath, extractEngineVersion, compareLock, compareVersions, pickNewestBuild,
  VERSION_ANCHOR, BUILD_ANCHOR,
} from '../lib/engine-source.mjs';
import {
  shouldInclude, buildManifest, validateManifest, isTextPath, DEFAULT_EXCLUDES,
} from '../lib/bundle.mjs';

// ── 引擎定位 ────────────────────────────────────────────────────────────

test('从 Craft 首页取主 bundle 路径', () => {
  const html = `<head><link href="/assets/index-X.css"><script type="module" crossorigin src="/assets/index-fGBNsmlf.js"></script></head>`;
  assert.equal(extractMainBundlePath(html), '/assets/index-fGBNsmlf.js');
  assert.equal(extractMainBundlePath('<html></html>'), null);
});

test('抽出动态 import 的 chunk 名并按可疑度排序(index-* 优先)', () => {
  const js = `a(()=>import("./flowDiagram-PKNHOUZH-D5IXPmuC.js"));b(()=>import("./index-D_EpyLZO.js"));
    c(()=>import("./nls.messages.zh-cn-DjCDCmFK.js"));d(()=>import("./index-CRZKnqBI.js"));
    e(()=>import("./index-D_EpyLZO.js"))`;
  const names = extractChunkNames(js);
  assert.equal(names.length, 4, '同名 chunk 去重');
  const ranked = rankGlueCandidates(names);
  // 图表与语言包被噪声表滤掉，只剩两个 index-*
  assert.deepEqual(ranked, ['index-CRZKnqBI.js', 'index-D_EpyLZO.js']);
});

test('glue 识别要求 wasm 路径 + initInk + createInkView 三者同时具备', () => {
  const real = `new URL("/assets/ink_web_bg-Cv9NP4M6.wasm",import.meta.url);function initInk(){}createInkView()`;
  assert.equal(looksLikeGlue(real), true);
  assert.equal(looksLikeGlue('createInkView() 但没有 wasm'), false);
  assert.equal(looksLikeGlue('/assets/ink_web_bg-X.wasm 但没有入口'), false);
  assert.equal(looksLikeGlue(''), false);
});

test('从 glue 抽 wasm 资源路径', () => {
  const glue = `n.wasmUrl||new URL("/assets/ink_web_bg-Cv9NP4M6.wasm",import.meta.url)`;
  assert.equal(extractWasmPath(glue), '/assets/ink_web_bg-Cv9NP4M6.wasm');
  assert.equal(extractWasmPath('no wasm here'), null);
});

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

test('多构建择新:Craft 同时挂着正式版与 daily,必须选对', () => {
  assert.ok(compareVersions('0.17.0', '0.16.1') > 0);
  assert.ok(compareVersions('0.17.0-daily.202608180107', '0.17.0') > 0, '同版本时 daily 戳更新');
  assert.equal(compareVersions('0.17.0', '0.17.0'), 0);
  const picked = pickNewestBuild([
    { version: '0.16.1', build: null, wasmPath: '/a.wasm' },
    { version: '0.17.0', build: '0.17.0-daily.202608180107', wasmPath: '/b.wasm' },
  ]);
  assert.equal(picked.wasmPath, '/b.wasm');
  assert.equal(pickNewestBuild([]), null);
  assert.equal(pickNewestBuild([{ version: null }]), null);
});

test('lock 比对:一致/首次/漂移三态,漂移逐项列出差异', () => {
  const actual = {
    engineVersion: '0.17.0', engineBuild: '0.17.0-daily.202608180107',
    gluePath: '/assets/index-A.js', glueSha256: 'aaa',
    wasmPath: '/assets/ink_web_bg-A.wasm', wasmSha256: 'bbb',
  };
  assert.deepEqual(compareLock(null, actual), { status: 'absent', changes: [] });
  assert.equal(compareLock({ ...actual }, actual).status, 'match');

  const drift = compareLock({ ...actual, wasmSha256: 'old', engineBuild: '0.16.0-daily.1' }, actual);
  assert.equal(drift.status, 'drift');
  assert.deepEqual(drift.changes.map((c) => c.key).sort(), ['engineBuild', 'wasmSha256']);
});

// ── bundle 整理 ─────────────────────────────────────────────────────────

test('排除口径对齐 .aixignore:测试/脚本/内容源/设计稿/点文件都不进 bundle', () => {
  for (const p of [
    'lib/__tests__/shell.test.mjs', 'lib/foo.test.mjs', 'scripts/build-pack.mjs',
    'data/packs/iron-coach/gear.json', 'assets/mockups-ai/p1-01.png', 'assets/app-icon.png',
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
