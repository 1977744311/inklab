// project.js — 工程装载的输入：取源码与清单、工程自带场景、以及装载期的 LLM / 网络护栏 / 相机 / 蓝牙选项。

import { replayModelFromSearch } from '/host/lib/caps/llm.mjs';
import { cameraModeFromSearch, normalizeCameraMode } from '/host/lib/camera-mode.mjs';
import { bluetoothModeFromSearch, normalizeBluetoothMode } from '/host/lib/bluetooth-mode.mjs';
import { boot, esc, panes, write } from '/host/inklab/dom.js';
import { hostFetch, state } from '/host/inklab/state.js';

// ── 工程源码 ────────────────────────────────────────────────────────────

export async function loadProject() {
  const info = await (await hostFetch('/api/manifest', { cache: 'no-store' })).json();
  state.info = info;
  const source = info.source || { type: 'directory', path: info.appDir };
  boot(`${source.type === 'aix' ? '发布包' : '源码工程'} <span class="acc">${esc(source.path)}</span>`);
  if (source.type === 'aix') {
    boot(`AIX 身份：VERSION <span class="acc">${esc(source.version || '(缺失)')}</span> · `
      + `MD5 ${esc((source.md5 || '').slice(0, 12))} · SHA-256 ${esc((source.sha256 || '').slice(0, 16))} · `
      + `${(Number(source.bytes || 0) / 1024).toFixed(1)}KB`, 'ok');
  } else {
    boot(`源码快照 SHA-256 ${esc((source.sha256 || '').slice(0, 16))}`, 'dim');
  }
  boot(`bundle <span class="acc">${info.manifest.length}</span> 个文件`);

  panes.files.innerHTML = '';
  write('files', `${source.type === 'aix' ? 'AIX' : 'DIR'} · ${esc(source.path)}`, 'acc');
  if (info.compare) {
    const d = info.compare.files;
    write('files', `DIFF vs ${esc(info.compare.source.path)} · +${d.added.length} -${d.removed.length} ~${d.changed.length} =${d.same}`,
      d.equal ? 'ok' : 'warn');
    for (const path of d.added) write('files', `+ ${esc(path)}`, 'ok');
    for (const path of d.removed) write('files', `- ${esc(path)}`, 'err');
    for (const path of d.changed) write('files', `~ ${esc(path)}`, 'warn');
  }
  for (const p of info.manifest) write('files', esc(p), 'dim');

  if (info.problems.length) {
    for (const p of info.problems) boot(`预检：${esc(p)}`, 'err');
    throw new Error('工程预检没过，先修上面这些再跑');
  }

  const TEXT = /\.(ink|js|mjs|json|wxss|css|md|txt|svg)$/i;
  const files = {};
  await Promise.all(info.manifest.map(async (path) => {
    const res = await hostFetch('/app/' + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读不到 ${path}（HTTP ${res.status}）`);
    files[path] = TEXT.test(path) ? await res.text() : new Uint8Array(await res.arrayBuffer());
  }));
  state.lastLoad = { info, files };
  return state.lastLoad;
}

/**
 * 工程自带的 e2e 场景（<app>/e2e/scenarios/*.mjs）。带缓存戳重新 import，
 * 热重载后拿到的是编辑后的模块（场景内部的相对 import 仍走浏览器模块缓存——
 * 改了被 import 的辅助文件要整页刷新才生效，这是 ESM 的边界，不藏着）。
 */
export async function loadProjectScenarios(info) {
  const out = [];
  const seq = Date.now();
  for (const rel of (info.e2e && info.e2e.scenarios) || []) {
    const name = rel.split('/').pop();
    try {
      const mod = await import(`/project-scenarios/${name}?v=${seq}`);
      const s = mod.default;
      if (!s || typeof s.id !== 'string' || typeof s.build !== 'function') {
        throw new Error('default 导出要有 { id, title, summary, build }');
      }
      out.push({ ...s, source: 'project' });
    } catch (err) {
      boot(`工程场景 ${esc(rel)} 加载失败：${esc(err && err.message)}`, 'err');
    }
  }
  return out;
}

/**
 * LLM 接线。模式取 URL `?llm=off|live|record|replay`；不给时有 endpoint（环境变量
 * INKLAB_LLM_ENDPOINT，serve 透传）就 live，否则 off——off 不配能力，引擎自判模型不可用，
 * 应用走自己的离线路径（诚实答复，不假装成功）。
 * replay 吃工程的录像（?cassette=e2e/cassettes/x.json，缺省认 default.json），不出网也不用密钥。
 */
/**
 * 外域出网默认挡下（`?netguard=0` 关掉）。默认开是刻意的：本地宿主跑的是**真源码**，
 * 应用里任何一条硬编码的线上域名都会真的打到别人的生产后端，而且多半发生在启动链路里
 * ——脚本层根本来不及拦（某真实应用的启动天气预取就是这么被发现的）。
 * 要看真后端：`?netguard=0`，或运行时 `__inklab.caps.net.allowExternal('example.com')` 点名放行。
 */
export function netGuardEnabled() {
  // 控制台的勾选框一旦接好就是权威（重载工程要跟着人手上的开关走，不要被 URL 顶回去）。
  const box = document.getElementById('net-guard');
  if (box && box.dataset.wired === '1') return box.checked;
  const v = new URLSearchParams(location.search).get('netguard');
  return !(v === '0' || v === 'off' || v === 'false');
}

/**
 * 相机来源。控制台一旦接好就以人的选择为准；初次装载从 URL 读。
 * 未知值安全回落 mock，避免自动化环境因拼错参数意外申请摄像头权限。
 */
export function selectedCameraMode() {
  const select = document.getElementById('camera-mode');
  if (select && select.dataset.wired === '1') return normalizeCameraMode(select.value);
  return cameraModeFromSearch(location.search);
}

/**
 * 蓝牙来源。和相机一样，控制台接好后人的选择优先；未知值必须安全回落 mock。
 * computer 模式不会在这里预先 requestDevice——浏览器要求设备选择发生在应用的用户手势里。
 */
export function selectedBluetoothMode() {
  const select = document.getElementById('bluetooth-mode');
  if (select && select.dataset.wired === '1') return normalizeBluetoothMode(select.value);
  return bluetoothModeFromSearch(location.search);
}

/**
 * 场景级 LLM 覆写入口（e2e runner 用；手动排障时也能在控制台直接调）。
 *
 *   __inklab.setLlm({ mode:'replay', cassette:'e2e/cassettes/x.json', model:'inklab-cassette' });
 *   await __inklab.reload();   // 覆写在**下一次装载**生效（能力层是装载期一次性建好的）
 *   __inklab.setLlm(null);     // 清掉，回到 URL / 环境变量决定的模式
 *
 * `model` 这一项是给**录像键**用的：键含 model 字段（llm.mjs normalizeRequestBody），
 * 录像带在哪个 model 名下录的、回放时就得钉回哪个，否则换台机器（llm.local.json 写着别的模型名）
 * 恒 replay-miss。钉一个不存在的假模型名是安全的：replay 一个字节都不出网，model 只进哈希。
 */
export function setLlm(override) {
  state.llmOverride = override && typeof override === 'object' ? { ...override } : null;
  return state.llmOverride;
}

export async function resolveLlm(info) {
  const q = new URLSearchParams(location.search);
  // 覆写优先于 URL：URL 是「这一页缺省怎么跑」，覆写是「这个场景要怎么跑」。
  const ov = state.llmOverride && typeof state.llmOverride === 'object' ? state.llmOverride : null;
  const asked = (ov && ov.mode) || q.get('llm');
  let mode = asked || (info.llm && info.llm.endpoint ? 'live' : 'off');
  if (!['off', 'live', 'record', 'replay'].includes(mode)) {
    boot(`不认识 llm=${esc(mode)}（只有 off/live/record/replay），按 off 处理`, 'warn');
    mode = 'off';
  }
  if (mode === 'off') return { mode: 'off', opts: null, cassettePath: null };

  const cassettes = (info.e2e && info.e2e.cassettes) || [];
  const cassettePath = (ov && ov.cassette) || q.get('cassette')
    || (cassettes.includes('e2e/cassettes/default.json') ? 'e2e/cassettes/default.json' : null);
  let cassette = [];
  if (mode === 'replay') {
    if (!cassettePath) {
      throw new Error('llm=replay 需要录像：给 ?cassette=e2e/cassettes/xxx.json、'
        + '在场景里声明 llm.cassette，或先用 llm=record 跑一遍录一份 default.json');
    }
    const res = await hostFetch('/app/' + cassettePath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读不到 LLM 录像 ${cassettePath}（HTTP ${res.status}）`);
    const parsed = await res.json();
    cassette = Array.isArray(parsed) ? parsed : parsed.entries || [];
  }
  // model：覆写 > serve 透传的本机配置。覆写只在**回放**时该生效——录制时要打给真上游，
  // 拿一个不存在的假模型名去录只会换回一个 400。
  const model = (mode === 'replay' && ov && ov.model)
    || replayModelFromSearch(location.search, mode)
    || (info.llm && info.llm.model) || '';
  return {
    mode,
    cassettePath: mode === 'replay' ? cassettePath : null,
    opts: {
      mode,
      cassette,
      // serve 配了 requestDefaults 时给的是本机转发路由的相对路径，这里按页面 origin 补全
      // ——引擎要的是完整 URL，不拼路径。
      ...(info.llm && info.llm.endpoint
        ? { endpoint: new URL(info.llm.endpoint, location.origin).href } : {}),
      ...(info.llm && info.llm.apiKey ? { apiKey: info.llm.apiKey } : {}),
      ...(model ? { model } : {}),
    },
  };
}
