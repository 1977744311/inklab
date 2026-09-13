import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Runtime binaries are a local cache, separate from the distributable host source.
export function engineCacheDirectory(env = process.env, home = homedir()) {
  return resolve(env.INKLAB_ENGINE_DIR || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'inklab', 'engines'));
}
