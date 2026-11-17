import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 应用目录里的 inklab.config.json（只给 InkLab 用，不进发布包）：
//   allowExternal  允许真实外呼的地址模式
//   runtime        这个项目默认跑哪个引擎：通道名（latest / daily / studio）或具体 lane id。
//                  命令行 --runtime、URL ?runtimes=、环境变量 INKLAB_RUNTIME 都比它优先。
//   device         推到真机的调试包：agentId（develop.rokid.*）、agentName、agentPrompt、page（默认打开哪页）、
//                  autoPush（保存即推送，默认开）、permissions、inkVersion、nativeVersion。
export async function readAppConfig(appDir, allowExternal = []) {
  let config = {};
  if (appDir) {
    try { config = JSON.parse(await readFile(join(appDir, 'inklab.config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (config.allowExternal !== undefined && (!Array.isArray(config.allowExternal)
    || config.allowExternal.some((p) => typeof p !== 'string' || !p.trim()))) {
    throw new Error('inklab.config.json: allowExternal 必须是非空字符串数组');
  }
  if (config.runtime !== undefined && (typeof config.runtime !== 'string' || !config.runtime.trim())) {
    throw new Error('inklab.config.json: runtime 必须是通道名（latest / daily / studio）或 lane id');
  }
  const device = config.device === undefined ? {} : config.device;
  if (!device || typeof device !== 'object' || Array.isArray(device)) throw new Error('inklab.config.json: device 必须是对象');
  for (const key of ['agentId', 'agentName', 'agentPrompt', 'page', 'inkVersion', 'nativeVersion']) {
    if (device[key] !== undefined && (typeof device[key] !== 'string' || !device[key].trim())) throw new Error(`inklab.config.json: device.${key} 必须是非空字符串`);
  }
  if (device.agentId !== undefined && !/^develop\.rokid\.[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9._-]{0,100}$/.test(device.agentId)) {
    throw new Error('inklab.config.json: device.agentId 必须是 develop.rokid.<业务>.<id>（小写字母、数字、点、横线）');
  }
  if (device.autoPush !== undefined && typeof device.autoPush !== 'boolean') throw new Error('inklab.config.json: device.autoPush 必须是 true 或 false');
  if (device.permissions !== undefined && (!Array.isArray(device.permissions) || device.permissions.some((p) => typeof p !== 'string' || !p.trim()))) {
    throw new Error('inklab.config.json: device.permissions 必须是非空字符串数组');
  }
  return {
    allowExternal: [...new Set([...(config.allowExternal || []), ...allowExternal])],
    ...(config.runtime ? { runtime: config.runtime.trim() } : {}),
    ...(Object.keys(device).length ? { device } : {}),
  };
}
