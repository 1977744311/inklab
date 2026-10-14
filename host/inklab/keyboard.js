// keyboard.js — 真实键盘：窗口级 keydown/keyup 统一走 sendInput（原因见 inklab.js 头注第 2 条）。

import { state } from '/host/inklab/state.js';
import { sendInput } from '/host/inklab/input.js';

// ── 真实键盘 ────────────────────────────────────────────────────────────

// 引擎 bindDomEvents 送进 wasm 的键名是 `event.code || event.key`（glue `Ht`），这里对齐。
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Backspace', 'Space']);
const isTypingTarget = (el) => Boolean(el) && (
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
);

function onKeyEvent(ev) {
  if (isTypingTarget(ev.target)) return;             // 在控制台输入框里打字不该推应用
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // 别抢浏览器快捷键
  if (!state.stages.length) return;
  const key = ev.code || ev.key;
  if (NAV_KEYS.has(key)) ev.preventDefault();        // 方向键别滚页面、Backspace 别触发后退
  try { sendInput(ev.type === 'keydown' ? 'keydown' : 'keyup', key); } catch { /* 未知键名不该炸页面 */ }
}
window.addEventListener('keydown', onKeyEvent);
window.addEventListener('keyup', onKeyEvent);
