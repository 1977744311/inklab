import { createMirrorView } from '/host/device-mirror.js';
import { playerUrl } from '/host/lib/multiplayer.mjs';
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
  for (const button of document.querySelectorAll('[data-gesture],#capture,#wake,#say,#run,#push,#open-agent,#exit-agent,#imu-apply')) button.disabled = state.busy || !connected;
  $('push').disabled ||= Boolean(state.status?.agentError) || state.status?.push?.status === 'running';
  $('say').disabled ||= !state.status?.capabilities.asrText;
  $('wake').disabled ||= !state.status?.capabilities.wakeAssistant;
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
  // 切到真机页就启用（普通启动不碰 ADB）；还没选设备时让服务端自动选（只连着一副眼镜时）
  if (!state.status.enabled || !state.status.serial) state.status = await api('enable', {});
  $('device-select').replaceChildren(...state.status.devices.map((d) => {
    const option = document.createElement('option'); option.value = d.serial;
    option.textContent = `${d.model || 'Android'} · ${d.serial} · ${d.state}`;
    option.disabled = d.state !== 'device'; return option;
  }));
  if (state.status.serial) $('device-select').value = state.status.serial;
  const connected = state.status.devices.some((d) => d.serial === state.status.serial && d.state === 'device');
  $('connection').textContent = state.status.serial || (state.status.enabled ? '未选择设备' : '未启用真机');
  $('connection').classList.toggle('connected', connected);
  if (state.status.error) note(state.status.error, true);
  else if (state.status.deviceError) note(state.status.deviceError, true);
  else note(connected ? '眼镜已连接。点「推到真机」装上调试包并打开，或在眼镜里手动打开应用。'
    : state.status.devices.some((d) => d.state === 'device') ? '连着几副眼镜：选一副，点「连接」。'
      : '没找到眼镜：用 USB 连上并在眼镜上允许调试，或先 inklab-device wifi 打开无线调试。连上后几秒内自动选上。');
  renderDevice();
  renderPush();
  renderImu().catch(() => {});
  alignSimulator();
  connectLogs();
  state.scenarios = await api('scenarios');
  const scenarioSelect = $('scenario-select');
  const previous = scenarioSelect.value;
  scenarioSelect.replaceChildren(...state.scenarios.map((scene) => {
    const option = document.createElement('option'); option.value = scene.id;
    option.textContent = `${scene.support.supported ? '' : '[不支持] '}${scene.title || scene.id}`; return option;
  }));
  scenarioSelect.disabled = !state.scenarios.length;
  if (scenarioSelect.disabled) scenarioSelect.add(new Option('暂无真机场景', ''));
  if (state.scenarios.some((s) => s.id === previous)) scenarioSelect.value = previous;
  renderScenario();
  $('coverage').replaceChildren();
  const item = (text) => { const el = document.createElement('div'); el.className = 'coverage-item'; el.textContent = text; $('coverage').append(el); };
  item(`真实按键 / 原始截图：支持；识别文字：${state.status.capabilities.asrText ? '应用调试包' : '不支持'}；OCR：${state.status.ocr.available ? '本机 Vision' : state.status.ocr.reason || '不可用'}`);
  item('不能自动验证麦克风识音、TTS 完播；不能注入 mock caps、存储种子、传感器或模型录带。');
  item('模拟器的 .mjs 场景也会列出来：只用按键、等待、截图的可以直接在真机上跑（方向键按触控板手势做），跑完生成和模拟器同名截图的对照页；用到 do / expect 或模拟硬件的标为不支持。');
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
function renderDevice() {
  const device = state.status?.device;
  const match = state.status?.runtimeMatch;
  const how = { exact: '构建号一致', 'same-version': '同一版本', 'same-minor': '同一版本线', 'nearest-older': '最接近的旧版本', nearest: '最接近' };
  $('device-facts').textContent = device
    ? `${device.model || '眼镜'} · Android ${device.android || '?'} · Ink ${device.ink?.version || '未知'}`
      + (match ? ` ↔ 模拟器 ${match.id}（${how[match.match] || match.match}）` : '')
      + (device.touchpad ? ` · 触控板 ${device.touchpad.name}` : ' · 没有触控板档案')
    : '';
  $('device-warnings').replaceChildren(...(state.status?.warnings || []).map((w) => {
    const li = document.createElement('li'); li.className = w.level; li.textContent = w.text; return li;
  }));
}
const pushLabels = { idle: '未推送', running: '推送中', done: '已推送', queued: '已装上 · 未显示', failed: '失败' };
/** 推送前关掉助手的结果：销毁了几个旧实例。 */
const reclaimLabel = (r) => (!r || r.already ? '' : r.closed ? `回收旧实例 ${r.dropped} 个` : '助手没关掉，旧实例还在');

