const nav = document.querySelector('.workbench-modes');
const simulatorOptions = ['runtime', 'runtimes', 'players', 'preview', 'lighting',
  'camera', 'bluetooth', 'netguard', 'llm', 'cassette', 'llm-model', 'probe'];
const initial = new URLSearchParams(location.search);

// A popped-out player still belongs to its multiplayer grid.
if (nav && window === window.top && !(window.opener && initial.has('player'))) {
  const mode = nav.dataset.mode || 'simulator';
  const active = mode === 'device' && initial.get('simulator') === '1' ? 'hybrid' : mode;
  const modes = [['simulator', '模拟器'], ['device', 'USB 真机'], ['hybrid', '真机 + 模拟器']];
  const links = modes.map(([id, label]) => {
    const link = document.createElement('a');
    link.textContent = label;
    if (id === active) link.setAttribute('aria-current', 'page');
    return link;
  });
  const home = document.querySelector('[data-workbench-home]');

  function syncLinks() {
    const current = new URLSearchParams(location.search);
    const options = new URLSearchParams();
    for (const name of simulatorOptions) {
      if (current.has(name)) options.set(name, current.get(name));
    }
    const query = options.size ? `?${options}` : '';
    const [simulator, device, combined] = links;
    simulator.href = `/${query}`;
    device.href = `/device${query}`;
    options.set('simulator', '1');
    combined.href = `/device?${options}`;
    if (home) home.href = simulator.href;
  }

  syncLinks();
  nav.replaceChildren(...links);
  nav.hidden = false;
  // The runtime picker updates the URL in place. Refresh native link targets
  // when focused or activated, including middle-click and the context menu.
  for (const event of ['focusin', 'pointerdown', 'click']) nav.addEventListener(event, syncLinks);
}
