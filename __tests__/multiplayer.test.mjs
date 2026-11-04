import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerRouter, playerCount, playerUrl } from '../lib/multiplayer.mjs';
import { clearDirectory, scopedDirectory, scopedLocalStorage } from '../lib/player-storage.mjs';

function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) };
}
test('players accepts 1–6 and rejects invalid CLI/URL values', () => {
  for (let n = 1; n <= 6; n++) assert.equal(playerCount(String(n)), n);
  for (const value of [0, 7, 1.5, 'x', '']) assert.throws(() => playerCount(value), /1–6/);
});
test('input goes only to the selected player, including keyup', () => {
  const calls = [[], [], []];
  const players = calls.map((rows) => ({ sendInput: (...args) => rows.push(args), press: (key) => rows.push(key) }));
  const route = createPlayerRouter(players);
  route.press('Enter');
  route.select(2);
  route.sendInput('keydown', 'ArrowDown', 5);
  route.sendInput('keyup', 'ArrowDown', 6);
  assert.deepEqual(calls, [['Enter'], [], [['keydown', 'ArrowDown', 5], ['keyup', 'ArrowDown', 6]]]);
  assert.throws(() => route.select(3), RangeError);
  assert.equal(route.active, 2);
});
test('popout keeps the player identity and network settings, selects one runtime', () => {
  const url = new URL(playerUrl('http://localhost/?players=4&runtimes=a,b&llm=off', 2, 4));
  assert.equal(url.searchParams.get('player'), '3');
  assert.equal(url.searchParams.get('players'), '1');
  assert.equal(url.searchParams.get('player-count'), '4');
  assert.equal(url.searchParams.get('runtimes'), 'a');
  assert.equal(url.searchParams.get('llm'), 'off');
  assert.equal(url.searchParams.has('embedded'), false);
});
test('localStorage identity and saved values are isolated, persistent and enumerable', () => {
  const raw = storage();
  const a = scopedLocalStorage(raw, 'app-p1:');
  const b = scopedLocalStorage(raw, 'app-p2:');
  a.setItem('ink.host.identity.device_seed.v1', 'one');
  b.setItem('ink.host.identity.device_seed.v1', 'two');
  a.score = 40;
  assert.equal(b.score, undefined);
  assert.equal(a.length, 2);
  assert.deepEqual(Object.keys(a), ['ink.host.identity.device_seed.v1', 'score']);
  assert.equal(scopedLocalStorage(raw, 'app-p1:').getItem('score'), '40');
  a.clear();
  assert.equal(a.length, 0);
  assert.equal(b.getItem('ink.host.identity.device_seed.v1'), 'two');
});
test('OPFS roots and recursive cache deletion affect only the selected player', async () => {
  function directory() {
    const entries = new Map();
    return { entries,
      async getDirectoryHandle(name) { if (!entries.has(name)) entries.set(name, directory()); return entries.get(name); },
      async *keys() { yield* entries.keys(); },
      async removeEntry(name, opts) { assert.equal(opts.recursive, true); entries.delete(name); } };
  }
  const root = directory();
  const getA = scopedDirectory(async () => root, 'app-p1');
  const getB = scopedDirectory(async () => root, 'app-p2');
  const a = await getA(); const b = await getB();
  await a.getDirectoryHandle('audio'); await b.getDirectoryHandle('audio');
  assert.notEqual(a, b);
  assert.equal(await getA(), a);
  await clearDirectory(a);
  assert.equal(a.entries.size, 0);
  assert.equal(b.entries.size, 1);
});
