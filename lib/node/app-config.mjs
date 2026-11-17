import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 应用目录里的 inklab.config.json（只给 InkLab 用，不进发布包）：
//   allowExternal  允许真实外呼的地址模式
//   runtime        这个项目默认跑哪个引擎：通道名（latest / daily / studio）或具体 lane id。
//                  命令行 --runtime、URL ?runtimes=、环境变量 INKLAB_RUNTIME 都比它优先。
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
  return {
    allowExternal: [...new Set([...(config.allowExternal || []), ...allowExternal])],
    ...(config.runtime ? { runtime: config.runtime.trim() } : {}),
  };
}
