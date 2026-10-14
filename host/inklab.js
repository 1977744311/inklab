// inklab.js — 本地宿主的入口：初始化引擎、把工程源码喂进去、把画面接到 canvas，
// 并把「驱动 / 场景 / 能力注入」这三件事接到页面上。实现按职责分在 inklab/*.js，
// 本文件只负责按顺序把它们接起来，并暴露 window.__inklab 自动化入口。
//
// 有两条接线口径是实测逼出来的，改之前先读 docs/runtime-notes.md 的《焦点与帧》一节：
//
//  1) **每次程序化输入之后必须自己 pump 帧**。引擎的帧调度是 requestAnimationFrame
//     （glue `Vr()`），而应用的步进要落在帧上——页面不可见（后台标签页 / 窗口被完全遮挡）
//     时 rAF 停摆，`dispatchInput` 只有第一下生效，后面全落空。`view.render()` 是公开且同步的，
//     调它就等于手摇一帧，与可见性无关。所以宿主里所有输入出口都走 `sendInput`/`wake`
//     （inklab/input.js），它们 dispatch 完立刻 pump。
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

import {
  initialInspectorCollapsed, normalizeControlGroup, normalizeUiTheme, storedBoolean,
} from '/host/lib/ui-preferences.mjs';
import { normalizeLightingProfile, normalizePreviewMode } from '/host/lib/lighting.mjs';
import '/host/inklab/engine-log.js';
import { pump, PUMP_MAX } from '/host/inklab/frame.js';
import { findScenario, state } from '/host/inklab/state.js';
import {
  applyControlGroup, applyHintsVisibility, applyInspectorCollapsed, applyUiTheme, readUiPref, UI_PREF_KEYS,
} from '/host/inklab/prefs.js';
import { press, sendInput, snapshot, snapshotMatrix, wake } from '/host/inklab/input.js';
import { buildRunEvidence, conformanceReport } from '/host/inklab/inspector.js';
import {
  refreshRecordingState, stageRecorder, startStageRecording, stopStageRecording,
} from '/host/inklab/recording.js';
import { setLlm } from '/host/inklab/project.js';
import { applyLightingProfile, applyPreviewMode } from '/host/inklab/stage.js';
import { connectWatch, start } from '/host/inklab/lifecycle.js';
import { renderScenarioPicker, runScenario } from '/host/inklab/scenarios.js';
import { wireConsole } from '/host/inklab/console.js';
import { e2eShotReport, stampFor } from '/host/inklab/e2e.js';
import '/host/inklab/keyboard.js';

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
