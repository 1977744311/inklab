import { createMirrorView } from '/host/device-mirror.js';
const $ = (id) => document.getElementById(id);
const state = { target: 'real-glasses', ready: false, status: null, scenarios: [], lastScenario: null,
  token: '', busy: false, runId: null, screen: null };
window.__inklab = state;
const labels = { running: '运行中', passed: '画面断言通过', failed: '失败', unsupported: '不支持',
  'pending-review': '待看图确认', cancelled: '已停止' };
async function api(path, body) {
  const response = await fetch(`/api/device/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-inklab-device-token': state.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function note(text, error = false) { $('device-note').textContent = text; $('device-note').classList.toggle('error', error); }
function controls() {
  const connected = state.status?.enabled && state.status?.devices.some((d) => d.serial === state.status.serial && d.state === 'device');
  for (const button of document.querySelectorAll('[data-key],#capture,#wake,#say,#run')) button.disabled = state.busy || !connected;
  $('say').disabled ||= !state.status?.capabilities.asrText;
  $('run').disabled ||= !selectedScenario()?.support.supported;
  $('connect').disabled = state.busy || !state.status?.enabled;
  $('stop').disabled = !state.runId || !state.busy;
  $('mirror-toggle').disabled = mirrorView.state().starting || (!connected && !mirrorView.state().active);
}
const mirrorView = createMirrorView({ api, onState: () => controls(), onNote: note,
  hasEvidence: () => Boolean(state.screen) });
function displayShot(shot) {
  state.screen = shot;
  $('screen').src = shot.url; $('screen').style.display = 'block'; $('empty').hidden = true;
  $('screen').alt = `眼镜原图 ${shot.name}，${shot.width}×${shot.height}`;
  $('frame-meta').dataset.evidence = `${shot.width}×${shot.height} · ADB 原图 · ${new Date(shot.at).toLocaleTimeString()}`;
  $('frame-meta').textContent = $('frame-meta').dataset.evidence;
  $('download-image').href = shot.url; $('download-image').hidden = false;
  $('ocr').textContent = shot.ocr?.status === 'available' ? shot.ocr.text || '未识别到文字'
    : shot.ocr?.reason || '本张图未请求文字识别。';
  mirrorView.evidenceChanged();
}
async function refresh() {
  state.status = await api('status'); state.token = state.status.token;
  $('device-select').replaceChildren(...state.status.devices.map((d) => {
    const option = document.createElement('option'); option.value = d.serial;
    option.textContent = `${d.model || 'Android'} · ${d.serial} · ${d.state}`;
    option.disabled = d.state !== 'device'; return option;
  }));
  if (state.status.serial) $('device-select').value = state.status.serial;
  $('connection').textContent = state.status.serial || (state.status.enabled ? '未选择设备' : '未启用真机');
  $('connection').classList.toggle('connected', state.status.devices.some((d) => d.serial === state.status.serial && d.state === 'device'));
  if (!state.status.enabled) note('请用 npm run inklab -- <工程目录> --device 启动服务。');
  else if (state.status.error) note(state.status.error, true);
  else note(state.status.capabilities.asrText ? '文字模拟需要眼镜当前运行已启用调试入口的包。' : '当前工程支持按键和截图；文字模拟需增加应用适配器。');
  state.scenarios = await api('scenarios');
  const previous = $('scenario-select').value;
  $('scenario-select').replaceChildren(...state.scenarios.map((scene) => {
    const option = document.createElement('option'); option.value = scene.id;
    option.textContent = `${scene.support.supported ? '' : '[不支持] '}${scene.title || scene.id}`; return option;
  }));
  if (state.scenarios.some((s) => s.id === previous)) $('scenario-select').value = previous;
  renderScenario();
  const manifest = await fetch('/api/manifest').then((r) => r.json());
  $('coverage').replaceChildren();
  const item = (text) => { const el = document.createElement('div'); el.className = 'coverage-item'; el.textContent = text; $('coverage').append(el); };
  item(`真实按键 / 原始截图：支持；识别文字：${state.status.capabilities.asrText ? '应用调试包' : '不支持'}；OCR：${state.status.ocr.available ? '本机 Vision' : state.status.ocr.reason || '不可用'}`);
  item('不能自动验证麦克风识音、TTS 完播；不能注入 mock caps、存储种子、传感器或模型录带。');
  for (const file of manifest.e2e?.scenarios || []) item(`${file.split('/').pop()} · 不支持直接移植：请提供 e2e/device-scenarios/ 真机步骤。`);
  const latest = state.status.recentRuns?.find((r) => r.status !== 'running');
  if (latest && !state.lastScenario && !state.busy) {
    const run = await api(`run/${latest.id}`);
    const scene = state.scenarios.find((s) => s.id === latest.scenarioId);
    if (scene && run.report) {
      $('scenario-select').value = scene.id; renderScenario(); renderEvents(run, scene);
      state.lastScenario = run.report;
      $('export').disabled = false;
      $('run-state').textContent = labels[run.status] || run.status;
      $('run-state').dataset.status = run.status;
      $('report-location').textContent = run.reportFile || '';
    }
  }
  state.ready = true; controls(); return state.status;
}
function selectedScenario() { return state.scenarios.find((s) => s.id === $('scenario-select').value); }
function renderScenario() {
  const scene = selectedScenario();
  $('scenario-description').textContent = scene ? [scene.summary, scene.device?.readOnly ? '只读场景，不记录训练。' : '',
    ...(scene.support.reasons || [])].filter(Boolean).join(' ') : '工程暂无 e2e/device-scenarios/*.json 场景。';
  controls();
}
async function act(fn) {
  if (state.busy) return;
  state.busy = true; controls();
  try { return await fn(); } catch (err) { note(err.message, true); throw err; }
  finally { state.busy = false; controls(); }
}
async function command(args) {
  return act(async () => {
    const receipt = await api('command', args);
    displayShot(await api('capture', { name: `manual-${args.command}`, ocr: true }));
    note('输入已发送；请核对真实画面，发送成功不等于业务通过。');
    return receipt;
  });
}
function renderEvents(run, scene) {
  const events = new Map();
  for (const event of run.events) events.set(event.index, event);
  $('steps').replaceChildren(...(scene.device?.steps || []).map((step, index) => {
    const event = events.get(index); const row = document.createElement('div');
    row.className = `step ${!event ? 'pending' : event.phase === 'start' ? 'active' : event.ok ? 'passed' : 'failed'}`;
    const label = document.createElement('div'); label.className = 'label';
    const text = document.createElement('span'); text.textContent = `${index + 1}. ${step.label || event?.kind || Object.keys(step)[0]}`;
    const status = document.createElement('span'); status.textContent = !event ? '未执行' : event.phase === 'start' ? '执行中…'
      : event.ok ? event.verification === 'screenshot-ocr' ? '画面匹配' : '已完成' : '未通过';
    label.append(text, status); row.append(label);
    if (event?.reason) { const reason = document.createElement('small'); reason.textContent = event.reason; row.append(reason); }
    return row;
  }));
  const shots = run.events.filter((e) => e.phase === 'end' && e.screenshot).map((e) => e.screenshot);
  $('shots').replaceChildren(...shots.map((shot) => {
    const img = document.createElement('img'); img.src = shot.url; img.alt = shot.name; img.title = shot.name;
    img.onclick = () => { displayShot(shot); mirrorView.showEvidence(); }; return img;
  }));
  if (shots.length) displayShot(shots[shots.length - 1]);
}
async function runScenario(id = $('scenario-select').value) {
  const scene = state.scenarios.find((s) => s.id === id);
  if (!scene) throw new Error('没有这个真机场景');
  return act(async () => {
    const started = await api('run', { id }); state.runId = started.id; controls();
    $('export').disabled = true;
    let run;
    do {
      run = await api(`run/${started.id}`);
      renderEvents(run, scene);
      $('run-state').textContent = labels[run.status] || run.status;
      $('run-state').dataset.status = run.status;
      if (run.status === 'running') await new Promise((r) => setTimeout(r, 500));
    } while (run.status === 'running');
    state.lastScenario = run.report;
    $('export').disabled = !run.report;
    $('report-location').textContent = run.reportFile || '';
    note(run.report?.summary || run.error || run.status, run.status === 'failed');
    state.runId = null;
    return run.report;
  });
}
const handle = (fn) => () => { Promise.resolve().then(fn).catch((err) => note(err.message, true)); };
$('refresh').onclick = handle(refresh);
$('mirror-toggle').onclick = handle(() => mirrorView.toggle());
$('connect').onclick = handle(async () => { await api('select', { serial: $('device-select').value }); await refresh(); });
$('capture').onclick = handle(() => act(async () => displayShot(await api('capture', { name: 'manual', ocr: true }))));
for (const button of document.querySelectorAll('[data-key]')) button.onclick = handle(() => command({ command: 'key', value: button.dataset.key, waitMs: 900 }));
$('say').onclick = handle(() => command({ command: 'say', value: $('speech').value, waitMs: 800 }));
$('wake').onclick = handle(() => command({ command: 'wake-assistant', waitMs: 300 }));
$('scenario-select').onchange = renderScenario;
$('run').onclick = handle(() => runScenario());
$('stop').onclick = handle(() => api('stop', {}));
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.lastScenario, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${state.lastScenario.scenarioId}-run.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
Object.assign(state, { refresh, runScenario, command,
  snapshot: (name) => act(async () => { const shot = await api('capture', { name, ocr: true }); displayShot(shot); return shot; }),
  exportRun: () => state.lastScenario });
refresh().catch((err) => note(err.message, true));
