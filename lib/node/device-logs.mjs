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

const EPOCH = /^\s*(\d+\.\d+)\s/;
/** adb 的网络连接（无线调试）：序列号是 host:port。 */
export const isNetworkSerial = (serial) => /^[\w.-]+:\d+$/.test(String(serial || ''));

/**
 * 日志流：选中设备且有人在看（或推送、场景在跑）时开着 logcat，最近 1000 条留在内存里。
 * spawnProcess 可注入，便于测试。
 *
 * logcat 意外退出（无线调试时 Wi-Fi 抖一下、拔插线）就每 retryMs 重连一次，从收到的最后一行的时刻
 * 续读（`-T <epoch>`），同一时刻已经收过的行跳过。眼镜的 main 日志缓冲区只有约 1 MiB，断得太久，
 * 中间的行会被覆盖：state() 里的 drops 记着每次断开多久。网络序列号重连前先 adb connect。
 */
export function createDeviceLogs({ adb = process.env.ADB || 'adb', spawnProcess = spawn, limit = 1000,
  retryMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const entries = [];
  const subscribers = new Set();
  const imuListeners = new Set();
  let child = null;
  let serial = '';
  let partial = '';
  let seq = 0;
  let retry = null;
  let lastAt = '';            // 收到的最后一行的 epoch 原文：重连从这里续
  let atLast = new Set();     // 和 lastAt 同一时刻的行：续读时去重
  let downSince = null;       // 这次断开的时刻（ms）
  const drops = [];           // [{ at, ms }] 每次断开到重新收到行

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
  function spawnLogcat(resume = null) {
    partial = '';
    const from = resume ? Number(resume.from) : null;
    const proc = spawnProcess(adb, ['-s', serial, 'logcat', '-v', 'epoch', '-T', resume ? resume.from : '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child = proc;
    proc.stdout.setEncoding?.('utf8');
    proc.stdout.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const at = EPOCH.exec(line)?.[1];
        if (at) {
          if (resume && (Number(at) < from || (Number(at) === from && resume.seen.has(line)))) continue;
          if (downSince !== null) { drops.push({ at: downSince, ms: now() - downSince }); downSince = null; }
          if (at !== lastAt) { lastAt = at; atLast = new Set(); }
          atLast.add(line);
        }
        const entry = parseLogLine(line);
        if (entry) push(entry);
      }
    });
    const ended = () => {
      if (child !== proc) return; // stop() 或换了设备：不是意外断开
      child = null;
      if (downSince === null) downSince = now();
      scheduleRetry();
    };
    proc.on('close', ended);
    proc.on('error', ended);
  }
  function scheduleRetry() {
    if (retry || !serial) return;
    const target = serial;
    retry = setTimer(async () => {
      retry = null;
      if (serial !== target || child) return;
      if (isNetworkSerial(target)) {
        await new Promise((done) => {
          try { spawnProcess(adb, ['connect', target], { stdio: 'ignore' }).on('close', done).on('error', done); } catch { done(); }
        });
        if (serial !== target || child) return;
      }
      spawnLogcat(lastAt ? { from: lastAt, seen: new Set(atLast) } : null);
    }, retryMs);
  }
  function start(nextSerial) {
    if ((child || retry) && serial === nextSerial) return;
    stop();
    serial = nextSerial;
    if (!serial) return;
    lastAt = ''; atLast = new Set(); downSince = null; drops.length = 0;
    spawnLogcat();
  }
  function stop() {
    if (retry) { clearTimer(retry); retry = null; }
    const proc = child;
    child = null;
    if (proc) { try { proc.kill('SIGTERM'); } catch { /* 已经退出 */ } }
  }
  return {
    start, stop,
    running: () => Boolean(child),
    /** 连接状态：down 是这次断开了多少毫秒（没断为 null），drops 是之前每次断开多久。 */
    state: () => ({ serial, running: Boolean(child), down: downSince === null ? null : now() - downSince, drops: drops.slice() }),
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
  return { start() {}, stop() {}, running: () => false, state: () => ({ serial: '', running: false, down: null, drops: [] }),
    since: () => [], mark: () => 0, recent: () => [], onImu: () => () => {},
    subscribe(res) { res.writeHead(204); res.end(); }, close() {} };
}

/** 一段日志里值得放进报告的：应用日志全部、引擎与运行时的告警和错误（纯函数）。 */
export function notableLogs(list, max = 50) {
  return list.filter((entry) => entry.source === 'app' || entry.level === 'warn' || entry.level === 'error').slice(-max);
}
