import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRuntimeId, compareEngineVersions, normalizeRuntimeRegistry, resolveRuntimeAliases, resolveRuntimeId,
  runtimePlatform, selectRuntimeIds, runtimeDisplayVersion,
} from '../lib/runtime-lock.mjs';

const row = (id, version = '0.17.0') => ({
  id, engineVersion: version, glueSha256: 'g', wasmSha256: 'w', cacheDir: `runtimes/${id}`,
});

const lane = (id, build, source = '', extra = {}) => ({
  id, engineVersion: build.split('-')[0], engineBuild: build, source,
  glueSha256: 'g', wasmSha256: 'w', ...extra,
});
const NPM = 'https://registry.npmjs.org/@yodaos-pkg/ink';
const STUDIO = 'https://aiui.rokid.com/';
const CRAFT = 'https://js.rokid.com/craft';

test('命名运行时 registry：拒绝重复/危险 id', () => {
  const registry = normalizeRuntimeRegistry([row('stable', '0.16.1'), row('daily')]);
  assert.equal(runtimeDisplayVersion(registry.runtimes[0]), '0.16.1');
  assert.throws(() => normalizeRuntimeRegistry([row('x'), row('x')]), /重复/);
  assert.throws(() => assertRuntimeId('../x'), /非法/);
});

test('版本比较按 semver：预发布低于同号正式版，构建戳按数值比', () => {
  assert.ok(compareEngineVersions('0.20.0', '0.19.1') > 0);
  assert.ok(compareEngineVersions('0.21.0-daily.20261115175657', '0.20.0') > 0);
  assert.ok(compareEngineVersions('0.20.0-rc.1', '0.20.0') < 0);
  assert.ok(compareEngineVersions('0.19.0-daily.202610090441', '0.19.0-daily.202610080438') > 0);
  assert.ok(compareEngineVersions('0.10.0', '0.9.9') > 0, '按数值不按字典序');
  assert.equal(compareEngineVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareEngineVersions('?', '0.1.0') < 0, '读不出的版本最小');
});

test('来源平台：npm / studio / craft', () => {
  assert.equal(runtimePlatform(lane('a', '1.0.0', NPM)), 'npm');
  assert.equal(runtimePlatform({ id: 'npm-ink-0.19.1', source: 'x' }), 'npm');
  assert.equal(runtimePlatform(lane('b', '1.0.0', 'https://static.rokidcdn.com/prod/rokid-aiuistudio/1.3.6/index.html')), 'studio');
  assert.equal(runtimePlatform(lane('c', '1.0.0', CRAFT)), 'craft');
  assert.equal(runtimePlatform(lane('d', '1.0.0', 'file:///x')), 'custom');
});

test('通道名：latest = 版本最高的正式版，daily = 版本最高的任意构建，studio = Studio 来源里最高的', () => {
  const rows = [
    lane('studio-stable', '0.16.1', STUDIO),
    lane('craft-0.18.0', '0.18.0', CRAFT),
    lane('studio-0.19.0-daily.1', '0.19.0-daily.1', STUDIO),
    lane('studio-0.19.0-daily.2', '0.19.0-daily.2', STUDIO),
    lane('npm-ink-0.20.0', '0.20.0', NPM),
    lane('npm-ink-0.21.0-daily.9', '0.21.0-daily.9', NPM),
  ];
  assert.deepEqual(resolveRuntimeAliases(rows), {
    latest: 'npm-ink-0.20.0', daily: 'npm-ink-0.21.0-daily.9', studio: 'studio-0.19.0-daily.2',
  });
  assert.deepEqual(resolveRuntimeAliases(rows.filter((r) => r.source !== NPM)), {
    latest: 'craft-0.18.0', daily: 'studio-0.19.0-daily.2', studio: 'studio-0.19.0-daily.2',
  });
  assert.deepEqual(resolveRuntimeAliases([lane('only-daily', '1.0.0-daily.1', NPM)]),
    { latest: 'only-daily', daily: 'only-daily', studio: null }, '没有正式版时 latest 退到最新构建');
});

test('同号版本：npm 官方包优先，其次取回日期新的', () => {
  const rows = [
    lane('studio-0.20.0', '0.20.0', STUDIO, { fetchedAt: '2026-12-01' }),
    lane('npm-ink-0.20.0', '0.20.0', NPM, { fetchedAt: '2026-11-17' }),
  ];
  assert.equal(resolveRuntimeAliases(rows).latest, 'npm-ink-0.20.0');
  const same = [lane('a', '1.0.0', CRAFT, { fetchedAt: '2026-01-01' }), lane('b', '1.0.0', CRAFT, { fetchedAt: '2026-02-01' })];
  assert.equal(resolveRuntimeAliases(same).latest, 'b');
});

test('默认 lane 是 latest，与清单顺序无关', () => {
  const rows = [lane('npm-ink-0.21.0-daily.9', '0.21.0-daily.9', NPM), lane('craft-0.18.0', '0.18.0', CRAFT), lane('npm-ink-0.20.0', '0.20.0', NPM)];
  assert.equal(normalizeRuntimeRegistry(rows).default, 'npm-ink-0.20.0');
  assert.equal(normalizeRuntimeRegistry([...rows].reverse()).default, 'npm-ink-0.20.0');
});

test('lane id 或通道名都能解析；认不出的返回 null', () => {
  const registry = normalizeRuntimeRegistry([lane('craft-0.18.0', '0.18.0', CRAFT), lane('npm-ink-0.20.0', '0.20.0', NPM)]);
  assert.equal(resolveRuntimeId('craft-0.18.0', registry), 'craft-0.18.0');
  assert.equal(resolveRuntimeId('latest', registry), 'npm-ink-0.20.0');
  assert.equal(resolveRuntimeId('studio', registry), null);
  assert.equal(resolveRuntimeId('craft-stable', registry), null);
  assert.equal(resolveRuntimeId('toString', registry), null, '原型上的名字不算通道名');
});

test('URL 可多选 lane（也可写通道名），自动去重/过滤并回退默认', () => {
  const registry = normalizeRuntimeRegistry([row('stable'), row('daily')]);
  assert.deepEqual(selectRuntimeIds('?runtimes=daily,stable,daily,missing', registry), ['daily', 'stable']);
  assert.deepEqual(selectRuntimeIds('', registry), ['stable']);
  const named = normalizeRuntimeRegistry([lane('craft-0.18.0', '0.18.0', CRAFT), lane('npm-ink-0.21.0-daily.9', '0.21.0-daily.9', NPM)]);
  assert.deepEqual(selectRuntimeIds('?runtimes=daily,latest,craft-0.18.0', named), ['npm-ink-0.21.0-daily.9', 'craft-0.18.0']);
});

test('清单为空时直接报错并说怎么生成，不静默退化；只有往空清单里追加时才允许为空', () => {
  assert.throws(() => normalizeRuntimeRegistry([]), /还没有运行时.*inklab-engine/);
  const empty = normalizeRuntimeRegistry([], { allowEmpty: true });
  assert.equal(empty.default, null);
  assert.equal(empty.runtimes.length, 0);
});

test('清单必须是数组：旧格式的 { runtimes: […] } 对象和 null 都不被悄悄接受', () => {
  assert.throws(() => normalizeRuntimeRegistry({ default: 'a', runtimes: [row('a')] }), /应该是一个 lane 数组/);
  assert.throws(() => normalizeRuntimeRegistry(null), /应该是一个 lane 数组/);
  assert.throws(() => normalizeRuntimeRegistry({}, { allowEmpty: true }), /应该是一个 lane 数组/);
});
