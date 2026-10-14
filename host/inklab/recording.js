// recording.js — 舞台录屏：canvas.captureStream + MediaRecorder，只录主舞台。

import { createCanvasRecorder } from '/host/lib/recording.mjs';
import { compositePreviewCanvas, paintPreviewFrame } from '/host/lib/lighting.mjs';
import { $, boot, esc } from '/host/inklab/dom.js';
import { pump } from '/host/inklab/frame.js';
import { primaryStage, state } from '/host/inklab/state.js';
import { showPane } from '/host/inklab/inspector.js';

// 浏览器原生 canvas.captureStream + MediaRecorder：只录主舞台，不碰屏幕/窗口权限。
// Chrome 支持 H.264 MP4 时优先选它；不支持才由 recording.mjs 降级 WebM 并显式标记。
export const stageRecorder = createCanvasRecorder();

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

export function refreshRecordingState() {
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

export function stopRecordingTicker() {
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

export function startStageRecording({ name = 'manual', scenarioId = null } = {}) {
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

export async function stopStageRecording({ download = true } = {}) {
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

window.addEventListener('beforeunload', () => {
  if (recordingCompositeTimer !== null) clearInterval(recordingCompositeTimer);
  stageRecorder.dispose();
});
