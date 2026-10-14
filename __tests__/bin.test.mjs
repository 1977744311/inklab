// bin/ 下的命令行入口：只验证接线（import 链路能解析、缺参数时给用法与退出码、路径口径），
// 不碰网络与浏览器。入口是薄壳，搬目录最容易在这里断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../', import.meta.url).pathname;
const run = (name, args = [], { repo = REPO, ...options } = {}) => spawnSync(
  process.execPath, [join(repo, 'bin', name), ...args], { encoding: 'utf8', timeout: 30_000, ...options });

const lane = (id) => ({ id, engineVersion: '9.9.9', glueSha256: 'a'.repeat(64), wasmSha256: 'b'.repeat(64) });

/**
 * 复制出一份「全新 clone」：只有源码，清单和缓存都得自己摆。
 * 入口读的是自己所在仓库的 runtimes.lock.json——那是每个人的本机清单，测试不能依赖它。
 */
function cloneRepo(lanes) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'inklab-bin-repo-')));
  for (const sub of ['bin', 'lib', 'host', 'scenarios']) cpSync(join(REPO, sub), join(dir, sub), { recursive: true });
  if (lanes) writeFileSync(join(dir, 'runtimes.lock.json'), JSON.stringify(lanes));
  return dir;
}

test('各命令入口都能装载，缺参数时给出用法与非零退出码', () => {
  for (const [name, code, hint] of [
    ['inklab.mjs', 1, '用法'],
    ['inklab-e2e.mjs', 2, '用法'],
    ['inklab-matrix.mjs', 1, '用法'],
    ['inklab-device.mjs', 1, 'Usage'],
  ]) {
    const r = run(name);
    assert.equal(r.status, code, `${name}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(hint), name);
  }
});

test('inklab-engine --check 在空缓存目录下报「缺文件」且不发网络请求', () => {
  const repo = cloneRepo([lane('probe')]);
  const cache = realpathSync(mkdtempSync(join(tmpdir(), 'inklab-bin-cache-')));
  try {
    const r = run('inklab-engine.mjs', ['--check'], { repo, env: { ...process.env, INKLAB_ENGINE_DIR: cache } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /缺 ink-glue\.js/);
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('全新 clone 没有清单：engine / start / matrix 都说怎么生成它，而不是一句“没有运行时”', () => {
  const repo = cloneRepo(null);
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'inklab-bin-app-')));
  writeFileSync(join(app, 'app.json'), JSON.stringify({ appId: 'bin-fresh' }));
  try {
    for (const [name, args] of [
      ['inklab-engine.mjs', ['--check']],
      ['inklab.mjs', [app, '--port', '0']],
      ['inklab-matrix.mjs', [app]],
    ]) {
      const r = run(name, args, { repo });
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /runtimes\.lock\.json 里还没有运行时：联网后运行 npm run engine/, name);
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('matrix 的相对输入路径跟随调用者 cwd，而不是仓库的上级目录', () => {
  const repo = cloneRepo([lane('probe')]);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'inklab-bin-cwd-')));
  try {
    const r = run('inklab-matrix.mjs',
      ['no-such-app', '--runtime', 'probe', '--scenario', 'smoke', '--out', join(cwd, 'out')], { repo, cwd });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok((r.stdout + r.stderr).includes(join(cwd, 'no-such-app')), r.stdout + r.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
