// 分层边界：能被浏览器加载的代码（lib/ 里除 lib/node/ 外、host/、scenarios/）
// 不许依赖 Node——内置模块、Node 全局（Buffer/process）、或 lib/node/ 里的任何东西。
// 否则宿主页面某天加载到它们才报错，而单测（跑在 Node 里）永远发现不了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const NODE_ONLY_DIR = join(ROOT, 'lib', 'node');

async function listSources(dir, skip = () => false) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(path)) continue;
    if (entry.isDirectory()) files.push(...await listSources(path, skip));
    else if (/\.(mjs|js)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** 返回这段浏览器侧代码里所有越界依赖的描述；空数组 = 干净。 */
function boundaryViolations(source) {
  const code = stripComments(source);
  const found = [];
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('node:')) found.push(`Node 内置模块 ${spec}`);
    else if (/(^|\/)node\//.test(spec)) found.push(`lib/node/ 里的模块 ${spec}`);
  }
  if (/\bBuffer\b/.test(code)) found.push('Node 全局 Buffer');
  if (/\bprocess\.(?:env|argv|exit|cwd|platform|stdout|stderr|on)\b/.test(code)) found.push('Node 全局 process');
  return found;
}

test('边界检查器本身：能认出越界写法，也不误伤注释与普通代码', () => {
  assert.deepEqual(boundaryViolations("import { readFile } from 'node:fs/promises';"), ['Node 内置模块 node:fs/promises']);
  assert.deepEqual(boundaryViolations("import { x } from './node/serve.mjs';"), ['lib/node/ 里的模块 ./node/serve.mjs']);
  assert.deepEqual(boundaryViolations("import { x } from '/host/lib/node/serve.mjs';"), ['lib/node/ 里的模块 /host/lib/node/serve.mjs']);
  assert.deepEqual(boundaryViolations('const b = Buffer.from(x);'), ['Node 全局 Buffer']);
  assert.deepEqual(boundaryViolations('const e = process.env.HOME;'), ['Node 全局 process']);
  assert.deepEqual(boundaryViolations("// 见 process.env 与 node:fs\n/* Buffer */\nimport { a } from './a.mjs';"), []);
  assert.deepEqual(boundaryViolations("const url = 'http://x/node/y'; import('./caps/net.mjs');"), []);
});

test('浏览器侧代码（lib/ 除 lib/node/、host/、scenarios/）不依赖 Node', async () => {
  const files = [
    ...await listSources(join(ROOT, 'lib'), (path) => path === NODE_ONLY_DIR),
    ...await listSources(join(ROOT, 'host')),
    ...await listSources(join(ROOT, 'scenarios')),
  ];
  assert.ok(files.length > 20, `扫描到的文件太少（${files.length}），目录结构变了？`);
  const offenders = [];
  for (const file of files) {
    for (const why of boundaryViolations(await readFile(file, 'utf8'))) offenders.push(`${relative(ROOT, file)}: ${why}`);
  }
  assert.deepEqual(offenders, []);
});
