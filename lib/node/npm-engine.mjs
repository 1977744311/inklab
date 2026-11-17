// npm-engine.mjs — 从 npm 上的 @yodaos-pkg/ink 取 Ink 引擎（官方发布渠道，Apache-2.0）。
//
// 官方把引擎按 dist-tag 发布：latest 是正式版，daily 是每日构建。Craft / Studio 网页里嵌的构建都比它旧，
// 所以这是「最新的能拉到的引擎」的来源。只跟踪 NPM_TAGS 里的标签；标签指向的版本还没有 lane，
// 就取回 tarball、校验 integrity、解包，追加成 npm-ink-<版本> 这条新 lane。
//
// npm 包和网站上的构建不一样：index.js 还要 import 同包里的 ./pkg/ink_web.js、./env.js，
// 所以整个包都解进缓存目录，再按 InkLab 的约定复制出 ink-glue.js（= index.js）与 engine.wasm。
//
// 前半是纯函数（解包、校验、生成 lane 条目），便于直接测试；只有 findNpmBuilds 碰网络。

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { download } from './download.mjs';
import { extractEngineVersion } from './engine-version.mjs';

export const NPM_PACKAGE = '@yodaos-pkg/ink';
// latest 在前：清单还是空的时候，第一条正式版就是默认 lane。
export const NPM_TAGS = ['latest', 'daily'];
const WASM_PATH = 'pkg/ink_web_bg.wasm';

/** registry 地址：INKLAB_NPM_REGISTRY 优先（用镜像时设它），否则 npm 官方源。 */
export function npmRegistry(env = process.env) {
  return String(env.INKLAB_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

export const npmLaneId = (version) => `npm-ink-${version}`.toLowerCase();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 校验 npm 的 integrity 串（sha512-<base64>，也认 sha256/sha384）。不符就抛。 */
export function verifyIntegrity(bytes, integrity) {
  const m = /^(sha256|sha384|sha512)-(.+)$/.exec(String(integrity || '').trim());
  if (!m) throw new Error(`无法识别的 integrity：${integrity || '(空)'}`);
  const got = createHash(m[1]).update(bytes).digest('base64');
  if (got !== m[2]) throw new Error(`tarball 的 ${m[1]} 与 registry 声明的不符`);
}

/** pax 扩展头（typeflag x）里的 path=…；其余字段用不到。 */
function paxPath(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  for (const line of text.split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * 解开 npm tarball（gzip + ustar），返回 Map<包内路径, Uint8Array>，去掉顶层的 package/。
 * 只收普通文件；绝对路径与 .. 一律拒绝，免得一个坏包写到缓存目录外面。
 */
export function extractTarball(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return Buffer.from(end < 0 ? raw : raw.subarray(0, end)).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') { longName = paxPath(body); continue; }
    if (type === 'L') { longName = Buffer.from(body).toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue;
    const name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type !== '0' && type !== '\0') continue;

    const path = name.replace(/^package\//, '');
    const clean = normalize(path).split(sep).join('/');
    if (!path || path.startsWith('/') || clean.startsWith('../') || clean === '..') {
      throw new Error(`tarball 里有不安全的路径：${name}`);
    }
    files.set(clean, new Uint8Array(body));
  }
  if (!files.size) throw new Error('tarball 是空的');
  return files;
}

/** 包内的 glue 入口：package.json 的 main（缺省 index.js）。 */
export function glueEntryOf(files) {
  try {
    const pkg = JSON.parse(Buffer.from(files.get('package.json')).toString('utf8'));
    return String(pkg.main || 'index.js').replace(/^\.\//, '');
  } catch {
    return 'index.js';
  }
}

/**
 * 解开后的包 → lane 条目。engineBuild 写 npm 版本（基线指纹与界面都显示它），
 * engineVersion 写 wasm 自己报的版本（读不出就用 npm 版本去掉预发布后缀）。
 */
export function npmLaneEntry({ version, meta, files, registry, fetchedAt }) {
  const glueName = glueEntryOf(files);
  const glue = files.get(glueName);
  const wasm = files.get(WASM_PATH);
  if (!glue) throw new Error(`${NPM_PACKAGE}@${version} 里没有 ${glueName}`);
  if (!wasm) throw new Error(`${NPM_PACKAGE}@${version} 里没有 ${WASM_PATH}`);
  const id = npmLaneId(version);
  const read = extractEngineVersion(wasm);
  const prerelease = version.includes('-');
  return {
    id,
    label: `Ink ${version}`,
    channel: prerelease ? 'daily' : 'stable',
    cacheDir: `runtimes/${id}`,
    source: `${registry}/${NPM_PACKAGE}`,
    fetchedAt,
    engineVersion: read.version || version.split('-')[0],
    engineBuild: version,
    tarballUrl: meta.dist.tarball,
    tarballIntegrity: meta.dist.integrity,
    glueUrl: null,
    glueSha256: sha256(glue),
    wasmUrl: null,
    wasmSha256: sha256(wasm),
  };
}

/**
 * 把解开的包写进 lane 的缓存目录，并复制出 ink-glue.js / engine.wasm。
 * 先写到旁边的临时目录再整体改名：中途被打断不会留下半个 lane。
 */
export async function writeNpmLane(root, files) {
  const tmp = `${root}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  for (const [path, bytes] of files) {
    const target = join(tmp, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(tmp, 'ink-glue.js'), files.get(glueEntryOf(files)));
  await writeFile(join(tmp, 'engine.wasm'), files.get(WASM_PATH));
  await rm(root, { recursive: true, force: true });
  await mkdir(dirname(root), { recursive: true });
  await rename(tmp, root);
}

/** 下载一个版本的 tarball、校验 integrity 并解包。 */
export async function fetchNpmPackage(meta, downloadOptions = {}) {
  const tgz = await download(meta.dist.tarball, downloadOptions);
  verifyIntegrity(tgz, meta.dist.integrity);
  return extractTarball(tgz);
}

async function getJson(url, downloadOptions) {
  return JSON.parse(new TextDecoder().decode(await download(url, downloadOptions)));
}

/**
 * 看 npm 上 NPM_TAGS 指向哪些版本，哪些还没有 lane（按 lane id npm-ink-<版本> 认）。
 * 没有的才取回 tarball，连同解开的文件一起返回；本函数不写任何文件。
 * @returns {Promise<{tags: Record<string,string>, fresh: Array<{tag, version, entry, files}>}>}
 */
export async function findNpmBuilds(rows, {
  env = process.env, tags = NPM_TAGS, downloadOptions = {}, packageOptions = downloadOptions, log = () => {},
} = {}) {
  const registry = npmRegistry(env);
  const distTags = await getJson(`${registry}/-/package/${NPM_PACKAGE}/dist-tags`, downloadOptions);
  const known = new Set(rows.map((row) => row.id));
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const fresh = [];
  const seen = new Set();
  for (const tag of tags) {
    const version = distTags[tag];
    if (!version || seen.has(version)) continue;
    seen.add(version);
    const id = npmLaneId(version);
    if (known.has(id)) { log(`  ✓ ${NPM_PACKAGE}@${tag} = ${version}  已收录为 ${id}`); continue; }
    log(`  ✗ ${NPM_PACKAGE}@${tag} = ${version}  还没有 lane，下载中`);
    const meta = await getJson(`${registry}/${NPM_PACKAGE}/${encodeURIComponent(version)}`, downloadOptions);
    const files = await fetchNpmPackage(meta, packageOptions);
    fresh.push({ tag, version, entry: npmLaneEntry({ version, meta, files, registry, fetchedAt }), files });
  }
  return { tags: distTags, fresh };
}
