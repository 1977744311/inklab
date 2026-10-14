// lifecycle.js — 装载与热重载：start() 把工程重新装进引擎，connectWatch() 订阅服务端的文件变化。

import { CAMERA_MODES } from '/host/lib/camera-mode.mjs';
import { BLUETOOTH_MODES } from '/host/lib/bluetooth-mode.mjs';
import { runtimeDisplayVersion } from '/host/lib/runtime-lock.mjs';
import { SCENARIOS } from '/scenarios/index.mjs';
import { $, boot, esc, panes } from '/host/inklab/dom.js';
import { engineLog } from '/host/inklab/engine-log.js';
import { bluetoothController, bluetoothTrace, evidenceLedger, hostFetch, state } from '/host/inklab/state.js';
import { refreshInspector, refreshNetState } from '/host/inklab/inspector.js';
import {
  refreshRecordingState, stageRecorder, stopRecordingTicker, stopStageRecording,
} from '/host/inklab/recording.js';
import {
  loadProject, loadProjectScenarios, resolveLlm, selectedBluetoothMode, selectedCameraMode,
} from '/host/inklab/project.js';
import {
  applyLightingProfile, applyPreviewMode, bootStage, canvasForRuntime, disposeStage, makeDriver,
  refreshHeaderMeta, renderRuntimePicker, renderStageShells, selectedRuntimeRows, setRuntimeStatus,
  setSourceBadge,
} from '/host/inklab/stage.js';
import { renderScenarioPicker } from '/host/inklab/scenarios.js';

// ── 装载 ────────────────────────────────────────────────────────────────

let starting = null;

export async function start() {
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
      // （`cannot recursively acquire mutex`，与被测应用无关，详见 docs/runtime-notes.md）。
      // 所以日志窗口挡不干净它——场景里要写「本场引擎没崩」这类断言的，必须自己按
      // 「panic 前几行是不是拆实例标记」把这一路排除掉（口径见 docs/runtime-notes.md）。
      state.bootLogFrom = engineLog.length;
      state.stages = [];
      state.view = null; state.caps = null; state.driver = null;
      state.mod = null;
      state.runtimeErrors = [];
      if (bluetoothTrace.run && bluetoothTrace.run.stats().running) bluetoothTrace.run.stop();
      bluetoothTrace.run = null;

      // 必须在引擎 import / openBundle 前选好 navigator.bluetooth：应用 onLoad 可能立刻查可用性。
      state.bluetoothMode = selectedBluetoothMode();
      bluetoothController.setMode(state.bluetoothMode);
      if (state.bluetoothMode === BLUETOOTH_MODES.MOCK) state.bluetooth.resetRuntime();

      const { info, files } = await loadProject();
      renderRuntimePicker(info);
      setSourceBadge(info);
      const selectedRuntimes = selectedRuntimeRows(info);
      if (!selectedRuntimes.length) throw new Error('没有可用的运行时 lane；先跑 npm run engine');
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

export function connectWatch() {
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

/** 正在进行中的装载（Promise），没有则为 null。控制台按钮据此避免在装载中途操作。 */
export const isStarting = () => starting;
