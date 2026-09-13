import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeUiTheme, nextUiTheme, normalizeControlGroup, storedBoolean, initialInspectorCollapsed,
} from '../lib/ui-preferences.mjs';

test('主题只有浅色/暗色，非法值回到安全默认', () => {
  assert.equal(normalizeUiTheme('light'), 'light');
  assert.equal(normalizeUiTheme('unknown'), 'dark');
  assert.equal(nextUiTheme('dark'), 'light');
  assert.equal(nextUiTheme('light'), 'dark');
});

test('能力分组默认是交互，不会恢复一个已删除的页签', () => {
  assert.equal(normalizeControlGroup('devices'), 'devices');
  assert.equal(normalizeControlGroup('old-tab'), 'interaction');
});

test('Inspector 在窄屏默认收起，但用户显式选择永远优先', () => {
  assert.equal(initialInspectorCollapsed(1260), true);
  assert.equal(initialInspectorCollapsed(1261), false);
  assert.equal(initialInspectorCollapsed(900, '0'), false);
  assert.equal(initialInspectorCollapsed(1800, '1'), true);
  assert.equal(storedBoolean('true'), true);
  assert.equal(storedBoolean('false', true), false);
});
