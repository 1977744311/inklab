// device-info.mjs — 连上眼镜先看清它：型号、Ink 版本、触控板、开发者模式，以及会让真机测试失真的状态。
//
// 一次 adb shell 收齐（每多一次往返就多几百毫秒）。只读：不改任何系统设置。
// 会让测试失真的三类状态（2026-11-17 在 RG1 上实测）：
//   佩戴检测判定「没戴」时，触控板进低功耗，硬件收到点击也不上报手势；
//   开着的无障碍服务（例如 Quick Menu 的 RingKeyService）会接管按键；
//   AIUI 开发者模式没开时，开发者接口拒绝打开、安装调试包。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { touchpadProfileFor } from './device-input.mjs';

const exec = promisify(execFile);
export const DEVELOPER_SETTING = 'rokid_aiui_developer_mode';

/** 在设备上跑一段 sh 脚本，返回 stdout。脚本作为一个参数传给 adb shell，由设备端 sh 解析。 */
export async function adbShell(execute, serial, script, { timeout = 15000, adb = process.env.ADB || 'adb' } = {}) {
  const { stdout } = await execute(adb, ['-s', serial, 'shell', script], { timeout, maxBuffer: 16 * 1024 * 1024 });
  return String(stdout);
}

// 每行一个 key=value；getevent 的设备块原样跟在 @inputs 之后。
export const INFO_SCRIPT = [
  'echo "model=$(getprop ro.product.model)"',
  'echo "hardwareSerial=$(getprop ro.serialno)"',
  'echo "device=$(getprop ro.product.device)"',
  'echo "android=$(getprop ro.build.version.release)"',
  'echo "build=$(getprop ro.build.display.id)"',
  'echo "inkVersion=$(getprop debug.rokid.ink.version)"',
  'echo "inkBuildTime=$(getprop debug.rokid.ink.build_time)"',
  `echo "developerMode=$(settings get global ${DEVELOPER_SETTING})"`,
  'echo "screenOffTimeout=$(settings get system screen_off_timeout)"',
  'echo "accessibility=$(settings get secure enabled_accessibility_services)"',
  'for e in /sys/class/input/event*; do d=$e/device/device; '
    + 'if [ -r $d/psensor ]; then echo "wear.${e##*/}=$(cat $d/psensor) $(cat $d/low_power 2>/dev/null)"; fi; done',
  'echo "@inputs"',
  'getevent -pl 2>/dev/null | grep -E "^add device|^  name:"',
].join('; ');

/** 解析 INFO_SCRIPT 的输出（纯函数）。 */
export function parseDeviceInfo(stdout, serial = '') {
  const [head, inputsText = ''] = String(stdout).replace(/\r/g, '').split('@inputs');
  const fields = {};
  const wear = {};
  for (const line of head.split('\n')) {
    const m = /^([\w.]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1].startsWith('wear.')) {
      const [psensor, lowPower] = m[2].trim().split(/\s+/).map((v) => (v === undefined || v === '' ? null : Number(v)));
      wear[`/dev/input/${m[1].slice(5)}`] = { psensor, lowPower };
    } else fields[m[1]] = m[2].trim();
  }
  const clean = (value) => (value && value !== 'null' ? value : null);
  const inputs = [];
  for (const line of inputsText.split('\n')) {
    const add = /^add device \d+: (\S+)/.exec(line);
    if (add) inputs.push({ path: add[1], name: '' });
    const name = /^\s+name:\s+"(.*)"/.exec(line);
    if (name && inputs.length) inputs[inputs.length - 1].name = name[1];
  }
  const touchpad = inputs.map((input) => ({ ...input, profile: touchpadProfileFor(input.name) })).find((input) => input.profile) || null;
  const timeout = Number(fields.screenOffTimeout);
  return {
    serial,
    hardwareSerial: clean(fields.hardwareSerial),
    model: clean(fields.model),
    device: clean(fields.device),
    android: clean(fields.android),
    build: clean(fields.build),
    ink: { version: clean(fields.inkVersion), buildTime: clean(fields.inkBuildTime) },
    developerMode: clean(fields.developerMode),
    screenOffTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
    accessibility: (clean(fields.accessibility) || '').split(':').map((s) => s.trim()).filter(Boolean),
    inputs,
    touchpad: touchpad ? { path: touchpad.path, name: touchpad.name, profile: touchpad.profile.id } : null,
    wear: touchpad ? wear[touchpad.path] || null : null,
  };
}

export async function readDeviceInfo({ serial, execute = exec, adb } = {}) {
  return parseDeviceInfo(await adbShell(execute, serial, INFO_SCRIPT, { adb }), serial);
}

/** 会让真机测试失真的状态，逐条给出原因与处理办法（纯函数）。level: warn 会影响结果，info 只是提示。 */
export function deviceWarnings(info) {
  const out = [];
  if (!info.ink?.version) out.push({ level: 'warn', code: 'ink-version-unknown', text: '读不到眼镜的 Ink 版本（debug.rokid.ink.version），模拟器没法自动对齐引擎' });
  if (!info.touchpad) {
    out.push({ level: 'warn', code: 'touchpad-unknown', text: '没有这台眼镜的触控板档案：手势退回 input keyevent（扫描码为 0，双击、长按做不了）' });
  } else if (info.wear && info.wear.psensor === 0 && info.wear.lowPower === 1) {
    out.push({ level: 'warn', code: 'not-worn', text: '佩戴检测判定没戴：触控板处于低功耗，真手势不上报。戴好眼镜，或在眼镜设置里关掉佩戴检测；InkLab 回放的手势不受影响' });
  }
  for (const service of info.accessibility || []) {
    out.push({ level: 'warn', code: 'accessibility', text: `无障碍服务 ${service} 正在接管按键（比如 Quick Menu 会拦长按镜腿），真机上的按键结果可能被它改变` });
  }
  if (info.developerMode !== '1') out.push({ level: 'info', code: 'developer-mode', text: 'AIUI 开发者模式没开：推送、打开调试包时会临时打开，用完恢复原值' });
  return out;
}
