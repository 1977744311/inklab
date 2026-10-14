// state.js — 宿主全局状态（也是 window.__inklab 自动化入口）与几个启动期必须尽早留存的原生对象。

import { CAMERA_MODES } from '/host/lib/camera-mode.mjs';
import { BLUETOOTH_MODES, createNavigatorBluetoothController } from '/host/lib/bluetooth-mode.mjs';
import { normalizeUiTheme } from '/host/lib/ui-preferences.mjs';
import { createEvidenceLedger } from '/host/lib/evidence.mjs';
import { SCENARIOS } from '/scenarios/index.mjs';

// 宿主自己取源码/清单用的 fetch：**在断网注入之前留一份**。
// 能力控制台的「断网」会换掉 globalThis.fetch（引擎的出网口就是它），
// 不留这一份的话一断网连「重载工程」都拉不到源码了。
export const hostFetch = globalThis.fetch.bind(globalThis);

// ink_web 的蓝牙不是 hostCapabilities 命名空间，而是直接读 navigator.bluetooth。
// 控制器必须在第一次安装 mock 前保存原生对象，computer 模式才能无损恢复浏览器 Web Bluetooth。
export const bluetoothController = createNavigatorBluetoothController();

// ── 全局状态（也是自动化入口） ───────────────────────────────────────────

export const evidenceLedger = createEvidenceLedger();

export const state = {
  mod: null, mods: new Map(), info: null,
  view: null, caps: null, driver: null,   // 主舞台的快捷引用（脚本按这三个名字取）
  stages: [], shots: [], recordings: [], recording: null,
  runtimeSelection: [], runtimeErrors: [], previewMode: 'studio', lighting: 'absolute-dark',
  theme: normalizeUiTheme(document.documentElement.dataset.theme),
  controlGroup: 'interaction', hintsVisible: false, inspectorCollapsed: false,
  evidence: evidenceLedger,
  // 场景 = 工程自带（<app>/e2e/scenarios/，装载时动态 import）+ 内置通用（scenarios/）
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

window.__inklab = state; // 供自动化脚本从 DevTools / CDP 直接驱动

export const findScenario = (id) => state.scenarios.find((s) => s.id === id) || null;

export const primaryStage = () => state.stages.find((st) => st.primary) || null;

// ── 能力控制台 ──────────────────────────────────────────────────────────

export const capsOf = () => primaryStage()?.caps || null;

/**
 * 当前在播的 BLE 通知 trace 句柄：重载工程前要停掉、控制台启动、Inspector 读状态，三处共用，
 * 所以放在这里（ES 模块的绑定不能被别的模块赋值，用对象字段承载）。
 */
export const bluetoothTrace = { run: null };
