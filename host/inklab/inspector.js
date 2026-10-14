// inspector.js — Inspector 面板：标签页切换、能力状态刷新、证据汇总与导出。

import { BLUETOOTH_MODES, normalizeBluetoothMode } from '/host/lib/bluetooth-mode.mjs';
import { runtimeDisplayVersion } from '/host/lib/runtime-lock.mjs';
import { lightingProfile, previewMode } from '/host/lib/lighting.mjs';
import { redactEvidence } from '/host/lib/evidence.mjs';
import { $, esc, panes } from '/host/inklab/dom.js';
import { engineLog } from '/host/inklab/engine-log.js';
import {
  bluetoothController, bluetoothTrace, capsOf, evidenceLedger, primaryStage, state,
} from '/host/inklab/state.js';
import { applyInspectorCollapsed } from '/host/inklab/prefs.js';

export function showPane(name) {
  if (state.inspectorCollapsed) applyInspectorCollapsed(false);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.pane === name));
  for (const [k, el] of Object.entries(panes)) el.classList.toggle('on', k === name);
  refreshInspector();
}
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => showPane(tab.dataset.pane);
}

export function refreshCapState() {
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

export function refreshBatteryState() {
  const badge = $('battery-state');
  if (!badge) return;
  const rows = state.stages.map((stage) => ({ id: stage.id, listeners: stage.caps?.battery?.listeners?.().length || 0 }));
  const active = rows.filter((row) => row.listeners > 0);
  badge.textContent = active.length
    ? active.map((row) => `${row.id}:${row.listeners}`).join(' · ')
    : '等待应用订阅';
  badge.className = `pill ${active.length ? 'ok' : ''}`;
}

export function refreshBluetoothTraceState() {
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
  const stats = active[0] || (bluetoothTrace.run && bluetoothTrace.run.stats());
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

export function refreshSensorTraceState() {
  const caps = capsOf();
  const badge = $('sensor-trace-state');
  if (!caps || !badge) return;
  const trace = caps.sensors.traceState($('sensor-pick').value);
  badge.textContent = trace.source === 'trace'
    ? `${trace.samples} 帧 · ${trace.speed}×${trace.loop ? ' · 循环' : ''}`
    : 'baseline';
  badge.className = `pill ${trace.source === 'trace' ? 'ok' : ''}`;
}

export function refreshNetState() {
  const caps = capsOf();
  if (!caps) return;
  const on = caps.net.isOnline();
  const badge = $('net-state');
  badge.textContent = on ? 'online' : 'offline';
  badge.className = `pill ${on ? 'ok' : 'err'}`;
}

export function refreshBluetoothControls() {
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

export function buildRunEvidence() {
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

export function conformanceReport() {
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

function detailRows(rows, summary) {
  const q = inspectorQuery();
  const picked = q ? rows.filter((row) => safeJson(row).toLowerCase().includes(q)) : rows;
  if (!picked.length) return '<span class="dim">没有匹配记录。</span>';
  return picked.slice(-120).reverse().map((row) => (
    `<details class="inspect-row"><summary>${summary(row)}</summary><pre>${esc(safeJson(row))}</pre></details>`
  )).join('');
}

export function refreshInspector() {
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
