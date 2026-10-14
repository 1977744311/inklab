// engine-log.js — 接管 console：引擎自己的日志（带 Rust 源码路径）进日志面板，并原样转给真 console。

import { esc, write } from '/host/inklab/dom.js';

// 引擎把自己的日志直接打到浏览器 console（带 Rust 源码路径）。接管一份进日志面板，
// 原样转发给真 console，方便 DevTools 与自动化两边都能取证。
export const engineLog = [];
window.__inklab_engineLog = engineLog;
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
    if (text.startsWith('[inklab]')) return;                 // 宿主自己的日志不回灌
    const clean = text.replace(/%c/g, '').replace(/color:[^;]*;?|background:[^;]*;?|padding:[^;]*;?|font-weight:[^;]*;?/g, '').trim();
    engineLog.push({ level, text: clean });
    try { write('log', esc(clean), level === 'error' ? 'err' : level === 'warn' ? 'warn' : 'dim'); } catch { /* 面板还没建好 */ }
  };
}
