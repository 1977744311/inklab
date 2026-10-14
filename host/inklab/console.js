// console.js — 能力控制台：把页面上的按钮 / 开关接到能力层（传感器、蓝牙、相机、网络、LLM、录屏等）。

import { CAMERA_MODES, cameraModeFromSearch, normalizeCameraMode } from '/host/lib/camera-mode.mjs';
import { requestComputerCameraPermission } from '/host/lib/browser-camera.mjs';
import {
  BLUETOOTH_MODES, bluetoothModeFromSearch, normalizeBluetoothMode,
} from '/host/lib/bluetooth-mode.mjs';
import { parseBluetoothBytes, parseBluetoothNotificationTraceJson } from '/host/lib/caps/bluetooth.mjs';
import {
  createHeadGestureOrientationTrace, createSquatAccelerometerTrace, parseSensorTraceJson,
} from '/host/lib/sensor-trace.mjs';
import { nextUiTheme } from '/host/lib/ui-preferences.mjs';
import { $, boot, esc } from '/host/inklab/dom.js';
import {
  bluetoothController, bluetoothTrace, capsOf, evidenceLedger, primaryStage, state,
} from '/host/inklab/state.js';
import {
  applyControlGroup, applyHintsVisibility, applyInspectorCollapsed, applyUiTheme,
} from '/host/inklab/prefs.js';
import { inputTargets, snapshotMatrix, wake } from '/host/inklab/input.js';
import {
  buildRunEvidence, refreshBatteryState, refreshBluetoothControls, refreshBluetoothTraceState,
  refreshCapState, refreshInspector, refreshSensorTraceState, showPane,
} from '/host/inklab/inspector.js';
import {
  refreshRecordingState, stageRecorder, startStageRecording, stopRecordingTicker, stopStageRecording,
} from '/host/inklab/recording.js';
import { netGuardEnabled } from '/host/inklab/project.js';
import { applyLightingProfile, applyPreviewMode } from '/host/inklab/stage.js';
import { isStarting, start } from '/host/inklab/lifecycle.js';
import { runScenario, showScenarioDesc } from '/host/inklab/scenarios.js';

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

function downloadJson(value, filename) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function wireConsole() {
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
    const inflight = isStarting();
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
    const inflight = isStarting();
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
    const inflight = isStarting();
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
      if (bluetoothTrace.run && bluetoothTrace.run.stats().running) bluetoothTrace.run.stop();
      const run = caps.bluetooth.playNotificationTrace(trace);
      bluetoothTrace.run = run;
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
