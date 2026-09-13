#!/usr/bin/env node
// serve.mjs — InkLab 本地宿主：把引擎、工程源码和宿主页面拼在一个静态服务上。
//
//   node serve.mjs fixtures/cap-probe-app
//   node serve.mjs fixtures/minimal.aix
//   node serve.mjs <dir|package.aix> --compare-with <dir|package.aix>
//
// 路由：
//   /                 宿主页面
//   /host/*           宿主自身的脚本
//   /host/lib/*       lib/ 下的纯逻辑（能力层 / 驱动层），与单测跑的是同一份文件
//   /scenarios/*      内置场景脚本
//   /project-scenarios/*  被调工程自带的 e2e 场景（<app>/e2e/scenarios/）
//   /runtimes/<id>/*  命名运行时 lane 的 glue 与 wasm（/engine/* 仍指默认 lane，兼容旧入口）
//   /app/*            被调工程快照里的文件（源码目录或发布态 .aix）
//   /llm/chat/completions  LLM 转发：按 llm.local.json 的 requestDefaults 补缺失字段后转真上游
//   /api/manifest     bundle 文件清单 + 预检结果 + e2e 资产清单 + LLM 环境配置
//   /api/watch        SSE：被调工程目录一有变化就推一条，宿主据此热重载
//
// 顶层只有定义，跑服务的副作用都在 createInkLabServer()/main() 里——这样 __tests__ 能
// import 本文件里的纯逻辑（去抖批处理等）而不会顺手起一个服务器；e2e runner 则用
// createInkLabServer 在自己进程里嵌一个服务。

