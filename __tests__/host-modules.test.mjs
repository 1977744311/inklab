// 宿主模块图：host/inklab/ 下的每个文件都必须能从入口 host/inklab.js 经静态 import 到达，
// 且彼此之间不许成环。
// 前者防「只靠副作用生效的模块（键盘监听、console 接管）没人 import，于是静默失效」，
// 单测跑在 Node 里碰不到页面，这类缺失只会在浏览器里表现为「某个功能悄悄没了」；
// 后者保证模块求值顺序可推理（帧调度必须先于引擎 glue 装好，见 host/inklab.js 头注）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const HOST_DIR = join(ROOT, 'host');
const MODULE_DIR = join(HOST_DIR, 'inklab');
const ENTRY = join(HOST_DIR, 'inklab.js');

/** 一段源码里的静态 import 说明符（具名、多行、裸 import 都算），只留以 /host/ 开头的。 */
function hostImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"](\/host\/[^'"]+)['"]/gm)].map((m) => m[1]);
}

/** 入口出发能走到的全部宿主模块 → 它们各自 import 的宿主模块（只看 inklab.js 与 inklab/*.js）。 */
async function moduleGraph() {
  const graph = new Map();
  const visit = async (file) => {
    if (graph.has(file)) return;
    const deps = hostImports(await readFile(file, 'utf8'))
      .map((spec) => join(ROOT, spec))
      .filter((path) => path === ENTRY || path.startsWith(`${MODULE_DIR}/`));
    graph.set(file, deps);
    for (const dep of deps) await visit(dep);
  };
  await visit(ENTRY);
  return graph;
}

test('import 解析器：认得具名、多行、裸 import，且不被注释迷惑', () => {
  const source = [
    "import { a } from '/host/inklab/a.js';",
    "import {\n  b, c,\n} from '/host/inklab/b.js';",
    "import '/host/inklab/side-effect.js';",
    "import { lib } from '/host/lib/x.mjs';",
    "import { n } from 'node:fs';",
    "// import { z } from '/host/inklab/commented.js';",
    "/* import '/host/inklab/block-commented.js'; */",
  ].join('\n');
  assert.deepEqual(hostImports(source), [
    '/host/inklab/a.js', '/host/inklab/b.js', '/host/inklab/side-effect.js', '/host/lib/x.mjs',
  ]);
});

test('host/inklab/ 下的每个模块都能从入口 import 到', async () => {
  const reachable = new Set((await moduleGraph()).keys());
  const all = (await readdir(MODULE_DIR)).filter((name) => name.endsWith('.js')).map((name) => join(MODULE_DIR, name));
  assert.ok(all.length >= 10, `扫描到的模块太少（${all.length}），目录结构变了？`);
  const orphans = all.filter((file) => !reachable.has(file)).map((file) => relative(ROOT, file));
  assert.deepEqual(orphans, [], '这些模块没人 import：只靠副作用生效的会静默失效');
});

test('host/inklab/ 模块之间没有循环依赖', async () => {
  const graph = await moduleGraph();
  const state = new Map(); // 1 = 在栈上，2 = 已走完
  const stack = [];
  const visit = (file) => {
    state.set(file, 1);
    stack.push(file);
    for (const dep of graph.get(file) || []) {
      if (state.get(dep) === 1) {
        assert.fail(`循环依赖：${[...stack.slice(stack.indexOf(dep)), dep].map((f) => relative(ROOT, f)).join(' → ')}`);
      }
      if (!state.get(dep)) visit(dep);
    }
    stack.pop();
    state.set(file, 2);
  };
  visit(ENTRY);
});
