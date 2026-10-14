// 本机状态——引擎缓存目录与 runtimes.lock.json 清单：放在哪、怎么读、git 怎么躲开它。
// 每个人取到的引擎、选用的引擎都不一样，所以这两样都不入库；
// 一旦 .gitignore 漏了一行，一次 git add -A 就会把 Rokid 的二进制和个人清单提交进仓库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engineCacheDirectory } from '../lib/node/cache-path.mjs';
import { readRuntimeLock } from '../lib/node/runtime-lock-file.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('引擎缓存目录默认是项目根的 .engine/，不受 XDG_CACHE_HOME 影响；INKLAB_ENGINE_DIR 可以改到别处', () => {
  assert.equal(engineCacheDirectory({}), join(ROOT, '.engine'));
  assert.equal(engineCacheDirectory({ XDG_CACHE_HOME: '/somewhere/cache' }), join(ROOT, '.engine'));
  assert.equal(engineCacheDirectory({ INKLAB_ENGINE_DIR: '/somewhere/else' }), '/somewhere/else');
  assert.equal(engineCacheDirectory({ INKLAB_ENGINE_DIR: 'relative/dir' }), resolve('relative/dir'), '相对路径按 cwd 解析');
});

test('.gitignore 同时挡住清单与引擎缓存', async () => {
  const lines = (await readFile(join(ROOT, '.gitignore'), 'utf8')).split('\n').map((line) => line.trim());
  assert.ok(lines.includes('/.engine/'), '漏了 /.engine/：引擎二进制会被 git add -A 带进仓库');
  assert.ok(lines.includes('/runtimes.lock.json'), '漏了 /runtimes.lock.json：个人清单会被提交');
});

test('readRuntimeLock：文件不存在按空清单返回；合法 JSON 原样返回；坏 JSON 指名文件和原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-lock-file-'));
  try {
    const path = join(dir, 'runtimes.lock.json');
    assert.deepEqual(await readRuntimeLock(path), []);

    await writeFile(path, '[{"id":"a"}]');
    assert.deepEqual(await readRuntimeLock(path), [{ id: 'a' }]);

    await writeFile(path, '[{"id":"a"},]');
    await assert.rejects(readRuntimeLock(path), (error) => error.message.includes(path) && /不是合法的 JSON/.test(error.message));

    // 不是“文件不存在”的读取错误（这里：路径是个目录）不能被当成“没有清单”吞掉
    await assert.rejects(readRuntimeLock(dir), /EISDIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