import { realpathSync as cliRealpath } from 'node:fs';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifest, validateManifest } from './lib/bundle.mjs';
import { createProjectSource, diffProjectSnapshots } from './lib/project-source.mjs';
import { normalizeRuntimeRegistry } from './lib/runtime-lock.mjs';
import { createDeviceHandler, createDeviceService } from './lib/device-service.mjs';
import { engineCacheDirectory } from './lib/cache-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = engineCacheDirectory();
const HOST_DIR = join(HERE, 'host');
// lib 只有一份真相：宿主页面按 /host/lib/* 取，单测按相对路径取，跑的是同一个文件。
// 早先是往 host/ 拷一份副本，两份必然漂移——宿主跑的和测试跑的不是同一个文件就白测了。
const LIB_DIR = join(HERE, 'lib');
const SCENARIOS_DIR = join(HERE, 'scenarios');
const RUNTIMES_LOCK_PATH = join(HERE, 'runtimes.lock.json');
const LEGACY_LOCK_PATH = join(HERE, 'engine.lock.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8',
  '.ink': 'text/plain; charset=utf-8', '.wxss': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/** 热重载去抖的默认参数：一次保存往往连发好几条 fs 事件，攒够安静期再推一条。 */
export const WATCH_DEBOUNCE_MS = 200;
/** 但也不能无限攒：编辑器连续写盘时 trailing 去抖会一直被顶掉，超过这个上限强制推一次。 */
export const WATCH_MAX_WAIT_MS = 1000;

/**
 * 把一串文件变化事件攒成一批。**这是热重载唯一的正确性要害**：
 * 不去抖，一次「保存」就会触发好几次整包重载（fs.watch 对一次写盘常发 rename+change 两条以上，
 * 编辑器的原子替换更多），重载又会重启引擎——十次重载里九次是在跟自己赛跑。
 *
 * 语义：trailing 去抖（每来一条重新计时），但从**第一条**算起最多等 maxWaitMs 就强制推一次，
 * 免得「一直在写」的编辑器把 flush 无限期顶掉。
 *
 * 定时器全靠注入，所以单测能用假钟一拍一拍地断言，不需要真的等。
 *
 * @param {object} opts
 * @param {(paths:string[]) => void} opts.onFlush 攒好一批后调一次，参数是去重后的相对路径
 * @param {number} [opts.delayMs]
 * @param {number} [opts.maxWaitMs]
 * @param {(fn:Function, ms:number) => any} [opts.setTimeout]
 * @param {(handle:any) => void} [opts.clearTimeout]
 * @param {() => number} [opts.now]
 */
export function createChangeBatcher({
  onFlush,
  delayMs = WATCH_DEBOUNCE_MS,
  maxWaitMs = WATCH_MAX_WAIT_MS,
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (h) => globalThis.clearTimeout(h),
  now = () => Date.now(),
} = {}) {
  if (typeof onFlush !== 'function') throw new TypeError('createChangeBatcher 需要 onFlush');
  const pending = new Set();
  let timer = null;
  let firstAt = 0;

  const flush = () => {
    if (timer !== null) { clearT(timer); timer = null; }
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    firstAt = 0;
    onFlush(paths);
  };

  return {
    /** 收一条变化。返回当前批次里的文件数，方便调用方打日志。 */
    push(path) {
      if (path) pending.add(String(path));
      if (firstAt === 0) firstAt = now();
      const waited = now() - firstAt;
      if (waited >= maxWaitMs) { flush(); return 0; }
      if (timer !== null) clearT(timer);
      // 攒到上限就别再往后顺延了，掐着 maxWaitMs 触发。
      timer = setT(flush, Math.min(delayMs, Math.max(0, maxWaitMs - waited)));
      return pending.size;
    },
    /** 手动推一批（关服务时用，别把最后一批丢了）。 */
    flush,
    pending: () => [...pending],
    stop() { if (timer !== null) { clearT(timer); timer = null; } pending.clear(); firstAt = 0; },
  };
}

export async function walk(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await rec(abs);
      else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  await rec(root);
  return out;
}

export function parseArgs(argv) {
  const rest = [];
  const opts = { port: 8788, open: false, compareWith: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') { opts.port = Number(argv[i + 1]); i += 1; } else if (a === '--open') opts.open = true;
    else if (a === '--compare-with') { opts.compareWith = argv[i + 1]; i += 1; }
    else if (a === '--device') opts.device = true;
    else if (a === '--serial') { opts.serial = argv[i + 1]; i += 1; }
    else if (a === '--device-output') { opts.deviceOutput = argv[i + 1]; i += 1; }
    else rest.push(a);
  }
  opts.input = rest[0];
  opts.appDir = opts.input; // 旧调用方兼容
  return opts;
}

/** 目录穿越防护：任何 /app/../.. 之类的路径一律拒绝。 */
export function safeJoin(root, urlPath) {
  const p = resolve(root, '.' + decodeURIComponent(urlPath));
  return p === root || p.startsWith(root + sep) ? p : null;
}

/**
 * 哪些文件变化不该触发整包重载。除编辑器临时文件外，e2e 的录像/基线/报告也要拦：
 * 它们是跑测过程的读写物，e2e 跑完写报告若触发重载，宿主会在两个场景之间白白重启引擎。
 * e2e/scenarios/ 例外——改场景脚本就该重载（宿主重载时会重新 import 场景清单）。
 */
export function shouldIgnoreWatchPath(rel) {
  const p = String(rel);
  if (/(^|\/)\.|~$|\.swp$|\.tmp$|___jb_/.test(p)) return true;
  if (/(^|\/)e2e(\/|$)/.test(p) && !/(^|\/)e2e\/scenarios(\/|$)/.test(p)) return true;
  return false;
}

/**
 * 把 walk 出来的工程文件清单分拣成「进引擎 bundle 的」与「e2e 资产」。
 * e2e 目录的口径钉死在这里：scenarios 只认顶层 .mjs（测试文件不算场景），
 * cassettes 只认 .json，baselines 认 .png 与它的 .json 元数据。
 */
export function partitionAppFiles(relPaths, { published = false } = {}) {
  const all = (relPaths || []).map((p) => String(p).replace(/\\/g, '/'));
  const notTest = (p) => !/\.test\.mjs$/.test(p);
  return {
    // 发布包是事实源：包里有哪些字节就原样交给 openBundle，不能再套一次源码排除表。
    manifest: published ? [...new Set(all)].sort() : buildManifest(all),
    e2eScenarios: all.filter((p) => /^e2e\/scenarios\/[^/]+\.mjs$/.test(p) && notTest(p)).sort(),
    e2eCassettes: all.filter((p) => /^e2e\/cassettes\/[^/]+\.json$/.test(p)).sort(),
    e2eBaselines: all.filter((p) => /^e2e\/baselines\/.+\.(png|json)$/i.test(p)).sort(),
  };
}

/**
 * LLM 配置的环境变量口（密钥绝不写进仓库或代码字面量），原样透传给宿主页面。
 * 服务只绑 127.0.0.1，且无 CORS 头——别的 origin 的页面读不到这份响应。
 * INKLAB_LLM_API_KEY_FILE / apiKeyFile 指向仓库外的密钥文件（serve 启动时现读），
 * 让「配置常驻、密钥不进仓库树」两件事同时成立。
 */
export function llmEnvConfig(env = {}) {
  const pick = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  return {
    endpoint: pick('INKLAB_LLM_ENDPOINT'),
    model: pick('INKLAB_LLM_MODEL'),
    apiKey: pick('INKLAB_LLM_API_KEY'),
    apiKeyFile: pick('INKLAB_LLM_API_KEY_FILE'),
  };
}

/**
 * 合并 LLM 配置：环境变量 > `llm.local.json`（不入库的本地档）。
 * requestDefaults 只来自本地档：给上游请求体**补缺失字段**用的厂商参数
 * （例如思考型模型要 `enable_thinking:false` 才能赶上应用自己的生成超时闸）。
 * 纯函数；密钥文件的读取在 createInkLabServer 里做。
 */
export function mergeLlmConfig(envCfg = {}, fileCfg = {}) {
  const pick = (a, b) => {
    if (typeof a === 'string' && a.trim()) return a.trim();
    if (typeof b === 'string' && b.trim()) return b.trim();
    return null;
  };
  const defaults = fileCfg.requestDefaults;
  return {
    endpoint: pick(envCfg.endpoint, fileCfg.endpoint),
    model: pick(envCfg.model, fileCfg.model),
    apiKey: pick(envCfg.apiKey, fileCfg.apiKey),
    apiKeyFile: pick(envCfg.apiKeyFile, fileCfg.apiKeyFile),
    requestDefaults: defaults && typeof defaults === 'object' && !Array.isArray(defaults)
      && Object.keys(defaults).length ? defaults : null,
  };
}

/**
 * 把 requestDefaults 补进请求体 JSON：**只补缺失的键，引擎显式写了的字段绝不覆盖**——
 * 这是「宿主级厂商参数」与「篡改被调试对象行为」的分界线。解不出 JSON 就原样返回。
 */
export function fillRequestDefaults(bodyText, defaults) {
  if (!defaults || typeof defaults !== 'object') return bodyText;
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return bodyText; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText;
  let touched = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in parsed)) { parsed[k] = v; touched = true; }
  }
  return touched ? JSON.stringify(parsed) : bodyText;
}

