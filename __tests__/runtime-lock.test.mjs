import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRuntimeId, normalizeRuntimeRegistry, selectRuntimeIds, runtimeDisplayVersion,
} from '../lib/runtime-lock.mjs';

const row = (id, version = '0.17.0') => ({
  id, engineVersion: version, glueSha256: 'g', wasmSha256: 'w', cacheDir: `runtimes/${id}`,
});

test('命名运行时 registry 固定默认 lane、拒绝重复/危险 id', () => {
  const registry = normalizeRuntimeRegistry({ default: 'stable', runtimes: [row('stable', '0.16.1'), row('daily')] });
  assert.equal(registry.default, 'stable');
  assert.equal(runtimeDisplayVersion(registry.runtimes[0]), '0.16.1');
  assert.throws(() => normalizeRuntimeRegistry({ runtimes: [row('x'), row('x')] }), /重复/);
  assert.throws(() => assertRuntimeId('../x'), /非法/);
});

test('URL 可多选 lane，自动去重/过滤并回退默认', () => {
  const registry = normalizeRuntimeRegistry({ default: 'stable', runtimes: [row('stable'), row('daily')] });
  assert.deepEqual(selectRuntimeIds('?runtimes=daily,stable,daily,missing', registry), ['daily', 'stable']);
  assert.deepEqual(selectRuntimeIds('', registry), ['stable']);
});

test('旧 engine.lock 可退化为单 legacy lane', () => {
  const registry = normalizeRuntimeRegistry(null, {
    source: 'craft', engineVersion: '0.17.0', engineBuild: '0.17.0-daily.1',
    gluePath: '/g.js', glueSha256: 'g', wasmPath: '/w.wasm', wasmSha256: 'w',
  });
  assert.equal(registry.default, 'legacy');
  assert.equal(runtimeDisplayVersion(registry.runtimes[0]), '0.17.0-daily.1');
});
