// scenarios.js — 场景：下拉框与说明、跑场景（驱动器 + 录屏 + 取证）。

import { rgbaFrameHash } from '/host/lib/frame-hash.mjs';
import { diffPixels } from '/host/lib/shots.mjs';
import { $, boot, esc } from '/host/inklab/dom.js';
import { engineLog } from '/host/inklab/engine-log.js';
import { findScenario, primaryStage, state } from '/host/inklab/state.js';
import { advanceStampClock } from '/host/inklab/input.js';
import { showPane } from '/host/inklab/inspector.js';
import {
  refreshRecordingState, startStageRecording, stopRecordingTicker, stopStageRecording,
} from '/host/inklab/recording.js';
import { makeDriver } from '/host/inklab/stage.js';

// ── 场景跑测 ────────────────────────────────────────────────────────────

export function renderScenarioPicker() {
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
export function showScenarioDesc() {
  const s = findScenario($('scenario-pick').value);
  $('scenario-desc').textContent = s ? s.summary : '';
}

export async function runScenario(id = $('scenario-pick').value, options = {}) {
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
    try { advanceStampClock(driver.clock()); } catch { /* 拿不到就算了 */ }
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
