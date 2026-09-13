// index.mjs — 把各能力模块组装成一套完整的宿主能力集，并接好事件回灌通道。
//
// 这一层解决两件在各模块里各写一遍必然写歪的事：
//   1. 事件回灌的真实入口是 `view.getHostCapabilitiesTarget()` 上的 CustomEvent，
//      而且**校验失败只在 console 留一行、不抛回宿主**——拼错字段是纯沉默失败。
//      所以这里统一做名字白名单校验，把沉默失败提前变成响亮失败。
//   2. 引擎没配的方法一被用到就抛；`media` 更狠——不配会回落到 `navigator.mediaDevices`，
//      本地宿主会意外去开真摄像头。所以默认把这张表里的能力配满。
//
// bluetooth 是刻意的例外：ink_web 0.17.0 用独立 Web Bluetooth bridge 直接读取
// navigator.bluetooth，不经过 setHostCapabilities。它由 caps/bluetooth.mjs +
// bluetooth-mode.mjs 接线，不能在这里 compose（glue 没有对应 codec）。

import { composeCapabilities, isKnownEvent, CAPABILITY_EVENTS } from './contract.mjs';
import { createSensorCapabilities } from './sensors.mjs';
import { createSpeechCapabilities } from './speech.mjs';
import { createMediaCapabilities } from './media.mjs';
import { createLanguageModelCapabilities } from './llm.mjs';
import { createNetworkControl } from './net.mjs';
import { createBatteryCapabilities } from './battery.mjs';

/**
 * 把 InkView 的能力事件靶包成一个 `dispatchEvent(name, detail)`。
 * 事件名不在契约表里就当场抛——引擎那边只会静默丢弃，等到「功能没反应」时再查代价太大。
 */
export function createEventBridge(view, { onDispatch } = {}) {
  const target = typeof view?.getHostCapabilitiesTarget === 'function'
    ? view.getHostCapabilitiesTarget()
    : null;
  if (!target || typeof target.dispatchEvent !== 'function') {
    throw new Error('InkLab: 这个 InkView 没有能力事件靶（getHostCapabilitiesTarget）');
  }
  return (name, detail) => {
    if (!isKnownEvent(name)) {
      const ns = String(name).split('.')[0];
      const known = CAPABILITY_EVENTS[ns];
      throw new Error(`InkLab: 引擎不认识事件 ${name}${known ? `；${ns} 可用：${known.join(', ')}` : ''}`);
    }
    if (typeof onDispatch === 'function') { try { onDispatch(name, detail); } catch { /* 观察钩子不反伤 */ } }
    target.dispatchEvent(new CustomEvent(name, { detail }));
  };
}

/**
 * 组一套完整能力集。
 * @param {object} opts
 * @param {(name:string, detail:object)=>void} opts.dispatchEvent 事件回灌（用 createEventBridge 造）
 * @param {object} [opts.sensors] 传给 createSensorCapabilities 的额外配置
 * @param {object} [opts.speech]
 * @param {object} [opts.media]
 * @param {object} [opts.languageModel] 语言模型配置（缺省给一个「不可用」的诚实答复）
 */
export function createHostCapabilities({
  dispatchEvent, now = () => Date.now(),
  setTimeout: setT = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: clearT = (h) => clearTimeout(h),
  sensors: sensorOpts = {}, speech: speechOpts = {}, media: mediaOpts = {}, battery: batteryOpts = {},
  net: netOpts = {},
  languageModel = null, readFile, fetch: fetchImpl,
} = {}) {
  if (typeof dispatchEvent !== 'function') {
    throw new TypeError('InkLab: createHostCapabilities 需要 dispatchEvent');
  }
  const shared = { dispatchEvent, now, setTimeout: setT, clearTimeout: clearT };

  const sensors = createSensorCapabilities({ ...shared, ...sensorOpts });
  const speech = createSpeechCapabilities({ ...shared, ...speechOpts });
  const media = createMediaCapabilities({ ...shared, readFile, ...mediaOpts });
  const battery = createBatteryCapabilities({ dispatchEvent, now, ...batteryOpts });

  // 语言模型：没给配置时走一个「不可用」的诚实答复——返回空配置让引擎自判模型不可用，
  // 应用会走它自己的离线路径。假装成功比不可用更糟：那样测出来的降级全是错的。
  const llm = createLanguageModelCapabilities({ now, setTimeout: setT, fetch: fetchImpl, ...(languageModel || {}) });
  // 网络：默认带「外域出网挡下」那道闸（net.mjs guardExternal）。本地宿主跑的是真源码，
  // 应用里硬编码的线上域名会真的打到别人的生产后端——那既是隐私边界，也是 e2e 的稳定性前提。
  const net = createNetworkControl({ now, setTimeout: setT, ...netOpts });

  return {
    capabilities: composeCapabilities(
      sensors.capabilities, speech.capabilities, media.capabilities, battery.capabilities, llm.capabilities,
    ),
    sensors,
    speech,
    media,
    battery,
    llm,
    net,
    /** 宿主重载引擎前必须把所有在跑的采样/会话停干净，否则野计时器会打到已销毁的 view 上。 */
    dispose() {
      try { sensors.stopAll?.(); } catch { /* 尽力清场 */ }
      try { speech.reset?.(); } catch { /* 同上 */ }
      try { media.reset?.(); } catch { /* 同上 */ }
      try { battery.reset?.(); } catch { /* 同上 */ }
    },
  };
}
