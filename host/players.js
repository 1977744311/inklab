import { createPlayerRouter, playerCount, playerUrl } from '/host/lib/multiplayer.mjs';

const $ = (id) => document.getElementById(id);
const info = await (await fetch('/api/manifest')).json();
const count = playerCount(new URLSearchParams(location.search).get('players') ?? info.config.players);
const frames = [];
const players = Array.from({ length: count }, (_, index) => ({
  index,
  get window() { return frames[index].contentWindow; },
  get lab() { return this.window.__inklab; },
  get caps() { return this.lab.caps; },
  get view() { return this.lab.view; },
  get driver() { return this.lab.driver; },
  press(...args) { return this.lab.driver.press(...args); },
  sendInput(...args) { return this.lab.sendInput(...args); },
  shot(name = 'shot') { return this.lab.snapshot(`player-${index + 1}--${name}`); },
  clearCache() { return this.lab.clearCache(); },
}));
const router = createPlayerRouter(players);
let expanded = false;
let initialized = false;
const select = (index) => {
  router.select(index);
  $('focus-label').textContent = `玩家 ${index + 1}`;
  for (const [i, frame] of frames.entries()) {
    frame.parentElement.classList.toggle('active', i === index);
    frame.parentElement.classList.toggle('expanded', expanded && i === index);
    frame.contentDocument?.body?.classList.toggle('player-embedded', !(expanded && i === index));
  }
};
const notice = (message) => { $('notice').textContent = message; };
const act = async (fn) => {
  try { await fn(); } catch (error) { notice(error.message); }
};
const all = (fn) => players.forEach((p) => { if (p.lab?.ready) fn(p.lab); });
const facade = {
  players, get activePlayer() { return router.active; }, selectPlayer: select,
  get ready() {
    if (!initialized) return false;
    if (!players.every((p) => p.lab?.ready)) return false;
    for (const p of players) p.lab.players = players;
    return true;
  },
  get bootError() { return players.map((p) => p.lab?.bootError).find(Boolean) || null; },
  press: router.press, sendInput: router.sendInput,
  clearCache: () => players[router.active].clearCache(),
  clearAllCaches: () => Promise.all(players.map((p) => p.clearCache())),
  exportRun: () => ({ players: players.map((p) => ({ player: p.index + 1, ...p.lab.exportRun() })) }),
};
// Existing e2e runner reads the primary player's report/stamp; scenarios receive every player.
window.__inklab = new Proxy(facade, { get: (target, key) => key in target ? target[key] : players[0].lab?.[key] });
Object.defineProperty(window, '__inklab_engineLog', { get: () => players.flatMap((p) =>
  (p.window.__inklab_engineLog || []).map((r) => ({ ...r, text: `[玩家 ${p.index + 1}] ${r.text}` }))) });

