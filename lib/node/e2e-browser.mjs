// e2e-browser.mjs — e2e runner 的浏览器一侧：找 Chrome、起无头实例、最小 CDP 客户端，
// 以及两个页面级检查（等宿主就绪、核对 mock 隔离）。
//
// 零新依赖：CDP 用 Node ≥22 自带的全局 WebSocket；Chrome 用系统装好的（INKLAB_CHROME 可指定）。

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

/** 从 Chrome 的 stderr 里抠出 DevTools 的 ws 地址。 */
export function extractDevtoolsWsUrl(text) {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(text));
  return m ? m[1] : null;
}

// ── Chrome 与 CDP ───────────────────────────────────────────────────────

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
};

export async function findChrome(explicit, env = process.env) {
  const candidates = [explicit, env.INKLAB_CHROME, ...(CHROME_CANDIDATES[process.platform] || [])]
    .filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/')) {
      try { await stat(c); return c; } catch { continue; }
    }
    return c; // 裸命令名交给 PATH
  }
  throw new Error('找不到 Chrome。装一个，或用 --chrome / 环境变量 INKLAB_CHROME 指定二进制路径');
}

/** 起 Chrome，等它把 DevTools 的 ws 地址吐出来。 */
export async function launchChrome({ chromePath, profileDir, headed }) {
  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // 场景里有真实等待（激活冷却 1.3s 只能等），别让后台节流把它拉长；
    // 无头下 Chrome 可能把窗口判成被遮挡而停发 rAF——引擎 glue 的页面挂载续段就饿死在
    // rAF 队列里（实测症状：页面模块 eval 了但 onLoad 永远不来，语音导航随机丢）。
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
    // 钉死 DPR=2：截图是证据，不该随跑测机器的屏幕 DPR 漂（源码指纹里含 scaleFactor）
    '--force-device-scale-factor=2',
    '--hide-scrollbars', '--mute-audio',
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolveWs, rejectWs) => {
    let buf = '';
    const timer = setTimeout(() => rejectWs(new Error(`Chrome 起来了但 15s 内没吐 DevTools 地址：\n${buf.slice(-600)}`)), 15_000);
    const onData = (chunk) => {
      buf += String(chunk);
      const url = extractDevtoolsWsUrl(buf);
      if (url) { clearTimeout(timer); resolveWs(url); }
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); rejectWs(new Error(`Chrome 直接退出了（code ${code}）：\n${buf.slice(-600)}`)); });
    child.on('error', (err) => { clearTimeout(timer); rejectWs(err); });
  });
  return { child, wsUrl };
}

/** 最小 CDP 客户端：够 Target.createTarget / attachToTarget / Runtime.evaluate 用。 */
export function createCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const readyPromise = new Promise((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error(`连不上 DevTools：${wsUrl}`)), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`CDP ${msg.error.message}${msg.error.data ? `：${msg.error.data}` : ''}`));
      else res(msg.result);
    }
  });
  return {
    ready: () => readyPromise,
    send(method, params = {}, sessionId) {
      seq += 1;
      const id = seq;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { try { ws.close(); } catch { /* 已断就算了 */ } },
  };
}

/** 在页面里执行一个表达式（awaitPromise），异常翻译成人话抛回来。 */
export async function evalInPage(cdp, sessionId, expression, { timeoutMs = 30_000 } = {}) {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId),
    new Promise((_r, rej) => { setTimeout(() => rej(new Error(`页面执行超时（${timeoutMs}ms）：${expression.slice(0, 80)}…`)), timeoutMs); }),
  ]);
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'JS 异常';
    throw new Error(String(msg).split('\n')[0]);
  }
  return result.result ? result.result.value : undefined;
}

/**
 * 等宿主页面装载完（引擎 init + bundle）。`expectedDocumentToken` 非空时只认 URL 里带
 * 同一个 e2e-doc 的那份新 document，免得把导航前的旧页面当成「已就绪」。
 */
export async function waitForHostReady({ cdp, sessionId, timeoutMs, label = '宿主', expectedDocumentToken = null }) {
  // 等引擎 init + bundle 装载。整页导航期间 execution context 会短暂消失，继续轮询即可。
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let st = null;
    try {
      st = await evalInPage(cdp, sessionId,
        `(() => { const expected = ${JSON.stringify(expectedDocumentToken)};`
        + ' if (expected && new URLSearchParams(location.search).get("e2e-doc") !== expected) return null;'
        + ' const s = window.__inklab; return s ? { ready: s.ready === true, err: s.bootError || null } : null; })()',
        { timeoutMs: 5000 });
    } catch { /* 导航半途 context 不在，继续等 */ }
    if (st && st.err) {
      const tail = await evalInPage(cdp, sessionId,
        '(window.__inklab_engineLog || []).slice(-8).map(r => r.text).join("\\n")').catch(() => '');
      throw new Error(`${label}装载失败：${st.err}${tail ? `\n引擎日志尾巴：\n${tail}` : ''}`);
    }
    if (st && st.ready) return;
    if (Date.now() > deadline) throw new Error(`${label} ${timeoutMs}ms 内没装载完`);
    await new Promise((r) => { setTimeout(r, 300); });
  }
}

/** 核对 E2E 的相机 / 蓝牙隔离确实生效；每次整页导航后都要重验。 */
export async function assertE2eIsolation({ cdp, sessionId }) {
  // URL 层虽已强制 mock，仍核对宿主最终模式与实际对象；每次整页导航后都重验。
  const camera = await evalInPage(cdp, sessionId,
    '(() => { const s = window.__inklab; const st = s && s.stages && s.stages[0];'
    + ' return { mode: s && s.cameraMode, mediaIsMock: Boolean(st && st.hostCapabilities && st.caps'
    + ' && st.hostCapabilities.media && st.caps.capabilities.media'
    + ' && st.hostCapabilities.media.takePhoto === st.caps.capabilities.media.takePhoto) }; })()');
  if (camera.mode !== 'mock' || !camera.mediaIsMock) {
    throw new Error(`E2E 相机隔离失效：mode=${camera.mode} mediaIsMock=${camera.mediaIsMock}`);
  }

  // 蓝牙不走 hostCapabilities，必须核对 navigator 上的实际对象就是本页新建的模拟器。
  const bluetooth = await evalInPage(cdp, sessionId,
    '(() => { const s = window.__inklab; return {'
    + ' mode: s && s.bluetoothMode,'
    + ' mockInstalled: Boolean(s && s.bluetooth && navigator.bluetooth === s.bluetooth.bluetooth) }; })()');
  if (bluetooth.mode !== 'mock' || !bluetooth.mockInstalled) {
    throw new Error(`E2E 蓝牙隔离失效：mode=${bluetooth.mode} mockInstalled=${bluetooth.mockInstalled}`);
  }
}
