import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  return { allowExternal: [...new Set([...(config.allowExternal || []), ...allowExternal])] };
}
