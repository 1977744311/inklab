// device-agent.mjs — 把正在调试的应用装到眼镜上并打开，不经过手机与 Studio。
//
// 用的都是固件导出的开发者入口 content://com.rokid.aiui.develop，和官方 aix CLI（aix install）同一套协议：
//   安装：prepare 拿到收件目录（默认 /sdcard/aiui/package/.staging/adb）→ 推 package.aix + agent.json →
//         apply（回执 outcome 为 CREATED / UPDATED / UNCHANGED / REPAIRED 与 operationId）→ status 查这次安装。
//         之后再核对 developer_manifest.json 里这条的 fileMd5 与推上去的包一致，才算装上。
//         agentId 用我们固定的 develop.rokid.<业务>.<id>（官方 aix 装 .aix 时会改用包里写死的 ID，所以不直接调它）。
//   打开：content://com.rokid.aiui.develop 的 open 方法，回执里的 operationId 会作为 trace_id
//         出现在 AIUI 运行时日志里，看到 fullscreen_present_result 才算真的显示出来了。
//   两者都要求 AIUI 开发者模式（settings global rokid_aiui_developer_mode=1）：没开就临时打开，用完恢复原值。
// 这是本机调试安装，与 Studio 发布分开记版本，不能当作已发布的证据；只碰 develop.rokid.* 的调试包。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { DEVELOPER_SETTING, adbShell } from './device-info.mjs';
import { gestureScript, profileById } from './device-input.mjs';

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PACKAGE_DIR = '/sdcard/aiui/package';
export const MANIFEST_PATH = `${PACKAGE_DIR}/developer_manifest.json`;
export const PROVIDER = 'content://com.rokid.aiui.develop';
export const DEFAULT_INBOX = '/sdcard/aiui/package/.staging/adb';
// 官方 aix 的校验：develop.rokid.<业务>.<id>；再加上我们只用小写字母、数字、点、横线。
export const AGENT_ID_RE = /^develop\.rokid\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9._-]{0,100}$/;
const APPLY_OUTCOMES = ['CREATED', 'UPDATED', 'UNCHANGED', 'REPAIRED'];
const INSTALL_HINT = '需要 aiui 命令来打包：git clone git@github.com:1977744311/aiui-toolkit.git && cd aiui-toolkit && npm run install-cli；也可以直接传打好的 .aix';

/** adb shell 会把参数拼起来交给设备端 sh：每个参数用单引号包一次。 */
export const quoteShell = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

