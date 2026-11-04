// Each player lives in its own browser realm; this module only routes calls.
export function playerCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error('players 必须是 1–6 的整数');
  return n;
}

export function createPlayerRouter(players) {
  let active = 0;
  return {
    get active() { return active; },
    select(index) {
      if (!Number.isInteger(index) || !players[index]) throw new RangeError('没有这个玩家');
      active = index;
      return players[index];
    },
    sendInput: (...args) => players[active].sendInput(...args),
    press: (...args) => players[active].press(...args),
  };
}

export function playerUrl(href, index, count, { embedded = false } = {}) {
  const url = new URL(href);
  url.searchParams.set('players', '1');
  url.searchParams.set('player', String(index + 1));
  url.searchParams.set('player-count', String(count));
  if (embedded) url.searchParams.set('embedded', '1');
  else url.searchParams.delete('embedded');
  // Players and runtime comparison are mutually exclusive.
  const runtime = url.searchParams.get('runtimes')?.split(',')[0];
  if (runtime) url.searchParams.set('runtimes', runtime);
  return url.href;
}
