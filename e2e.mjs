#!/usr/bin/env node
// e2e.mjs — AIUI 工程的端到端跑测：内嵌 InkLab 服务 + 无头 Chrome + CDP 驱动宿主页面。
//
//   npm run e2e -- fixtures/cap-probe-app                # 跑工程全部 e2e 场景
//   npm run e2e -- <app|package.aix> --scenario onboarding-goal  # 只跑指定场景（可多次给）
//   npm run e2e -- <app> --runtime studio-canary                 # 钉到一条命名运行时 lane
//   npm run e2e -- <app> --accept                                # 把本次截图收为基线
//   npm run e2e -- <app> --scenario x --llm record               # 录 LLM 录像（落回场景声明的那份）
//   npm run e2e -- <app> --llm replay --cassette e2e/cassettes/x.json
//   npm run e2e -- <app> --llm live                              # 真模型抽检（不进默认闸，内容不确定）
//   npm run e2e -- <app> --headed                                # 开窗跑（排障看画面）
//   npm run e2e -- <app> --no-video                              # 关掉逐场景舞台录屏（默认开，成片进 e2e/report/<id>/）
//   npm run e2e -- <app> --no-netguard                           # 放开外域出网（默认挡下，见 caps/net.mjs）
//
// 分工（和 Playwright 一个道理）：InkLab 是测试框架，仓库级复用；测试内容是工程资产——
//   <app>/e2e/scenarios/   场景脚本（宿主页面下拉框里的「工程场景」就是它们）
//   <app>/e2e/cassettes/   LLM 录像（replay 模式喂，确定性、不出网、不用密钥）
//   <app>/e2e/baselines/   截图基线（png + 同名 json 元数据：capturedAt / sourceStamp）
//   <app>/e2e/report/      本次跑测产物（不入库）
//
// ── 场景级 LLM 声明（「on 与 off 一条命令一起跑」）─────────────────────────
// LLM 模式**不是整轮一个**：场景可以自己声明要什么模式。runner 把配置写进页面 URL，
// 场景之间整页导航；这既重建能力层，也清掉 glue/wasm 跨 InkView 缓存的 Web Bluetooth wrapper。
//
//   export default { id:'llm-fc-intent',
//     llm: { mode:'replay', cassette:'e2e/cassettes/llm-fc-intent.json', model:'inklab-cassette' }, … };
//
// 不声明的场景吃整轮缺省（命令行 `--llm`；没给时有 `e2e/cassettes/default.json` 就 replay，否则 off）。
// **命令行显式给的 `--llm` 恒赢**——`--llm live` 一把切成真模型抽检、`--llm record` 一把重录，
// 都不必逐个场景改声明。详见 resolveScenarioLlm。
//
// 为什么走真浏览器而不是在 Node 里跑引擎：引擎 wasm 要 canvas/Skia 的宿主环境，Node 没有；
// 宿主页面的 __inklab 自动化入口当初就是按 CDP 设计的（README「自动化入口」一节），
// 且所有程序化输入都带手动 pump 帧——这正是无头/后台标签页里能跑通的原因（RUNTIME-NOTES《焦点与帧》）。
//
// 零新依赖：CDP 用 Node ≥22 自带的全局 WebSocket；Chrome 用系统装好的（INKLAB_CHROME 可指定）。
//
// 顶层只有定义，副作用都在 main() 里——__tests__ 只 import 纯逻辑。

import { realpathSync as cliRealpath } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInkLabServer } from './serve.mjs';
import { formatReport, summarize } from './lib/shots.mjs';
import { hash16, stableStringify } from './lib/caps/llm.mjs';

// ── 纯逻辑（可单测） ────────────────────────────────────────────────────

export function parseE2eArgs(argv) {
  const opts = {
    appDir: null, scenarios: [], llm: null, cassette: null,
    accept: false, headed: false, chrome: null, port: 0, netGuard: true,
    saveCassette: null, bootTimeoutMs: 60_000, scenarioTimeoutMs: 240_000,
    video: true, runtime: null, reportDir: null, preview: 'studio', lighting: 'absolute-dark',
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--scenario') opts.scenarios.push(...String(next()).split(',').filter(Boolean));
    else if (a === '--llm') opts.llm = next();
    else if (a === '--cassette') opts.cassette = next();
    else if (a === '--save-cassette') opts.saveCassette = next();
    else if (a === '--runtime') opts.runtime = next();
    else if (a === '--report-dir') opts.reportDir = next();
    else if (a === '--preview') opts.preview = next();
    else if (a === '--lighting') opts.lighting = next();
    else if (a === '--accept') opts.accept = true;
    // 外域出网默认挡下（caps/net.mjs guardExternal）。这个开关只用来 A/B「是不是那道闸的锅」，
    // 常规跑测别开——开了应用里硬编码的线上域名会真的打到别人的生产后端。
    else if (a === '--no-netguard') opts.netGuard = false;
    // 每个场景的主舞台录屏默认开着（成片进 e2e/report/<id>/，随报告一起可再生、不入库）。
    else if (a === '--no-video') opts.video = false;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '--port') opts.port = Number(next()) || 0;
    else if (a === '--boot-timeout') opts.bootTimeoutMs = Number(next()) || opts.bootTimeoutMs;
    else if (a === '--scenario-timeout') opts.scenarioTimeoutMs = Number(next()) || opts.scenarioTimeoutMs;
    else if (a.startsWith('--')) throw new Error(`不认识的参数 ${a}`);
    else rest.push(a);
  }
  opts.appDir = rest[0] || null;
  if (opts.llm && !['off', 'live', 'record', 'replay'].includes(opts.llm)) {
    throw new Error(`--llm 只能是 off/live/record/replay，收到 ${opts.llm}`);
  }
  if (!['absolute-dark', 'indoor-bright', 'night-low-light'].includes(opts.lighting)) {
    throw new Error(`--lighting 只能是 absolute-dark/indoor-bright/night-low-light，收到 ${opts.lighting}`);
  }
  if (!['studio', 'optical'].includes(opts.preview)) {
    throw new Error(`--preview 只能是 studio/optical，收到 ${opts.preview}`);
  }
  return opts;
}

