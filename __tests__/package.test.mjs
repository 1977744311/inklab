// 发布包的内容：只带宿主与夹具。
// 引擎二进制与 runtimes.lock.json 清单是本机状态、本机 LLM 配置是私人的、e2e 跑测产物是可再生的——
// 它们都不许混进包里。npm 的 `files` 白名单优先于 .gitignore，所以光靠 .gitignore 挡不住，得实测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('npm pack 只带该带的：跑过 e2e 的残留、引擎二进制、本机配置都进不了包', async (t) => {
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) { t.skip('找不到 npm，跳过打包检查'); return; }

  const scratch = await mkdtemp(join(tmpdir(), 'inklab-pack-'));
  try {
    // 在副本里打包：既不碰真实工作区，又能随手造「跑过 e2e 的现场」。
    await cp(ROOT, scratch, {
      recursive: true,
      filter: (src) => !/(^|[\\/])(node_modules|\.git|\.runs|\.engine)([\\/]|$)/.test(src.slice(ROOT.length)),
    });
    const reportDir = join(scratch, 'fixtures', 'cap-probe-app', 'e2e', 'report', 'smoke');
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, 'shot.png'), 'png');
    await writeFile(join(scratch, 'fixtures', 'cap-probe-app', 'e2e', 'report', 'last-run.json'), '{}');
    await writeFile(join(scratch, 'ink-glue.js'), '// engine glue');
    await writeFile(join(scratch, 'engine.wasm'), 'wasm');
    await mkdir(join(scratch, '.engine', 'runtimes', 'craft'), { recursive: true });
    await writeFile(join(scratch, '.engine', 'runtimes', 'craft', 'notes.txt'), 'cached engine dir');
    await writeFile(join(scratch, 'runtimes.lock.json'), '[]');
    await writeFile(join(scratch, 'llm.local.json'), '{"apiKey":"secret"}');

    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: scratch, encoding: 'utf8' });
    assert.equal(pack.status, 0, pack.stderr);
    const paths = JSON.parse(pack.stdout)[0].files.map((f) => f.path.split(sep).join('/'));

    for (const bad of [
      /(^|\/)e2e\/report\//, /\.wasm$/, /(^|\/)ink-glue\.js$/, /(^|\/)llm\.local\.json$/, /(^|\/)node_modules\//, /(^|\/)\.runs\//,
      /(^|\/)\.engine\//, /(^|\/)runtimes\.lock\.json$/,
    ]) {
      assert.deepEqual(paths.filter((p) => bad.test(p)), [], `不该进包：${bad}`);
    }

    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const mustHave = [
      'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'docs/guide.md', 'docs/device.md', 'docs/runtime-notes.md',
      'host/index.html', 'lib/node/serve.mjs',
      'fixtures/minimal.aix', 'fixtures/cap-probe-app/app.json', 'scenarios/index.mjs',
      ...Object.values(pkg.bin).map((p) => p.replace(/^\.\//, '')),
    ];
    for (const want of mustHave) assert.ok(paths.includes(want), `包里缺 ${want}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
