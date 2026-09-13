import test from 'node:test';
import assert from 'node:assert/strict';

import { projectFileUrl, readProjectFile } from '../lib/project-file.mjs';

test('工程 fixture 路径固定读 /app/ 且逐段编码', () => {
  assert.equal(projectFileUrl('assets/pose frame.png'), '/app/assets/pose%20frame.png');
  assert.throws(() => projectFileUrl('../secret'), /\u975e\u6cd5/);
  assert.throws(() => projectFileUrl(''), /\u975e\u6cd5/);
});

test('项目图片读取成功返回字节，404 不得伪装成图片', async () => {
  const calls = [];
  const bytes = await readProjectFile('assets/squat.png', async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    };
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.deepEqual(calls, [{ url: '/app/assets/squat.png', init: { cache: 'no-store' } }]);

  await assert.rejects(
    readProjectFile('missing.png', async () => ({ ok: false, status: 404 })),
    /HTTP 404/,
  );
});
