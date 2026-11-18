// device-logs.mjs — 把眼镜上和 AIUI 应用有关的日志实时接到工作台。
//
// 从 adb logcat 里只挑三类（RG1 / Ink 0.20 实测的标签与格式）：
//   app   应用自己打的日志：Ink 标签下的 ink_script::console（console.log / warn / error）；
//   ink   引擎日志：Ink / InkView 标签的其余模块（实例创建与关闭、解包、页面耗时、音频……）；
//   aiui  运行时事件：消息里带 [AIUI] 的 event=…（打开、全屏、退回卡片……），压成一行摘要。
// 只读：logcat -T 1 只看启动之后的新日志，不清缓冲区，不改日志级别。

import { spawn } from 'node:child_process';
import { RECORD_PREFIX } from '../imu-trace.mjs';

const LINE = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(\S+?)\s*:\s?(.*)$/;
const LEVELS = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'error' };

/** 一行 `logcat -v epoch` → 日志条目；和 AIUI 无关的返回 null（纯函数）。 */
export function parseLogLine(line) {
  const m = LINE.exec(String(line));
  if (!m) return null;
  const [, at, pid, , level, tag, message] = m;
  const base = { at: Math.round(Number(at) * 1000), pid: Number(pid), level: LEVELS[level] || 'info' };
  if (message.includes('[AIUI]')) {
    const field = (name) => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(message)?.[1];
    const event = field('event');
    if (!event) return null;
    const detail = [field('agent_id'), field('surface'), field('to_state'), field('outcome'), field('error_code') !== 'NONE' ? field('error_code') : null,
      field('return_reason'), field('reason')].filter(Boolean).join(' · ');
    return { ...base, source: 'aiui', text: detail ? `${event} · ${detail}` : event };
  }
  if (tag !== 'Ink' && tag !== 'InkView') return null;
  const script = /^ink_script::console:\s?(.*)$/.exec(message);
  // 模拟 IMU 调试包的录制行：单独走，不进日志面板（每秒好几行、每行几 KB）。
  if (script && script[1].startsWith(RECORD_PREFIX)) return { ...base, source: 'imu', text: script[1] };
  if (script) return { ...base, source: 'app', text: script[1] };
  return { ...base, source: 'ink', text: message.replace(/^([a-z_]+::)+[a-z_]+:\s/, (prefix) => `${prefix.split('::').pop().replace(/:\s$/, '')}: `) };
}

/**
 * 日志流：选中设备且有人在看（或推送、场景在跑）时开着 logcat，最近 1000 条留在内存里。
 * spawnProcess 可注入，便于测试。
 */
export function createDeviceLogs({ adb = process.env.ADB || 'adb', spawnProcess = spawn, limit = 1000 } = {}) {
  const entries = [];
  const subscribers = new Set();
  const imuListeners = new Set();
  let child = null;
  let serial = '';
  let partial = '';
  let seq = 0;

  function push(entry) {
    if (entry.source === 'imu') {
      for (const fn of imuListeners) { try { fn(entry); } catch { /* 监听方自己的错不影响日志流 */ } }
      return;
    }
    const item = { ...entry, seq: ++seq };
    entries.push(item);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    const data = `data: ${JSON.stringify(item)}\n\n`;
    for (const res of subscribers) { try { res.write(data); } catch { subscribers.delete(res); } }
  }
  function start(nextSerial) {
    if (child && serial === nextSerial) return;
    stop();
    serial = nextSerial;
    if (!serial) return;
    partial = '';
    child = spawnProcess(adb, ['-s', serial, 'logcat', '-v', 'epoch', '-T', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) { const entry = parseLogLine(line); if (entry) push(entry); }
    });
    const ended = child;
    child.on('close', () => { if (child === ended) child = null; });
    child.on('error', () => { if (child === ended) child = null; });
  }
  function stop() {
    if (child) { try { child.kill('SIGTERM'); } catch { /* 已经退出 */ } }
    child = null;
  }
  return {
    start, stop,
    running: () => Boolean(child),
    /** seq 之后的条目；用来给一次推送或场景截取它那段时间的日志。 */
    since: (afterSeq = 0) => entries.filter((entry) => entry.seq > afterSeq),
    mark: () => seq,
    recent: (n = 200) => entries.slice(-n),
    /** 模拟 IMU 录制行的监听（不进环形缓冲、不推给日志面板）。返回取消函数。 */
    onImu(fn) { imuListeners.add(fn); return () => imuListeners.delete(fn); },
    subscribe(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ running: Boolean(child), serial })}\n\n`);
      for (const entry of entries.slice(-200)) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      subscribers.add(res);
      res.on('close', () => subscribers.delete(res));
    },
    close() { stop(); for (const res of subscribers) { try { res.end(); } catch { /* 已断开 */ } } subscribers.clear(); },
  };
}

/** 不读日志的占位（测试、或调用方不需要日志时用）。 */
export function nullDeviceLogs() {
  return { start() {}, stop() {}, running: () => false, since: () => [], mark: () => 0, recent: () => [], onImu: () => () => {},
    subscribe(res) { res.writeHead(204); res.end(); }, close() {} };
}

/** 一段日志里值得放进报告的：应用日志全部、引擎与运行时的告警和错误（纯函数）。 */
export function notableLogs(list, max = 50) {
  return list.filter((entry) => entry.source === 'app' || entry.level === 'warn' || entry.level === 'error').slice(-max);
}