async function sendFile(res, abs) {
  try {
    const body = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store', // 改一行刷新即生效
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

function sendBody(res, body, path) {
  if (body == null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(typeof body === 'string' ? body : Buffer.from(body));
}

async function loadRuntimeRegistry() {
  const [matrix, legacy] = await Promise.all([
    readFile(RUNTIMES_LOCK_PATH, 'utf8').then(JSON.parse).catch(() => null),
    readFile(LEGACY_LOCK_PATH, 'utf8').then(JSON.parse).catch(() => null),
  ]);
  const registry = normalizeRuntimeRegistry(matrix, legacy);
  const runtimes = [];
  const roots = new Map();
  for (const runtime of registry.runtimes) {
    const root = resolve(ENGINE_DIR, runtime.cacheDir);
    if (!(root === ENGINE_DIR || root.startsWith(ENGINE_DIR + sep))) {
      throw new Error(`运行时 ${runtime.id} 的 cacheDir 越出 .engine：${runtime.cacheDir}`);
    }
    const available = await Promise.all([
      stat(join(root, 'ink-glue.js')).then(() => true).catch(() => false),
      stat(join(root, 'engine.wasm')).then(() => true).catch(() => false),
    ]).then((v) => v.every(Boolean));
    runtimes.push({ ...runtime, available });
    if (available) roots.set(runtime.id, root);
  }
  const available = runtimes.filter((r) => r.available);
  if (!available.length) {
    throw new Error('还没取任何运行时。先跑：node fetch-engine.mjs --matrix');
  }
  const defaultId = roots.has(registry.default) ? registry.default : available[0].id;
  return { schemaVersion: 1, default: defaultId, runtimes, roots };
}

/**
 * 起一个 InkLab 宿主服务（可嵌入：e2e runner 在自己进程里用它，CLI 的 main() 也用它）。
 *
 * @param {object} opts
 * @param {string} [opts.input]  被调源码目录或 .aix（绝对或相对 cwd）
 * @param {string} [opts.appDir] 旧参数名，等价于 input
 * @param {string} [opts.compareWith] 可选的第二工程源，只做内容差分，不执行
 * @param {number} [opts.port]  0 = 随机空闲端口（e2e 用）
 * @param {object} [opts.env]   环境变量来源，默认 process.env（llm 配置与 appId 从这里取）
 * @param {(line:string) => void} [opts.log]
 * @returns {Promise<{server:object, port:number, url:string, appDir:string, watching:boolean, close:() => Promise<void>}>}
 */
export async function createInkLabServer({
  input, appDir, compareWith = null, port = 8788, env = process.env, log = () => {},
  device = false, serial = '', deviceOutput, deviceService,
} = {}) {
  const project = await createProjectSource(input || appDir);
  const comparison = compareWith ? await createProjectSource(compareWith) : null;
  const devices = deviceService || createDeviceService({ appDir: project.path, enabled: device,
    serial, ...(deviceOutput ? { outputDir: deviceOutput } : {}) });
  const handleDevice = createDeviceHandler(devices);
  const runtimeRegistry = await loadRuntimeRegistry();
  const firstSnapshot = project.snapshot();
  if (!firstSnapshot.files['app.json']) {
    throw new Error(`${project.path} 里没有 app.json，看着不像 AIUI 工程或合法 .aix`);
  }

  // ── LLM 配置：环境变量 > llm.local.json（不入库），启动时解析一次 ─────────
  // 密钥优先级：apiKey 字面量（仅环境变量该用）> apiKeyFile 指向的仓库外文件。
  let llm = llmEnvConfig(env);
  try {
    llm = mergeLlmConfig(llm, JSON.parse(await readFile(join(HERE, 'llm.local.json'), 'utf8')));
  } catch { /* 没有本地配置档就只看环境变量 */ }
  if (!llm.apiKey && llm.apiKeyFile) {
    try {
      llm.apiKey = (await readFile(llm.apiKeyFile, 'utf8')).trim() || null;
    } catch (err) {
      log(`[inklab] LLM 密钥文件读不到（${llm.apiKeyFile}）：${err && err.message}`);
    }
  }
  if (llm.endpoint && !/\/chat\/completions\/?$/.test(llm.endpoint)) {
    log(`[inklab] 提醒：LLM endpoint 要写完整的 chat-completions URL（引擎不拼路径）：${llm.endpoint}`);
  }

  // ── 热重载：一路 SSE 客户端 + 一个攒批的 fs.watch ────────────────────────
  const clients = new Set();
  let changeSeq = 0;
  const batcher = createChangeBatcher({
    onFlush(paths) {
      changeSeq += 1;
      const payload = JSON.stringify({ seq: changeSeq, at: Date.now(), files: paths.slice(0, 20), count: paths.length });
      log(`[inklab] 源码变化 ${paths.length} 个文件 → 推给 ${clients.size} 个宿主页面`);
      for (const res of clients) {
        try { res.write(`event: change\ndata: ${payload}\n\n`); } catch { clients.delete(res); }
      }
    },
  });

  let watcher = null;
  try {
    // recursive 在 macOS/Windows 上原生支持，Linux 要 Node 20+；不支持就退化成不热重载，
    // 但服务本身照跑——热重载没了顶多手动点「重载工程」，不该因此起不来。
    watcher = watch(project.watchPath, { recursive: project.watchRecursive }, (_type, filename) => {
      const rel = project.type === 'aix'
        ? project.describe().name
        : String(filename || '').split(sep).join('/');
      if (!rel) return;
      if (shouldIgnoreWatchPath(rel)) return;
      batcher.push(rel);
    });
  } catch (err) {
    log(`[inklab] fs.watch 起不来，热重载不可用：${err && err.message}`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (await handleDevice(req, res, url)) return undefined;
    if (path === '/device' || path === '/device/') return sendFile(res, join(HOST_DIR, 'device.html'));

    if (path === '/' || path === '/index.html') return sendFile(res, join(HOST_DIR, 'index.html'));

    if (path === '/api/watch') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ input: project.path, sourceType: project.type, watching: Boolean(watcher) })}\n\n`);
      clients.add(res);
      // 心跳：反代/浏览器都会掐掉长时间不出声的连接，注释行不触发 onmessage。
      const beat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* 掉线下面会清 */ } }, 25_000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
      return undefined;
    }

    if (path === '/api/manifest') {
      const sourceSnapshot = await project.refresh();
      const parts = partitionAppFiles(sourceSnapshot.paths, { published: project.type === 'aix' });
      const appJsonText = typeof sourceSnapshot.files['app.json'] === 'string'
        ? sourceSnapshot.files['app.json'] : null;
      const problems = validateManifest(parts.manifest, appJsonText);
      const source = project.describe();
      let compare = null;
      if (comparison) {
        const other = await comparison.refresh();
        compare = {
          source: comparison.describe(),
          files: diffProjectSnapshots(sourceSnapshot, other),
        };
      }
      const publicRuntimes = runtimeRegistry.runtimes.map(({ cacheDir: _cacheDir, glueUrl: _glueUrl, wasmUrl: _wasmUrl, ...runtime }) => runtime);
      const defaultRuntime = publicRuntimes.find((r) => r.id === runtimeRegistry.default)
        || publicRuntimes.find((r) => r.available);
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      return res.end(JSON.stringify({
        appDir: project.path,
        input: project.path,
        source,
        compare,
        appId: env.INKLAB_APP_ID || 'inklab-local',
        manifest: parts.manifest,
        problems,
        engine: {
          version: defaultRuntime?.engineVersion || null,
          build: defaultRuntime?.engineBuild || null,
          wasmSha256: defaultRuntime?.wasmSha256 || null,
        },
        runtimeDefault: runtimeRegistry.default,
        runtimes: publicRuntimes,
        e2e: {
          scenarios: parts.e2eScenarios,
          cassettes: parts.e2eCassettes,
          baselines: parts.e2eBaselines,
        },
        // 页面只需要这三样；apiKeyFile 是服务端自己的事，不透传。
        // 配了 requestDefaults 就让页面走本机 /llm 转发路由（补厂商参数）。
        // 域名刻意用 localhost 而不是页面同源的 127.0.0.1：引擎对**同源** endpoint
        // 不发请求（实测 getConfig 之后 POST 无影无踪），换个 host 字符串就通。
        llm: {
          endpoint: llm.endpoint
            ? (llm.requestDefaults ? `http://localhost:${server.address().port}/llm/chat/completions` : llm.endpoint)
            : null,
          model: llm.model,
          apiKey: llm.apiKey,
        },
      }));
    }

    // LLM 转发：把 requestDefaults 补进请求体后转给真上游，流式原样回传。
    // Authorization 从引擎的请求原样带过去——本路由不持有也不注入密钥。
    // 页面按 localhost 访问本路由（见 manifest 注释），对 127.0.0.1 的页面是跨域，
    // 要应付浏览器的 CORS 预检；服务仍只绑 127.0.0.1，不对外。
    const LLM_CORS = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': '*',
    };
    if (path === '/llm/chat/completions' && req.method === 'OPTIONS') {
      res.writeHead(204, LLM_CORS);
      return res.end();
    }
    if (path === '/llm/chat/completions' && req.method === 'POST') {
      if (!llm.endpoint) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', ...LLM_CORS }); return res.end('LLM 未配置'); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = Buffer.concat(chunks).toString('utf8');
      body = fillRequestDefaults(body, llm.requestDefaults);
      try {
        const upstream = await fetch(llm.endpoint, {
          method: 'POST',
          headers: {
            'content-type': req.headers['content-type'] || 'application/json',
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
          body,
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
          ...LLM_CORS,
        });
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      } catch (err) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...LLM_CORS });
        return res.end(`LLM 上游失败：${err && err.message}`);
      }
    }

    if (path.startsWith('/app/')) {
      const rel = path.slice('/app/'.length);
      return sendBody(res, await project.read(rel), rel);
    }
    if (path.startsWith('/project-scenarios/')) {
      const rel = `e2e/scenarios/${path.slice('/project-scenarios/'.length)}`;
      return sendBody(res, await project.read(rel), rel);
    }
    if (path.startsWith('/runtimes/')) {
      const match = /^\/runtimes\/([^/]+)\/(.+)$/.exec(path);
      const root = match && runtimeRegistry.roots.get(match[1]);
      if (!root) { res.writeHead(404); return res.end('runtime not available'); }
      const abs = safeJoin(root, `/${match[2]}`);
      if (!abs) { res.writeHead(403); return res.end('forbidden'); }
      return sendFile(res, abs);
    }
    for (const [prefix, root] of [
      ['/host/lib/', LIB_DIR], ['/host/', HOST_DIR], ['/scenarios/', SCENARIOS_DIR],
      ['/engine/', runtimeRegistry.roots.get(runtimeRegistry.default)],
    ]) {
      if (path.startsWith(prefix)) {
        if (!root) { res.writeHead(404); return res.end('not found'); }
        const abs = safeJoin(root, path.slice(prefix.length - 1));
        if (!abs) { res.writeHead(403); return res.end('forbidden'); }
        return sendFile(res, abs);
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return undefined;
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
  });
  const actualPort = server.address().port;

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    deviceUrl: `http://127.0.0.1:${actualPort}/device`,
    appDir: project.path,
    input: project.path,
    sourceType: project.type,
    watching: Boolean(watcher),
    // 给 CLI 打启动日志用的脱敏摘要——密钥本体不出这个函数
    llmSummary: llm.endpoint
      ? `${llm.endpoint}${llm.model ? ` · ${llm.model}` : ''} · 密钥${llm.apiKey ? '已载入' : '缺失'}`
      : null,
    async close() {
      await devices.close();
      batcher.stop();
      if (watcher) watcher.close();
      for (const res of clients) { try { res.end(); } catch { /* 掉线的连接不拦关闭 */ } }
      clients.clear();
      await new Promise((r) => { server.close(() => r()); });
    },
  };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.input) {
    console.error('用法: node serve.mjs <app-dir|package.aix> [--compare-with <dir|package.aix>] [--port 8788] [--open] [--device --serial SN --device-output DIR]');
    process.exit(1);
  }

  let lab;
  try {
    lab = await createInkLabServer({ input: opts.input, compareWith: opts.compareWith, port: opts.port,
      device: opts.device, serial: opts.serial, deviceOutput: opts.deviceOutput, log: (l) => console.log(l) });
  } catch (err) {
    console.error(`[inklab] ${err && err.message}`);
    process.exit(1);
  }

  console.log(`[inklab] 工程 ${lab.input}（${lab.sourceType === 'aix' ? '发布包' : '源码目录'}）`);
  console.log(`[inklab] 打开 ${lab.url}`);
  if (opts.device) console.log(`[inklab] USB 真机工作台 ${lab.deviceUrl}（手动打开一次 AIUI 应用后执行场景）`);
  if (lab.llmSummary) console.log(`[inklab] LLM ${lab.llmSummary}（页面缺省 live，可用 ?llm=off 关掉）`);
  console.log(`[inklab] 热重载 ${lab.watching ? '已开（改源码即自动重跑装载）' : '不可用（手动点「重载工程」）'}。Ctrl+C 退出。`);
  if (opts.open) {
    const { spawn } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(cmd, [opts.device ? lab.deviceUrl : lab.url], { stdio: 'ignore', detached: true }).unref();
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await lab.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 只有被当成命令跑时才起服务；被 import（单测）时本文件只是一堆纯函数。
if (process.argv[1] && cliRealpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
