import test from 'node:test';
import assert from 'node:assert/strict';

import { createEvidenceLedger, instrumentCapabilities, redactEvidence } from '../lib/evidence.mjs';

test('run.json 脱敏密钥、压缩二进制并截断超长正文', () => {
  const value = redactEvidence({
    authorization: 'Bearer secret', nested: { apiKey: 'x', ok: true },
    bytes: new Uint8Array(12), body: 'x'.repeat(9000),
  });
  assert.equal(value.authorization, '<redacted>');
  assert.equal(value.nested.apiKey, '<redacted>');
  assert.equal(value.bytes, '<Uint8Array 12B>');
  assert.match(value.body, /truncated/);
});

test('能力插桩按 lane 记录 call/result/error，且不改变返回与抛错语义', async () => {
  let clock = 100;
  const ledger = createEvidenceLedger({ now: () => clock++ });
  const caps = instrumentCapabilities({ demo: {
    ok: async (value) => ({ value }),
    fail: async () => { throw new Error('boom'); },
  } }, { ledger, lane: 'daily' });

  assert.deepEqual(await caps.demo.ok(7), { value: 7 });
  await assert.rejects(() => caps.demo.fail(), /boom/);
  assert.deepEqual(ledger.entries.map((e) => e.kind), [
    'capability.call', 'capability.result', 'capability.call', 'capability.error',
  ]);
  assert.ok(ledger.entries.every((e) => e.lane === 'daily'));
});