const slugOf = (text) => String(text || '').toLowerCase().replace(/^aiui-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

/** 应用目录叫 app 时，项目名取上一级（aiui-zhenghuo/app → zhenghuo）。 */
export function projectSlug(appDir) {
  const dir = resolve(appDir);
  return slugOf(basename(dir) === 'app' ? basename(dirname(dir)) : basename(dir));
}

function manifestField(text, name) {
  const m = new RegExp(`^- \\*\\*${name}\\*\\*:\\s*(.+)$`, 'm').exec(String(text || ''));
  return m ? m[1].trim() : '';
}

const PERMISSION_ALIASES = { INTERNET: ['network'], RECORD_AUDIO: ['microphone', 'audio'], CAMERA: ['camera'] };

/**
 * 调试包的身份与 agent.json（纯函数，文件内容由调用方读好传进来）。
 * device 是 inklab.config.json 的 device 段；没写 agentId 时按项目名生成 develop.rokid.inklab.<项目>。
 */
export function projectAgent({ appDir, appJson = {}, agentsMd = '', packageVersion = '', device = {} }) {
  const slug = projectSlug(appDir);
  const agentId = device.agentId || `develop.rokid.inklab.${slug}`;
  if (!AGENT_ID_RE.test(agentId)) throw new Error(`调试包 agentId 必须是 develop.rokid.<业务>.<id>（小写字母、数字、点、横线）：${agentId}`);
  const name = manifestField(agentsMd, 'Name') || appJson.window?.navigationBarTitleText || slug;
  const declared = Array.isArray(appJson.permissions) ? appJson.permissions.map(String) : [];
  const permissions = device.permissions || [...new Set([
    ...declared.filter((p) => p !== 'INTERNET'),
    ...declared.flatMap((p) => PERMISSION_ALIASES[p] || []),
    'audio', 'accelerometer',
  ])];
  return {
    schemaVersion: 1,
    agentId,
    agentName: device.agentName || `${name}（调试）`,
    agentDesc: `${manifestField(agentsMd, 'Summary') || name} · InkLab 本机调试安装`,
    agentPrompt: device.agentPrompt || `打开${name}调试`,
    agentLogo: '',
    nativeVersion: device.nativeVersion || packageVersion || '0.0.1',
    inkVersion: device.inkVersion || '>=0.18.0',
    permissions,
  };
}

/** 从磁盘读齐 projectAgent 需要的东西。 */
export function readProjectAgent(appDir, device = {}) {
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  const json = (path) => { try { return JSON.parse(read(path)) || {}; } catch { return {}; } };
  const pkg = [join(appDir, 'package.json'), join(dirname(resolve(appDir)), 'package.json')].map(json).find((p) => p.version) || {};
  return projectAgent({ appDir, appJson: json(join(appDir, 'app.json')), agentsMd: read(join(appDir, 'AGENTS.md')),
    packageVersion: pkg.version || '', device });
}

/**
 * 打包：传的是 .aix 就直接用；是源码目录就调用 aiui build（带大小上限、开发文件排除等全部校验）。
 * @returns {Promise<{ aixPath: string, md5: string, bytes: number, version: string|null, cleanup: () => Promise<void> }>}
 */
export async function buildPackage(input, { name = projectSlug(input), execute = exec, aiui = process.env.AIUI || 'aiui', log = () => {} } = {}) {
  const md5Of = (bytes) => createHash('md5').update(bytes).digest('hex');
  if (/\.aix$/i.test(input)) {
    const bytes = await readFile(input);
    return { aixPath: resolve(input), md5: md5Of(bytes), bytes: bytes.length, version: null, cleanup: async () => {} };
  }
  const outDir = await mkdtemp(join(tmpdir(), 'inklab-device-build-'));
  const cleanup = () => rm(outDir, { recursive: true, force: true });
  try {
    log(`打包 ${input}（aiui build）`);
    await execute(aiui, ['build', resolve(input), '--name', name, '--out', outDir], { timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    await cleanup();
    if (error.code === 'ENOENT') throw new Error(`找不到 aiui 命令。${INSTALL_HINT}`, { cause: error });
    throw new Error(`aiui build 失败：${String(error.stderr || error.stdout || error.message).trim().split('\n').slice(-3).join(' ')}`, { cause: error });
  }
  const aixPath = join(outDir, `${name}.aix`);
  const record = JSON.parse(await readFile(join(outDir, `${name}.build.json`), 'utf8').catch(() => '{}'));
  const bytes = await readFile(aixPath);
  return { aixPath, md5: md5Of(bytes), bytes: bytes.length, version: record.version || null, cleanup };
}

/** 开发者模式按「借用」处理：没开就临时打开，fn 结束后恢复原值（原来没有这个键就删掉）。 */
export async function withDeveloperMode(execute, serial, fn) {
  const shell = (script) => adbShell(execute, serial, script);
  const before = (await shell(`settings get global ${DEVELOPER_SETTING}`)).trim();
  if (before === '1') return fn();
  await shell(`settings put global ${DEVELOPER_SETTING} 1`);
  try { return await fn(); }
  finally {
    await shell(before === 'null' || !before
      ? `settings delete global ${DEVELOPER_SETTING}`
      : `settings put global ${DEVELOPER_SETTING} ${quoteShell(before)}`).catch(() => {});
  }
}

/** developer_manifest.json → 调试包列表（纯函数）。 */
export function parseDeveloperManifest(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return []; }
  return (Array.isArray(data?.packages) ? data.packages : []).map((p) => ({
    agentId: String(p.agentId || ''), agentName: String(p.agentName || ''), nativeVersion: String(p.nativeVersion || ''),
    fileMd5: String(p.fileMd5 || ''), fileName: String(p.fileName || ''),
  })).filter((p) => p.agentId);
}

export async function listDeveloperAgents({ execute = exec, serial }) {
  return parseDeveloperManifest(await adbShell(execute, serial, `cat ${MANIFEST_PATH} 2>/dev/null`));
}

/** 别的调试包从哪一页打开：把它的 .aix 拉下来读 app.json 的第一页（开发者通道的包放在共享存储里）。 */
export async function firstPageOf({ execute = exec, serial, agentId }) {
  const entry = (await listDeveloperAgents({ execute, serial })).find((p) => p.agentId === agentId);
  if (!entry?.fileName || !/^[\w.-]+\.aix$/.test(entry.fileName)) throw new Error(`眼镜上没有调试包 ${agentId}`);
  const dir = await mkdtemp(join(tmpdir(), 'inklab-device-peek-'));
  try {
    const local = join(dir, entry.fileName);
    await execute(process.env.ADB || 'adb', ['-s', serial, 'pull', `${PACKAGE_DIR}/${entry.fileName}`, local], { timeout: 60000 });
    const { stdout } = await execute('unzip', ['-p', local, 'app.json'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const page = JSON.parse(String(stdout)).pages?.[0];
    if (!page) throw new Error(`${agentId} 的 app.json 里没有页面`);
    return page;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 开发者接口的一次调用：content call --method <m> [--arg <a>]（拼成设备端 sh 命令）。 */
export const developCall = (method, arg) => ['content', 'call', '--uri', PROVIDER, '--method', method,
  ...(arg === undefined ? [] : ['--arg', arg])].map(quoteShell).join(' ');

/**
 * 开发者接口回执 → JSON（纯函数）。和官方 aix 一样按括号配对取 result_data 后面那一个对象，
 * 不靠正则吞到行尾（消息里可能带 } 或 ]）。
 */
export function parseDevelopResult(text) {
  const raw = String(text);
  if (raw.trim().startsWith('{')) return JSON.parse(raw.trim());
  const matches = [...raw.matchAll(/result_data\s*=/g)];
  if (matches.length !== 1) throw new Error(`开发者接口没有返回 result_data：${raw.trim().slice(0, 200)}`);
  const tail = raw.slice(matches[0].index + matches[0][0].length).trimStart();
  if (!tail.startsWith('{')) throw new Error('开发者接口的 result_data 不是 JSON 对象');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < tail.length; i += 1) {
    const c = tail[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return JSON.parse(tail.slice(0, i + 1));
  }
  throw new Error('开发者接口的 result_data 不完整');
}

/** errorCode 非空就报错，带上设备给的说明；开发者模式关着、引擎不兼容时说清楚（纯函数）。 */
export function requireNoError(result, stage) {
  if (result.errorCode === '' || result.errorCode === undefined || result.errorCode === null) return result;
  const message = result.message || result.errorMessage || '';
  if (stage === 'prepare' && result.errorCode === 'ENTRYPOINT_DISABLED') throw new Error('开发者模式没开（ENTRYPOINT_DISABLED）');
  if (['PROJECTION_ENGINE_INCOMPATIBLE', 'ENGINE_INCOMPATIBLE'].includes(result.errorCode)) {
    throw new Error(`包声明的引擎范围和眼镜上的 Ink 不兼容（${result.errorCode}）${message ? `：${message}` : ''}；改 app.json 的 engine 或 inkVersion 后重新打包`);
  }
  throw new Error(`${stage} 失败（${result.errorCode}）${message ? `：${message}` : ''}`);
}

/**
 * 安装（官方协议）：prepare → 推 package.aix + agent.json 到收件目录 → apply → status，
 * 再等 developer_manifest.json 里出现同一 MD5。调用方负责开发者模式（withDeveloperMode）。
 */
export async function installAgent({ execute = exec, serial, aixPath, md5, agent, wait = sleep, timeoutMs = 30000, log = () => {} }) {
  const adb = process.env.ADB || 'adb';
  const call = async (method, arg) => parseDevelopResult(await adbShell(execute, serial, developCall(method, arg), { timeout: 30000 }));
  const prepared = requireNoError(await call('prepare'), 'prepare');
  if (prepared.ready !== true) throw new Error('prepare 没有报告 ready=true');
  const inbox = String(prepared.inboxPath || DEFAULT_INBOX).replace(/\/$/, '');
  const local = await mkdtemp(join(tmpdir(), 'inklab-device-agent-'));
  try {
    await writeFile(join(local, 'agent.json'), `${JSON.stringify(agent, null, 2)}\n`);
    log(`推送到 ${inbox}`);
    await adbShell(execute, serial, `rm -f ${quoteShell(`${inbox}/package.aix`)} ${quoteShell(`${inbox}/agent.json`)}`);
    await execute(adb, ['-s', serial, 'push', aixPath, `${inbox}/package.aix`], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    await execute(adb, ['-s', serial, 'push', join(local, 'agent.json'), `${inbox}/agent.json`], { timeout: 30000 });
  } finally {
    await rm(local, { recursive: true, force: true });
  }
  log('安装（apply）');
  const applied = requireNoError(await call('apply'), 'apply');
  if (applied.agentId !== agent.agentId) throw new Error(`apply 装上的是 ${applied.agentId}，不是 ${agent.agentId}`);
  if (!APPLY_OUTCOMES.includes(String(applied.outcome))) throw new Error(`apply 结果异常：${applied.outcome ?? '没有 outcome'}`);
  if (typeof applied.operationId !== 'string' || !applied.operationId.trim()) throw new Error('apply 没有返回 operationId');
  const status = requireNoError(await call('status', applied.operationId), 'status');
  if (['FAILED_RETRYABLE', 'FAILED_PERMANENT'].includes(String(status.publishState))) {
    log(`⚠ 同步到手机失败（publishState=${status.publishState}），眼镜上的安装不受影响`);
  }
  const started = Date.now();
  for (;;) {
    const installed = (await listDeveloperAgents({ execute, serial })).find((p) => p.agentId === agent.agentId);
    if (installed && installed.fileMd5 === md5) {
      return { agentId: agent.agentId, fileMd5: md5, inbox, outcome: applied.outcome, operationId: applied.operationId,
        publishState: status.publishState ?? null, installed };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`安装没有生效：${installed ? `设备上仍是旧包 ${installed.fileMd5}` : '设备清单里没有这条'}`);
    await wait(500);
  }
}

/** open 的回执：ok=true 且带 operationId（纯函数）。 */
export function parseProviderReply(text) {
  const reply = parseDevelopResult(text);
  if (reply.ok !== true) throw new Error(`打开被拒绝：${reply.errorCode || 'UNKNOWN_ERROR'}`);
  if (!reply.operationId) throw new Error('打开请求没有返回 operationId');
  return reply;
}

export const openCommand = ({ agentId, page, target = '_blank', params = {} }) => developCall('open', JSON.stringify({ agentId, path: page, target, params }));

const AIUI_LOG = "logcat -d -v epoch 2>/dev/null | grep -F '[AIUI]' | tail -n 800";

/** 一行 AIUI 运行时日志 → { at, event, agentId, traceId, surface, toState, outcome }（纯函数）。 */
export function parseAiuiLine(line) {
  const at = Number.parseFloat(String(line).trim());
  const field = (name) => new RegExp(`(?:^|\\s)${name}=([^\\s]+)`).exec(line)?.[1] ?? null;
  const event = field('event');
  if (!event) return null;
  return { at: Number.isFinite(at) ? at : 0, event, agentId: field('agent_id'), traceId: field('trace_id'),
    surface: field('surface'), toState: field('to_state'), outcome: field('outcome') };
}

/** 设备当前时间（秒，带小数），用来只看这之后的日志。 */
export async function deviceNow({ execute = exec, serial }) {
  return Number.parseFloat((await adbShell(execute, serial, 'date +%s.%N')).trim()) || 0;
}

const recentAiui = (execute, serial) => adbShell(execute, serial, AIUI_LOG, { timeout: 10000 }).catch(() => '');
const entriesSince = (logText, since) => String(logText).split('\n').map(parseAiuiLine).filter((entry) => entry && entry.at >= since);

/**
 * since 之后，这个应用有没有真的显示到全屏（纯函数）。
 * 实测（RG1，0.20.0-rc）：AIUI 同一时间只显示一个全屏应用，新打开的实例不会顶掉已在前台的实例（自己的旧实例也一样），
 * 只会排在后面；前台的退出（fullscreen_host_teardown）后，排着的才显示，这时会有 fullscreen_present_result。
 * 眼镜的日志缓冲只有 1 MiB，很快被冲掉，所以只看这次操作之后的日志，不靠更早的历史推断前台。
 */
export function presentedSince(logText, { agentId, since = 0 }) {
  return entriesSince(logText, since).some((entry) => entry.agentId === agentId && entry.outcome === 'COMMITTED'
    && (entry.event === 'fullscreen_present_result' || (entry.event === 'presentation_result' && entry.surface === 'ASSISTANT_FULLSCREEN')));
}

/** since 之后有没有全屏应用退下来（纯函数）。 */
export function teardownSince(logText, since = 0) {
  return entriesSince(logText, since).some((entry) => entry.event === 'fullscreen_host_teardown' || entry.event === 'fullscreen_return_begin');
}

/** since 之后前台全屏应用开始退回（纯函数）：退回卡片约要 2 秒，这期间再双击会把助手整个关掉，连排着的实例一起丢掉。 */
export function returnBegunSince(logText, since = 0) {
  return entriesSince(logText, since).some((entry) => entry.event === 'fullscreen_return_begin' || entry.event === 'fullscreen_host_teardown');
}

/** since 之后这次打开的实例有没有就绪（纯函数）：打开请求的 operationId 只出现在它自己的实例日志里。 */
export function instanceReady(logText, { operationId, since = 0 }) {
  return entriesSince(logText, since).some((entry) => entry.traceId === operationId
    && (entry.toState === 'READY' || entry.event === 'ink_view_attach_end'));
}

async function waitFor({ execute, serial, wait, timeoutMs, check }) {
  const started = Date.now();
  for (;;) {
    const log = await recentAiui(execute, serial);
    const hit = check(log);
    if (hit || Date.now() - started >= timeoutMs) return { hit, log };
    await wait(400);
  }
}

/**
 * 打开调试包的某一页，并确认它真的显示到了全屏。调用方负责开发者模式与唤醒屏幕。
 * 前台有别的全屏应用（包括自己的旧实例）挡着时，新实例排在后面。bringToFront=true 时：
 *   做一次真双击（应用收到返回）→ 如果前台开始退回，就等它退完、排着的实例显示（最多 5 秒），
 *   等不到就重新发一次打开（这时前台已空）；如果应用把返回当「上一层」消化掉了，再双击，最多 attempts 次。
 * 不在退回过程中连续双击（会把助手整个关掉，排着的实例也丢了），也不替应用点确认按钮。
 */
export async function openAgent({ execute = exec, serial, agentId, page, target, params, wait = sleep, timeoutMs = 3500,
  bringToFront = false, touchpad = null, attempts = 4 }) {
  let since = await deviceNow({ execute, serial });
  let reply = parseProviderReply(await adbShell(execute, serial, openCommand({ agentId, page, target, params })));
  const shown = (from) => (log) => presentedSince(log, { agentId, since: from });
  let state = await waitFor({ execute, serial, wait, timeoutMs, check: shown(since) });
  let tries = 0;
  let reopened = false;
  while (!state.hit && bringToFront && tries < attempts) {
    tries += 1;
    const tapAt = await deviceNow({ execute, serial });
    await adbShell(execute, serial, gestureScript(profileById(touchpad?.profile), 'double-tap', { path: touchpad?.path }));
    state = await waitFor({ execute, serial, wait, timeoutMs: 2500, check: (log) => shown(since)(log) || returnBegunSince(log, tapAt) });
    if (shown(since)(state.log)) { state.hit = true; break; }
    if (!returnBegunSince(state.log, tapAt)) continue; // 应用把返回当成了「上一层」，再试
    state = await waitFor({ execute, serial, wait, timeoutMs: 5000, check: shown(since) });
    if (state.hit) break;
    since = await deviceNow({ execute, serial }); // 前台已经退下：重新打开一次
    reply = parseProviderReply(await adbShell(execute, serial, openCommand({ agentId, page, target, params })));
    reopened = true;
    state = await waitFor({ execute, serial, wait, timeoutMs, check: shown(since) });
    break;
  }
  const ready = instanceReady(state.log, { operationId: reply.operationId, since });
  const note = state.hit
    ? (tries ? `前台原来有全屏应用挡着，双击 ${tries} 次让它退下${reopened ? '、重新打开' : ''}后显示` : undefined)
    : bringToFront ? `双击 ${tries} 次后仍没显示：前台应用可能把返回当成上一层，或弹出了退出确认；在眼镜上退出它之后再打开`
      : !ready ? '运行时日志里没等到这次打开的实例就绪'
        : '实例已就绪但没显示到前台：前台还有别的全屏应用（包括本应用的旧实例），它退出后才会显示';
  return { operationId: reply.operationId, since, ready, presented: Boolean(state.hit), tries, reopened, ...(note ? { note } : {}) };
}

/**
 * 等应用画出第一帧：这个应用在 since 之后出现 ink_performance，或超时。
 * 3D、大资源的应用打开后要一两秒才有画面，太早截图只会截到黑屏。
 */
export async function waitForFirstFrame({ execute = exec, serial, agentId, since = 0, wait = sleep, timeoutMs = 6000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = await adbShell(execute, serial, `logcat -d -v epoch 2>/dev/null | grep -F 'event=ink_performance' | grep -F ${quoteShell(`agent_id=${agentId}`)} | tail -n 3`, { timeout: 10000 }).catch(() => '');
    if (log.split('\n').some((line) => Number.parseFloat(line) >= since)) return true;
    await wait(300);
  }
  return false;
}

/**
 * 退出前台的全屏应用：做真双击（应用收到的是返回），看之后有没有全屏退下来；最多 attempts 次。
 * 应用可能把返回当「上一层」或弹出退出确认，退不掉就照实返回，不替应用点确认。
 */
export async function exitAgent({ execute = exec, serial, touchpad = null, attempts = 1, wait = sleep }) {
  const since = await deviceNow({ execute, serial });
  for (let i = 0; i < attempts; i += 1) {
    await adbShell(execute, serial, gestureScript(profileById(touchpad?.profile), 'double-tap', { path: touchpad?.path }));
    await wait(1200);
    if (teardownSince(await recentAiui(execute, serial), since)) return { left: true, tries: i + 1 };
  }
  return { left: false, tries: attempts,
    note: `双击 ${attempts} 次后没有全屏应用退下来：前台可能没有全屏应用，或应用把返回当成上一层、弹出了退出确认` };
}