for (let index = 0; index < count; index++) {
  const cell = document.createElement('section');
  cell.className = 'player';
  cell.innerHTML = `<header><b>玩家 ${index + 1}</b><button>单独窗口</button></header><iframe title="玩家 ${index + 1}" allow="autoplay"></iframe><div class="status">启动中…</div>`;
  const frame = cell.querySelector('iframe');
  frames.push(frame);
  cell.querySelector('button').onclick = () => {
    // Transfer this seat, rather than running two live copies of one identity.
    frame.src = 'about:blank';
    const popup = window.open(playerUrl(location.href, index, count), `inklab-player-${index + 1}`);
    if (!popup) { frame.src = playerUrl(location.href, index, count, { embedded: true }); notice('请允许弹出窗口'); return; }
    Object.defineProperty(players[index], 'window', { configurable: true, get: () => popup.closed ? frame.contentWindow : popup });
    const monitor = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(monitor);
      frame.src = playerUrl(location.href, index, count, { embedded: true });
    }, 500);
    notice(`玩家 ${index + 1} 已转到单独窗口；关掉后回到网格`);
  };
  cell.addEventListener('pointerdown', () => select(index));
  frame.addEventListener('load', () => {
    if (frame.contentWindow.location.href === 'about:blank') return;
    frame.contentWindow.addEventListener('pointerdown', () => select(index), true);
    frame.contentWindow.addEventListener('keydown', (e) => onKey(e, true), true);
    frame.contentWindow.addEventListener('keyup', (e) => onKey(e, true), true);
    select(router.active);
  });
  $('players').append(cell);
  frame.src = playerUrl(location.href, index, count, { embedded: true });
  // Stagger WASM initialization to avoid six concurrent compile/layout bursts.
  await new Promise((r) => setTimeout(r, 180));
}
function onKey(event, inFrame = false) {
  const isTyping = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName) || event.target?.isContentEditable;
  if (isTyping || event.target?.closest?.('.workbench-modes')) return;
  // Outside the player area, Tab moves through the mode links and toolbar.
  if (event.key === 'Tab' && !inFrame && event.target instanceof Element && !event.target.closest('#players')) return;
  const digit = /^Digit([1-6])$/.exec(event.code || '');
  const switchTo = event.altKey && digit ? Number(digit[1]) - 1
    : event.key === 'Tab' ? (router.active + (event.shiftKey ? count - 1 : 1)) % count : -1;
  if (switchTo >= 0 && switchTo < count) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'keydown') { select(switchTo); frames[switchTo].focus(); }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (inFrame) {
    // A keyboard-focused old frame must never keep controlling the previous seat.
    if (event.currentTarget !== players[router.active].window) {
      event.preventDefault(); event.stopImmediatePropagation();
      router.sendInput(event.type, event.code || event.key);
    }
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Backspace', 'Space'].includes(event.code)) event.preventDefault();
  act(() => router.sendInput(event.type, event.code || event.key));
}
window.addEventListener('keydown', (e) => onKey(e));
window.addEventListener('keyup', (e) => onKey(e));
$('controls').onclick = () => { expanded = !expanded; select(router.active); };
for (const button of document.querySelectorAll('[data-key]')) button.onclick = () => act(() => router.press(button.dataset.key));
$('offline').onclick = () => players[router.active].caps.net.offline();
$('online').onclick = () => players[router.active].caps.net.online();
$('nod').onclick = () => players[router.active].window.document.getElementById('sensor-head-nod').click();
$('shake').onclick = () => players[router.active].window.document.getElementById('sensor-head-shake').click();
$('cache-current').onclick = () => act(async () => { await facade.clearCache(); notice('当前玩家下载缓存已清除并重载'); });
$('cache-all').onclick = () => act(async () => { await facade.clearAllCaches(); notice('全部玩家下载缓存已清除并重载'); });
$('guard').onchange = () => {
  for (const p of players) {
    if (!p.lab?.ready) continue;
    const box = p.window.document.getElementById('net-guard');
    box.checked = $('guard').checked;
    box.onchange();
  }
};
$('allow-add').onclick = () => {
  const pattern = $('allow-pattern').value.trim();
  if (!pattern) return;
  all((lab) => lab.allowExternal(pattern));
  $('allow-pattern').value = '';
};
// Six separate EventSources would occupy Chrome's entire HTTP/1.1 origin
// connection pool and starve the sixth engine's WASM/module requests.
const watch = new EventSource('/api/watch');
watch.addEventListener('change', () => {
  if (players.some(p => p.lab?.scenarioRunning)) return;
  for (const p of players) {
    if (p.lab?.ready && p.window.document.getElementById('autoreload').checked) p.lab.reload();
  }
});
const ticker = setInterval(() => {
  for (const p of players) {
    const node = frames[p.index].parentElement.querySelector('.status');
    const lab = p.lab;
    if (!lab?.ready) { node.textContent = lab?.bootError || '启动中…'; continue; }
    lab.players = players;
    const status = lab.caps.net.networkState();
    const open = status.ws.filter((s) => s.state === 1).length;
    const connecting = status.ws.filter((s) => s.state === 0).length;
    const downloads = status.downloads;
    const received = downloads.reduce((n, d) => n + d.received, 0);
    const total = downloads.reduce((n, d) => n + d.total, 0);
    node.textContent = `${status.online ? '联网' : '整体断网'} · WS ${open ? `已连接 ${open}` : connecting ? '连接中' : '已断'} · `
      + (downloads.length ? `下载 ${downloads.length} 项 ${total ? Math.round(received / total * 100) + '%' : Math.round(received / 1024) + ' KB'}` : '无进行中下载');
  }
  const lab = players[0].lab;
  if (lab?.ready) {
    $('allow-list').textContent = '已放行：' + lab.caps.net.rules().filter((r) => r.kind === 'allow').map((r) => r.pattern).join('、');
    $('guard').checked = lab.caps.net.isExternalGuarded();
  }
}, 500);
window.addEventListener('beforeunload', () => {
  clearInterval(ticker);
  watch.close();
  for (const p of players) if (p.window !== frames[p.index].contentWindow) p.window.close();
});

initialized = true;
