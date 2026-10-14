import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRuntimeId, normalizeRuntimeRegistry, selectRuntimeIds, runtimeDisplayVersion,
} from '../lib/runtime-lock.mjs';

const row = (id, version = '0.17.0') => ({
  id, engineVersion: version, glueSha256: 'g', wasmSha256: 'w', cacheDir: `runtimes/${id}`,
});

test('命名运行时 registry：第一条是默认 lane，拒绝重复/危险 id', () => {
  const registry = normalizeRuntimeRegistry([row('stable', '0.16.1'), row('daily')]);
  assert.equal(registry.default, 'stable');
  assert.equal(runtimeDisplayVersion(registry.runtimes[0]), '0.16.1');
  assert.throws(() => normalizeRuntimeRegistry([row('x'), row('x')]), /重复/);
  assert.throws(() => assertRuntimeId('../x'), /非法/);
});

test('顺序即优先级：把哪条挪到最前面，哪条就是默认 lane', () => {
  assert.equal(normalizeRuntimeRegistry([row('daily'), row('stable')]).default, 'daily');
  assert.equal(normalizeRuntimeRegistry([row('stable'), row('daily')]).default, 'stable');
});

test('URL 可多选 lane，自动去重/过滤并回退默认', () => {
  const registry = normalizeRuntimeRegistry([row('stable'), row('daily')]);
  assert.deepEqual(selectRuntimeIds('?runtimes=daily,stable,daily,missing', registry), ['daily', 'stable']);
  assert.deepEqual(selectRuntimeIds('', registry), ['stable']);
});

test('清单为空时直接报错并说怎么生成，不静默退化；只有往空清单里追加时才允许为空', () => {
  assert.throws(() => normalizeRuntimeRegistry([]), /还没有运行时.*npm run engine/);
  const empty = normalizeRuntimeRegistry([], { allowEmpty: true });
  assert.equal(empty.default, null);
  assert.equal(empty.runtimes.length, 0);
});

test('清单必须是数组：旧格式的 { runtimes: […] } 对象和 null 都不被悄悄接受', () => {
  assert.throws(() => normalizeRuntimeRegistry({ default: 'a', runtimes: [row('a')] }), /应该是一个 lane 数组/);
  assert.throws(() => normalizeRuntimeRegistry(null), /应该是一个 lane 数组/);
  assert.throws(() => normalizeRuntimeRegistry({}, { allowEmpty: true }), /应该是一个 lane 数组/);
});
