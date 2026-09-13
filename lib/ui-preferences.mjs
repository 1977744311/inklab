// ui-preferences.mjs — InkLab 工作台的纯 UI 选项。
// 不读 DOM/localStorage，让主题、控制分组与窄屏 Inspector 策略可独立测试。

export const UI_THEMES = Object.freeze(['dark', 'light']);
export const CONTROL_GROUPS = Object.freeze(['interaction', 'devices', 'sensors', 'all']);

export function normalizeUiTheme(value, fallback = 'dark') {
  const safeFallback = UI_THEMES.includes(String(fallback)) ? String(fallback) : 'dark';
  return UI_THEMES.includes(String(value)) ? String(value) : safeFallback;
}

export function nextUiTheme(value) {
  return normalizeUiTheme(value) === 'dark' ? 'light' : 'dark';
}

export function normalizeControlGroup(value) {
  return CONTROL_GROUPS.includes(String(value)) ? String(value) : 'interaction';
}

export function storedBoolean(value, fallback = false) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return Boolean(fallback);
}

export function initialInspectorCollapsed(viewportWidth, storedValue = null) {
  if (storedValue !== null && storedValue !== undefined && storedValue !== '') {
    return storedBoolean(storedValue, false);
  }
  return Number(viewportWidth) <= 1260;
}
