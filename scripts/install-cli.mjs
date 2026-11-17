#!/usr/bin/env node
// 把 package.json 里 bin 声明的命令软链到 ~/.local/bin（可用 --bin-dir 或环境变量 AIUI_BIN_DIR 改位置）。
//
// 为什么不用 npm link：npm link 把命令装在当前 Node 版本的全局目录里，用 fnm / nvm 切换 Node 版本后
// 命令就不见了。软链放在固定目录，跟 Node 版本无关；链接指向本仓库的 bin/，git pull 之后就是新版。
//
//   npm run install-cli                 安装（已存在且指向本仓库的链接会跳过）
//   npm run install-cli -- --uninstall  卸载本仓库装的链接（不动别人的文件）
//   npm run install-cli -- --bin-dir DIR
//
// 同一份脚本也在 aiui-toolkit/scripts/install-cli.mjs，改一处请同步另一处。
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function linkTarget(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) return { kind: 'file' };
    return { kind: 'link', target: resolve(dirname(path), await readlink(path)) };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
}

export async function installCli({ root = ROOT, binDir, uninstall = false, env = process.env, log = console.log } = {}) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const dir = resolve(binDir || env.AIUI_BIN_DIR || join(homedir(), '.local', 'bin'));
  const results = [];
  if (!uninstall) await mkdir(dir, { recursive: true });
  for (const [name, rel] of Object.entries(pkg.bin || {})) {
    const target = resolve(root, rel);
    const link = join(dir, name);
    const current = await linkTarget(link);
    if (uninstall) {
      if (current.kind === 'link' && current.target === target) { await rm(link); results.push({ name, action: 'removed' }); }
      else results.push({ name, action: 'skipped' });
      continue;
    }
    if (current.kind === 'file') throw new Error(`${link} 已存在且不是软链，不覆盖。请先手动移走它。`);
    if (current.kind === 'link' && current.target === target) { results.push({ name, action: 'unchanged' }); continue; }
    if (current.kind === 'link') await rm(link);
    await chmod(target, 0o755);
    await symlink(target, link);
    results.push({ name, action: current.kind === 'link' ? 'relinked' : 'linked', from: current.target });
  }
  const onPath = (env.PATH || '').split(delimiter).map(p => resolve(p)).includes(dir);
  for (const r of results) log(`${r.action.padEnd(9)} ${join(dir, r.name)}${r.from ? `（原来指向 ${r.from}）` : ''}`);
  if (!uninstall && !onPath) log(`注意：${dir} 不在 PATH 里。把 export PATH="${dir}:$PATH" 加进 shell 配置后重开终端。`);
  return { dir, onPath, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--bin-dir');
  installCli({ uninstall: argv.includes('--uninstall'), binDir: at >= 0 ? argv[at + 1] : undefined })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
