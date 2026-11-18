// imu-library.js — 模拟器读工程里的 IMU 轨迹（<app>/e2e/traces/*.json，格式见 lib/imu-trace.mjs）。
// 场景里用 lab.imu，控制台的「录制轨迹」下拉框也用它；真机录下来的轨迹和这里读的是同一批文件。

import { normalizeTrace, playTraceInSimulator, sliceTrace, traceSummary } from '/host/lib/imu-trace.mjs';
import { readProjectFile } from '/host/lib/project-file.mjs';
import { state } from '/host/inklab/state.js';

const cache = new Map();
let cacheOwner = null;

/** 工程里有哪些轨迹（不带 e2e/traces/ 前缀和 .json 后缀）。 */
export function projectTraceIds() {
  return ((state.info && state.info.e2e && state.info.e2e.traces) || [])
    .map((p) => p.replace(/^e2e\/traces\//, '').replace(/\.json$/, ''));
}

/** 「名字」或「名字#段落」。 */
function parseRef(ref) {
  const text = String(ref || '');
  const at = text.indexOf('#');
  return at < 0 ? { id: text, segment: '' } : { id: text.slice(0, at), segment: text.slice(at + 1) };
}

export async function loadProjectTrace(ref) {
  const { id } = parseRef(ref);
  if (cacheOwner !== state.info) { cache.clear(); cacheOwner = state.info; } // 工程重载后重新读
  if (!cache.has(id)) {
    if (!projectTraceIds().includes(id)) throw new Error(`工程里没有轨迹 e2e/traces/${id}.json（有：${projectTraceIds().join('、') || '无'}）`);
    cache.set(id, readProjectFile(`e2e/traces/${id}.json`)
      .then((bytes) => normalizeTrace(new TextDecoder().decode(bytes), { name: id })));
  }
  return cache.get(id);
}

/** 截好要放的那一段（段落可以写在 ref 里，也可以在 options 里给）。 */
export async function pickTrace(ref, { segment, sensors, from, to } = {}) {
  const parsed = parseRef(ref);
  const trace = await loadProjectTrace(parsed.id);
  const seg = segment || parsed.segment || undefined;
  return seg || sensors || from !== undefined || to !== undefined ? sliceTrace(trace, { segment: seg, sensors, from, to }) : trace;
}

/**
 * 场景用的 lab.imu：
 *   await lab.imu.play('rg1-guided#nod-normal')            立刻切给正在跑的传感器会话
 *   await lab.imu.play('walk', { mode: 'load', loop: true })  只给之后新开的会话
 *   lab.imu.list() / await lab.imu.load(id) / await lab.imu.segment('rg1-guided#nod-normal')
 */
export function createLabImu(sensorCaps) {
  return {
    list: projectTraceIds,
    load: loadProjectTrace,
    async summary(ref) { return traceSummary(await loadProjectTrace(ref)); },
    async segment(ref) {
      const { id, segment } = parseRef(ref);
      const trace = await loadProjectTrace(id);
      const found = trace.segments.find((s) => s.id === segment);
      if (!found) throw new Error(`轨迹 ${id} 里没有段落 ${segment}`);
      return found;
    },
    async play(ref, options = {}) {
      const picked = await pickTrace(ref, options);
      return { durationMs: picked.durationMs, sensors: playTraceInSimulator(sensorCaps, picked, options) };
    },
  };
}
