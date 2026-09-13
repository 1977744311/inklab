// project-source.mjs — 把源码目录与发布态 .aix 统一成同一个只读工程源。
//
// 关键纪律：目录按 InkLab/.aixignore 口径筛选；.aix 已经是发布真相，包里有什么就原样跑什么，
// 不在装载时二次排除。每次 refresh() 生成一个一致快照，manifest、文件读取和身份哈希都来自它。

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import { readAix, toBundleFiles, versionOf } from './aix.mjs';
import { buildManifest, isTextPath } from './bundle.mjs';

const inflate = promisify(inflateRaw);
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const slash = (p) => String(p).split(sep).join('/');

export function normalizeProjectPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) return null;
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await visit(abs);
      else if (entry.isFile()) out.push(slash(relative(root, abs)));
    }
  }
  await visit(root);
  return out.sort();
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(String(value));
}

function snapshotHash(files) {
  const h = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    h.update(path); h.update('\0'); h.update(bytesOf(files[path])); h.update('\0');
  }
  return h.digest('hex');
}

async function directorySnapshot(root) {
  const allPaths = await walk(root);
  const manifest = buildManifest(allPaths);
  const files = {};
  for (const path of manifest) {
    const bytes = new Uint8Array(await readFile(join(root, path)));
    files[path] = isTextPath(path) ? new TextDecoder('utf-8').decode(bytes) : bytes;
  }
  return {
    paths: allPaths,
    manifest,
    files,
    identity: {
      type: 'directory', path: root, name: basename(root), version: null,
      bytes: Object.values(files).reduce((n, v) => n + bytesOf(v).byteLength, 0),
      sha256: snapshotHash(files), md5: null,
    },
  };
}

async function aixSnapshot(path) {
  const packageBytes = new Uint8Array(await readFile(path));
  const raw = await readAix(packageBytes, async (chunk) => new Uint8Array(await inflate(chunk)));
  const normalized = {};
  for (const [entry, bytes] of Object.entries(raw)) {
    const clean = normalizeProjectPath(entry);
    if (!clean) throw new Error(`.aix 含不安全路径：${entry}`);
    if (normalized[clean]) throw new Error(`.aix 含重复路径：${clean}`);
    normalized[clean] = bytes;
  }
  const files = toBundleFiles(normalized, isTextPath);
  const manifest = Object.keys(files).sort();
  return {
    paths: manifest,
    manifest,
    files,
    identity: {
      type: 'aix', path, name: basename(path), version: versionOf(normalized),
      bytes: packageBytes.byteLength,
      sha256: digest('sha256', packageBytes), md5: digest('md5', packageBytes),
    },
  };
}

/**
 * @returns 一个有 refresh/read/describe 的只读源。read() 永远读当前快照，避免 manifest 与文件跨版本。
 */
export async function createProjectSource(input, { cwd = process.cwd() } = {}) {
  if (!input) throw new Error('需要 AIUI 源码目录或 .aix 文件');
  const path = resolve(cwd, input);
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`工程输入不存在：${path}`);
  const type = info.isDirectory() ? 'directory'
    : (info.isFile() && extname(path).toLowerCase() === '.aix' ? 'aix' : null);
  if (!type) throw new Error(`工程输入必须是目录或 .aix 文件：${path}`);

  let current = null;
  const source = {
    path, type,
    watchPath: path,
    watchRecursive: type === 'directory',
    async refresh() {
      current = type === 'directory' ? await directorySnapshot(path) : await aixSnapshot(path);
      return current;
    },
    snapshot() {
      if (!current) throw new Error('工程源尚未 refresh');
      return current;
    },
    async read(relPath) {
      if (!current) throw new Error('工程源尚未 refresh');
      const clean = normalizeProjectPath(relPath);
      if (!clean) return null;
      if (clean in current.files) return current.files[clean];
      // 源码目录的 e2e 场景/录像/基线不进 bundle 快照，但仍要能经 /app 与
      // /project-scenarios 读取；先用 paths 白名单封住目录穿越，再按需读盘。
      if (type === 'directory' && current.paths.includes(clean)) {
        const bytes = new Uint8Array(await readFile(join(path, clean)));
        return isTextPath(clean) ? new TextDecoder('utf-8').decode(bytes) : bytes;
      }
      return null;
    },
    describe() {
      if (!current) throw new Error('工程源尚未 refresh');
      return { ...current.identity };
    },
  };
  await source.refresh();
  return source;
}

export function diffProjectSnapshots(left, right) {
  const a = left?.files || {};
  const b = right?.files || {};
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const added = [], removed = [], changed = [], same = [];
  for (const path of paths) {
    if (!(path in a)) added.push(path);
    else if (!(path in b)) removed.push(path);
    else if (digest('sha256', bytesOf(a[path])) !== digest('sha256', bytesOf(b[path]))) changed.push(path);
    else same.push(path);
  }
  return { added, removed, changed, same: same.length, equal: !added.length && !removed.length && !changed.length };
}
