// dom.js — DOM 小工具：按 id 取元素、日志/启动面板写行、HTML 转义。其余模块都建立在它上面。

export const $ = (id) => document.getElementById(id);
export const panes = {
  boot: $('pane-boot'), log: $('pane-log'), network: $('pane-network'), caps: $('pane-caps'),
  scenario: $('pane-scenario'), files: $('pane-files'), evidence: $('pane-evidence'),
};

export function write(pane, msg, cls = '') {
  const el = panes[pane];
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.insertAdjacentHTML('beforeend', `<div class="row ${cls}">${msg}</div>`);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
export const boot = (m, c) => write('boot', m, c);

export const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