function renderPush() {
  const s = state.status;
  if (!s) return;
  const push = s.push || { status: 'idle' };
  $('push-agent').textContent = s.agentError || (s.agent ? `${s.agent.agentName} · ${s.agent.agentId}` : '');
  const select = $('push-page');
  const pages = s.pages || [];
  if (select.dataset.pages !== pages.join('|')) {
    select.replaceChildren(...pages.map((page) => new Option(page, page)));
    select.dataset.pages = pages.join('|');
  }
  if (push.page && pages.includes(push.page) && document.activeElement !== select) select.value = push.page;
  $('auto-push').checked = push.auto === true;
  $('push-state').textContent = pushLabels[push.status] || push.status;
  $('push-state').dataset.status = push.status;
  const seconds = push.finishedAt && push.startedAt ? `${((push.finishedAt - push.startedAt) / 1000).toFixed(1)} 秒` : '';
  $('push-note').textContent = push.status === 'running' ? `${push.trigger === 'save' ? '保存后自动推送' : '推送'}：${push.stage || ''}…`
    : push.status === 'failed' ? `第「${push.stage || '?'}」步失败：${push.error}`
      : push.status === 'done' || push.status === 'queued'
        ? [`${push.trigger === 'save' ? '保存后自动推送' : '推送'}完成 ${seconds}`, push.installed?.outcome, reclaimLabel(push.reclaimed),
          push.opened?.note || push.note].filter(Boolean).join(' · ')
        : push.pending ? '源码有改动，等手头的操作结束后推送' : '本机调试安装：打包 → 装上调试包 → 关掉助手回收旧实例 → 打开 → 截图，不经过手机和 Studio。';
  $('push-note').classList?.toggle('error', push.status === 'failed');
  if (push.screenshot && push.screenshot.id !== state.pushShot) {
    state.pushShot = push.screenshot.id;
    displayShot(push.screenshot);
  }
}
let simulatorAligned = false;
function alignSimulator() {
  const frame = $('simulator-frame');
  if (simulatorAligned || $('simulator-panel').hidden || !frame.dataset.base) return;
  const url = new URL(frame.dataset.base);
  const lane = state.status?.runtimeMatch?.id;
  if (lane && !url.searchParams.has('runtimes')) url.searchParams.set('runtimes', lane);
  frame.src = playerUrl(url.href, 0, 1, { embedded: true });
  simulatorAligned = true;
  if (lane) $('simulator-note').textContent = `模拟器引擎 ${lane}，对齐眼镜上的 Ink ${state.status.device?.ink?.version}。两端加入同一房间。网络开关只影响模拟器。`;
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
async function command(args, { capture = true } = {}) {
  return act(async () => {
    const receipt = await api('command', args);
    if (capture) displayShot(await api('capture', { name: `manual-${args.command}`, ocr: true }));
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
    $('compare-link').hidden = !run.report?.compare?.url;
    if (run.report?.compare?.url) $('compare-link').href = run.report.compare.url;
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
for (const button of document.querySelectorAll('[data-gesture]')) button.onclick = handle(() => {
  const { active, mode } = mirrorView.state();
  const live = active && mode === 'live';
  return command({ command: 'gesture', value: button.dataset.gesture, waitMs: live ? 0 : 900 }, { capture: !live });
});
const pushAction = (route, body = {}) => act(async () => {
  const result = await api(route, body);
  await refresh();
  if (route === 'open' || route === 'exit') note(result.note || (route === 'open' ? (result.presented ? '已打开' : '已发出打开请求') : (result.left ? '已退出' : '没有退出')));
  return result;
});
$('push').onclick = handle(() => pushAction('push', { page: $('push-page').value }));
$('open-agent').onclick = handle(() => pushAction('open', { page: $('push-page').value }));
$('exit-agent').onclick = handle(() => pushAction('exit'));
$('auto-push').onchange = handle(async () => { await api('auto-push', { enabled: $('auto-push').checked }); await refresh(); });
$('agents-section').ontoggle = handle(async () => { if ($('agents-section').open) await renderAgents(); });
async function renderAgents() {
  const agents = await api('agents');
  const mine = state.status?.agent?.agentId;
  $('agents-list').replaceChildren(...(agents.length ? agents : [null]).map((agent) => {
    const li = document.createElement('li');
    if (!agent) { li.textContent = '眼镜上还没有调试包'; return li; }
    const label = document.createElement('span');
    label.textContent = `${agent.agentName || agent.agentId}${agent.agentId === mine ? '（本工程）' : ''} `;
    const id = document.createElement('small'); id.textContent = `${agent.agentId} · ${agent.nativeVersion}`; label.append(id);
    const open = document.createElement('button'); open.textContent = '打开';
    open.onclick = handle(() => pushAction('open', agent.agentId === mine ? { page: $('push-page').value } : { agentId: agent.agentId }));
    li.append(label, open); return li;
  }));
}

// ── 真机日志：服务端读 logcat，挑出应用日志、运行时事件和引擎日志，SSE 推过来 ──
const logSources = () => new Set([...document.querySelectorAll('[data-log-source]:checked')].map((box) => box.dataset.logSource));
const logLabels = { app: '应用', aiui: '运行时', ink: '引擎' };
function appendLog(entry) {
  const list = $('device-logs');
  const li = document.createElement('li');
  li.dataset.source = entry.source; li.dataset.level = entry.level;
  li.hidden = !logSources().has(entry.source);
  const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
  const src = document.createElement('span'); src.className = 'src'; src.textContent = logLabels[entry.source] || entry.source;
  li.append(`${time} `, src, ` ${entry.text}`);
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
  list.append(li);
  while (list.children.length > 500) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}
let logStream = null;
function connectLogs() {
  if (logStream || !state.token || !state.status?.serial) return;
  logStream = new EventSource(`/api/device/logs/events/${state.token}`);
  logStream.onmessage = (event) => { try { appendLog(JSON.parse(event.data)); } catch { /* 坏行跳过 */ } };
  logStream.onerror = () => { logStream?.close(); logStream = null; };
}
for (const box of document.querySelectorAll('[data-log-source]')) box.onchange = () => {
  const show = logSources();
  for (const li of $('device-logs').children) li.hidden = !show.has(li.dataset.source);
};
$('logs-clear').onclick = () => $('device-logs').replaceChildren();
// ── 模拟 IMU ──
const imuLabels = { real: '真实传感器', replay: '回放', live: '实时', record: '录制' };
async function renderImu() {
  if (!state.status?.enabled) return;
  const imu = await api('imu');
  state.imu = imu;
  const mode = $('imu-mode');
  if (document.activeElement !== mode && !mode.dataset.dirty) mode.value = imu.settings.mode;
  const traceSelect = $('imu-trace');
  const ids = imu.traces.map((t) => t.id);
  if (traceSelect.dataset.ids !== ids.join('|')) {
    const prev = traceSelect.value || imu.settings.trace;
    traceSelect.replaceChildren(new Option(ids.length ? '选轨迹…' : '工程里还没有轨迹（e2e/traces/）', ''), ...ids.map((id) => new Option(id, id)));
    traceSelect.dataset.ids = ids.join('|');
    if (ids.includes(prev)) traceSelect.value = prev;
    renderSegments();
  }
  const view = mode.value;
  $('imu-trace-row').hidden = view !== 'replay' && view !== 'live';
  $('imu-live-panel').hidden = view !== 'live';
  $('imu-record-panel').hidden = view !== 'record';
  const installed = imu.installed?.mode || 'real';
  $('imu-state').textContent = `眼镜上：${imuLabels[installed]}`;
  const rec = imu.recording;
  const sensors = Object.entries(rec.sensors || {}).map(([n, v]) => `${n} ${v.seconds}s`).join(' · ');
  $('imu-note').textContent = view === 'record'
    ? (sensors ? `已收到：${sensors}${rec.errors?.length ? ` · 错误 ${rec.errors.map((e) => `${e.sensor} ${e.error}`).join('、')}` : ''}` : '推送录制模式的包并打开应用后，读数会出现在这里')
    : view === 'live' ? (imu.live.connected ? `已连上眼镜 · ${(imu.live.state?.sessions || []).map((s) => `${s.sensor} ${s.source}`).join('、') || '应用还没开传感器'}` : '眼镜上的实时调试包还没连上（推送实时模式的包并打开应用）')
      : view === 'replay' ? '选一条轨迹（可以只放其中一段），切换并推送后每次传感器 start 都从头放' : '正常调试包，用眼镜的真传感器';
}
function renderSegments() {
  const trace = state.imu?.traces.find((t) => t.id === $('imu-trace').value);
  const segments = trace?.segments || [];
  $('imu-segment').replaceChildren(new Option('整条', ''), ...segments.map((s) => new Option(`${s.label || s.id}（${Math.round(s.durationMs / 1000)}s）`, s.id)));
  if (state.imu?.settings.trace === $('imu-trace').value && state.imu.settings.segment) $('imu-segment').value = state.imu.settings.segment;
}
$('imu-mode').onchange = () => { $('imu-mode').dataset.dirty = '1'; renderImu().catch(() => {}); };
$('imu-trace').onchange = renderSegments;
$('imu-apply').onclick = handle(async () => {
  await api('imu/mode', { mode: $('imu-mode').value, trace: $('imu-trace').value, segment: $('imu-segment').value, loop: $('imu-loop').checked });
  delete $('imu-mode').dataset.dirty;
  await pushAction('push', { page: $('push-page').value });
  await renderImu();
});
const imuLive = (body, done) => handle(async () => { const r = await api('imu/live', body()); $('imu-note').textContent = done(r); });
$('imu-live-play').onclick = imuLive(() => ({ type: 'play', trace: $('imu-trace').value, segment: $('imu-segment').value, loop: $('imu-loop').checked }),
  (r) => `已下发：${r.sensors.join('、')}`);
$('imu-live-clear').onclick = imuLive(() => ({ type: 'clear' }), () => '已回到真传感器');
$('imu-live-error').onclick = imuLive(() => ({ type: 'error', sensor: $('imu-fault-sensor').value, error: $('imu-fault').value, message: 'InkLab 注入' }),
  (r) => `已注入 ${r.sensors[0]} 故障（粘性，要手动清除）`);
$('imu-live-clear-error').onclick = imuLive(() => ({ type: 'clearError' }), () => '已清除故障');
$('imu-save').onclick = handle(async () => {
  const seconds = $('imu-seconds').value.trim();
  const saved = await api('imu/save', { name: $('imu-name').value.trim(), ...(seconds ? { lastSeconds: Number(seconds) } : {}) });
  $('imu-note').textContent = `已存：e2e/traces/${saved.id}.json · ${(saved.durationMs / 1000).toFixed(1)}s`;
  await renderImu();
});
$('imu-mark').onclick = handle(async () => { const m = await api('imu/mark', { label: $('imu-name').value.trim() || '标记' }); $('imu-note').textContent = `已打标记「${m.label}」`; });
$('imu-clear').onclick = handle(async () => { await api('imu/clear', {}); await renderImu(); });

// 保存即推送由服务端触发：页面轮询状态，把推送进度和推送后的截图显示出来。
setInterval(() => {
  if (!state.ready || state.busy || document.hidden || !state.status?.enabled) return;
  // 还没选上眼镜：等它连上就自动选（选上了才整页刷新）
  if (!state.status.serial) { api('enable', {}).then((status) => { if (status.serial) refresh(); }).catch(() => {}); return; }
  api('status').then((status) => { state.status = status; renderPush(); controls(); }).catch(() => {});
  renderImu().catch(() => {});
}, 3000);
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

if (new URLSearchParams(location.search).get('simulator') === '1') {
  document.title = 'InkLab · 真机 + 模拟器';
  const frame = $('simulator-frame');
  const url = new URL(location.href);
  url.pathname = '/'; url.searchParams.delete('simulator');
  url.searchParams.set('hybrid-seat', '1');
  url.searchParams.set('preview', 'studio');
  // 等第一次拿到设备状态再加载：模拟器引擎要对齐眼镜上的 Ink 版本（alignSimulator）。
  frame.dataset.base = url.href;
  $('simulator-panel').hidden = false;
  document.querySelector('main').classList.add('hybrid');

  const controlSimulator = (fn, { requireReady = true } = {}) => async () => {
    const note = $('simulator-note');
    try {
      const lab = frame.contentWindow.__inklab;
      if (!lab?.reload || (requireReady && !lab.ready)) throw new Error(lab?.bootError || '模拟器正在启动');
      note.textContent = await fn(lab) || '';
    } catch (err) { note.textContent = err.message; }
  };
  for (const button of document.querySelectorAll('[data-sim-key]')) button.onclick = controlSimulator(lab => { lab.press(button.dataset.simKey); });
  // 真机手势同步到模拟器：发触控板真实会发的那几个键（前后滑各带两个方向）。
  const SIM_KEYS = { forward: ['ArrowRight', 'ArrowDown'], backward: ['ArrowLeft', 'ArrowUp'], tap: ['Enter'], 'double-tap': ['Backspace'] };
  for (const button of document.querySelectorAll('[data-gesture]')) {
    button.addEventListener('click', () => {
      if (!$('sync-gestures').checked || !SIM_KEYS[button.dataset.gesture]) return;
      controlSimulator(async (lab) => { for (const key of SIM_KEYS[button.dataset.gesture]) await lab.press(key); return `模拟器也收到了：${SIM_KEYS[button.dataset.gesture].join(' + ')}`; })();
    });
  }
  $('simulator-reload').onclick = controlSimulator(async lab => {
    await lab.reload();
    return lab.bootError;
  }, { requireReady: false });
  $('simulator-offline').onclick = controlSimulator(lab => { lab.caps.net.offline(); return '模拟器网络已断开'; });
  $('simulator-online').onclick = controlSimulator(lab => { lab.caps.net.online(); return '模拟器网络已恢复'; });
}
refresh().catch((err) => { note(err.message, true); alignSimulator(); });
