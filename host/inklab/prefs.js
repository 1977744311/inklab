// prefs.js — 界面偏好：主题 / 控制台分组 / 说明开关 / Inspector 折叠，及其 localStorage 持久化。

import { nextUiTheme, normalizeControlGroup, normalizeUiTheme } from '/host/lib/ui-preferences.mjs';
import { $ } from '/host/inklab/dom.js';
import { state } from '/host/inklab/state.js';

export const UI_PREF_KEYS = Object.freeze({
  theme: 'inklab.theme',
  controls: 'inklab.controls',
  hints: 'inklab.hints',
  inspector: 'inklab.inspectorCollapsed',
});
export const readUiPref = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeUiPref = (key, value) => {
  try { localStorage.setItem(key, String(value)); } catch { /* 禁用存储时本轮仍可用 */ }
};

export function applyUiTheme(value, { persist = true } = {}) {
  const theme = normalizeUiTheme(value, state.theme);
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const next = nextUiTheme(theme);
  const button = $('theme-toggle');
  if (button) {
    button.innerHTML = `${theme === 'dark' ? '☀' : '◐'}<span class="button-label">${next === 'light' ? '浅色' : '暗色'}</span>`;
    button.title = `切换到${next === 'light' ? '浅色' : '暗色'}界面`;
    button.setAttribute('aria-label', button.title);
  }
  if (persist) writeUiPref(UI_PREF_KEYS.theme, theme);
  return theme;
}

export function applyControlGroup(value, { persist = true } = {}) {
  const group = normalizeControlGroup(value);
  state.controlGroup = group;
  const grid = $('control-grid');
  if (grid) {
    grid.dataset.group = group;
    grid.scrollTop = 0;
  }
  for (const tab of document.querySelectorAll('[data-control-target]')) {
    const selected = tab.dataset.controlTarget === group;
    tab.classList.toggle('on', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  if (persist) writeUiPref(UI_PREF_KEYS.controls, group);
  return group;
}

export function applyHintsVisibility(value, { persist = true } = {}) {
  const visible = Boolean(value);
  state.hintsVisible = visible;
  document.body.classList.toggle('show-hints', visible);
  const button = $('hints-toggle');
  if (button) {
    button.classList.toggle('on', visible);
    button.setAttribute('aria-pressed', String(visible));
    button.textContent = visible ? '收起说明' : '说明';
  }
  if (persist) writeUiPref(UI_PREF_KEYS.hints, visible ? '1' : '0');
  return visible;
}

export function applyInspectorCollapsed(value, { persist = true } = {}) {
  const collapsed = Boolean(value);
  state.inspectorCollapsed = collapsed;
  document.body.classList.toggle('inspector-collapsed', collapsed);
  const button = $('inspector-toggle');
  if (button) {
    button.classList.toggle('on', !collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.innerHTML = `${collapsed ? '◨' : '◧'}<span class="button-label">Inspector</span>`;
    button.title = collapsed ? '展开 Inspector' : '收起 Inspector';
  }
  if (persist) writeUiPref(UI_PREF_KEYS.inspector, collapsed ? '1' : '0');
  return collapsed;
}
