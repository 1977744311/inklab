import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 引擎二进制是本机状态：默认放在项目根的 .engine/（已 git 忽略），不随源码分发；INKLAB_ENGINE_DIR 可改到别处。
export function engineCacheDirectory(env = process.env) {
  return resolve(env.INKLAB_ENGINE_DIR || join(ROOT, '.engine'));
}
