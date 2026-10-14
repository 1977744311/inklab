import { readFile } from 'node:fs/promises';

/**
 * 读 runtimes.lock.json。文件不存在是正常状态（全新 clone 还没跑过 npm run engine），按空清单返回；
 * 存在但不是合法 JSON 要明说，别让手写时漏的一个逗号变成“没有运行时”。
 */
export async function readRuntimeLock(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是合法的 JSON：${error.message}`, { cause: error });
  }
}