/**
 * **场景级 LLM 声明**（V3：把「在线路径」变成默认闸的一等公民）。
 *
 * 病灶：LLM 模式此前是**整轮一个**（命令行 `--llm` 或 URL 参数），于是默认全量跑只能二选一——
 * 要么全 off（跑到的几乎全是降级路径，在线那一半零覆盖），要么全 replay（离线降级场景反而测不了）。
 * 「off 只是一个 case」这条裁决要求同一条命令里两边都跑到。
 *
 * 做法：场景模块可以自己声明要什么模式：
 *
 *   export default {
 *     id: 'llm-fc-intent',
 *     llm: { mode:'replay', cassette:'e2e/cassettes/llm-fc-intent.json', model:'inklab-cassette' },
 *     build(ctx) { … },
 *   };
 *
 * runner 把声明编码进宿主 URL，并在场景之间整页导航。只重建 InkView 不足以清掉
 * glue/wasm 跨实例缓存的 Web Bluetooth wrapper，因此场景隔离必须是新 document。
 *
 * 优先级（**命令行显式给的 `--llm` 恒赢**）：这样 `--llm live` 才能一把把全轮切成真模型抽检、
 * `--llm record` 才能重录，而不必逐个场景改声明。
 *
 * @param {{id?:string, llm?:{mode?:string, cassette?:string, model?:string}}} scenario 场景元数据
 * @param {{llm?:string|null, cassette?:string|null}} opts 命令行参数
 * @param {string} fallbackMode 既没声明也没显式给时的兜底（main 里算好的整轮缺省模式）
 * @returns {{mode:string, cassette:(string|null), model:(string|null)}}
 */
export function resolveScenarioLlm(scenario, opts = {}, fallbackMode = 'off') {
  const decl = scenario && scenario.llm && typeof scenario.llm === 'object' ? scenario.llm : null;
  const forced = opts.llm ? String(opts.llm) : null;
  const mode = forced || (decl && decl.mode ? String(decl.mode) : '') || String(fallbackMode || 'off');
  if (mode === 'off') return { mode: 'off', cassette: null, model: null };
  const tape = (opts.cassette ? String(opts.cassette) : '')
    || (decl && decl.cassette ? String(decl.cassette) : '');
  return {
    mode,
    cassette: mode === 'replay' ? (tape || null) : null,
    // model 只在**回放**时钉：录像键含 model 字段，录像在哪个名下录的、回放就得钉回哪个
    // （见 llm.mjs normalizeRequestBody）。录制时要打给真上游，钉个假名字只会换回 400。
    model: mode === 'replay' && decl && decl.model ? String(decl.model) : null,
    // 设计内的非命中声明（只在 replay 有意义）：场景明说自己**预期**哪些非 hit 结果
    // （如 fault 演练、故意的 classify miss）。结论闸按精确多重集对账，声明不符照样红。
    expectOutcomes: mode === 'replay' && decl && Array.isArray(decl.expectOutcomes)
      ? decl.expectOutcomes.map((x) => String(x))
      : null,
  };
}

/** 两份 LLM 配置是不是同一个（相同就不必为了切模式白重载一次）。 */
export function sameLlmConfig(a, b) {
  const norm = (x) => ({
    mode: (x && x.mode) || 'off',
    cassette: (x && x.cassette) || null,
    model: (x && x.model) || null,
  });
  const x = norm(a);
  const y = norm(b);
  return x.mode === y.mode && x.cassette === y.cassette && x.model === y.model;
}

/** 首场配置相同可复用刚打开的新页面；从第二场起即使配置相同也必须换 document。 */
export function shouldNavigateForScenario(index, desired, current) {
  return Number(index) > 0 || !sameLlmConfig(desired, current);
}

