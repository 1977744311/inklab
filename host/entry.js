import { installPlayerStorage } from '/host/lib/player-storage.mjs';

try {
  const info = await (await fetch('/api/manifest')).json();
  const search = new URLSearchParams(location.search);
  const player = Number(search.get('player') || 1);
  if (!Number.isInteger(player) || player < 1 || player > 6) throw new Error('player 必须是 1–6');
  window.__inklabStorage = installPlayerStorage(window, `${info.config.storageNamespace}-player-${player}`);
  if (search.has('clear-cache')) {
    await window.__inklabStorage.clearCache();
    const url = new URL(location.href);
    url.searchParams.delete('clear-cache');
    history.replaceState(null, '', url);
  }
  window.__inklabInitialInfo = info;
  if (search.has('player')) {
    document.title = `InkLab · 玩家 ${player}`;
    document.querySelector('.brand-copy span').textContent = `玩家 ${player}`;
  }
  if (search.has('embedded')) document.body.classList.add('player-embedded');
  await import('/host/inklab.js');
} catch (error) {
  window.__inklab = { ready: false, bootError: error.message };
  document.getElementById('meta').textContent = error.message;
}
