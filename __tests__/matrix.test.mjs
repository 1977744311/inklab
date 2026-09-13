import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMatrixArgs, conformanceTable, visualDiffs } from '../matrix.mjs';

test('矩阵参数支持多 runtime、多场景与全光照', () => {
  const opts = parseMatrixArgs([
    'apps/x', '--runtime', 'stable,daily', '--runtime', 'stable',
    '--scenario', 'a,b', '--all-lighting', '--out', '/tmp/out', '--video',
  ]);
  assert.equal(opts.input, 'apps/x');
  assert.deepEqual(opts.runtimes, ['stable', 'daily']);
  assert.deepEqual(opts.scenarios, ['a', 'b']);
  assert.equal(opts.allLighting, true);
  assert.equal(opts.video, true);
});

test('conformance 表按 feature 对齐 lane，未观测不冒充 unsupported', () => {
  const table = conformanceTable([
    { id: 'stable@dark', conformance: [{ feature: 'battery', status: 'unsupported' }] },
    { id: 'daily@dark', conformance: [{ feature: 'battery', status: 'supported' }, { feature: 'opfs', status: 'contract-drift' }] },
  ]);
  assert.deepEqual(table, [
    { feature: 'battery', values: { 'stable@dark': 'unsupported', 'daily@dark': 'supported' } },
    { feature: 'opfs', values: { 'stable@dark': 'not-observed', 'daily@dark': 'contract-drift' } },
  ]);
});

test('视觉差分按同光照/场景/截图名分组，以 PNG 哈希判 same 或 visual-changed', () => {
  const rows = visualDiffs([
    { id: 'a', runtime: 'a', lighting: 'dark', shots: [{ scenario: 's', name: 'x.png', sha256: '1', bytes: 1 }] },
    { id: 'b', runtime: 'b', lighting: 'dark', shots: [{ scenario: 's', name: 'x.png', sha256: '2', bytes: 1 }] },
    { id: 'c', runtime: 'c', lighting: 'night', shots: [{ scenario: 's', name: 'x.png', sha256: '1', bytes: 1 }] },
  ]);
  assert.equal(rows.find((r) => r.lighting === 'dark').status, 'visual-changed');
  assert.equal(rows.find((r) => r.lighting === 'night').status, 'same');
});
