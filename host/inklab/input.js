// input.js — 程序化输入的唯一出口（按键 / 唤醒词）与截图：每次输入后立刻 pump 帧，见 inklab.js 头注第 1 条。

import { assertInput } from '/host/lib/driver.mjs';
import { compositePreviewCanvas } from '/host/lib/lighting.mjs';
import { $ } from '/host/inklab/dom.js';
import { pump } from '/host/inklab/frame.js';
import { evidenceLedger, primaryStage, state } from '/host/inklab/state.js';

/** 键盘/唤醒共用的时间戳时钟：单调、不回退。应用的同向去重闸看的就是这个数。 */
let lastStamp = 0;

const stampNow = () => { lastStamp = Math.max(lastStamp + 16, Date.now()); return lastStamp; };

/** 输入要打到哪些舞台：主舞台恒在，副舞台看「镜像输入」开关。 */
export function inputTargets() {
  if (state.inputScope) return state.stages.filter((st) => st?.view && st.id === state.inputScope);
  return state.stages.filter((st) => st && st.view && (st.primary || $('mirror').checked));
}

/** 全部程序化输入的唯一出口：校验 → dispatch → 立刻 pump（见文件头第 1 条）。 */
export function sendInput(type, key, timestamp) {
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
export function press(key) {
  const at = sendInput('keydown', key);
  sendInput('keyup', key, at + 16);
  return at;
}

export function wake(keyword = 'inklab', timestamp) {
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

/** 截图（默认主舞台）。场景的 shot 步骤与截图按钮共用这一条。 */
export function snapshot(name = `shot-${state.shots.length}`, stage = primaryStage()) {
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

export function snapshotMatrix(name = `matrix-${state.shots.length}`) {
  return state.stages.map((stage) => snapshot(
    `${name}--${stage.runtime.id}--${state.previewMode}--${state.lighting}`, stage,
  ));
}

/** 场景跑完把宿主时钟追到驱动器的虚拟时钟（别的模块不能直接给 lastStamp 赋值）。 */
export function advanceStampClock(driverClock) { lastStamp = Math.max(lastStamp, driverClock); }
