// inklab.js — 本地宿主：初始化引擎、把工程源码喂进去、把画面接到 canvas，
// 并把「驱动 / 场景 / 能力注入」这三件事接到页面上。
//
// 有两条接线口径是实测逼出来的，改之前先读 RUNTIME-NOTES 的《焦点与帧》一节：
//
//  1) **每次程序化输入之后必须自己 pump 帧**。引擎的帧调度是 requestAnimationFrame
//     （glue `Vr()`），而应用的步进要落在帧上——页面不可见（后台标签页 / 窗口被完全遮挡）
//     时 rAF 停摆，`dispatchInput` 只有第一下生效，后面全落空。`view.render()` 是公开且同步的，
//     调它就等于手摇一帧，与可见性无关。所以本文件里所有输入出口都走 `sendInput`/`wake`，
//     它们 dispatch 完立刻 pump。
//
//  2) **不开 `bindDomEvents({syncFocus:true})`**。InkView 焦点是引擎内部标志，
//     开了 syncFocus 之后 DOM 的 focus/blur 会被转发进去；而 Chrome 在标签页切后台时
//     会给当前聚焦元素发 blur —— 于是「窗口一切走 InkView 就 blurred，应用调 ASR 就报
//     `SpeechRecognition.start() is unavailable while InkView is blurred`」。
//     新建的 InkView 默认就是 focused，正常路径根本不需要装载期 focus。
//     要故意测 blurred，用能力控制台里的 focus()/blur() 两个钮。
//
//  键盘也因此不交给 bindDomEvents：它的 keydown 直接进 wasm，宿主既插不进 pump，
//  也没法把同一次输入镜像到第二块画布。宿主自己监听 window，统一走 sendInput。

import { createProbeCapabilities } from '/host/lib/caps/probe.mjs';
import { createHostCapabilities, createEventBridge } from '/host/lib/caps/index.mjs';
import { llmAllowExternal, replayModelFromSearch } from '/host/lib/caps/llm.mjs';
import {
  CAMERA_MODES, cameraModeFromSearch, hostCapabilitiesForCameraMode, normalizeCameraMode,
} from '/host/lib/camera-mode.mjs';
import {
  createComputerCameraTakePhoto, requestComputerCameraPermission,
} from '/host/lib/browser-camera.mjs';
import {
  BLUETOOTH_MODES, bluetoothModeFromSearch, createNavigatorBluetoothController,
  normalizeBluetoothMode,
} from '/host/lib/bluetooth-mode.mjs';
import {
  parseBluetoothBytes, parseBluetoothNotificationTraceJson,
} from '/host/lib/caps/bluetooth.mjs';
import {
  createSquatAccelerometerTrace, createHeadGestureOrientationTrace, parseSensorTraceJson,
} from '/host/lib/sensor-trace.mjs';
import { createDriver, assertInput } from '/host/lib/driver.mjs';
import { rgbaFrameHash } from '/host/lib/frame-hash.mjs';
import { createCanvasRecorder } from '/host/lib/recording.mjs';
import { createShotStore, diffPixels } from '/host/lib/shots.mjs';
import { createSourceStamp } from '/host/lib/stamp.mjs';
import { readProjectFile } from '/host/lib/project-file.mjs';
import { selectRuntimeIds, runtimeDisplayVersion } from '/host/lib/runtime-lock.mjs';
import {
  normalizeUiTheme, nextUiTheme, normalizeControlGroup, storedBoolean, initialInspectorCollapsed,
} from '/host/lib/ui-preferences.mjs';
import {
  LIGHTING_PROFILES, PREVIEW_MODES, normalizeLightingProfile, lightingProfile,
  normalizePreviewMode, previewMode, previewGeometry, paintPreviewFrame, compositePreviewCanvas,
} from '/host/lib/lighting.mjs';
import { createEvidenceLedger, instrumentCapabilities, redactEvidence } from '/host/lib/evidence.mjs';
import { SCENARIOS } from '/scenarios/index.mjs';

const $ = (id) => document.getElementById(id);
const panes = {
  boot: $('pane-boot'), log: $('pane-log'), network: $('pane-network'), caps: $('pane-caps'),
  scenario: $('pane-scenario'), files: $('pane-files'), evidence: $('pane-evidence'),
};

function write(pane, msg, cls = '') {
  const el = panes[pane];
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.insertAdjacentHTML('beforeend', `<div class="row ${cls}">${msg}</div>`);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
const boot = (m, c) => write('boot', m, c);

function showPane(name) {
  if (state.inspectorCollapsed) applyInspectorCollapsed(false);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.pane === name));
  for (const [k, el] of Object.entries(panes)) el.classList.toggle('on', k === name);
  refreshInspector();
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => showPane(tab.dataset.pane);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// 宿主自己取源码/清单用的 fetch：**在断网注入之前留一份**。
// 能力控制台的「断网」会换掉 globalThis.fetch（引擎的出网口就是它），
// 不留这一份的话一断网连「重载工程」都拉不到源码了。
const hostFetch = globalThis.fetch.bind(globalThis);

// ink_web 的蓝牙不是 hostCapabilities 命名空间，而是直接读 navigator.bluetooth。
// 控制器必须在第一次安装 mock 前保存原生对象，computer 模式才能无损恢复浏览器 Web Bluetooth。
const bluetoothController = createNavigatorBluetoothController();

// 引擎把自己的日志直接打到浏览器 console（带 Rust 源码路径）。接管一份进日志面板，
// 原样转发给真 console，方便 DevTools 与自动化两边都能取证。
const engineLog = [];
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

// ── rAF 保活 ────────────────────────────────────────────────────────────
//
// 无头/被判遮挡的 Chrome 可能长时间不派发 rAF（实测 >8s），而引擎 glue 的调度器——
// 页面挂载的续段、startRendering 的渲染循环——全排在 rAF 上。饿死的症状极隐蔽：
// 「页面模块 eval 了但 onLoad 永远不来」「语音导航随机丢」（e2e 实测约一半概率）。
// 手动 pump 只摇 wasm 帧，救不了 glue 层排队的 rAF 任务，反遮挡的 Chrome 旗子也治不住。
// 这里给每个 rAF 回调加一个 32ms 计时器保底：谁先到谁执行、只执行一次——
// 前台时真 rAF（约 16ms）更快，行为不变；rAF 停摆时计时器把队列续上。
// 必须在 import 引擎 glue 之前装好（glue 模块初始化时就会取 rAF 引用）。

const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const rafEntries = new Map();
window.requestAnimationFrame = (cb) => {
  const entry = { done: false, rafId: 0, timerId: 0 };
  const fire = (ts) => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timerId);
    nativeCancelRaf(entry.rafId);
    rafEntries.delete(entry.rafId);
    cb(typeof ts === 'number' ? ts : performance.now());
  };
  entry.rafId = nativeRaf(fire);
  entry.timerId = setTimeout(fire, 32);
  rafEntries.set(entry.rafId, entry);
  return entry.rafId;
};
window.cancelAnimationFrame = (id) => {
  const entry = rafEntries.get(id);
  if (entry) {
    entry.done = true;
    clearTimeout(entry.timerId);
    rafEntries.delete(id);
  }
  nativeCancelRaf(id);
};

// ── 帧泵 ────────────────────────────────────────────────────────────────

/** pump 一次最多摇多少帧。够一次 setData → 布局 → 绘制走完，又不至于卡住 UI 线程。 */
const PUMP_MAX = 24;

/**
 * 同步摇帧，直到引擎报告没有更多要画的（连续两次 render() 返回 false）。
 *
 * `view.render()` 是公开同步方法，返回「这一帧画了东西没有」。startRendering 的循环
 * 调的也是它，只是排在 rAF 上——页面不可见时 rAF 停摆，那条循环就断了。
 * 手动调用与可见性无关，这正是脚本驱动能在后台标签页里跑通的原因。
 */
function pump(view, max = PUMP_MAX) {
  let painted = 0;
  let idle = 0;
  for (let i = 0; i < max; i += 1) {
    let more = false;
    try { more = view.render() === true; } catch { break; } // 视图已销毁等：不该让输入路径炸掉
    if (more) { painted += 1; idle = 0; } else { idle += 1; if (idle >= 2) break; }
  }
  return painted;
}

// ── 全局状态（也是自动化入口） ───────────────────────────────────────────

const evidenceLedger = createEvidenceLedger();
const UI_PREF_KEYS = Object.freeze({
  theme: 'inklab.theme',
  controls: 'inklab.controls',
  hints: 'inklab.hints',
  inspector: 'inklab.inspectorCollapsed',
});
const readUiPref = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeUiPref = (key, value) => {
  try { localStorage.setItem(key, String(value)); } catch { /* 禁用存储时本轮仍可用 */ }
};

const state = {
  mod: null, mods: new Map(), info: null,
  view: null, caps: null, driver: null,   // 主舞台的快捷引用（脚本按这三个名字取）
  stages: [], shots: [], recordings: [], recording: null,
  runtimeSelection: [], runtimeErrors: [], previewMode: 'studio', lighting: 'absolute-dark',
  theme: normalizeUiTheme(document.documentElement.dataset.theme),
  controlGroup: 'interaction', hintsVisible: false, inspectorCollapsed: false,
  evidence: evidenceLedger,
  // 场景 = 工程自带（<app>/e2e/scenarios/，装载时动态 import）+ 内置通用（tools/inklab/scenarios/）
  scenarios: SCENARIOS.map((s) => ({ ...s, source: 'builtin' })),
  lastLoad: null, lastScenario: null, scenarioRunning: false,
  // e2e runner（CDP）看这两个：ready=true 才开始跑，bootError 非空说明装载失败。
  ready: false, bootError: null,
  llm: { mode: 'off' },
  // 场景级 LLM 覆写（`setLlm()` 写、下一次 `reload()` 生效，优先级高于 URL）。
  // 为什么需要它：LLM 模式是**装载期**决定的（能力层在 bootStage 里一次性建好），一页只能有一个模式；
  // 而「on 与 off 一条命令一起跑」要求同一轮里不同场景跑不同模式。e2e runner 于是在每个场景前
  // 按场景声明写这个字段再重载 —— 重载本来就是场景间的清场动作，不多花一次装载。
  llmOverride: null,
  cameraMode: CAMERA_MODES.MOCK,
  cameraPermission: 'not-requested',
  bluetoothMode: BLUETOOTH_MODES.MOCK,
  bluetooth: bluetoothController.simulator,
  bluetoothController,
};

