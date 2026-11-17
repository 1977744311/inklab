// engine-update.mjs — inklab / inklab-e2e / inklab-matrix 启动时自动看一眼 npm 上有没有新引擎。
//
// 目的：项目里写通道名（latest / daily），引擎更新后不用任何人手动跑 inklab-engine。
// 一天最多查一次（上次成功检查的时间记在引擎缓存目录的 update-check.json）；
// 查不了（断网、registry 慢）只打一行警告，照常用本机已有的引擎，不挡启动。
//   INKLAB_NO_UPDATE=1   不检查（CI 想完全离线、或要钉死引擎时用）
//   INKLAB_UPDATE=force  忽略一天一次的间隔，这次一定检查

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { engineCacheDirectory } from './cache-path.mjs';

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 只是顺手一看：dist-tags 很小，几秒没回应就放弃；真有新版本时 tarball 照常下载（带停滞超时与重试）。
const QUICK = { retries: 0, stallMs: 5_000 };

export function updateStatePath(env = process.env) {
  return join(engineCacheDirectory(env), 'update-check.json');
}

async function lastChecked(path) {
  try {
    const value = Date.parse(JSON.parse(await readFile(path, 'utf8')).checkedAt);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** 这次该不该查：纯判断，便于测试。 */
export function shouldCheck({ env = process.env, now = Date.now(), checkedAt = 0, intervalMs = UPDATE_INTERVAL_MS } = {}) {
  if (env.INKLAB_NO_UPDATE === '1') return false;
  if (env.INKLAB_UPDATE === 'force') return true;
  return !(checkedAt && now - checkedAt >= 0 && now - checkedAt < intervalMs);
}

/**
 * 需要时查 npm 并把新版本收进清单。返回新加的 lane id；没查或没新东西时返回 []。从不抛错。
 * record 可注入（测试用），缺省用 fetch-engine 的 recordNpmBuilds。
 */
export async function autoUpdateEngines({ env = process.env, now = Date.now(), log = console.log, record } = {}) {
  const statePath = updateStatePath(env);
  if (!shouldCheck({ env, now, checkedAt: await lastChecked(statePath) })) return [];
  try {
    const recordBuilds = record || (await import('./fetch-engine.mjs')).recordNpmBuilds;
    const added = await recordBuilds({ downloadOptions: QUICK, quiet: true });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ checkedAt: new Date(now).toISOString() })}\n`);
    if (added.length) log(`[inklab] 已取回新引擎：${added.join('、')}（latest / daily 通道自动指向最新）`);
    return added;
  } catch (error) {
    log(`[inklab] ⚠ 没能检查 npm 上的新引擎（${error.message}），先用本机已有的引擎；INKLAB_NO_UPDATE=1 可关掉检查`);
    return [];
  }
}
