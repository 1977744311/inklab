import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbaFrameHash } from '../lib/frame-hash.mjs';

test('full fingerprint sees movement and alpha changes even outside the PNG tail', () => {
  const base = { width: 2, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255, 0, 0, 0, 255]) };
  const moved = { ...base, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 255, 0, 255]) };
  const faded = { ...base, data: new Uint8ClampedArray([0, 128, 0, 255, 0, 0, 0, 255]) };
  assert.notEqual(rgbaFrameHash(base), rgbaFrameHash(moved));
  assert.notEqual(rgbaFrameHash(base), rgbaFrameHash(faded));
  assert.equal(rgbaFrameHash(base), rgbaFrameHash({ ...base, data: base.data.slice() }));
  assert.throws(() => rgbaFrameHash({ width: 1, height: 1, data: [] }), /invalid/);
});