/** 人话化一份 LLM 配置（日志/报告用）。 */
export function describeLlm(cfg) {
  const mode = (cfg && cfg.mode) || 'off';
  if (mode === 'off') return 'off';
  const bits = [mode];
  if (cfg && cfg.cassette) bits.push(cfg.cassette.replace(/^e2e\/cassettes\//, ''));
  if (cfg && cfg.model) bits.push(`model=${cfg.model}`);
  return bits.join(' · ');
}

/**
 * record 模式下这个场景录到的东西该落到哪个文件。
 * 场景自带声明时就落回它自己的录像带——「录一遍 → 提交 → 以后 replay」这条路才闭得上环。
 */
export function cassetteTargetFor(scenario, opts = {}) {
  const decl = scenario && scenario.llm && typeof scenario.llm === 'object' ? scenario.llm : null;
  return (opts.saveCassette ? String(opts.saveCassette) : '')
    || (decl && decl.cassette ? String(decl.cassette) : '')
    || 'e2e/cassettes/default.json';
}

/**
 * 把录像带的键**钉到一个固定的模型名上**（录完即清洗，`--llm record` 落盘前自动跑）。
 *
 * 修的是什么：录像键含 `model` 字段（llm.mjs `normalizeRequestBody` 保留它，因为换个模型
 * 换的是整个应答）。而录制时用的是本机 `llm.local.json` / `INKLAB_LLM_*` 里的**真模型名**——
 * 于是原样提交的录像带只在录它那台机器上命中，换台机器（或本机换了模型）全线 `replay-miss`。
 * 这个坑第一次出现在 `photo-hit.json`，当时的办法是跑测命令前面挂一句
 * `INKLAB_LLM_MODEL=inklab-cassette`——能用，但每条跑测命令都得记得带上它，忘了就是一片未命中。
 *
 * 现在的办法：场景在 `llm.model` 里声明要钉哪个名字，录制落盘前就地把 `request.model` 换成它
 * 并**重算键**（键 = `hash16(stableStringify(归一化请求))`，重算等价于「用那个模型名录的」）。
 * 回放时宿主按同一个声明把 model 钉回去，键自然对上。钉一个**不存在的**假模型名是刻意的：
 * replay 一个字节都不出网，model 只进哈希、不进任何真实请求。
 *
 * @param {{version?:number, apiStyle?:string, entries?:Array}} cassette exportCassette() 的产物
 * @param {string|null} model 要钉的模型名；空 → 原样返回（没声明就别乱改）
 */
export function pinCassetteModel(cassette, model) {
  const entries = cassette && Array.isArray(cassette.entries) ? cassette.entries : [];
  const name = String(model || '').trim();
  if (!name) return { ...cassette, entries };
  return {
    ...cassette,
    entries: entries.map((e) => {
      // 没有归一化请求（手写录像带可以省掉 request）就重算不了键——原样留着，别悄悄写坏。
      if (!e || !e.request || typeof e.request !== 'object') return e;
      const request = { ...e.request, model: name };
      return { ...e, key: hash16(stableStringify(request)), request };
    }),
  };
}

/** 从 Chrome 的 stderr 里抠出 DevTools 的 ws 地址。 */
export function extractDevtoolsWsUrl(text) {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(text));
  return m ? m[1] : null;
}

/** 宿主页面地址：E2E 永远钉死 mock 相机与蓝牙，避免无头/CI 触碰真实硬件权限。 */
export function buildPageUrl(base, {
  llmMode, cassette, model, netGuard, documentToken, runtime, preview, lighting,
} = {}) {
  const u = new URL(base);
  u.searchParams.set('camera', 'mock');
  u.searchParams.set('bluetooth', 'mock');
  if (llmMode) u.searchParams.set('llm', llmMode);
  if (cassette) u.searchParams.set('cassette', cassette);
  if (model) u.searchParams.set('llm-model', model);
  if (documentToken) u.searchParams.set('e2e-doc', documentToken);
  if (runtime) u.searchParams.set('runtimes', runtime);
  if (preview) u.searchParams.set('preview', preview);
  if (lighting) u.searchParams.set('lighting', lighting);
  // 只在**显式关掉**时才写参数：默认挡下由宿主自己决定，URL 里不留噪声。
  if (netGuard === false) u.searchParams.set('netguard', '0');
  return u.toString();
}

/**
 * 本轮的**网络账面摘要**（V3 P1-F L5）。
 *
 * 为什么进报告：「全程零真实外呼」是隐私与稳定性的核心结论，但它此前只活在场景内的一条断言里
 * ——跑完就没了，事后翻 last-run.json 看不出「这一轮到底有没有东西打出去、被挡下的是谁」。
 * 这里把 fetch 层的账按域名收敛成两张名单存进报告：`externalStubs` 是被外域闸挡下的（好事，
 * 但要看得见挡的是谁），`passed` 是真的放行出去的（**非本机域名出现在这里就是要查的事**）。
 *
 * 一处要一起读的口径：`passed` 记的是**外域闸**放行了什么，闸内侧还有一层 LLM 拦截。
 * 所以 `--llm replay` 时 LLM 端点（缺省是 `replay.inklab.invalid`，RFC 2606 永不解析）会出现在
 * `passed` 里——那次「放行」只是穿过闸，随后由录像层就地作答，并没有出网。判「有没有真出去」时
 * 请连同同一份报告里的 `llm.mode` 与 `llm.exchanges`（replay-hit / replay-miss）一起看。
 *
 * @param {Array<object>} requests `caps.net.requests` 的快照
 * @param {{truncatedLog?:boolean}} [stats] `caps.net.logStats()`；账被丢过就必须标出来，
 *   否则「passed 是空的」可能只是因为记录被体积闸丢了（假阴性）。
 */
export function summarizeNetLog(requests, stats = {}) {
  const rows = Array.isArray(requests) ? requests.filter((r) => r && r.layer === 'fetch') : [];
  const originOf = (url) => {
    try { return new URL(String(url)).origin; } catch { return String(url || '').slice(0, 80) || '(空)'; }
  };
  const tally = (pred) => {
    const counts = new Map();
    for (const r of rows) {
      if (!pred(r)) continue;
      const key = originOf(r.url);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
      .map(([origin, count]) => ({ origin, count }));
  };
  const externalStubs = tally((r) => r.decision === 'external-stub');
  const passed = tally((r) => r.decision === 'pass');
  return {
    fetchCalls: rows.length,
    externalStubs,
    passed,
    blocked: rows.filter((r) => r.decision === 'block').length,
    stubbed: rows.filter((r) => r.decision === 'status').length,
    truncatedLog: Boolean(stats && stats.truncatedLog),
  };
}

/**
 * 单个场景的结论。步骤失败恒 fail；截图基线只在「工程已有基线」时强制
 * （逼没建过基线的工程先 --accept 一次不合理），--accept 本轮只收图不判图。
 */
export function judgeScenario({ report, shotReport, accepted, llmMode = 'off', llmExchanges = [], llmExpect = null }) {
  const problems = [];
  if (!report.ok) problems.push(`步骤失败：${report.summary}`);
  if (llmMode === 'replay') {
    const misses = (Array.isArray(llmExchanges) ? llmExchanges : [])
      .filter((entry) => entry && entry.outcome !== 'replay-hit')
      .map((entry) => entry.outcome || '未知结果');
    if (Array.isArray(llmExpect)) {
      // 场景声明了设计内非命中：按精确多重集对账。多了、少了、种类不对都红——
      // 这比「有 miss 就红」更严：预期的 fault 没发生同样是回归。
      const actual = [...misses].sort();
      const expected = [...llmExpect].sort();
      const same = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
      if (!same) {
        problems.push(`LLM 回放结果与场景声明不符（声明 [${expected.join('、') || '无'}]，实际 [${actual.join('、') || '无'}]）`);
      }
    } else if (misses.length) {
      problems.push(`LLM 回放未命中 ${misses.length} 次（${misses.join('、')}）`);
    }
  }
  if (!accepted && shotReport && shotReport.hasBaselines) {
    const s = summarize(shotReport.baseline);
    if (!s.ok) {
      const why = [];
      if (s.changed) why.push(`变了 ${s.changed}`);
      if (s.new) why.push(`新增 ${s.new}（有基线的工程冒出没基线的屏，先 --accept 收编）`);
      if (s.missing) why.push(`未采 ${s.missing}`);
      if (s.stale) why.push(`陈旧 ${s.stale}`);
      problems.push(`截图基线不通过：${why.join(' · ')}`);
    }
  }
  return { ok: problems.length === 0, problems };
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

async function findChrome(explicit, env = process.env) {
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
async function launchChrome({ chromePath, profileDir, headed }) {
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
function createCdp(wsUrl) {
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
async function evalInPage(cdp, sessionId, expression, { timeoutMs = 30_000 } = {}) {
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

// ── 主流程 ──────────────────────────────────────────────────────────────

async function main(argv) {
  let opts;
  try { opts = parseE2eArgs(argv); } catch (err) { console.error(`[e2e] ${err.message}`); process.exit(2); }
  if (!opts.appDir) {
    console.error('用法: node e2e.mjs <app-dir|package.aix> [--scenario id] [--runtime id] [--preview studio|optical] [--lighting id] [--report-dir path] [--accept] [--llm off|live|record|replay] [--headed] [--no-video]');
    process.exit(2);
  }
  if (typeof WebSocket === 'undefined') {
    console.error('[e2e] 需要 Node ≥ 22（要用自带的全局 WebSocket 连 CDP）');
    process.exit(2);
  }

  const APP_INPUT = resolve(process.cwd(), opts.appDir);
  const inputInfo = await stat(APP_INPUT).catch(() => null);
  const isAix = Boolean(inputInfo?.isFile() && extname(APP_INPUT).toLowerCase() === '.aix');
  const APP_DIR = inputInfo?.isDirectory() ? APP_INPUT : null;
  if (!APP_DIR && !isAix) throw new Error(`输入必须是 AIUI 工程目录或 .aix：${APP_INPUT}`);
  if (isAix && opts.accept) throw new Error('.aix 是只读发布真相，不能把基线写回包内；请对源码目录使用 --accept');
  if (isAix && opts.llm === 'record') throw new Error('.aix 是只读发布真相，LLM record 请在源码目录执行');
  // LLM 模式：显式给了听显式的；没给时有 default 录像就 replay（确定性优先），否则 off。
  let llmMode = opts.llm;
  if (!llmMode) {
    if (opts.cassette) llmMode = 'replay';
    else {
      try {
        if (!APP_DIR) throw new Error('package has no writable e2e root');
        await stat(join(APP_DIR, 'e2e/cassettes/default.json'));
        llmMode = 'replay';
      } catch { llmMode = 'off'; }
    }
  }

  const startedAt = new Date().toISOString();
  const reportDir = opts.reportDir
    ? resolve(process.cwd(), opts.reportDir)
    : (APP_DIR
      ? join(APP_DIR, 'e2e', 'report')
      : join(dirname(APP_INPUT), 'inklab-report', basename(APP_INPUT, extname(APP_INPUT))));
  const reportRel = APP_DIR && !opts.reportDir ? 'e2e/report' : '.';
  await mkdir(reportDir, { recursive: true });

  let lab = null;
  let chrome = null;
  let cdp = null;
  let profileDir = null;
  let manifestInfo = null;
  const cleanup = async () => {
    try { cdp?.close(); } catch { /* 收尾尽力 */ }
    if (chrome) {
      chrome.kill('SIGTERM');
      await new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); });
    }
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (lab) await lab.close().catch(() => {});
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

  try {
    lab = await createInkLabServer({ input: APP_INPUT, port: opts.port, log: () => {} });
    manifestInfo = await (await fetch(`${lab.url}api/manifest`)).json();
    if (opts.runtime) {
      const requested = String(opts.runtime).split(',').filter(Boolean);
      const available = new Set((manifestInfo.runtimes || []).filter((r) => r.available).map((r) => r.id));
      const missing = requested.filter((id) => !available.has(id));
      if (missing.length) throw new Error(`运行时不可用：${missing.join('、')}（可用：${[...available].join('、')}）`);
    }
    console.log(`[e2e] 服务 ${lab.url}（${isAix ? 'AIX 发布包' : '源码目录'} · llm=${llmMode}`
      + ` camera=mock bluetooth=mock preview=${opts.preview}`
      + `${opts.preview === 'optical' ? ` lighting=${opts.lighting}` : ''}`
      + `${opts.runtime ? ` runtime=${opts.runtime}` : ''}${opts.cassette ? ` cassette=${opts.cassette}` : ''}）`);

    profileDir = await mkdtemp(join(tmpdir(), 'inklab-e2e-'));
    const chromePath = await findChrome(opts.chrome);
    const launched = await launchChrome({ chromePath, profileDir, headed: opts.headed });
    chrome = launched.child;
    cdp = createCdp(launched.wsUrl);
    await cdp.ready();

    const pageUrl = buildPageUrl(lab.url, {
      llmMode, cassette: opts.cassette, netGuard: opts.netGuard, runtime: opts.runtime,
      preview: opts.preview, lighting: opts.lighting,
    });
    const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const waitForHostReady = async (label = '宿主', expectedDocumentToken = null) => {
      // 等引擎 init + bundle 装载。整页导航期间 execution context 会短暂消失，继续轮询即可。
      const deadline = Date.now() + opts.bootTimeoutMs;
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
        if (Date.now() > deadline) throw new Error(`${label} ${opts.bootTimeoutMs}ms 内没装载完`);
        await new Promise((r) => { setTimeout(r, 300); });
      }
    };

    const assertE2eIsolation = async () => {
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
    };

    await waitForHostReady('宿主首次');
    await assertE2eIsolation();

    // 舞台录屏能力探测：headless=new 的完整 Chrome 一般都有 MediaRecorder + captureStream。
    // 真缺能力就整轮明确跳过录屏，而不是把 runScenario 交给一个必抛的 start。
    let canRecordVideo = false;
    if (opts.video) {
      canRecordVideo = Boolean(await evalInPage(cdp, sessionId,
        "typeof MediaRecorder === 'function' && typeof HTMLCanvasElement === 'function'"
        + " && typeof HTMLCanvasElement.prototype.captureStream === 'function'").catch(() => false));
      if (!canRecordVideo) {
        console.log('[e2e] 本浏览器缺 MediaRecorder/captureStream，本轮跳过舞台录屏');
      }
    }

    // 要跑哪些场景：默认 = 工程自带的全部；--scenario 点名的话内置的也能跑。
    const available = await evalInPage(cdp, sessionId,
      '__inklab.scenarios.map(s => ({ id: s.id, source: s.source, llm: s.llm || null }))');
    let ids = opts.scenarios;
    if (!ids.length) {
      ids = available.filter((s) => s.source === 'project').map((s) => s.id);
      if (!ids.length) {
        throw new Error(`${APP_INPUT} 没有 e2e 场景（e2e/scenarios/*.mjs）。`
          + `可用的内置场景：${available.map((s) => s.id).join('、') || '无'}（用 --scenario 点名跑）`);
      }
    }
    for (const id of ids) {
      if (!available.some((s) => s.id === id)) {
        throw new Error(`没有场景 ${id}。可用：${available.map((s) => s.id).join('、')}`);
      }
    }
    // 每个场景要什么 LLM 模式（命令行显式 > 场景声明 > 整轮缺省，见 resolveScenarioLlm）。
    const metaOf = (id) => available.find((s) => s.id === id) || { id };
    const llmPlan = new Map(ids.map((id) => [id, resolveScenarioLlm(metaOf(id), opts, llmMode)]));
    for (const [id, cfg] of llmPlan) {
      if (cfg.mode === 'replay' && !cfg.cassette) {
        throw new Error(`场景 ${id} 要 llm=replay 但没有录像：在场景里声明 llm.cassette，或用 --cassette 指一份。`);
      }
    }
    const onIds = ids.filter((id) => llmPlan.get(id).mode !== 'off');
    console.log(`[e2e] 场景 ${ids.length} 个：${ids.map((id) => {
      const cfg = llmPlan.get(id);
      return cfg.mode === 'off' ? id : `${id}[${cfg.mode}]`;
    }).join('、')}`);
    console.log(`[e2e] LLM 覆盖：在线 ${onIds.length} 个 · 离线 ${ids.length - onIds.length} 个`);

    // ── 逐场景跑。场景之间必须整页导航：只重建 InkView 时，ink_web/glue 会跨实例复用
    //    Web Bluetooth device/service/characteristic wrapper，旧实例的懒 teardown 可污染新场景。
    //    新 document 同时重建 glue、能力层和模拟器；LLM 配置随 URL 恢复。
    const scenarioResults = [];
    // record 模式下每个场景录到的条目按**目标录像带**归堆（能力层随重载重建，跑完再导只剩最后一场）。
    const cassetteBuckets = new Map();
    // 网络账面（L5）逐场景收：`reload()` 会重建能力层，`__inklab.caps.net` 只留最后一轮的账，
    // 跑完再取等于把前几场的记录扔了。只取 fetch 层的 url/method/decision——整条 body **不进报告**
    // （那是用户数据，报告要贴进 issue），域名与判定足够回答「有没有东西真打出去」。
    const NET_LEDGER_EXPR = '(__inklab.caps && __inklab.caps.net) ? { rows: __inklab.caps.net.requests'
      + '.filter(r => r.layer === "fetch").map(r => ({ layer: r.layer, url: r.url, method: r.method, decision: r.decision })),'
      + ' stats: (__inklab.caps.net.logStats ? __inklab.caps.net.logStats() : {}) } : { rows: [], stats: {} }';
    const netRows = [];
    const netStats = { truncatedLog: false };
    // 首次装载用的是 buildPageUrl 里的整轮缺省；第一个场景若配置不同也要换到对应 URL。
    let currentLlm = { mode: llmMode, cassette: llmMode === 'replay' ? (opts.cassette || null) : null, model: null };
    for (const [i, id] of ids.entries()) {
      const wantLlm = llmPlan.get(id);
      if (shouldNavigateForScenario(i, wantLlm, currentLlm)) {
        const documentToken = `${i + 1}-${id}`;
        const nextUrl = buildPageUrl(lab.url, {
          llmMode: wantLlm.mode,
          cassette: wantLlm.cassette,
          model: wantLlm.model,
          netGuard: opts.netGuard,
          documentToken,
          runtime: opts.runtime,
          preview: opts.preview, lighting: opts.lighting,
        });
        await cdp.send('Page.navigate', { url: nextUrl }, sessionId);
        await waitForHostReady(
          `场景 ${id}（第 ${i + 1} 个，llm=${describeLlm(wantLlm)}）前`,
          documentToken,
        );
        await assertE2eIsolation();
        currentLlm = wantLlm;
      }
      process.stdout.write(`[e2e] ▶ ${id}${wantLlm.mode === 'off' ? '' : `（llm ${describeLlm(wantLlm)}）`} … `);
      const report = await evalInPage(cdp, sessionId,
        `__inklab.runScenario(${JSON.stringify(id)}, { record: ${canRecordVideo}, download: false })`
        + '.then(r => ({ ok: r.ok, summary: r.summary, steps: r.steps, skipped: r.skipped,'
        + ' failure: r.failure || null, recording: r.recording || null, recordingError: r.recordingError || null }))',
        { timeoutMs: opts.scenarioTimeoutMs });
      const shotReport = await evalInPage(cdp, sessionId,
        `__inklab.e2eShotReport(${JSON.stringify(id)})`, { timeoutMs: 60_000 });

      // 截图落盘：报告目录恒写（排障要看图）；--accept 时另写基线 + 元数据。
      const shotFiles = [];
      for (const s of shotReport.shots) {
        const png = Buffer.from(s.dataUrl.split(',')[1], 'base64');
        const outDir = join(reportDir, id);
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, `${s.name}.png`), png);
        shotFiles.push(`${reportRel === '.' ? '' : `${reportRel}/`}${id}/${s.name}.png`);
        if (opts.accept) {
          const baseDir = join(APP_DIR, 'e2e', 'baselines', id);
          await mkdir(baseDir, { recursive: true });
          await writeFile(join(baseDir, `${s.name}.png`), png);
          await writeFile(join(baseDir, `${s.name}.json`), JSON.stringify({
            name: s.name, scenario: id, capturedAt: new Date().toISOString(),
            sourceStamp: shotReport.stamp, width: s.width, height: s.height,
          }, null, 2));
        }
      }

      // 舞台录屏落盘：宿主在 runScenario 里已封口（download:false），这里把 Blob 按 4MB
      // 分片经 CDP 拉回来写进报告目录（与截图同目录、随报告可再生、不入库），
      // 再把页面里的成片对象弹掉，免得长整轮把几百 MB 的 Blob 都攒在内存里。
      let videoFile = null;
      if (canRecordVideo && report.recording) {
        try {
          const info = await evalInPage(cdp, sessionId,
            '(() => { const r = (__inklab.recordings || []).at(-1);'
            + ' return r && r.blob ? { size: r.blob.size, extension: r.extension, pptReady: r.pptReady,'
            + ' durationMs: r.durationMs } : null; })()');
          if (info && info.size > 0) {
            const CHUNK = 4 * 1024 * 1024;
            const parts = [];
            for (let offset = 0; offset < info.size; offset += CHUNK) {
              const end = Math.min(offset + CHUNK, info.size);
              const b64 = await evalInPage(cdp, sessionId,
                `__inklab.recordings.at(-1).blob.slice(${offset}, ${end}).arrayBuffer()`
                + '.then((buf) => { const u = new Uint8Array(buf); let s = "";'
                + ' for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));'
                + ' return btoa(s); })', { timeoutMs: 60_000 });
              parts.push(Buffer.from(b64, 'base64'));
            }
            const outDir = join(reportDir, id);
            await mkdir(outDir, { recursive: true });
            await writeFile(join(outDir, `${id}.${info.extension}`), Buffer.concat(parts));
            videoFile = `${reportRel === '.' ? '' : `${reportRel}/`}${id}/${id}.${info.extension}`;
            console.log(`[e2e]   录屏 → ${videoFile}`
              + `（${Math.ceil(info.durationMs / 1000)}s · ${String(info.extension).toUpperCase()}`
              + `${info.pptReady ? ' · 可直接插 PPT' : ' · 插 PPT 前需转 MP4'}）`);
          }
        } catch (err) {
          console.log(`[e2e]   ⚠ 录屏导出失败：${err && err.message}`);
        }
        await evalInPage(cdp, sessionId,
          '(() => { const r = (__inklab.recordings || []).pop();'
          + ' if (r && r.objectUrl) { try { URL.revokeObjectURL(r.objectUrl); } catch {} } return true; })()')
          .catch(() => {});
      }
      if (report.recordingError) console.log(`[e2e]   ⚠ 场景录屏失败：${report.recordingError}`);

      // replay 未命中不能被应用本地兜底掩盖：先取模型账，再给本场下结论。
      const scenarioExchanges = await evalInPage(cdp, sessionId,
        '(__inklab.caps && __inklab.caps.llm) ? __inklab.caps.llm.exchanges : []').catch(() => []);
      const conformance = await evalInPage(cdp, sessionId,
        'typeof __inklab.conformanceReport === "function" ? __inklab.conformanceReport() : { results: [], samples: 0 }')
        .catch(() => ({ results: [], samples: 0 }));
      const verdict = judgeScenario({
        report,
        shotReport,
        accepted: opts.accept,
        llmMode: wantLlm.mode,
        llmExchanges: scenarioExchanges,
        llmExpect: wantLlm.expectOutcomes || null,
      });
      console.log(verdict.ok ? '✓' : '✗', report.summary);
      if (!verdict.ok) for (const p of verdict.problems) console.log(`[e2e]   ${p}`);
      if (opts.accept && shotReport.shots.length) {
        console.log(`[e2e]   基线已收编 ${shotReport.shots.length} 张（stamp ${shotReport.stamp}）`);
      } else if (shotReport.hasBaselines) {
        console.log(formatReport(shotReport.baseline).split('\n').map((l) => `[e2e]   ${l}`).join('\n'));
      } else if (shotReport.shots.length) {
        console.log(`[e2e]   无截图基线（跑一次 --accept 把 ${shotReport.shots.map((s) => s.name).join('、')} 收为基线）`);
      }

      // 本场的网络账与 LLM 往返账（下一场重载前取，否则记录随能力层一起被丢）。
      const ledger = await evalInPage(cdp, sessionId, NET_LEDGER_EXPR).catch(() => ({ rows: [], stats: {} }));
      const scenarioNet = summarizeNetLog(ledger.rows, ledger.stats);
      netRows.push(...(Array.isArray(ledger.rows) ? ledger.rows : []));
      if (scenarioNet.truncatedLog) netStats.truncatedLog = true;
      if (wantLlm.mode === 'record') {
        // 录像同样要在重载前导出：能力层一重建，这一场录到的条目就没了。
        const cassette = await evalInPage(cdp, sessionId, '__inklab.caps.llm.exportCassette()')
          .catch(() => ({ entries: [] }));
        const meta = metaOf(id);
        const target = cassetteTargetFor(meta, opts);
        const bucket = cassetteBuckets.get(target)
          || { apiStyle: cassette.apiStyle, entries: new Map(), pin: null, from: [] };
        // 录完即清洗：把键钉到场景声明的假模型名上（否则录像带只在录它那台机器上命中）。
        const pin = (meta.llm && meta.llm.model) || null;
        const cleaned = pinCassetteModel(cassette, pin);
        for (const entry of cleaned.entries || []) {
          if (entry && typeof entry.key === 'string') bucket.entries.set(entry.key, entry);
        }
        if (pin) bucket.pin = pin;
        bucket.from.push(id);
        cassetteBuckets.set(target, bucket);
      }

      scenarioResults.push({
        id, ok: verdict.ok, problems: verdict.problems,
        steps: report.steps, skipped: report.skipped, failure: report.failure,
        summary: report.summary, stamp: shotReport.stamp,
        baseline: shotReport.hasBaselines || opts.accept ? shotReport.baseline : null,
        shots: shotFiles,
        video: videoFile,
        net: scenarioNet,
        conformance,
        // 本场跑在哪个 LLM 模式下、发生了哪些往返。判「在线路径到底测没测到」就看这两项。
        llm: { ...wantLlm, exchanges: Array.isArray(scenarioExchanges) ? scenarioExchanges : [] },
      });
    }

    // record 模式：把录到的 LLM 录像落盘（录像不含请求头，密钥不会跟着走——llm.mjs 保证）。
    const cassettesSaved = [];
    for (const [rel, bucket] of cassetteBuckets) {
      const entries = [...bucket.entries.values()];
      if (!entries.length) continue;
      if (!APP_DIR) throw new Error(`发布包跑测不能写 LLM 录像：${rel}`);
      const abs = join(APP_DIR, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, JSON.stringify({
        version: 1,
        apiStyle: bucket.apiStyle || 'openai-chat-completions',
        _读我: `InkLab \`--llm record\` 录于 ${new Date().toISOString().slice(0, 10)}，来源场景：${bucket.from.join('、')}。`
          + (bucket.pin
            ? `键已钉到假模型名 \`${bucket.pin}\`（场景 llm.model 声明的值）——录像键含 model 字段，`
              + '不钉就只在录它那台机器上命中。回放时宿主按同一条声明把 model 钉回去。'
            : '⚠ 场景没声明 llm.model，键里带的是本机真模型名，换台机器会全线 replay-miss。')
          + '录像里不含任何请求头，因此不含密钥（llm.mjs exportCassette 保证）。',
        entries,
      }, null, 2));
      cassettesSaved.push(rel);
      console.log(`[e2e] LLM 录像 ${entries.length} 条 → ${rel}`
        + `${bucket.pin ? `（键已钉到 model=${bucket.pin}）` : '（⚠ 没钉 model，换机器会未命中）'}`);
    }
    if (scenarioResults.some((r) => r.llm.mode === 'record') && !cassettesSaved.length) {
      console.log('[e2e] record 模式跑完但一条 LLM 请求都没发生（场景没触发 LLM？）');
    }
    const llmExchanges = scenarioResults.flatMap((r) => r.llm.exchanges.map((e) => ({ scenario: r.id, ...e })));
    const net = summarizeNetLog(netRows, netStats);
    const outbound = net.passed.filter((p) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(p.origin));
    console.log(`[e2e] 网络账面：fetch ${net.fetchCalls} 次 · 外域挡下 ${net.externalStubs.length} 个域名`
      + `${net.externalStubs.length ? `（${net.externalStubs.map((s) => `${s.origin}×${s.count}`).join('、')}）` : ''}`
      + ` · 真放行的非本机域名 ${outbound.length}${outbound.length ? `（${outbound.map((s) => s.origin).join('、')}）` : '（零真实外呼）'}`
      + `${net.truncatedLog ? ' · ⚠ 账不完整（日志闸丢过旧条目）' : ''}`);

    // LLM 账面：在线场景到底有没有真的走到模型（replay-hit / live:2xx），未命中了几发。
    const outcomeTally = llmExchanges.reduce((acc, e) => {
      const k = String(e && e.outcome || '?').replace(/^(live|record):\d+$/, '$1:2xx');
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const onScenarios = scenarioResults.filter((r) => r.llm.mode !== 'off');
    console.log(`[e2e] LLM 账面：在线场景 ${onScenarios.length} / ${scenarioResults.length} 个 · 往返 ${llmExchanges.length} 次`
      + `${Object.keys(outcomeTally).length ? `（${Object.entries(outcomeTally).map(([k, v]) => `${k}×${v}`).join('、')}）` : ''}`);

    const ok = scenarioResults.every((r) => r.ok);
    const runReport = {
      ok, app: APP_INPUT, inputType: isAix ? 'aix' : 'directory', runtime: opts.runtime || null,
      preview: opts.preview, lighting: opts.lighting,
      source: manifestInfo?.source || null,
      runtimeLocks: (manifestInfo?.runtimes || []).filter((r) => r.available
        && (!opts.runtime || String(opts.runtime).split(',').includes(r.id))),
      startedAt, finishedAt: new Date().toISOString(),
      llm: {
        // 整轮缺省模式；每个场景实际跑的模式在 scenarios[].llm 里（场景可自带声明覆写）。
        defaultMode: llmMode,
        cassette: opts.cassette || null,
        saved: cassettesSaved,
        online: onScenarios.map((r) => r.id),
        offline: scenarioResults.filter((r) => r.llm.mode === 'off').map((r) => r.id),
        outcomes: outcomeTally,
        exchanges: llmExchanges,
      },
      netGuard: opts.netGuard,
      // 「本轮零真实外呼」的留痕：externalStubs = 被闸挡下的域名，passed = 真的放行出去的域名。
      net,
      accepted: opts.accept, scenarios: scenarioResults,
    };
    await writeFile(join(reportDir, 'last-run.json'), JSON.stringify(runReport, null, 2));
    console.log(`[e2e] 报告 ${join(reportDir, 'last-run.json')}`);
    console.log(ok
      ? `[e2e] 通过：${scenarioResults.length} 个场景全绿（在线 ${onScenarios.length} · 离线 ${scenarioResults.length - onScenarios.length}）`
      : '[e2e] 不通过');
    await cleanup();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`[e2e] 失败：${err && err.message}`);
    await cleanup();
    process.exit(1);
  }
}

// 只有被当成命令跑时才动真格；被 import（单测）时本文件只是一堆纯函数。
if (process.argv[1] && cliRealpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
