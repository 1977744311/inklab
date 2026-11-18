// device-wifi.mjs — 无线调试：眼镜连着线时切到 adb TCP 模式，再经 Wi-Fi 连上，之后可以拔线。
//
// RG1（Android 12 user 版，ro.adb.secure=1）实测：`adb tcpip 5555` 可用，电脑原来的调试授权直接有效，
// 眼镜上不用再点确认。TCP 模式不持久，眼镜重启后回到只走 USB，要插线再开一次。
// 不替你开 Wi-Fi、不替你连网络（要输密码）：眼镜没连上 Wi-Fi 就照实说。

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { adbShell } from './device-info.mjs';
import { isNetworkSerial } from './device-logs.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const WIFI_ADB_PORT = 5555;

// 上次连上的无线地址。adb 服务一重启（别的工具重启它、或它卡住后手动 kill-server）就会忘掉网络连接，
// 找不到设备时按这里记的地址自动重连一次。丢了无所谓，所以放缓存目录。
export const wifiMemoryFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'inklab', 'wifi-adb.json');

/** device 是这副眼镜的 USB 序列号（ro.serialno）：插着同一副眼镜时才去重连。 */
export async function rememberWifiTarget(serial, { file = wifiMemoryFile(), device = '' } = {}) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ serial, device, at: new Date().toISOString() })}\n`);
}
/** @returns {Promise<{ serial: string, device: string }|null>} */
export async function recallWifiTarget({ file = wifiMemoryFile() } = {}) {
  try {
    const { serial, device = '' } = JSON.parse(await readFile(file, 'utf8'));
    return isNetworkSerial(serial) ? { serial, device } : null;
  } catch { return null; }
}
export async function forgetWifiTarget({ file = wifiMemoryFile() } = {}) { await rm(file, { force: true }); }

/**
 * 按记下的地址 adb connect 一次。ready 是 adb devices 里已就绪的设备：记下的连接已经在里面就不动；
 * 插着别的设备也不动；只有一台都没有、或只插着同一副眼镜的 USB 时才连。
 * @returns {Promise<{ serial: string|null, target: string|null }>} 连上（或本来就在）时 serial 是网络序列号。
 */
export async function reconnectRemembered({ execute = exec, file = wifiMemoryFile(), ready = [] } = {}) {
  const memory = await recallWifiTarget({ file });
  if (!memory) return { serial: null, target: null };
  const target = memory.serial;
  if (ready.some((d) => d.serial === target)) return { serial: target, target };
  if (ready.length && !(memory.device && ready.every((d) => d.serial === memory.device))) return { serial: null, target };
  const reply = await adb(execute, ['connect', target], 8000).catch((err) => String(err.message));
  return { serial: /connected to/.test(reply) ? target : null, target };
}

const WIFI_SCRIPT = [
  // 「Wifi is connected to "…"」在 RG1 上是第 4 行（前面有 scanning 提示和 ClientModeManager 标题）。
  'cmd wifi status 2>/dev/null | grep -E "^Wifi is (enabled|disabled|connected|not connected)"',
  'echo "@ip=$(ip -4 addr show wlan0 2>/dev/null | grep -o \'inet [0-9.]*\' | head -1 | cut -d" " -f2)"',
  'echo "@port=$(getprop service.adb.tcp.port)"',
].join('; ');

/** `cmd wifi status` 等的输出 → { enabled, ssid, ip, port }（纯函数）。 */
export function parseWifiStatus(text) {
  const out = String(text);
  const ssid = /Wifi is connected to "(.*)"/.exec(out)?.[1] || null;
  const ip = /@ip=([0-9.]+)/.exec(out)?.[1] || null;
  const port = Number(/@port=(\d+)/.exec(out)?.[1]) || null;
  return { enabled: /Wifi is enabled/.test(out) || Boolean(ssid), ssid, ip, port };
}

export async function wifiStatus({ execute = exec, serial }) {
  return parseWifiStatus(await adbShell(execute, serial, WIFI_SCRIPT, { timeout: 10000 }));
}

function adb(execute, args, timeout = 15000) {
  return execute(process.env.ADB || 'adb', args, { timeout, maxBuffer: 1024 * 1024 })
    .then(({ stdout, stderr }) => `${stdout || ''}${stderr || ''}`);
}

/**
 * 打开无线调试并连上。serial 是 USB 序列号；已经是网络序列号就只核对一下。
 * @returns {Promise<{ serial: string, ssid: string|null, ip: string, already: boolean, note: string }>}
 */
export async function enableWifiAdb({ execute = exec, serial, port = WIFI_ADB_PORT, wait = sleep, memory = wifiMemoryFile() }) {
  if (isNetworkSerial(serial)) {
    const device = (await adbShell(execute, serial, 'getprop ro.serialno', { timeout: 8000 })).trim();
    await rememberWifiTarget(serial, { file: memory, device }).catch(() => {});
    return { serial, ssid: null, ip: serial.split(':')[0], already: true, note: '已经是无线连接' };
  }
  const wifi = await wifiStatus({ execute, serial });
  if (!wifi.ssid || !wifi.ip) {
    throw new Error(wifi.enabled
      ? '眼镜开着 Wi-Fi 但没连上网络：在眼镜或手机 App 里连上和这台电脑同一个 Wi-Fi，再试一次'
      : '眼镜的 Wi-Fi 关着：先打开并连上和这台电脑同一个 Wi-Fi，再试一次');
  }
  const target = `${wifi.ip}:${port}`;
  const already = wifi.port === port;
  if (!already) {
    // adbd 重启成 TCP 模式（同时仍走 USB），USB 连接会断一两秒。
    await adb(execute, ['-s', serial, 'tcpip', String(port)]);
    await wait(1500);
    await adb(execute, ['-s', serial, 'wait-for-device'], 20000).catch(() => {});
  }
  let reply = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    reply = await adb(execute, ['connect', target], 10000).catch((err) => String(err.message));
    if (/connected to/.test(reply)) break;
    await wait(1000);
  }
  if (!/connected to/.test(reply)) {
    throw new Error(`连不上 ${target}（${reply.trim() || '无输出'}）：电脑和眼镜要在同一个网络里，路由器不能隔离设备；`
      + '网络没问题还连不上，可能是电脑上的 adb 服务卡住了，运行 adb kill-server 后再试');
  }
  await adbShell(execute, target, 'echo ok', { timeout: 8000 });
  await rememberWifiTarget(target, { file: memory, device: serial }).catch(() => {});
  return { serial: target, ssid: wifi.ssid, ip: wifi.ip, already,
    note: `已经通过 Wi-Fi（${wifi.ssid}）连上 ${target}，可以拔线了；眼镜重启后要插线再开一次` };
}

/** 关掉无线调试：adbd 回到只走 USB，断开电脑这边的网络连接。 */
export async function disableWifiAdb({ execute = exec, serial, memory = wifiMemoryFile() }) {
  const status = await wifiStatus({ execute, serial }).catch(() => null);
  const target = isNetworkSerial(serial) ? serial : status?.ip && status?.port ? `${status.ip}:${status.port}` : '';
  if (status?.port) await adb(execute, ['-s', serial, 'usb']).catch(() => {});
  if (target) await adb(execute, ['disconnect', target]).catch(() => {});
  await forgetWifiTarget({ file: memory }).catch(() => {});
  return { off: true, disconnected: target || null, note: '眼镜回到只走 USB 调试' };
}