function applyUiTheme(value, { persist = true } = {}) {
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

function applyControlGroup(value, { persist = true } = {}) {
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

function applyHintsVisibility(value, { persist = true } = {}) {
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

function applyInspectorCollapsed(value, { persist = true } = {}) {
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

window.__inklab = state; // 供自动化脚本从 DevTools / CDP 直接驱动

// 浏览器原生 canvas.captureStream + MediaRecorder：只录主舞台，不碰屏幕/窗口权限。
// Chrome 支持 H.264 MP4 时优先选它；不支持才由 recording.mjs 降级 WebM 并显式标记。
const stageRecorder = createCanvasRecorder();

const findScenario = (id) => state.scenarios.find((s) => s.id === id) || null;

/** 键盘/唤醒共用的时间戳时钟：单调、不回退。应用的同向去重闸看的就是这个数。 */
let lastStamp = 0;
let bluetoothTraceRun = null;
const stampNow = () => { lastStamp = Math.max(lastStamp + 16, Date.now()); return lastStamp; };

/** 输入要打到哪些舞台：主舞台恒在，副舞台看「镜像输入」开关。 */
function inputTargets() {
  if (state.inputScope) return state.stages.filter((st) => st?.view && st.id === state.inputScope);
  return state.stages.filter((st) => st && st.view && (st.primary || $('mirror').checked));
}

/** 全部程序化输入的唯一出口：校验 → dispatch → 立刻 pump（见文件头第 1 条）。 */
function sendInput(type, key, timestamp) {
  assertInput(type, key); // 脏参数进 wasm 是 memory access out of bounds，不是普通异常
  const ts = Number.isFinite(timestamp) ? timestamp : stampNow();
  const targets = inputTargets();
  evidenceLedger.record('input.key', { type, key, timestamp: ts, targets: targets.map((st) => st.id) });
  for (const st of targets) {
    st.view.dispatchInput(type, key, ts);
    pump(st.view);
  }
  return ts;
}

/** 一次完整按键。 */
function press(key) {
  const at = sendInput('keydown', key);
  sendInput('keyup', key, at + 16);
  return at;
}

function wake(keyword = 'inklab', timestamp) {
  if (typeof keyword !== 'string' || keyword === '') {
    throw new TypeError('dispatchVoiceWakeup 的 keyword 必须是非空字符串');
  }
  const ts = Number.isFinite(timestamp) ? timestamp : stampNow();
  const targets = inputTargets();
  evidenceLedger.record('input.voice-wakeup', { keyword, timestamp: ts, targets: targets.map((st) => st.id) });
  for (const st of targets) {
    st.view.dispatchVoiceWakeup(keyword, ts);
    pump(st.view);
  }
  return ts;
}

const primaryStage = () => state.stages.find((st) => st.primary) || null;

/** 截图（默认主舞台）。场景的 shot 步骤与截图按钮共用这一条。 */
function snapshot(name = `shot-${state.shots.length}`, stage = primaryStage()) {
  if (!stage) throw new Error('还没有可截图的舞台');
  pump(stage.view); // 先补一帧：别把上一屏当成这一步的证据
  const composed = compositePreviewCanvas(stage.canvas, {
    mode: state.previewMode, lighting: state.lighting,
  });
  const dataUrl = composed.toDataURL('image/png');
  const rec = {
    name, at: Date.now(), stage: stage.id, runtime: stage.runtime,
    previewMode: state.previewMode, lighting: state.lighting, dataUrl,
  };
  state.shots.push(rec);
  evidenceLedger.record('artifact.screenshot', {
    name, runtime: stage.runtime?.id, previewMode: state.previewMode, lighting: state.lighting,
    width: composed.width, height: composed.height,
  }, stage.id);
  return rec;
}

function snapshotMatrix(name = `matrix-${state.shots.length}`) {
  return state.stages.map((stage) => snapshot(
    `${name}--${stage.runtime.id}--${state.previewMode}--${state.lighting}`, stage,
  ));
}

// ── 舞台录屏 ────────────────────────────────────────────────────────────

let recordingTicker = null;
let recordingCompositeTimer = null;
let recordingCompositeCanvas = null;

const durationLabel = (ms, roundUp = false) => {
  const raw = Math.max(0, Number(ms || 0) / 1000);
  const sec = roundUp && raw > 0 ? Math.ceil(raw) : Math.floor(raw);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

function recordingFormatHint() {
  const format = stageRecorder.formats()[0];
  if (!stageRecorder.supported()) return { text: '录屏不可用', cls: 'err', pptReady: false };
  if (!format) return { text: '浏览器格式', cls: 'warn', pptReady: false };
  return format.pptReady
    ? { text: 'MP4 · PPT', cls: 'ok', pptReady: true }
    : { text: 'WebM · 需转码', cls: 'warn', pptReady: false };
}

function refreshRecordingState() {
  const active = stageRecorder.active;
  const button = $('record');
  const badge = $('record-state');
  const stage = primaryStage();
  const canStart = stageRecorder.supported() && typeof stage?.canvas?.captureStream === 'function';
  button.disabled = !canStart && !active;
  $('scenario-record').disabled = !canStart || Boolean(active);
  if (active) {
    const elapsed = Date.now() - active.startedAt;
    button.textContent = '停止录制';
    badge.textContent = `● 录制中 ${durationLabel(elapsed)} · ${active.width}×${active.height}`;
    badge.className = 'pill recording';
    return;
  }
  button.textContent = '开始录制';
  const hint = recordingFormatHint();
  badge.textContent = hint.text;
  badge.className = `pill ${hint.cls}`;
}

function beginRecordingTicker() {
  if (recordingTicker !== null) clearInterval(recordingTicker);
  recordingTicker = setInterval(refreshRecordingState, 500);
}

function stopRecordingTicker() {
  if (recordingTicker !== null) clearInterval(recordingTicker);
  recordingTicker = null;
}

function appendRecording(rec) {
  const card = document.createElement('div');
  card.className = 'recording-card';

  const video = document.createElement('video');
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = rec.objectUrl;
  card.appendChild(video);

  const meta = document.createElement('div');
  meta.className = 'recording-meta';
  const summary = document.createElement('span');
  summary.textContent = `${rec.width}×${rec.height} · ${durationLabel(rec.durationMs, true)} · ${rec.extension.toUpperCase()}`
    + `${rec.pptReady ? ' · 可直接插入 PPT' : ' · 插入 PPT 前需转 MP4'}`;
  meta.appendChild(summary);

  const link = document.createElement('a');
  link.className = 'recording-download';
  link.href = rec.objectUrl;
  link.download = rec.filename;
  link.textContent = `下载 ${rec.extension.toUpperCase()}`;
  meta.appendChild(link);
  card.appendChild(meta);

  $('scenario-recordings').prepend(card);
}

function downloadRecording(rec) {
  const link = document.createElement('a');
  link.href = rec.objectUrl;
  link.download = rec.filename;
  link.click();
}

function startStageRecording({ name = 'manual', scenarioId = null } = {}) {
  const stage = primaryStage();
  if (!stage) throw new Error('引擎还没跑起来，不能录主舞台');
  pump(stage.view);
  recordingCompositeCanvas = compositePreviewCanvas(stage.canvas, {
    mode: state.previewMode, lighting: state.lighting,
  });
  const compositeContext = recordingCompositeCanvas.getContext('2d');
  const drawCompositeFrame = () => {
    paintPreviewFrame(compositeContext, stage.canvas, {
      mode: state.previewMode,
      lighting: state.lighting,
      width: recordingCompositeCanvas.width,
      height: recordingCompositeCanvas.height,
    });
  };
  recordingCompositeTimer = setInterval(drawCompositeFrame, 1000 / 30);
  let started;
  try {
    started = stageRecorder.start({
      canvas: recordingCompositeCanvas,
      name,
      fps: 30,
      meta: {
        stage: stage.id, runtime: stage.runtime.id, scenarioId,
        previewMode: state.previewMode, lighting: state.lighting,
      },
    });
  } catch (error) {
    clearInterval(recordingCompositeTimer);
    recordingCompositeTimer = null;
    recordingCompositeCanvas = null;
    throw error;
  }
  state.recording = started;
  beginRecordingTicker();
  refreshRecordingState();
  boot(`开始录主舞台：${started.width}×${started.height} · 30fps · ${esc(started.mimeType)}`,
    started.pptReady ? 'ok' : 'warn');
  return started;
}

async function stopStageRecording({ download = true } = {}) {
  if (recordingCompositeTimer !== null) clearInterval(recordingCompositeTimer);
  recordingCompositeTimer = null;
  const rec = await stageRecorder.stop();
  recordingCompositeCanvas = null;
  stopRecordingTicker();
  state.recording = null;
  refreshRecordingState();
  if (!rec) return null;
  state.recordings.push(rec);
  appendRecording(rec);
  showPane('scenario');
  if (download) downloadRecording(rec);
  boot(`录屏完成：${esc(rec.filename)} · ${rec.width}×${rec.height} · ${durationLabel(rec.durationMs, true)}`
    + `${rec.pptReady ? ' · 可直接插入 PPT' : ' · 当前是 WebM，插入 PPT 前需转 MP4'}`,
  rec.pptReady ? 'ok' : 'warn');
  return rec;
}

// ── 工程源码 ────────────────────────────────────────────────────────────

async function loadProject() {
  const info = await (await hostFetch('/api/manifest', { cache: 'no-store' })).json();
  state.info = info;
  const source = info.source || { type: 'directory', path: info.appDir };
  boot(`${source.type === 'aix' ? '发布包' : '源码工程'} <span class="acc">${esc(source.path)}</span>`);
  if (source.type === 'aix') {
    boot(`AIX 身份：VERSION <span class="acc">${esc(source.version || '(缺失)')}</span> · `
      + `MD5 ${esc((source.md5 || '').slice(0, 12))} · SHA-256 ${esc((source.sha256 || '').slice(0, 16))} · `
      + `${(Number(source.bytes || 0) / 1024).toFixed(1)}KB`, 'ok');
  } else {
    boot(`源码快照 SHA-256 ${esc((source.sha256 || '').slice(0, 16))}`, 'dim');
  }
  boot(`bundle <span class="acc">${info.manifest.length}</span> 个文件`);

  panes.files.innerHTML = '';
  write('files', `${source.type === 'aix' ? 'AIX' : 'DIR'} · ${esc(source.path)}`, 'acc');
  if (info.compare) {
    const d = info.compare.files;
    write('files', `DIFF vs ${esc(info.compare.source.path)} · +${d.added.length} -${d.removed.length} ~${d.changed.length} =${d.same}`,
      d.equal ? 'ok' : 'warn');
    for (const path of d.added) write('files', `+ ${esc(path)}`, 'ok');
    for (const path of d.removed) write('files', `- ${esc(path)}`, 'err');
    for (const path of d.changed) write('files', `~ ${esc(path)}`, 'warn');
  }
  for (const p of info.manifest) write('files', esc(p), 'dim');

  if (info.problems.length) {
    for (const p of info.problems) boot(`预检：${esc(p)}`, 'err');
    throw new Error('工程预检没过，先修上面这些再跑');
  }

  const TEXT = /\.(ink|js|mjs|json|wxss|css|md|txt|svg)$/i;
  const files = {};
  await Promise.all(info.manifest.map(async (path) => {
    const res = await hostFetch('/app/' + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读不到 ${path}（HTTP ${res.status}）`);
    files[path] = TEXT.test(path) ? await res.text() : new Uint8Array(await res.arrayBuffer());
  }));
  state.lastLoad = { info, files };
  return state.lastLoad;
}

/**
 * 工程自带的 e2e 场景（<app>/e2e/scenarios/*.mjs）。带缓存戳重新 import，
 * 热重载后拿到的是编辑后的模块（场景内部的相对 import 仍走浏览器模块缓存——
 * 改了被 import 的辅助文件要整页刷新才生效，这是 ESM 的边界，不藏着）。
 */
async function loadProjectScenarios(info) {
  const out = [];
  const seq = Date.now();
  for (const rel of (info.e2e && info.e2e.scenarios) || []) {
    const name = rel.split('/').pop();
    try {
      const mod = await import(`/project-scenarios/${name}?v=${seq}`);
      const s = mod.default;
      if (!s || typeof s.id !== 'string' || typeof s.build !== 'function') {
        throw new Error('default 导出要有 { id, title, summary, build }');
      }
      out.push({ ...s, source: 'project' });
    } catch (err) {
      boot(`工程场景 ${esc(rel)} 加载失败：${esc(err && err.message)}`, 'err');
    }
  }
  return out;
}

/**
 * LLM 接线。模式取 URL `?llm=off|live|record|replay`；不给时有 endpoint（环境变量
 * INKLAB_LLM_ENDPOINT，serve 透传）就 live，否则 off——off 不配能力，引擎自判模型不可用，
 * 应用走自己的离线路径（诚实答复，不假装成功）。
 * replay 吃工程的录像（?cassette=e2e/cassettes/x.json，缺省认 default.json），不出网也不用密钥。
 */
/**
 * 外域出网默认挡下（`?netguard=0` 关掉）。默认开是刻意的：本地宿主跑的是**真源码**，
 * 应用里任何一条硬编码的线上域名都会真的打到别人的生产后端，而且多半发生在启动链路里
 * ——脚本层根本来不及拦（看见崇左的启动天气预取就是这么被发现的）。
 * 要看真后端：`?netguard=0`，或运行时 `__inklab.caps.net.allowExternal('example.com')` 点名放行。
 */
function netGuardEnabled() {
  // 控制台的勾选框一旦接好就是权威（重载工程要跟着人手上的开关走，不要被 URL 顶回去）。
  const box = document.getElementById('net-guard');
  if (box && box.dataset.wired === '1') return box.checked;
  const v = new URLSearchParams(location.search).get('netguard');
  return !(v === '0' || v === 'off' || v === 'false');
}

/**
 * 相机来源。控制台一旦接好就以人的选择为准；初次装载从 URL 读。
 * 未知值安全回落 mock，避免自动化环境因拼错参数意外申请摄像头权限。
 */
function selectedCameraMode() {
  const select = document.getElementById('camera-mode');
  if (select && select.dataset.wired === '1') return normalizeCameraMode(select.value);
  return cameraModeFromSearch(location.search);
}

/**
 * 蓝牙来源。和相机一样，控制台接好后人的选择优先；未知值必须安全回落 mock。
 * computer 模式不会在这里预先 requestDevice——浏览器要求设备选择发生在应用的用户手势里。
 */
function selectedBluetoothMode() {
  const select = document.getElementById('bluetooth-mode');
  if (select && select.dataset.wired === '1') return normalizeBluetoothMode(select.value);
  return bluetoothModeFromSearch(location.search);
}

/**
 * 场景级 LLM 覆写入口（e2e runner 用；手动排障时也能在控制台直接调）。
 *
 *   __inklab.setLlm({ mode:'replay', cassette:'e2e/cassettes/x.json', model:'inklab-cassette' });
 *   await __inklab.reload();   // 覆写在**下一次装载**生效（能力层是装载期一次性建好的）
 *   __inklab.setLlm(null);     // 清掉，回到 URL / 环境变量决定的模式
 *
 * `model` 这一项是给**录像键**用的：键含 model 字段（llm.mjs normalizeRequestBody），
 * 录像带在哪个 model 名下录的、回放时就得钉回哪个，否则换台机器（llm.local.json 写着别的模型名）
 * 恒 replay-miss。钉一个不存在的假模型名是安全的：replay 一个字节都不出网，model 只进哈希。
 */
function setLlm(override) {
  state.llmOverride = override && typeof override === 'object' ? { ...override } : null;
  return state.llmOverride;
}

async function resolveLlm(info) {
  const q = new URLSearchParams(location.search);
  // 覆写优先于 URL：URL 是「这一页缺省怎么跑」，覆写是「这个场景要怎么跑」。
  const ov = state.llmOverride && typeof state.llmOverride === 'object' ? state.llmOverride : null;
  const asked = (ov && ov.mode) || q.get('llm');
  let mode = asked || (info.llm && info.llm.endpoint ? 'live' : 'off');
  if (!['off', 'live', 'record', 'replay'].includes(mode)) {
    boot(`不认识 llm=${esc(mode)}（只有 off/live/record/replay），按 off 处理`, 'warn');
    mode = 'off';
  }
  if (mode === 'off') return { mode: 'off', opts: null, cassettePath: null };

  const cassettes = (info.e2e && info.e2e.cassettes) || [];
  const cassettePath = (ov && ov.cassette) || q.get('cassette')
    || (cassettes.includes('e2e/cassettes/default.json') ? 'e2e/cassettes/default.json' : null);
  let cassette = [];
  if (mode === 'replay') {
    if (!cassettePath) {
      throw new Error('llm=replay 需要录像：给 ?cassette=e2e/cassettes/xxx.json、'
        + '在场景里声明 llm.cassette，或先用 llm=record 跑一遍录一份 default.json');
    }
    const res = await hostFetch('/app/' + cassettePath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读不到 LLM 录像 ${cassettePath}（HTTP ${res.status}）`);
    const parsed = await res.json();
    cassette = Array.isArray(parsed) ? parsed : parsed.entries || [];
  }
  // model：覆写 > serve 透传的本机配置。覆写只在**回放**时该生效——录制时要打给真上游，
  // 拿一个不存在的假模型名去录只会换回一个 400。
  const model = (mode === 'replay' && ov && ov.model)
    || replayModelFromSearch(location.search, mode)
    || (info.llm && info.llm.model) || '';
  return {
    mode,
    cassettePath: mode === 'replay' ? cassettePath : null,
    opts: {
      mode,
      cassette,
      // serve 配了 requestDefaults 时给的是本机转发路由的相对路径，这里按页面 origin 补全
      // ——引擎要的是完整 URL，不拼路径。
      ...(info.llm && info.llm.endpoint
        ? { endpoint: new URL(info.llm.endpoint, location.origin).href } : {}),
      ...(info.llm && info.llm.apiKey ? { apiKey: info.llm.apiKey } : {}),
      ...(model ? { model } : {}),
    },
  };
}

// ── 舞台 ────────────────────────────────────────────────────────────────

// bindDomEvents 的键盘绑定挂在 keyboardTarget（缺省 window）上，且直接进 wasm：
// 宿主既插不进 pump，也没法镜像到第二块画布。给它一个游离元素当靶子就等于把它关掉——
// 游离节点永远收不到键盘事件——指针/滚轮那部分照常生效。
const keyboardSink = document.createElement('div');

function runtimeRegistryOf(info) {
  const runtimes = (info?.runtimes || []).filter((runtime) => runtime.available);
  return { default: info?.runtimeDefault, runtimes };
}

function renderRuntimePicker(info) {
  const host = $('runtime-picks');
  const all = info?.runtimes || [];
  const signature = all.map((r) => `${r.id}:${r.available}`).join('|');
  const previous = new Set([...host.querySelectorAll('input:checked')].map((input) => input.value));
  if (host.dataset.signature === signature) return;
  const initial = previous.size
    ? [...previous]
    : selectRuntimeIds(location.search, runtimeRegistryOf(info), { max: 4 });
  host.innerHTML = all.map((runtime) => {
    const version = runtimeDisplayVersion(runtime);
    const checked = runtime.available && initial.includes(runtime.id) ? ' checked' : '';
    const disabled = runtime.available ? '' : ' disabled';
    return `<label class="runtime-pick${runtime.available ? '' : ' unavailable'}" title="${esc(runtime.source || '')}">`
      + `<input type="checkbox" value="${esc(runtime.id)}"${checked}${disabled}>`
      + `${esc(runtime.label)} <span class="stage-version">${esc(version)}</span></label>`;
  }).join('');
  host.dataset.signature = signature;
  if (!host.querySelector('input:checked')) {
    const fallback = host.querySelector('input:not(:disabled)');
    if (fallback) fallback.checked = true;
  }
}

function selectedRuntimeRows(info) {
  const checked = new Set([...$('runtime-picks').querySelectorAll('input:checked')].map((input) => input.value));
  const rows = (info?.runtimes || []).filter((runtime) => runtime.available && checked.has(runtime.id));
  if (rows.length) return rows;
  const fallback = (info?.runtimes || []).find((runtime) => runtime.available && runtime.id === info.runtimeDefault)
    || (info?.runtimes || []).find((runtime) => runtime.available);
  return fallback ? [fallback] : [];
}

function renderStageShells(runtimes) {
  const light = normalizeLightingProfile(state.lighting);
  const preview = normalizePreviewMode(state.previewMode);
  $('stages').innerHTML = runtimes.map((runtime, index) => (
    `<section class="stage" data-runtime="${esc(runtime.id)}">`
      + `<div class="stage-head"><span class="stage-title">${index === 0 ? '主 lane' : `lane ${index + 1}`} · ${esc(runtime.label)}</span>`
      + `<span class="stage-version">${esc(runtimeDisplayVersion(runtime))}</span></div>`
      + `<div class="optical-stage preview-${preview} light-${light}" data-optical-runtime="${esc(runtime.id)}">`
      + `<canvas data-runtime-canvas="${esc(runtime.id)}" width="480" height="352" tabindex="${index === 0 ? '0' : '-1'}"></canvas>`
      + `<canvas class="preview-composite" aria-hidden="true"></canvas></div>`
      + `<div class="stage-meta"><span data-runtime-status="${esc(runtime.id)}">等待启动</span>`
      + `${index === 0 ? ' · <kbd>↑</kbd><kbd>↓</kbd> 焦点 · <kbd>Enter</kbd> 执行 · <kbd>Backspace</kbd> 返回' : ' · 独立 WASM / appId'}</div>`
      + '</section>'
  )).join('');
}

function canvasForRuntime(id) {
  return [...document.querySelectorAll('canvas[data-runtime-canvas]')]
    .find((canvas) => canvas.dataset.runtimeCanvas === id) || null;
}

function setRuntimeStatus(id, text, cls = '') {
  const node = [...document.querySelectorAll('[data-runtime-status]')]
    .find((el) => el.dataset.runtimeStatus === id);
  if (node) { node.textContent = text; node.className = `stage-status ${cls}`; }
}

// 实时预览、截图、录屏都调用 paintPreviewFrame；原 canvas 继续接收指针/键盘。
function drawStagePreview(stage) {
  if (state.previewMode !== 'optical') return;
  const output = stage.previewCanvas;
  const geometry = previewGeometry(stage.canvas, 'optical');
  if (output.width !== geometry.width) output.width = geometry.width;
  if (output.height !== geometry.height) output.height = geometry.height;
  paintPreviewFrame(output.getContext('2d'), stage.canvas, {
    mode: 'optical', lighting: state.lighting,
  });
}

function applyLightingProfile(value, { record = true } = {}) {
  const id = normalizeLightingProfile(value);
  state.lighting = id;
  $('lighting-profile').value = id;
  const profile = lightingProfile(id);
  for (const wrapper of document.querySelectorAll('.optical-stage')) {
    for (const item of LIGHTING_PROFILES) wrapper.classList.remove(`light-${item.id}`);
    wrapper.classList.add(`light-${id}`);
  }
  for (const stage of state.stages) drawStagePreview(stage);
  $('lighting-state').textContent = state.previewMode === 'optical'
    ? `${profile.label} · AR 480×640`
    : '效果预览 · 480×352';
  const url = new URL(location.href);
  url.searchParams.set('lighting', id);
  history.replaceState(null, '', url);
  if (record) evidenceLedger.record('environment.lighting', {
    id, label: profile.label, active: state.previewMode === 'optical', simulated: true,
  });
  refreshHeaderMeta();
  refreshInspector();
  return profile;
}

function applyPreviewMode(value, { record = true } = {}) {
  const id = normalizePreviewMode(value);
  state.previewMode = id;
  $('preview-mode').value = id;
  $('lighting-profile').disabled = id === 'studio';
  for (const wrapper of document.querySelectorAll('.optical-stage')) {
    for (const item of PREVIEW_MODES) wrapper.classList.remove(`preview-${item.id}`);
    wrapper.classList.add(`preview-${id}`);
  }
  const url = new URL(location.href);
  url.searchParams.set('preview', id);
  history.replaceState(null, '', url);
  if (record) evidenceLedger.record('environment.preview', {
    id, label: previewMode(id).label,
    studioReference: id === 'studio' ? 'effect-preview-480x352' : 'device-simulation-480x640',
    studioGeometryParity: true,
    backgroundAsset: id === 'optical' ? 'inklab-original' : null,
    composite: id === 'optical' ? 'black-unmatte-v2' : 'source-over',
    simulated: true,
  });
  applyLightingProfile(state.lighting, { record: false });
  refreshHeaderMeta();
  refreshInspector();
  return previewMode(id);
}

function refreshHeaderMeta() {
  if (!state.info) return;
  const total = state.runtimeSelection.length || state.stages.length;
  $('meta').innerHTML = `${state.stages.length}/${total} lane · ${state.info.manifest.length} 文件`
    + ` · ${esc(previewMode(state.previewMode).shortLabel)}`
    + (state.previewMode === 'optical' ? `/${esc(lightingProfile(state.lighting).shortLabel)}` : '')
    + (state.llm?.mode && state.llm.mode !== 'off' ? ` · llm:${esc(state.llm.mode)}` : '')
    + (state.runtimeErrors.length ? ` · <span class="err">${state.runtimeErrors.length} lane 失败</span>` : '');
}

function setSourceBadge(info) {
  const source = info?.source || {};
  const badge = $('source-badge');
  const size = Number(source.bytes || 0);
  const sizeText = size ? `${(size / 1024).toFixed(size > 1048576 ? 0 : 1)} KB` : '?';
  badge.innerHTML = `<strong>${source.type === 'aix' ? 'AIX 发布包' : '源码目录'}</strong>`
    + ` ${esc(source.name || '')} · ${sizeText}`
    + `${source.version ? ` · VERSION ${esc(source.version)}` : ''}`
    + `${source.sha256 ? ` · sha256 ${esc(source.sha256.slice(0, 12))}` : ''}`;
  badge.className = `source-badge ${source.type === 'aix' ? 'ok' : 'dim'}`;
}

async function bootStage({
  id, runtime, canvas, width, height, scaleFactor, primary, files, info, mod, llm, cameraMode,
  bluetooth, bluetoothMode,
}) {
  setRuntimeStatus(id, '初始化 InkView…');
  const eventCounts = new Map();
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const view = await mod.createInkView({
    width, height, scaleFactor,
    layoutMode: 'bounded', // 引擎只认 'bounded' | 'width-constrained-auto-height'
    canvas,
    onContentSizeChanged: (s) => boot(`[${id}] contentSizeChanged ${esc(JSON.stringify(s))}`, 'dim'),
  });

  // 宿主能力层默认把传感器 / 语音 / 媒体全部由我们自己喂。当前引擎自己的浏览器
  // media 后端不实现 takePhoto，所以 computer 模式只替换这一格；录音等其余媒体方法仍模拟。
  const rawDispatch = createEventBridge(view, {
    onDispatch: (name, detail) => {
      const count = (eventCounts.get(name) || 0) + 1;
      eventCounts.set(name, count);
      // 高频 IMU 只留首帧和每 60 帧采样，完整波形由 trace fixture 保存。
      if (!/\.reading$/.test(name) || count === 1 || count % 60 === 0) {
        evidenceLedger.record('capability.event', { name, detail, sample: count }, id);
      }
      if (!/\.reading$/.test(name)) write('log', `[${id}] evt ${esc(name)}`, 'acc');
    },
  });
  // 能力事件注入后立刻 pump——与输入路径同一纪律（文件头第 1 条）。不 pump 的话，
  // 注入的转写/传感器事件推进了应用状态，但换页/重绘要等 rAF；无头或被遮挡时 rAF
  // 不可靠，实测表现为「回执播了但导航丢了」这类时好时坏。
  const dispatchEvent = (name, detail) => { rawDispatch(name, detail); pump(view); };
  const caps = createHostCapabilities({
    dispatchEvent,
    // 工程场景可直接复用自身 assets 作为拍照 fixture；404 不得被当照片字节。
    readFile: (name) => readProjectFile(name, hostFetch),
    fetch: hostFetch,             // live/record 时 LLM 的上游、以及非 LLM 请求的透传出口
    languageModel: llm || null,   // null = 不配，引擎自判模型不可用（诚实答复）
    // 外域出网默认挡下（?netguard=0 关掉）。理由见 net.mjs guardExternal：应用里硬编码的线上域名
    // 会在**任何脚本步骤之前**就真的打出去（看见崇左的启动天气预取），场景层拦不住。
    // LLM 端点自动放行（清单口径见 llm.mjs llmAllowExternal）：live/record 下那次出网是有意的；
    // **replay 下同样要放行**——闸在外层、录像在内层，不放行的话回放请求全被判外域回 503，
    // 根本走不到 caps.llm.fetch（放行也不出网：内层照录像作答）。
    net: {
      guardExternal: netGuardEnabled(),
      externalOrigin: location.origin,
      allowExternal: llmAllowExternal(llm),
    },
  });
  // 仅把模拟器控制面挂给场景/控制台；引擎的调用仍走 navigator.bluetooth。
  // 这里若塞进 caps.capabilities，setHostCapabilities 的严格 codec 会把它静默丢掉。
  caps.bluetooth = bluetooth;
  const computerTakePhoto = cameraMode === CAMERA_MODES.COMPUTER
    ? createComputerCameraTakePhoto()
    : null;
  caps.capabilities = instrumentCapabilities(caps.capabilities, { ledger: evidenceLedger, lane: id });
  const hostCapabilities = hostCapabilitiesForCameraMode(
    caps.capabilities, cameraMode, { computerTakePhoto },
  );
  view.setHostCapabilities(hostCapabilities);

  // 排查用回声探针（默认不装，?probe=1 打开），把引擎真实调用参数录进 __inklab.stages[i].probe。
  let probe = null;
  if (new URLSearchParams(location.search).has('probe')) {
    probe = createProbeCapabilities({
      onCall: (rec) => write('log', `[${id}] cap ${rec.ns}.${rec.method} ${esc(JSON.stringify(rec.args))}`, 'acc'),
    });
    view.setHostCapabilities(hostCapabilitiesForCameraMode(
      probe.capabilities, cameraMode, { computerTakePhoto },
    ));
    boot(`[${id}] 回声探针已接管能力层（?probe=1）`, 'warn');
  }

  // 引擎日志走浏览器 console（引擎内部直接 console.* 打 Rust 侧日志，不是 onMessage —
  // onMessage 是应用 postMessage 用的另一条路）。这里接管 console 转进日志面板。
  view.setOnMessage?.((msg) => {
    evidenceLedger.record('app.message', { message: msg }, id);
    write('log', `[${id}] app→host ${esc(typeof msg === 'string' ? msg : JSON.stringify(msg))}`, 'acc');
  });
  view.setOnPerformanceEntry?.((e) => {
    evidenceLedger.record('performance.entry', e, id);
    write('log', `[${id}] perf ${esc(JSON.stringify(e))}`, 'dim');
  });

  view.setInteractive?.(true);
  // 只接指针/滚轮；键盘见 keyboardSink 的注释。**不开 syncFocus**（文件头第 2 条）。
  view.bindDomEvents({ canvas, keyboardTarget: keyboardSink, focusTarget: canvas });
  view.focus?.(); // 实测新建即 focused，这一行是幂等保险，不是「装载期必须 focus」的那条迷信

  // 副舞台换个 appId：应用存档的落点没定位到（不在 localStorage，推断在 wasm 线性内存/OPFS），
  // 两块画布用同一个 appId 有互相踩存档的风险，换一个最省事。
  const appId = `${info.appId}--runtime-${runtime.id}`;
  view.openBundle({ appId, files: mod.normalizeBundleFiles(files) });
  // startRendering 起持续渲染循环（rAF）。页面不可见时它会停，程序化输入靠 pump 兜底。
  view.startRendering?.();

  const stage = {
    id, runtime, mod, primary: Boolean(primary), canvas, view, caps, probe, dispatchEvent,
    hostCapabilities, cameraMode, computerTakePhoto, bluetooth, bluetoothMode,
    width, height, scaleFactor, appId,
  };
  stage.previewCanvas = canvas.parentElement.querySelector('.preview-composite');
  drawStagePreview(stage);
  stage.previewTimer = setInterval(() => {
    if (!document.hidden) drawStagePreview(stage);
  }, 1000 / 30);
  setRuntimeStatus(id, `运行中 · ${width}×${height} @${scaleFactor}`, 'ok');
  evidenceLedger.record('runtime.ready', {
    runtime: runtime.id, version: runtimeDisplayVersion(runtime), appId, width, height, scaleFactor,
  }, id);
  boot(`[${id}] <span class="ok">已跑起来</span> ${esc(runtimeDisplayVersion(runtime))} · ${width}×${height} @${scaleFactor} · isRunning=${view.isRunning?.()}`, 'ok');
  return stage;
}

function disposeStage(stage) {
  if (!stage) return;
  clearInterval(stage.previewTimer);
  try { stage.uninstallNet?.(); } catch { /* 每个 runtime module 各有自己的拦截器 */ }
  try { stage.caps?.dispose(); } catch { /* 重载时旧能力可丢 */ }
  try { stage.view?.destroy(); } catch { /* 重载时旧实例可丢 */ }
}

/**
 * 给 driver.mjs 用的 view 代理。有两处必须转接，直接把真 InkView 丢进去会踩坑：
 *  - dispatchInput：要走宿主的统一出口（校验 + pump + 镜像）；
 *  - dispatchHostCapabilityEvent：外层 InkView **没有**这个可用方法（同名的是 wasm 内部方法，
 *    吃 JSON 字符串），真正的事件回灌入口是 getHostCapabilitiesTarget()，即 createEventBridge。
 */
function driverView(stage) {
  return {
    dispatchInput: (type, key, ts) => { sendInput(type, key, ts); },
    dispatchVoiceWakeup: (keyword, ts) => { wake(keyword, ts); },
    dispatchHostCapabilityEvent: (name, detail) => stage.dispatchEvent(name, detail),
    requestRender: () => pump(stage.view),
    isRunning: () => stage.view.isRunning?.(),
  };
}

function makeDriver(stage, extra = {}) {
  return createDriver({
    view: driverView(stage),
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    screenshot: (name) => {
      const primary = snapshot(name, stage);
      // driver 的权威返回仍是当前 lane（E2E 基线不变）；手动多 lane 场景同时把其余画面
      // 存进 UI/统一证据，便于同一步横向审图。
      if (stage.primary && state.stages.length > 1) {
        for (const peer of state.stages) {
          if (peer !== stage) snapshot(`${name}--${peer.runtime.id}`, peer);
        }
      }
      return primary;
    },
    log: (line) => write('log', `drv ${esc(line)}`, 'acc'),
    ...extra,
  });
}

// ── 装载 ────────────────────────────────────────────────────────────────

let starting = null;

async function start() {
  if (starting) return starting; // 热重载连推两条时别把引擎重启叠起来
  starting = (async () => {
    let recordingCloseNote = null;
    // 主舞台一旦销毁，canvas stream 就不再是完整场景。重载前先正常封口并下载，
    // 不允许留下一个看似成功、实际半截/空白的文件。
    if (stageRecorder.active) {
      try {
        await stopStageRecording({ download: true });
        recordingCloseNote = { text: '工程重载前已自动结束并下载当前录屏', cls: 'warn' };
      } catch (err) {
        state.recording = null;
        stopRecordingTicker();
        refreshRecordingState();
        recordingCloseNote = { text: `工程重载时录屏收尾失败：${esc(err && err.message)}`, cls: 'err' };
      }
    }
    panes.boot.innerHTML = '';
    if (recordingCloseNote) boot(recordingCloseNote.text, recordingCloseNote.cls);
    state.ready = false;
    state.bootError = null;
    evidenceLedger.record('run.reload', { previousLanes: state.stages.map((stage) => stage.id) });
    try {
      for (const st of state.stages) disposeStage(st);
      globalThis.fetch = hostFetch;
      // A native notification subscription outlives the destroyed Ink instance.
      // Close the real GATT transport immediately after teardown so 50-60 Hz IMU
      // events cannot keep targeting the old, disconnected QuickJS channel. The
      // authorized BluetoothDevice stays cached and the new app may reconnect it.
      if (state.bluetoothMode === BLUETOOTH_MODES.COMPUTER) {
        try { bluetoothController.computerBluetooth()?.disconnectAuthorizedDevice?.(); }
        catch { /* browser already disconnected */ }
      }
      // 本次装载在引擎日志里的起点：场景的 lab.pagesLoaded() / lab.logTail() 只看**本实例**的日志，
      // 不把上一轮的记录误当成本轮证据（engineLog 跨重载累积）。
      //
      // 在 disposeStage **之后**取：拆旧实例是上一轮的收尾，不是这一轮的开头。
      // ⚠️ 这只挡住了同步那半截。当前引擎拆实例是**懒执行**的：`Dropping Ink instance …` /
      // `JsRuntime drop start …` 常常在下一轮装载之后才真正跑完，**并且会 panic**
      // （`cannot recursively acquire mutex`，与被测应用无关，详见 RUNTIME-NOTES）。
      // 所以日志窗口挡不干净它——场景里要写「本场引擎没崩」这类断言的，必须自己按
      // 「panic 前几行是不是拆实例标记」把这一路排除掉（看见崇左 llm-fault-fallback 有现成写法）。
      state.bootLogFrom = engineLog.length;
      state.stages = [];
      state.view = null; state.caps = null; state.driver = null;
      state.mod = null;
      state.runtimeErrors = [];
      if (bluetoothTraceRun && bluetoothTraceRun.stats().running) bluetoothTraceRun.stop();
      bluetoothTraceRun = null;

      // 必须在引擎 import / openBundle 前选好 navigator.bluetooth：应用 onLoad 可能立刻查可用性。
      state.bluetoothMode = selectedBluetoothMode();
      bluetoothController.setMode(state.bluetoothMode);
      if (state.bluetoothMode === BLUETOOTH_MODES.MOCK) state.bluetooth.resetRuntime();

      const { info, files } = await loadProject();
      renderRuntimePicker(info);
      setSourceBadge(info);
      const selectedRuntimes = selectedRuntimeRows(info);
      if (!selectedRuntimes.length) throw new Error('没有可用的运行时 lane；先跑 inklab:engine -- --matrix');
      state.runtimeSelection = selectedRuntimes.map((runtime) => runtime.id);
      renderStageShells(selectedRuntimes);
      applyPreviewMode(state.previewMode, { record: false });
      applyLightingProfile(state.lighting, { record: false });
      evidenceLedger.record('source.loaded', {
        source: info.source,
        compare: info.compare,
        manifestFiles: info.manifest.length,
        runtimes: state.runtimeSelection,
      });

      // 场景 = 工程自带 + 内置通用；每轮装载都重取，改场景热重载后下拉框跟着变。
      const projectScenarios = await loadProjectScenarios(info);
      state.scenarios = [...projectScenarios, ...SCENARIOS.map((s) => ({ ...s, source: 'builtin' }))];
      renderScenarioPicker();
      if (projectScenarios.length) {
        boot(`工程场景 <span class="acc">${projectScenarios.length}</span> 个：${projectScenarios.map((s) => esc(s.id)).join('、')}`, 'ok');
      }

      // LLM：off 不配能力；replay 在这里就把录像读好（读不到要响亮失败，不留到跑一半）。
      const llm = await resolveLlm(info);
      state.llm = { mode: llm.mode, cassettePath: llm.cassettePath };
      state.llmOpts = llm.opts; // 全部 runtime lane 给同一份，行为才可比
      state.cameraMode = selectedCameraMode();

      for (const runtime of selectedRuntimes) {
        const id = runtime.id;
        try {
          setRuntimeStatus(id, '载入 WASM…');
          let mod = state.mods.get(id);
          if (!mod) {
            mod = await import(`/runtimes/${encodeURIComponent(id)}/ink-glue.js`);
            state.mods.set(id, mod);
          }
          await mod.initInk({ wasmUrl: new URL(`/runtimes/${encodeURIComponent(id)}/engine.wasm`, location.origin) });
          boot(`[${esc(id)}] 引擎 <span class="acc">ink_web ${esc(mod.getInkVersion())}</span>（锁定本地 wasm）`, 'ok');
          const stage = await bootStage({
            id, runtime, canvas: canvasForRuntime(id), width: 480, height: 352,
            scaleFactor: window.devicePixelRatio || 2, primary: state.stages.length === 0,
            files, info, mod, llm: llm.opts, cameraMode: state.cameraMode,
            bluetooth: state.bluetooth, bluetoothMode: state.bluetoothMode,
          });
          state.stages.push(stage);
        } catch (error) {
          const message = error?.message || String(error);
          setRuntimeStatus(id, `启动失败 · ${message}`, 'err');
          state.runtimeErrors.push({ id, version: runtimeDisplayVersion(runtime), message });
          evidenceLedger.record('runtime.error', { runtime: id, version: runtimeDisplayVersion(runtime), message }, id);
          boot(`[${esc(id)}] 启动失败：${esc(message)}`, 'err');
        }
      }
      if (!state.stages.length) throw new Error(`全部运行时 lane 启动失败：${state.runtimeErrors.map((e) => `${e.id}: ${e.message}`).join('；')}`);
      const main = state.stages[0];
      main.primary = true;
      state.mod = main.mod;
      state.view = main.view;
      state.caps = main.caps;
      state.driver = makeDriver(main);
      boot(`宿主能力已装：${Object.keys(main.hostCapabilities).join(' / ')} / bluetooth（navigator bridge）· ${state.stages.length} 条 lane 隔离`, 'ok');
      if (state.cameraMode === CAMERA_MODES.COMPUTER) {
        boot('相机：<span class="acc">电脑摄像头（手动）</span>。宿主不会自动拍摄；'
          + '应用在用户交互中调用 takePhoto 时，浏览器才会申请相机权限。', 'ok');
        if (!navigator.mediaDevices?.getUserMedia) {
          boot('当前浏览器没有 navigator.mediaDevices.getUserMedia，电脑摄像头模式不可用', 'warn');
        }
      } else {
        boot('相机：<span class="acc">模拟图片</span>（默认；E2E 固定使用）', 'dim');
      }
      if (state.bluetoothMode === BLUETOOTH_MODES.COMPUTER) {
        boot('蓝牙：<span class="acc">电脑蓝牙（手动）</span>。宿主不会预先弹权限；'
          + '应用在你的按键/点击交互中扫描时，浏览器才会打开设备选择。', 'ok');
        if (!bluetoothController.isComputerSupported()) {
          boot('当前浏览器没有 navigator.bluetooth，电脑蓝牙模式不可用；可切回模拟蓝牙', 'warn');
        }
      } else {
        boot('蓝牙：<span class="acc">模拟设备</span>（默认；E2E 固定使用）· '
          + '内置 InkLab Heart Rate，也可用 <code>__inklab.bluetooth.replaceDevices(...)</code> 换业务协议', 'dim');
      }
      boot(main.caps.net.isExternalGuarded()
        ? '外域出网：<span class="acc">默认挡下</span>（不同源一律 503，日志里记 external-stub）。'
          + '要打真后端：<code>?netguard=0</code> 或 <code>__inklab.caps.net.allowExternal(&#39;域名&#39;)</code>'
        : '外域出网：<span class="err">放行</span>（?netguard=0）——应用里硬编码的线上域名会真的打出去', 'dim');
      if (llm.mode === 'off') {
        boot('LLM：off（没配 endpoint）。应用会走它自己的离线路径；要接真模型设 INKLAB_LLM_* 环境变量', 'dim');
      } else {
        boot(`LLM：<span class="acc">${llm.mode}</span>`
          + `${llm.opts.endpoint ? ` · ${esc(llm.opts.endpoint)}` : ''}`
          + `${llm.opts.model ? ` · ${esc(llm.opts.model)}` : ''}`
          + `${llm.mode === 'replay' ? ` · 录像 ${esc(llm.cassettePath)}（${main.caps.llm.recordings.length} 条）` : ''}`, 'ok');
      }

      // 每条 lane 对应一个独立 glue module，因此各自安装拦截器；浏览器 fetch 最外层仍由主 lane
      // 统一把关，保证默认外域 503 与 LLM record/replay 的安全边界只有一个权威出口。
      for (const stage of state.stages) {
        stage.caps.net.attachView(stage.view);
        stage.uninstallNet = stage.caps.net.install(stage.mod);
      }
      // fetch 链：net 拦截（断网/按 URL 故障）→ LLM 拦截（转发/录制/回放）→ 原始 fetch。
      // net 在外层，断网时 LLM 一起断（与真机一致）；llm off 时不进链，别白挂一层。
      globalThis.fetch = main.caps.net.wrapFetch(llm.mode === 'off' ? hostFetch : main.caps.llm.fetch);
      refreshNetState();

      refreshHeaderMeta();
      state.ready = true;
      refreshRecordingState();
      refreshInspector();
    } catch (err) {
      state.bootError = (err && err.message) || String(err);
      boot(`失败：${esc(err && err.message)}`, 'err');
      boot(esc((err && err.stack || '').split('\n').slice(1, 4).join('\n')), 'dim');
      $('meta').innerHTML = '<span class="err">启动失败</span>';
      refreshRecordingState();
    } finally {
      starting = null;
    }
  })();
  return starting;
}

// ── 热重载（服务端 fs.watch + SSE，去抖在服务端做） ───────────────────────

function connectWatch() {
  const badge = $('watch-state');
  let es;
  try { es = new EventSource('/api/watch'); } catch { badge.textContent = 'watch 起不来'; return; }
  es.addEventListener('hello', (ev) => {
    const d = JSON.parse(ev.data || '{}');
    badge.textContent = d.watching ? 'watch 已连' : 'watch 不可用';
    badge.className = `pill ${d.watching ? 'ok' : 'warn'}`;
  });
  es.addEventListener('change', (ev) => {
    const d = JSON.parse(ev.data || '{}');
    const what = (d.files || []).slice(0, 3).join(', ') + (d.count > 3 ? ` 等 ${d.count} 个` : '');
    if (!$('autoreload').checked) { boot(`源码变了（${esc(what)}），热重载没开`, 'dim'); return; }
    if (state.scenarioRunning) { boot(`源码变了（${esc(what)}），场景在跑，先不重载`, 'warn'); return; }
    boot(`<span class="acc">热重载</span> ${esc(what)}`, 'ok');
    start();
  });
  es.onerror = () => { badge.textContent = 'watch 断了'; badge.className = 'pill err'; };
}

// ── 场景跑测 ────────────────────────────────────────────────────────────

function renderScenarioPicker() {
  const sel = $('scenario-pick');
  const prev = sel.value;
  const group = (source, label) => {
    const items = state.scenarios.filter((s) => s.source === source);
    if (!items.length) return '';
    return `<optgroup label="${esc(label)}">`
      + items.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')
      + '</optgroup>';
  };
  sel.innerHTML = group('project', '工程场景') + group('builtin', '内置');
  // 重载后尽量停在原来选中的场景上（还在清单里的话）
  if (prev && findScenario(prev)) sel.value = prev;
  showScenarioDesc();
}
function showScenarioDesc() {
  const s = findScenario($('scenario-pick').value);
  $('scenario-desc').textContent = s ? s.summary : '';
}

async function runScenario(id = $('scenario-pick').value, options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const scenario = findScenario(id);
  const stage = primaryStage();
  if (!scenario) throw new Error(`没有这个场景：${id}`);
  if (!stage) throw new Error('引擎还没跑起来');
  const out = $('scenario-out');
  state.scenarioRunning = true;
  $('scenario-run').disabled = true;
  $('scenario-state').textContent = '跑着…';
  out.innerHTML = '<div class="row dim">跑着…</div>';
  $('scenario-shots').innerHTML = '';
  showPane('scenario'); // 结果住在右侧页签里，不再把左边的能力控制台往下顶
  const shotsFrom = state.shots.length;
  const shouldRecord = options.record == null ? $('scenario-record').checked : Boolean(options.record);

  // 实时进度：整份步骤清单先渲染成待执行，driver 的 onStep 跑到哪步就地更新到哪步。
  // liveStep 在 build 出步骤、渲染完清单之后才接上——build 抛错时清单根本没有，别空转。
  let liveStep = null;
  const renderPendingSteps = (steps) => {
    out.innerHTML = steps.map((s, i) => (
      `<div class="row dim" id="scn-step-${i}">· #${i + 1} ${esc((s && s.label) || `第 ${i + 1} 步`)}</div>`
    )).join('');
    liveStep = (e) => {
      const row = document.getElementById(`scn-step-${e.index}`);
      if (!row) return;
      if (e.phase === 'start') {
        row.className = 'row acc';
        row.innerHTML = `▸ #${e.index + 1} ${esc(e.label)} …`;
      } else {
        row.className = `row ${e.ok ? 'dim' : 'err'}`;
        row.innerHTML = `#${e.index + 1} ${esc(e.label)} · ${e.ok ? `ok ${e.ms}ms` : `失败：${esc(e.reason)}`}`;
        if (e.ok && e.kind === 'shot') {
          const rec = state.shots[state.shots.length - 1];
          if (rec) $('scenario-shots').insertAdjacentHTML('beforeend', `<img src="${rec.dataUrl}" title="${esc(rec.name)}">`);
        }
      }
      try { row.scrollIntoView({ block: 'nearest' }); } catch { /* 滚动只是便利 */ }
    };
  };

  // 每次跑都重建驱动器：虚拟时钟从头开始，上一次跑到哪不影响这一次。
  const driver = makeDriver(stage, { onStep: (e) => { if (liveStep) liveStep(e); } });
  state.driver = driver;
  let report;
  let builtSteps = [];
  let autoRecording = false;
  let scenarioRecording = null;
  let recordingError = null;
  try {
    if (shouldRecord) {
      startStageRecording({ name: `scenario-${id}`, scenarioId: id });
      autoRecording = true;
    }
    const steps = scenario.build({
      caps: stage.caps, stage, driver, view: stage.view,
      // 场景可用的宿主观测面。
      // pagesLoaded：本次装载以来引擎到过的页面。两个日志源，口径实测校正过：
      //   * `eval_module … pages/x/index.js`——页面**首次**加载必打（模块求值，同步确定）。
      //     模块有缓存，同一页面本次装载内只出现一次；
      //   * `Page "…" method "onLoad|onShow"`——是**采样式**性能日志，方法跑得快就不打
      //     （曾把「日志缺席」误判成「导航丢了」，截图证明页面好好的），只能当补充。
      // frameHash：主画布当前画面的廉价指纹，用来等「首帧画完并稳定」。
      lab: {
        pagesLoaded: () => engineLog.slice(state.bootLogFrom || 0)
          .map((r) => {
            const method = /Page "([^"]+)" method "on(?:Load|Show)"/.exec(r.text);
            if (method) return method[1];
            const evaled = /eval_module namespace success module='[^']*\/(pages\/[^/']+)\/index\.js'/.exec(r.text);
            return evaled ? `${evaled[1]}/index` : undefined;
          })
          .filter(Boolean),
        framePixels: () => {
          const canvas = stage.canvas;
          return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        },
        compareFrame: (expected, options = {}) => {
          const canvas = stage.canvas;
          const actual = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          return diffPixels(expected, actual, options);
        },
        frameHash: ({ full = false } = {}) => {
          if (full) {
            const canvas = stage.canvas;
            return rgbaFrameHash(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
          }
          const url = stage.canvas.toDataURL('image/png');
          return `${url.length}:${url.slice(-64)}`;
        },
        // 排障用：引擎日志尾巴（本次装载以来）。断言别依赖它，失败信息里带它。
        logTail: (n = 12) => engineLog.slice(state.bootLogFrom || 0).slice(-n).map((r) => r.text),
      },
    });
    builtSteps = steps;
    renderPendingSteps(steps);
    report = await driver.runScenario(steps);
  } catch (err) {
    report = {
      ok: false, steps: [], shots: [], skipped: 0,
      failure: { index: -1, reason: err && err.message },
      summary: `场景没跑起来：${err && err.message}`,
    };
  } finally {
    // 真实键盘与驱动器共用应用侧的去重闸，跑完把宿主时钟追到驱动器的虚拟时钟，
    // 免得跑完再手敲键盘时时间戳回退、被去重闸当成同一次按键吞掉。
    try { lastStamp = Math.max(lastStamp, driver.clock()); } catch { /* 拿不到就算了 */ }
    if (autoRecording) {
      try {
        scenarioRecording = await stopStageRecording({ download: options.download !== false });
      } catch (err) {
        recordingError = (err && err.message) || String(err);
        state.recording = null;
        stopRecordingTicker();
        refreshRecordingState();
        boot(`场景已结束，但录屏收尾失败：${esc(recordingError)}`, 'err');
      }
    }
    state.scenarioRunning = false;
    $('scenario-run').disabled = false;
  }

  report.scenarioId = id; // e2eShotReport 要核对「报告是不是这个场景的」
  if (scenarioRecording) {
    report.recording = {
      filename: scenarioRecording.filename,
      durationMs: scenarioRecording.durationMs,
      width: scenarioRecording.width,
      height: scenarioRecording.height,
      mimeType: scenarioRecording.mimeType,
      pptReady: scenarioRecording.pptReady,
    };
  }
  if (recordingError) report.recordingError = recordingError;
  state.lastScenario = report;
  $('scenario-state').innerHTML = recordingError
    ? `<span class="${report.ok ? 'warn' : 'err'}">${report.ok ? '场景通过 · 录屏失败' : '失败'}</span>`
    : (report.ok ? '<span class="ok">通过</span>' : '<span class="err">失败</span>');
  // 收尾重渲染（权威口径）：已执行行 + 失败后未执行的步骤标灰保留 + 总结行。
  const skippedRows = builtSteps.slice(report.steps.length).map((s, k) => (
    `<div class="row dim">· #${report.steps.length + k + 1} ${esc((s && s.label) || '')}（未执行）</div>`
  ));
  out.innerHTML = report.steps.map((s) => (
    `<div class="row ${s.ok ? 'dim' : 'err'}">#${s.index + 1} ${esc(s.label)} · ${s.ok ? `ok ${s.ms}ms` : `失败：${esc(s.reason)}`}</div>`
  )).join('') + skippedRows.join('') + `<div class="row ${report.ok ? 'ok' : 'err'}">${esc(report.summary)}</div>`;
  $('scenario-shots').innerHTML = state.shots.slice(shotsFrom)
    .map((s) => `<img src="${s.dataUrl}" title="${esc(s.name)}">`).join('');
  return report;
}

// ── 能力控制台 ──────────────────────────────────────────────────────────

const capsOf = () => primaryStage()?.caps || null;

/** 控制台每个动作都可能抛（比如没开麦就注入转写）——统一在这里说人话，不让异常沉进 console。 */
function guard(fn, okMsg) {
  return () => {
    const caps = capsOf();
    if (!caps) { boot('引擎还没跑起来', 'warn'); return; }
    try {
      const r = fn(caps);
      if (okMsg) boot(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok');
    } catch (err) {
      boot(`能力控制台：${esc(err && err.message)}`, 'err');
    }
    refreshCapState();
  };
}

function guardStages(fn, okMsg) {
  return () => {
    const stages = inputTargets();
    if (!stages.length) { boot('引擎还没跑起来', 'warn'); return; }
    const results = [];
    const errors = [];
    for (const stage of stages) {
      try { results.push({ lane: stage.id, value: fn(stage.caps, stage) }); }
      catch (error) { errors.push({ lane: stage.id, message: error?.message || String(error) }); }
    }
    if (okMsg && results.length) {
      const message = typeof okMsg === 'function' ? okMsg(results[0].value, results) : okMsg;
      boot(`${message} · ${results.length}/${stages.length} lane`, errors.length ? 'warn' : 'ok');
    }
    for (const error of errors) boot(`能力控制台 [${esc(error.lane)}]：${esc(error.message)}`, 'err');
    refreshCapState();
    refreshInspector();
  };
}

function refreshCapState() {
  const caps = capsOf();
  if (!caps) return;
  const listening = caps.speech.isListening();
  const badge = $('asr-state');
  badge.textContent = listening ? 'listening' : 'idle';
  badge.className = `pill ${listening ? 'ok' : ''}`;
  refreshNetState();
  refreshBluetoothControls();
  refreshSensorTraceState();
  refreshBatteryState();
}

function refreshBatteryState() {
  const badge = $('battery-state');
  if (!badge) return;
  const rows = state.stages.map((stage) => ({ id: stage.id, listeners: stage.caps?.battery?.listeners?.().length || 0 }));
  const active = rows.filter((row) => row.listeners > 0);
  badge.textContent = active.length
    ? active.map((row) => `${row.id}:${row.listeners}`).join(' · ')
    : '等待应用订阅';
  badge.className = `pill ${active.length ? 'ok' : ''}`;
}

function refreshBluetoothTraceState() {
  const badge = $('bluetooth-trace-state');
  if (!badge) return;
  const mock = normalizeBluetoothMode($('bluetooth-mode').value) === BLUETOOTH_MODES.MOCK;
  if (!mock) {
    badge.textContent = 'mock only';
    badge.className = 'pill';
    return;
  }
  const active = state.bluetooth && typeof state.bluetooth.activeNotificationTraces === 'function'
    ? state.bluetooth.activeNotificationTraces() : [];
  const stats = active[0] || (bluetoothTraceRun && bluetoothTraceRun.stats());
  if (!stats) {
    badge.textContent = 'idle';
    badge.className = 'pill';
    return;
  }
  badge.textContent = `${stats.status} · ${stats.emittedFrames}/${stats.totalFrames}`
    + `${stats.loops ? ` · ${stats.loops} loops` : ''}`;
  badge.className = `pill ${stats.status === 'failed' ? 'err'
    : (stats.status === 'running' || stats.status === 'completed' ? 'ok' : '')}`;
}

function refreshSensorTraceState() {
  const caps = capsOf();
  const badge = $('sensor-trace-state');
  if (!caps || !badge) return;
  const trace = caps.sensors.traceState($('sensor-pick').value);
  badge.textContent = trace.source === 'trace'
    ? `${trace.samples} 帧 · ${trace.speed}×${trace.loop ? ' · 循环' : ''}`
    : 'baseline';
  badge.className = `pill ${trace.source === 'trace' ? 'ok' : ''}`;
}

function refreshNetState() {
  const caps = capsOf();
  if (!caps) return;
  const on = caps.net.isOnline();
  const badge = $('net-state');
  badge.textContent = on ? 'online' : 'offline';
  badge.className = `pill ${on ? 'ok' : 'err'}`;
}

function refreshBluetoothControls() {
  const select = $('bluetooth-mode');
  const badge = $('bluetooth-state');
  if (!select || !badge) return;
  const mode = normalizeBluetoothMode(select.value);
  const mock = mode === BLUETOOTH_MODES.MOCK;
  for (const id of [
    'bluetooth-power', 'bluetooth-disconnect', 'bluetooth-notify',
    'bluetooth-trace-open', 'bluetooth-trace-stop', 'bluetooth-trace-loop',
  ]) {
    $(id).disabled = !mock;
  }
  $('bluetooth-log').disabled = false;
  for (const id of ['bluetooth-service', 'bluetooth-characteristic', 'bluetooth-bytes']) {
    $(id).disabled = !mock;
  }
  refreshBluetoothTraceState();
  const authorize = $('bluetooth-authorize');
  if (!mock) {
    const supported = bluetoothController.isComputerSupported();
    const adapter = bluetoothController.computerBluetooth();
    const pending = Boolean(adapter && adapter.needsAuthorization?.());
    const selected = adapter && adapter.authorizedDevice?.();
    const hasFilters = Boolean(adapter && adapter.lastRequestOptions?.());
    authorize.disabled = !supported || (!pending && !hasFilters);
    authorize.textContent = pending ? '选择真实设备'
      : (selected ? '重新选择设备' : '等待应用搜索');
    badge.textContent = !supported ? 'computer · unsupported'
      : pending ? 'computer · 等待选择'
        : selected ? `computer · ${selected.name || '设备已授权'}` : 'computer · ready';
    badge.className = `pill ${supported ? 'ok' : 'err'}`;
    return;
  }
  authorize.disabled = true;
  authorize.textContent = '选择真实设备';
  const available = state.bluetooth.isAvailable();
  const connected = state.bluetooth.devices().filter((device) => device.gatt.connected).length;
  $('bluetooth-power').textContent = available ? '设为不可用' : '恢复适配器';
  badge.textContent = available
    ? `mock · ${connected ? `${connected} 已连接` : 'available'}`
    : 'mock · unavailable';
  badge.className = `pill ${available ? 'ok' : 'err'}`;
}

function inspectorQuery() {
  return String($('inspector-filter')?.value || '').trim().toLowerCase();
}

const safeJson = (value) => {
  try { return JSON.stringify(redactEvidence(value), null, 2); } catch { return String(value); }
};

function networkEvidence() {
  return state.stages.flatMap((stage) => (stage.caps?.net?.requests || []).map((row) => ({
    lane: stage.id,
    runtime: runtimeDisplayVersion(stage.runtime),
    ...redactEvidence(row),
  })));
}

function buildRunEvidence() {
  return redactEvidence({
    schemaVersion: 1,
    kind: 'inklab.run',
    generatedAt: new Date().toISOString(),
    source: state.info?.source || null,
    comparison: state.info?.compare || null,
    runtimes: {
      selected: state.runtimeSelection,
      lanes: state.stages.map((stage) => ({
        id: stage.id,
        label: stage.runtime.label,
        channel: stage.runtime.channel,
        version: stage.runtime.engineVersion,
        build: stage.runtime.engineBuild,
        wasmSha256: stage.runtime.wasmSha256,
        appId: stage.appId,
        running: Boolean(stage.view?.isRunning?.()),
      })),
      errors: state.runtimeErrors,
    },
    environment: {
      preview: {
        id: state.previewMode,
        label: previewMode(state.previewMode).label,
        studioReference: state.previewMode === 'studio' ? 'effect-preview-480x352' : 'device-simulation-480x640',
        studioGeometryParity: true,
        backgroundAsset: state.previewMode === 'optical' ? 'inklab-original' : null,
        composite: state.previewMode === 'optical' ? 'black-unmatte-v2' : 'source-over',
      },
      lighting: {
        id: state.lighting,
        label: lightingProfile(state.lighting).label,
        active: state.previewMode === 'optical',
        simulated: true,
      },
      camera: state.cameraMode,
      bluetooth: state.bluetoothMode,
      llm: state.llm,
      netGuard: primaryStage()?.caps?.net?.isExternalGuarded?.() ?? null,
    },
    scenario: state.lastScenario,
    timeline: evidenceLedger.snapshot(),
    network: networkEvidence(),
    engineLog: engineLog.slice(-1000),
    artifacts: {
      screenshots: state.shots.map(({ dataUrl: _dataUrl, runtime, ...shot }) => ({
        ...shot,
        runtime: runtime ? { id: runtime.id, version: runtimeDisplayVersion(runtime) } : null,
      })),
      recordings: state.recordings.map(({ blob: _blob, objectUrl: _objectUrl, ...recording }) => recording),
    },
  });
}

function conformanceReport() {
  const results = [];
  for (const row of engineLog.slice(state.bootLogFrom || 0)) {
    const match = /\[conformance\]\s+result\s+(\{.*\})\s*$/.exec(row.text);
    if (!match) continue;
    try { results.push(JSON.parse(match[1])); } catch { /* 坏探针输出留在 engine log，不伪造成结果 */ }
  }
  const latest = new Map();
  for (const result of results) if (result?.feature) latest.set(result.feature, result);
  return { results: [...latest.values()], samples: results.length };
}

function downloadJson(value, filename) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function detailRows(rows, summary) {
  const q = inspectorQuery();
  const picked = q ? rows.filter((row) => safeJson(row).toLowerCase().includes(q)) : rows;
  if (!picked.length) return '<span class="dim">没有匹配记录。</span>';
  return picked.slice(-120).reverse().map((row) => (
    `<details class="inspect-row"><summary>${summary(row)}</summary><pre>${esc(safeJson(row))}</pre></details>`
  )).join('');
}

function refreshInspector() {
  if (!$('pane-network')) return;
  const network = networkEvidence();
  $('pane-network').innerHTML = detailRows(network, (row) => (
    `<span class="acc">${esc(row.lane)}</span> ${esc(row.method || '')} ${esc(row.url || '')}`
      + ` → <span class="${row.decision === 'pass' ? 'ok' : row.decision === 'external-stub' ? 'warn' : 'err'}">${esc(row.decision || row.status || '?')}</span>`
  ));

  const capability = evidenceLedger.entries.filter((entry) => entry.kind.startsWith('capability.'));
  $('pane-caps').innerHTML = detailRows(capability, (entry) => (
    `<span class="acc">${esc(entry.lane || '-')}</span> ${esc(entry.kind)} · `
      + `${esc(entry.detail?.namespace || entry.detail?.name || '')}${entry.detail?.method ? `.${esc(entry.detail.method)}` : ''}`
  ));

  const source = state.info?.source || {};
  $('evidence-summary').innerHTML = [
    ['输入', `${source.type === 'aix' ? 'AIX' : 'DIR'} · ${source.name || '?'} · ${(source.sha256 || '').slice(0, 12)}`],
    ['运行时', state.stages.map((stage) => `${stage.id}=${runtimeDisplayVersion(stage.runtime)}`).join(' / ') || '未启动'],
    ['环境', `${previewMode(state.previewMode).label}`
      + `${state.previewMode === 'optical' ? `/${lightingProfile(state.lighting).label}` : ''}`
      + ` · camera:${state.cameraMode} · bluetooth:${state.bluetoothMode}`],
    ['场景', state.lastScenario ? `${state.lastScenario.scenarioId || '?'} · ${state.lastScenario.ok ? 'PASS' : 'FAIL'}` : '尚未运行'],
    ['证据', `${evidenceLedger.entries.length} events · ${network.length} network · ${state.shots.length} shots`],
  ].map(([key, value]) => `<strong>${esc(key)}</strong><span>${esc(value)}</span>`).join('');
  $('evidence-state').textContent = `${evidenceLedger.entries.length} events`;
  $('evidence-events').innerHTML = detailRows(evidenceLedger.entries, (entry) => (
    `<span class="dim">#${entry.seq} +${entry.offsetMs}ms</span> `
      + `<span class="acc">${esc(entry.lane || 'host')}</span> ${esc(entry.kind)}`
  ));

  const q = inspectorQuery();
  for (const paneName of ['boot', 'log', 'scenario', 'files']) {
    for (const row of panes[paneName]?.querySelectorAll('.row') || []) {
      row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
    }
  }
}

function wireConsole() {
  $('theme-toggle').onclick = () => applyUiTheme(nextUiTheme(state.theme));
  $('inspector-toggle').onclick = () => applyInspectorCollapsed(!state.inspectorCollapsed);
  for (const tab of document.querySelectorAll('[data-control-target]')) {
    tab.onclick = () => applyControlGroup(tab.dataset.controlTarget);
  }
  $('hints-toggle').onclick = () => applyHintsVisibility(!state.hintsVisible);
  $('reload').onclick = () => start();
  $('runtime-picks').onchange = async (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const checked = [...$('runtime-picks').querySelectorAll('input:checked')];
    if (!checked.length) {
      event.target.checked = true;
      boot('至少保留一条运行时 lane', 'warn');
      return;
    }
    const ids = checked.map((input) => input.value);
    const url = new URL(location.href);
    url.searchParams.set('runtimes', ids.join(','));
    history.replaceState(null, '', url);
    evidenceLedger.record('runtime.selection', { ids });
    const inflight = starting;
    if (inflight) await inflight;
    await start();
  };
  $('preview-mode').onchange = () => applyPreviewMode($('preview-mode').value);
  $('lighting-profile').onchange = () => applyLightingProfile($('lighting-profile').value);
  $('mirror').onchange = () => {
    evidenceLedger.record('input.mirror', { enabled: $('mirror').checked });
    refreshInspector();
  };
  $('wake').onclick = () => { wake('inklab'); refreshCapState(); };
  $('shot').onclick = () => {
    const records = snapshotMatrix(`manual-${state.shots.length}`);
    for (const rec of records) {
      const a = document.createElement('a');
      a.download = `inklab-${rec.stage}-${rec.previewMode}-${rec.lighting}-${rec.at}.png`;
      a.href = rec.dataUrl;
      a.click();
    }
    showPane('evidence');
    refreshInspector();
  };
  $('record').onclick = async () => {
    $('record').disabled = true;
    try {
      if (stageRecorder.active) {
        await stopStageRecording({ download: true });
      } else {
        // 手动录制可以覆盖随后的一段自由操作；不要同时把场景勾选误解成另起第二条录制。
        $('scenario-record').checked = false;
        startStageRecording({ name: 'manual' });
      }
    } catch (err) {
      state.recording = null;
      stopRecordingTicker();
      boot(`录屏失败：${esc(err && err.message)}`, 'err');
    } finally {
      refreshRecordingState();
    }
  };

  const cameraSelect = $('camera-mode');
  const cameraAuthorize = $('camera-authorize');
  const setCameraBadge = (text, cls = '') => {
    const badge = $('camera-state');
    badge.textContent = text;
    badge.className = `pill ${cls}`;
  };
  const refreshCameraControls = () => {
    const mode = normalizeCameraMode(cameraSelect.value);
    cameraAuthorize.disabled = mode !== CAMERA_MODES.COMPUTER
      || state.cameraPermission === 'requesting';
    if (mode === CAMERA_MODES.MOCK) {
      setCameraBadge('mock', 'ok');
      return;
    }
    const labels = {
      granted: ['ready', 'ok'],
      denied: ['denied', 'err'],
      unavailable: ['unavailable', 'err'],
      requesting: ['requesting…', 'warn'],
      'not-requested': ['待授权', 'warn'],
    };
    const [text, cls] = labels[state.cameraPermission] || labels['not-requested'];
    setCameraBadge(text, cls);
  };
  const authorizeComputerCamera = async () => {
    state.cameraPermission = 'requesting';
    cameraAuthorize.disabled = true;
    refreshCameraControls();
    try {
      await requestComputerCameraPermission();
      state.cameraPermission = 'granted';
      return { ok: true, message: '电脑摄像头权限已取得；未拍照，视频轨道已立即关闭' };
    } catch (err) {
      state.cameraPermission = err?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
      return { ok: false, message: `${err?.name || 'Error'}：${err?.message || String(err)}` };
    } finally {
      refreshCameraControls();
    }
  };
  cameraSelect.value = cameraModeFromSearch(location.search);
  cameraSelect.dataset.wired = '1';
  refreshCameraControls();
  // 直接用 ?camera=computer 打开时不能擅自弹权限；只读已有状态，让按钮给出明确提示。
  if (cameraSelect.value === CAMERA_MODES.COMPUTER && navigator.permissions?.query) {
    navigator.permissions.query({ name: 'camera' }).then((permission) => {
      if (permission.state === 'granted' || permission.state === 'denied') {
        state.cameraPermission = permission.state;
        refreshCameraControls();
      }
    }).catch(() => { /* Permissions API 不支持 camera 时保留“待授权” */ });
  }
  cameraSelect.onchange = async () => {
    const mode = normalizeCameraMode(cameraSelect.value);
    const url = new URL(location.href);
    url.searchParams.set('camera', mode);
    history.replaceState(null, '', url);
    let permissionResult = null;
    if (mode === CAMERA_MODES.COMPUTER) {
      // onchange 本身是真实用户交互，必须在任何异步重载之前发起 getUserMedia。
      permissionResult = await authorizeComputerCamera();
    } else {
      state.cameraPermission = 'not-requested';
      refreshCameraControls();
    }
    // 能力表只在 InkView 启动时注入，切换来源必须重建实例。若正赶上冷启动，
    // 先让它收尾再重建，避免 start() 的防重入把这次切换悄悄吞掉。
    const inflight = starting;
    if (inflight) await inflight;
    await start();
    if (permissionResult) {
      boot(permissionResult.ok ? permissionResult.message : `电脑摄像头授权失败：${permissionResult.message}`,
        permissionResult.ok ? 'ok' : 'err');
    }
  };
  cameraAuthorize.onclick = async () => {
    const result = await authorizeComputerCamera();
    boot(result.ok ? result.message : `电脑摄像头授权失败：${result.message}`,
      result.ok ? 'ok' : 'err');
  };

  const bluetoothSelect = $('bluetooth-mode');
  bluetoothSelect.value = bluetoothModeFromSearch(location.search);
  bluetoothSelect.dataset.wired = '1';
  refreshBluetoothControls();
  bluetoothSelect.onchange = async () => {
    const mode = normalizeBluetoothMode(bluetoothSelect.value);
    const url = new URL(location.href);
    url.searchParams.set('bluetooth', mode);
    history.replaceState(null, '', url);
    refreshBluetoothControls();
    // 不在这里 requestDevice：Web Bluetooth 的选择框必须由应用真正的扫描交互触发。
    const inflight = starting;
    if (inflight) await inflight;
    await start();
    refreshBluetoothControls();
  };
  $('bluetooth-authorize').onclick = async () => {
    const adapter = bluetoothController.computerBluetooth();
    if (!adapter || typeof adapter.authorizeDevice !== 'function') {
      boot('电脑蓝牙不可用，无法打开设备选择器', 'err');
      return;
    }
    try {
      // authorizeDevice 内部在第一个 await 前同步调用 requestDevice；不要在这里
      // 先做任何异步工作，否则 Chromium 的 transient user activation 会丢失。
      const selected = await adapter.authorizeDevice();
      boot(`电脑蓝牙已选择：${esc(selected && selected.name || '未命名设备')}；原扫描继续`, 'ok');
    } catch (err) {
      boot(`电脑蓝牙选择失败：${esc(err && (err.name || err.message) || err)}`, 'err');
    }
    refreshBluetoothControls();
  };
  $('bluetooth-power').onclick = guard((c) => {
    const available = c.bluetooth.setAvailability(!c.bluetooth.isAvailable());
    return available;
  }, (available) => (available ? '模拟蓝牙适配器已恢复' : '模拟蓝牙适配器已设为不可用；现有连接已断开'));
  $('bluetooth-disconnect').onclick = guard((c) => c.bluetooth.disconnectAll(), '已断开全部模拟 GATT 连接');
  $('bluetooth-notify').onclick = guard((c) => {
    const bytes = parseBluetoothBytes($('bluetooth-bytes').value);
    return c.bluetooth.emitNotification({
      serviceUuid: $('bluetooth-service').value,
      characteristicUuid: $('bluetooth-characteristic').value,
    }, bytes);
  }, (result) => `已发 BLE 通知：${result.bytes.length} bytes · ${result.characteristicUuid}`);
  $('bluetooth-trace-open').onclick = () => $('bluetooth-trace-file').click();
  $('bluetooth-trace-file').onchange = async () => {
    const input = $('bluetooth-trace-file');
    const file = input.files && input.files[0];
    if (!file) return;
    const caps = capsOf();
    if (!caps) { boot('引擎还没跑起来', 'warn'); input.value = ''; return; }
    try {
      if (normalizeBluetoothMode($('bluetooth-mode').value) !== BLUETOOTH_MODES.MOCK) {
        throw new Error('通知 trace 只注入模拟蓝牙；电脑蓝牙保持真实设备数据');
      }
      const trace = parseBluetoothNotificationTraceJson(await file.text(), {
        serviceUuid: $('bluetooth-service').value,
        characteristicUuid: $('bluetooth-characteristic').value,
        intervalMs: 20,
        loop: $('bluetooth-trace-loop').checked,
      });
      if (bluetoothTraceRun && bluetoothTraceRun.stats().running) bluetoothTraceRun.stop();
      const run = caps.bluetooth.playNotificationTrace(trace);
      bluetoothTraceRun = run;
      const started = run.stats();
      boot(`已开始 BLE 通知 trace：${esc(file.name)} · ${started.totalFrames} 帧`
        + `${started.loop ? ' · 循环' : ''}`, 'ok');
      run.done.then(
        (result) => boot(`BLE 通知 trace ${result.stopped ? '已停止' : '已完成'}：`
          + `${run.stats().emittedFrames} 帧`, result.stopped ? 'dim' : 'ok'),
        (err) => boot(`BLE 通知 trace 失败：${esc(err && err.message)}`, 'err'),
      ).then(refreshBluetoothTraceState);
    } catch (err) {
      boot(`BLE 通知 trace：${esc(err && err.message)}`, 'err');
    } finally {
      input.value = '';
      refreshBluetoothTraceState();
    }
  };
  $('bluetooth-trace-stop').onclick = guard((c) => c.bluetooth.stopNotificationTraces(),
    (count) => (count ? `已停止 ${count} 条 BLE 通知 trace` : '没有正在运行的 BLE 通知 trace'));
  $('bluetooth-log').onclick = () => {
    const computer = normalizeBluetoothMode($('bluetooth-mode').value) === BLUETOOTH_MODES.COMPUTER;
    const source = computer ? bluetoothController.computerBluetooth() : capsOf()?.bluetooth;
    const rows = Array.isArray(source && source.calls) ? source.calls.slice(-16) : [];
    boot(rows.length ? `蓝牙调用（最近 ${rows.length} 条）` : '还没有蓝牙调用；先让应用扫描/连接', 'dim');
    for (const row of rows) {
      const { at: _at, operation, ...detail } = row;
      boot(`  ${esc(operation)}${Object.keys(detail).length ? ` ${esc(JSON.stringify(detail))}` : ''}`, 'dim');
    }
  };

  $('scenario-pick').onchange = showScenarioDesc;
  $('scenario-run').onclick = () => runScenario();
  $('scenario-clear').onclick = () => {
    $('scenario-out').textContent = '还没跑过。';
    $('scenario-shots').innerHTML = '';
    $('scenario-recordings').innerHTML = '';
    $('scenario-state').textContent = '';
  };
  // 截图缩略图点开看大图（再点收回去）。dataUrl 开不了新标签页（Chrome 拦顶层 data: 导航）。
  $('scenario-shots').onclick = (ev) => {
    if (ev.target instanceof HTMLImageElement) ev.target.classList.toggle('zoom');
  };

  $('inspector-filter').oninput = refreshInspector;
  $('inspector-refresh').onclick = refreshInspector;
  $('evidence-export').onclick = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(buildRunEvidence(), `inklab-run-${stamp}.json`);
    evidenceLedger.record('artifact.run-json', { filename: `inklab-run-${stamp}.json` });
    refreshInspector();
  };
  $('evidence-clear').onclick = () => {
    evidenceLedger.clear();
    refreshInspector();
  };

  const asrText = () => $('asr-text').value;
  $('asr-say').onclick = guardStages((c) => c.speech.say(asrText()), () => `ASR 注入 final：${esc(asrText())}`);
  $('asr-interim').onclick = guardStages((c) => c.speech.say(asrText(), { interim: true }), () => `ASR 注入 interim：${esc(asrText())}`);
  $('asr-nomatch').onclick = guardStages((c) => c.speech.nomatch(), '已发 nomatch（引擎会补完尾巴）');
  $('asr-endturn').onclick = guardStages((c) => c.speech.endTurn(), '本轮识别已自然收尾（完整尾巴 + end）');
  $('asr-error').onclick = guardStages((c) => c.speech.errorOut('no-speech', 'InkLab 注入'), '已发 error:no-speech');
  $('asr-abort').onclick = guardStages((c) => c.speech.abortMidway(), '已模拟 ASR 中途 abort（真机会这样）');

  $('net-off').onclick = guardStages((c) => c.net.offline(), '已断网：拦截器 block + connectivity offline');
  $('net-on').onclick = guardStages((c) => c.net.online(), '已恢复联网');
  $('net-guard').checked = netGuardEnabled();
  $('net-guard').dataset.wired = '1'; // 之后 netGuardEnabled() 以这个勾选框为准
  $('net-guard').onchange = guardStages(
    (c) => c.net.guardExternal($('net-guard').checked),
    () => ($('net-guard').checked
      ? '外域出网已挡下（不同源一律 503）'
      : '外域出网已放行——应用里硬编码的线上域名会真的打出去'),
  );
  $('net-log').onclick = guard((c) => {
    const rows = c.net.requests.slice(-12);
    boot(rows.length ? `请求日志（最近 ${rows.length} 条）` : '还没有出网请求（引擎的出网口是 globalThis.fetch）', 'dim');
    for (const r of rows) boot(`  ${esc(r.layer)} ${esc(r.method)} ${esc(r.url)} → ${esc(r.decision)}${r.reason ? ` (${esc(r.reason)})` : ''}`, 'dim');
  });

  $('sensor-inject').onclick = guardStages((c) => c.sensors.injectError($('sensor-pick').value, {
    error: $('sensor-fault').value, message: 'InkLab 注入',
  }), () => `已注入 ${esc($('sensor-pick').value)} 故障：${esc($('sensor-fault').value)}（粘性，要手动清除）`);
  $('sensor-inject-after').onclick = guardStages((c) => c.sensors.injectError($('sensor-pick').value, {
    error: $('sensor-fault').value, message: 'InkLab 注入', afterReadings: 20,
  }), () => `已排队 ${esc($('sensor-pick').value)} 故障：先发 20 条读数再报错`);
  $('sensor-clear').onclick = guardStages((c) => c.sensors.clearError($('sensor-pick').value), '已清除该传感器的故障');
  $('sensor-state').onclick = guard((c) => {
    const rows = c.sensors.activeSessions();
    boot(rows.length ? `传感器活动会话 ${rows.length} 个` : '没有活动的传感器会话（引擎还没调 start）', 'dim');
    for (const r of rows) boot(`  ${esc(r.sensor)} ${r.frequency}Hz ${esc(r.source)} readings=${r.readings}${r.running ? '' : ' (停了)'}`, 'dim');
  });
  $('sensor-pick').onchange = refreshSensorTraceState;
  $('sensor-trace-squat').onclick = guardStages((c) => {
    $('sensor-pick').value = 'accelerometer';
    return c.sensors.loadTrace('accelerometer', createSquatAccelerometerTrace(), {
      loop: $('sensor-trace-loop').checked,
    });
  }, (loaded) => `已装合成深蹲 IMU：${loaded.samples} 帧${loaded.loop ? '，循环' : ''}；下次采集生效`);
  const playHeadGesture = (kind) => {
    $('sensor-pick').value = 'absoluteOrientation';
    const samples = createHeadGestureOrientationTrace(kind);
    const results = state.stages.map((stage) => ({
      lane: stage.id,
      ...stage.caps.sensors.playTrace('absoluteOrientation', samples),
    }));
    const active = results.reduce((sum, row) => sum + row.activeSessions, 0);
    evidenceLedger.record('fixture.head-gesture', { kind, samples: samples.length, results });
    boot(`已注入合成 ${kind} 四元数：${samples.length} 帧 · ${active} 个运行中 World Awareness 会话`,
      active ? 'ok' : 'warn');
    refreshSensorTraceState();
    refreshInspector();
  };
  $('sensor-head-nod').onclick = () => playHeadGesture('nod');
  $('sensor-head-shake').onclick = () => playHeadGesture('shake');
  $('sensor-trace-clear').onclick = guardStages((c) => {
    const sensor = $('sensor-pick').value;
    c.sensors.clearTrace(sensor);
    return sensor;
  }, (sensor) => `${esc(sensor)} 已回到静置基线；下次采集生效`);
  $('sensor-trace-open').onclick = () => $('sensor-trace-file').click();
  $('sensor-trace-file').onchange = async () => {
    const input = $('sensor-trace-file');
    const file = input.files && input.files[0];
    if (!file) return;
    const caps = capsOf();
    if (!caps) { boot('引擎还没跑起来', 'warn'); input.value = ''; return; }
    try {
      const parsed = parseSensorTraceJson(await file.text(), $('sensor-pick').value);
      const loadedRows = inputTargets().map((stage) => stage.caps.sensors.loadTrace(parsed.sensor, parsed.samples, {
        speed: parsed.speed,
        loop: $('sensor-trace-loop').checked,
      }));
      const loaded = loadedRows[0];
      $('sensor-pick').value = parsed.sensor;
      boot(`已导入 ${esc(file.name)}：${esc(loaded.sensor)} ${loaded.samples} 帧 · ${loaded.speed}×`
        + `${loaded.loop ? ' · 循环' : ''}；下次采集生效 · ${loadedRows.length} lane`, 'ok');
    } catch (err) {
      boot(`IMU trace：${esc(err && err.message)}`, 'err');
    } finally {
      input.value = '';
      refreshCapState();
    }
  };

  const batteryLevel = $('battery-level');
  const batteryCharging = $('battery-charging');
  const refreshBatteryInput = () => {
    $('battery-level-text').textContent = `${batteryLevel.value}%`;
  };
  const injectBattery = (level = Number(batteryLevel.value) / 100, charging = batteryCharging.checked) => {
    batteryLevel.value = String(Math.round(level * 100));
    batteryCharging.checked = Boolean(charging);
    refreshBatteryInput();
    const results = state.stages.map((stage) => ({
      lane: stage.id,
      result: stage.caps.battery.setStatus({
        level,
        charging,
        chargingTime: charging ? Math.max(0, Math.round((1 - level) * 3600)) : null,
        dischargingTime: charging ? null : Math.max(0, Math.round(level * 7200)),
      }),
    }));
    evidenceLedger.record('fixture.battery', { level, charging, results });
    boot(`电池状态已注入 ${Math.round(level * 100)}% · ${charging ? '充电中' : '放电中'} · `
      + `${results.filter((row) => row.result.listeners > 0).length}/${results.length} lane 已订阅`, 'ok');
    refreshBatteryState();
    refreshInspector();
  };
  batteryLevel.oninput = refreshBatteryInput;
  $('battery-apply').onclick = () => injectBattery();
  $('battery-low').onclick = () => injectBattery(0.12, false);
  $('battery-full').onclick = () => injectBattery(1, true);
  refreshBatteryInput();

  $('view-focus').onclick = guard(() => primaryStage().view.focus(), 'view.focus()：能力可用');
  $('view-blur').onclick = guard(() => primaryStage().view.blur(), 'view.blur()：引擎此后会拒掉 ASR（blurred）');
  $('tts-list').onclick = guard((c) => {
    const rows = c.speech.spokenTexts.slice(-10);
    boot(rows.length ? `播报（最近 ${rows.length} 条）` : '应用还没播报过', 'dim');
    for (const t of rows) boot(`  ${esc(t)}`, 'dim');
  });

  // 点完按钮把焦点还回去：否则按钮留着 DOM 焦点，Enter/空格会去按按钮而不是驱动应用。
  document.addEventListener('click', (ev) => {
    if (ev.target instanceof HTMLButtonElement) ev.target.blur();
  });

  setInterval(refreshCapState, 1000);
}

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

// ── e2e 取证：源码指纹 + 截图基线比对（跑在页面里，runner 经 CDP 拿结论） ──

/**
 * 当前装载的源码指纹（lib/stamp.mjs）。必须用**本轮装载在内存里的那份文件表**算——
 * 渲染完回头 stat 磁盘会拼出「改后源码 + 改前画面」的假证据（stamp.mjs 头注第 6 条）。
 */
function stampFor(scenarioId) {
  const main = primaryStage();
  if (!state.lastLoad || !main) throw new Error('还没装载完，算不了源码指纹');
  const { info, files } = state.lastLoad;
  const fixtureParts = [];
  // 默认 E2E 口径保持旧 stamp：Studio 黑底 + mock 相机/蓝牙 + llm off 不额外加噪。
  // 背景叠加规则进指纹，避免沿用旧 screen 混合的截图基线。
  if (state.previewMode !== 'studio') fixtureParts.push(`preview:${state.previewMode}`, 'composite:black-unmatte-v2');
  if (state.previewMode === 'optical' && state.lighting !== 'absolute-dark') {
    fixtureParts.push(`lighting:${state.lighting}`);
  }
  if (state.cameraMode !== CAMERA_MODES.MOCK) fixtureParts.push(`camera:${state.cameraMode}`);
  if (state.bluetoothMode !== BLUETOOTH_MODES.MOCK) fixtureParts.push(`bluetooth:${state.bluetoothMode}`);
  if (state.llm && state.llm.mode !== 'off') fixtureParts.push(`llm:${state.llm.mode}`);
  return createSourceStamp({
    files,
    engine: {
      build: main.runtime.engineBuild, version: main.runtime.engineVersion,
      wasmSha256: main.runtime.wasmSha256 || '',
    },
    viewport: { width: main.width, height: main.height, scaleFactor: main.scaleFactor },
    scenario: scenarioId || '',
    // LLM 模式进夹具 id：replay 喂录像跑出来的屏和 off 走离线路径跑出来的屏不是同一张证据。
    fixtures: fixtureParts.join('|'),
  });
}

/** dataUrl / objectURL → RGBA 像素（shots.mjs 吃的形状）。 */
async function decodeImage(src) {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('图像解码失败'));
    img.src = src;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

/**
 * 上一次 runScenario 的截图 vs 工程基线（<app>/e2e/baselines/<scenarioId>/）。
 * 比对在页面里做（canvas 解码 + shots.mjs 的像素 diff）；写基线不在这儿——
 * 页面落不了盘，accept 由 e2e runner 拿返回值里的 dataUrl 写文件。
 */
async function e2eShotReport(scenarioId) {
  const report = state.lastScenario;
  if (!report || report.scenarioId !== scenarioId) {
    throw new Error(`先跑 ${scenarioId} 再要报告（lastScenario=${(report && report.scenarioId) || '无'}）`);
  }
  const scenario = findScenario(scenarioId);
  const stampInfo = stampFor(scenarioId);
  const baseDir = `e2e/baselines/${scenarioId}`;
  const known = ((state.info.e2e && state.info.e2e.baselines) || [])
    .filter((p) => p.startsWith(baseDir + '/') && p.endsWith('.png'))
    .map((p) => p.slice(baseDir.length + 1, -4));

  const readShot = async (name) => {
    const res = await hostFetch(`/app/${baseDir}/${name}.png`, { cache: 'no-store' });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    let image;
    try { image = await decodeImage(url); } finally { URL.revokeObjectURL(url); }
    let meta = {};
    try {
      const m = await hostFetch(`/app/${baseDir}/${name}.json`, { cache: 'no-store' });
      if (m.ok) meta = await m.json();
    } catch { /* 没有元数据的老基线：sourceStamp 缺席会被判 stale，正是想要的 */ }
    return { image, capturedAt: meta.capturedAt ?? null, sourceStamp: meta.sourceStamp ?? null };
  };
  const store = createShotStore({
    readShot,
    writeShot: () => { throw new Error('页面里不落盘，accept 由 e2e runner 做'); },
    listShots: () => known,
    defaultDiffOptions: (scenario && scenario.shotOptions) || {},
  });

  const shots = [];
  for (const rec of report.shots) {
    const v = rec.value || rec;
    const image = await decodeImage(v.dataUrl);
    shots.push({
      name: rec.name,
      dataUrl: v.dataUrl,
      width: image.width,
      height: image.height,
      image,
      diffOptions: rec.diffOptions || null,
    });
  }
  const baseline = await store.compareAll(
    shots.map((s) => ({ name: s.name, image: s.image, diffOptions: s.diffOptions })),
    { sourceStamp: stampInfo.stamp },
  );
  return {
    scenarioId,
    stamp: stampInfo.stamp,
    stampParts: stampInfo.parts,
    hasBaselines: known.length > 0,
    shots: shots.map(({ name, dataUrl, width, height }) => ({ name, dataUrl, width, height })),
    baseline,
  };
}

// ── 自动化入口 ──────────────────────────────────────────────────────────

Object.assign(state, {
  press, sendInput, wake, snapshot, snapshotMatrix, runScenario, reload: start,
  startRecording: startStageRecording, stopRecording: stopStageRecording,
  recordingFormats: () => stageRecorder.formats(),
  scenarioById: findScenario, stampFor, e2eShotReport, setLlm,
  exportRun: buildRunEvidence, conformanceReport,
  setPreviewMode: applyPreviewMode, setLighting: applyLightingProfile,
  setTheme: applyUiTheme, setControlGroup: applyControlGroup,
  setHintsVisible: applyHintsVisibility, setInspectorCollapsed: applyInspectorCollapsed,
  pump: (n) => state.stages.map((st) => pump(st.view, n || PUMP_MAX)),
});

renderScenarioPicker();
wireConsole();
applyUiTheme(normalizeUiTheme(document.documentElement.dataset.theme, readUiPref(UI_PREF_KEYS.theme) || 'dark'), { persist: false });
applyControlGroup(normalizeControlGroup(readUiPref(UI_PREF_KEYS.controls)), { persist: false });
applyHintsVisibility(storedBoolean(readUiPref(UI_PREF_KEYS.hints), false), { persist: false });
applyInspectorCollapsed(initialInspectorCollapsed(window.innerWidth, readUiPref(UI_PREF_KEYS.inspector)), { persist: false });
const initialSearch = new URLSearchParams(location.search);
state.previewMode = normalizePreviewMode(initialSearch.get('preview'));
state.lighting = normalizeLightingProfile(initialSearch.get('lighting'));
applyPreviewMode(state.previewMode, { record: false });
applyLightingProfile(state.lighting, { record: false });
refreshRecordingState();
connectWatch();
start();

window.addEventListener('beforeunload', () => {
  if (recordingCompositeTimer !== null) clearInterval(recordingCompositeTimer);
  stageRecorder.dispose();
});
