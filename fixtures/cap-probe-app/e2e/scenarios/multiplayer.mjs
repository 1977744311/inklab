// Real browser/API isolation probe. No product fixtures or service dependencies.
export default {
  id: 'multiplayer', title: '多玩家输入与存储隔离', summary: '独立 realm、设备种子、输入、localStorage 和 OPFS',
  build({ players, driver }) {
    let before;
    return [
      { label: '至少两个独立玩家', expect: () => players.length >= 2 && players.every((p) => p.lab.ready) },
      { label: '就绪后界面放行控件已接线', do: () => {
        const root = players[0].window.parent;
        root.document.getElementById('allow-pattern').value = 'allowed.example.test';
        root.document.getElementById('allow-add').click();
        if (!players.every(p => !p.caps.net.wouldStubExternal('https://allowed.example.test/a'))) throw new Error('界面控件尚未接线');
      } },
      { label: '记录输入与写入玩家一存储', do: async () => {
        before = players.map((p) => p.lab.evidence.entries.filter((e) => e.kind === 'input.key').length);
        players[0].window.localStorage.setItem('isolation-probe', 'player-one');
        const root = await players[0].window.navigator.storage.getDirectory();
        const file = await root.getFileHandle('isolation-probe', { create: true });
        const writer = await file.createWritable(); await writer.write('player-one'); await writer.close();
        await players[0].press('ArrowDown');
      } },
      { label: '按键没有广播给别的玩家', expect: () => players.every((p, i) =>
        p.lab.evidence.entries.filter((e) => e.kind === 'input.key').length === before[i] + (i === 0 ? 2 : 0)) },
      { label: '真实键盘与 Mac Option 快捷键路由', do: () => {
        const root = players[0].window.parent;
        root.dispatchEvent(new root.KeyboardEvent('keydown', { key: '™', code: 'Digit2', altKey: true }));
        if (root.__inklab.activePlayer !== 1) throw new Error('Option+2 未切换');
        const counts = players.map(p => p.lab.evidence.entries.filter(e => e.kind === 'input.key').length);
        for (const type of ['keydown', 'keyup']) root.dispatchEvent(new root.KeyboardEvent(type, { key: 'Enter', code: 'Enter' }));
        if (!players.every((p, i) => p.lab.evidence.entries.filter(e => e.kind === 'input.key').length === counts[i] + (i === 1 ? 2 : 0))) throw new Error('真实键盘广播了输入');
        root.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' }));
        if (root.__inklab.activePlayer !== 2 % players.length) throw new Error('Tab 未切换');
        root.__inklab.selectPlayer(0);
      } },
      { label: '存储与设备种子独立', do: async () => {
        const seeds = players.map((p) => p.window.localStorage.getItem('ink.host.identity.device_seed.v1'));
        if (seeds.some((s) => !s) || new Set(seeds).size !== players.length) throw new Error('设备种子未隔离');
        for (const p of players.slice(1)) {
          if (p.window.localStorage.getItem('isolation-probe') !== null) throw new Error('localStorage 泄漏');
          const root = await p.window.navigator.storage.getDirectory();
          try { await root.getFileHandle('isolation-probe'); throw new Error('OPFS 泄漏'); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
        players[0].window.localStorage.removeItem('isolation-probe');
        await (await players[0].window.navigator.storage.getDirectory()).removeEntry('isolation-probe');
      } },
      { label: '每个玩家分别取证', do: () => { for (const p of players) p.shot('isolated'); } },
      { label: '主玩家截图', do: () => driver.shot('multiplayer-primary') },
    ];
  },
};
