// stage.js — 舞台：运行时选择器、每条 lane 的画布与引擎启动、光照 / 预览模式、驱动器接线。

import { createProbeCapabilities } from '/host/lib/caps/probe.mjs';
import { createEventBridge, createHostCapabilities } from '/host/lib/caps/index.mjs';
import { llmAllowExternal } from '/host/lib/caps/llm.mjs';
import { CAMERA_MODES, hostCapabilitiesForCameraMode } from '/host/lib/camera-mode.mjs';
import { createComputerCameraTakePhoto } from '/host/lib/browser-camera.mjs';
import { createDriver } from '/host/lib/driver.mjs';
import { readProjectFile } from '/host/lib/project-file.mjs';
import { runtimeDisplayVersion, selectRuntimeIds } from '/host/lib/runtime-lock.mjs';
import {
  LIGHTING_PROFILES, lightingProfile, normalizeLightingProfile, normalizePreviewMode, paintPreviewFrame,
  PREVIEW_MODES, previewGeometry, previewMode,
} from '/host/lib/lighting.mjs';
import { instrumentCapabilities } from '/host/lib/evidence.mjs';
import { $, boot, esc, write } from '/host/inklab/dom.js';
import { pump } from '/host/inklab/frame.js';
import { evidenceLedger, hostFetch, state } from '/host/inklab/state.js';
import { sendInput, snapshot, wake } from '/host/inklab/input.js';
import { refreshInspector } from '/host/inklab/inspector.js';
import { netGuardEnabled } from '/host/inklab/project.js';

// ── 舞台 ────────────────────────────────────────────────────────────────

// bindDomEvents 的键盘绑定挂在 keyboardTarget（缺省 window）上，且直接进 wasm：
// 宿主既插不进 pump，也没法镜像到第二块画布。给它一个游离元素当靶子就等于把它关掉——
// 游离节点永远收不到键盘事件——指针/滚轮那部分照常生效。
const keyboardSink = document.createElement('div');

function runtimeRegistryOf(info) {
  const runtimes = (info?.runtimes || []).filter((runtime) => runtime.available);
  return { default: info?.runtimeDefault, runtimes };
}

export function renderRuntimePicker(info) {
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

export function selectedRuntimeRows(info) {
  const checked = new Set([...$('runtime-picks').querySelectorAll('input:checked')].map((input) => input.value));
  const rows = (info?.runtimes || []).filter((runtime) => runtime.available && checked.has(runtime.id));
  if (rows.length) return rows;
  const fallback = (info?.runtimes || []).find((runtime) => runtime.available && runtime.id === info.runtimeDefault)
    || (info?.runtimes || []).find((runtime) => runtime.available);
  return fallback ? [fallback] : [];
}

export function renderStageShells(runtimes) {
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

export function canvasForRuntime(id) {
  return [...document.querySelectorAll('canvas[data-runtime-canvas]')]
    .find((canvas) => canvas.dataset.runtimeCanvas === id) || null;
}

export function setRuntimeStatus(id, text, cls = '') {
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

export function applyLightingProfile(value, { record = true } = {}) {
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

export function applyPreviewMode(value, { record = true } = {}) {
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

export function refreshHeaderMeta() {
  if (!state.info) return;
  const total = state.runtimeSelection.length || state.stages.length;
  $('meta').innerHTML = `${state.stages.length}/${total} lane · ${state.info.manifest.length} 文件`
    + ` · ${esc(previewMode(state.previewMode).shortLabel)}`
    + (state.previewMode === 'optical' ? `/${esc(lightingProfile(state.lighting).shortLabel)}` : '')
    + (state.llm?.mode && state.llm.mode !== 'off' ? ` · llm:${esc(state.llm.mode)}` : '')
    + (state.runtimeErrors.length ? ` · <span class="err">${state.runtimeErrors.length} lane 失败</span>` : '');
}

export function setSourceBadge(info) {
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

export async function bootStage({
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
    // 会在**任何脚本步骤之前**就真的打出去（某真实应用的启动天气预取），场景层拦不住。
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

export function disposeStage(stage) {
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

export function makeDriver(stage, extra = {}) {
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
