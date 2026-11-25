// 同一用户的所有 InkLab 工作台和 CLI 共享。锁跟调试会话走，USB / Wi-Fi 用同一个硬件序列号。
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const defaultRoot = join(homedir(), '.cache', 'inklab', 'device-locks');
const lockPath = (root, device) => join(root, createHash('sha256').update(device).digest('hex'));

// 崩溃的进程号可能已经被系统重用。在 macOS / Linux 上也核对进程的启动时间。
function processStart(pid) {
  if (process.platform === 'win32') return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function removeEmpty(directory) {
  try { rmdirSync(directory); } catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
}

// 只删这一次占用独有的标记。即使另外一个进程已经接手，rmdir 也移不走它的非空目录。
function removeOwner(directory, marker) {
  try { unlinkSync(join(directory, marker)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  removeEmpty(directory);
}

export function deviceLockOwner(device, root = defaultRoot) {
  const directory = lockPath(root, device);
  try {
    const [marker] = readdirSync(directory);
    if (!marker) { removeEmpty(directory); return null; }
    const { started, ...owner } = JSON.parse(readFileSync(join(directory, marker), 'utf8'));
    try { process.kill(owner.pid, 0); }
    catch (err) {
      if (err.code === 'ESRCH') { removeOwner(directory, marker); return null; }
      if (err.code !== 'EPERM') throw err;
    }
    const currentStart = started && processStart(owner.pid);
    if (currentStart && currentStart !== started) { removeOwner(directory, marker); return null; }
    return owner;
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export function acquireDeviceLock(device, { project, agentId }, root = defaultRoot) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = lockPath(root, device);
  const staging = mkdtempSync(join(root, '.claim-'));
  const marker = randomUUID();
  const owner = { project, agentId, pid: process.pid };
  try {
    writeFileSync(join(staging, marker), JSON.stringify({ ...owner, started: processStart(owner.pid) }), { mode: 0o600 });
    // 发布完整的非空目录是原子操作：同时申请只会成功一个，崩溃也不会留下半写的 owner。
    for (;;) {
      try { renameSync(staging, directory); break; }
      catch (err) {
        const occupied = ['ENOTEMPTY', 'EEXIST'].includes(err.code) || (err.code === 'EPERM' && existsSync(directory));
        if (!occupied) throw err;
        const other = deviceLockOwner(device, root);
        if (other) {
          const label = other.agentId ? `${other.agentId}（${other.project}）` : other.project;
          throw Object.assign(new Error(`真机正由 ${label} 调试。请先在占用它的工作台释放真机，或等命令结束。`), { statusCode: 409 });
        }
      }
    }
    return { device, owner, release: () => removeOwner(directory, marker) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
