// download.mjs：停滞超时、重试策略与进度文本。全部用本地 node:http 服务模拟各种失败，不碰外网。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

import { download, formatProgress } from '../lib/node/download.mjs';

const MODULE_URL = new URL('../lib/node/download.mjs', import.meta.url).href;
const BODY = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));

// ── 服务端行为：按请求次序依次生效，用完后一直沿用最后一个 ────────────────────
const ok = (_req, res) => { res.writeHead(200, { 'content-length': String(BODY.length) }); res.end(BODY); };
const status = (code) => (_req, res) => { res.writeHead(code); res.end('x'); };
const silent = () => {}; // 连响应头都不给
const truncated = (_req, res) => { // 声明了完整长度，发一半就把连接掐断
  res.writeHead(200, { 'content-length': String(BODY.length) });
  res.write(BODY.subarray(0, 50_000));
  setTimeout(() => res.socket.destroy(), 30);
};
const stallAfterHeaders = (_req, res) => { // 发出响应头和一小段，然后不再发
  res.writeHead(200, { 'content-length': String(BODY.length) });
  res.write(BODY.subarray(0, 1000));
};
const trickle = (parts, gapMs) => (_req, res) => { // 慢但一直在发
  const size = Math.ceil(BODY.length / parts);
  res.writeHead(200, { 'content-length': String(BODY.length) });
  let sent = 0;
  const timer = setInterval(() => {
    res.write(BODY.subarray(sent * size, (sent + 1) * size));
    sent += 1;
    if (sent >= parts) { clearInterval(timer); res.end(); }
  }, gapMs);
  res.on('close', () => clearInterval(timer));
};

async function withServer(handlers, run) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const n = hits.push(req.url) - 1;
    handlers[Math.min(n, handlers.length - 1)](req, res);
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    return await run({ url: `http://127.0.0.1:${server.address().port}/engine.wasm`, hits });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
}

const same = (bytes) => Buffer.from(bytes).equals(BODY);

// ── 下载 ────────────────────────────────────────────────────────────────────

test('正常下载返回完整字节，进度逐块上报，总量取自 content-length', async () => {
  await withServer([ok], async ({ url, hits }) => {
    const events = [];
    const bytes = await download(url, { onProgress: (p) => events.push(p) });
    assert.ok(same(bytes));
    assert.equal(hits.length, 1);
    assert.ok(events.length >= 1);
    const last = events.at(-1);
    assert.deepEqual(last, { received: BODY.length, total: BODY.length });
    for (let i = 1; i < events.length; i += 1) assert.ok(events[i].received >= events[i - 1].received);
  });
});

test('带 content-encoding 的响应不上报总量：content-length 是压缩后的大小，和解压后的字节不能比', async () => {
  const packed = gzipSync(BODY);
  const gzipped = (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(packed.length) });
    res.end(packed);
  };
  await withServer([gzipped], async ({ url }) => {
    const events = [];
    const bytes = await download(url, { onProgress: (p) => events.push(p) });
    assert.ok(same(bytes), '应当拿到解压后的原文');
    assert.ok(events.length >= 1);
    assert.ok(events.every((p) => p.total === null), JSON.stringify(events));
  });
});

test('服务器声明了长度却中途断开：重试后拿到完整内容', async () => {
  await withServer([truncated, ok], async ({ url, hits }) => {
    const retries = [];
    const bytes = await download(url, { backoffMs: 1, onRetry: (r) => retries.push(r) });
    assert.ok(same(bytes));
    assert.equal(hits.length, 2);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].retries, 3);
    assert.match(retries[0].reason, /terminated/);
  });
});

test('响应头迟迟不来：判为停滞并重试', async () => {
  await withServer([silent, ok], async ({ url, hits }) => {
    const retries = [];
    const bytes = await download(url, { stallMs: 300, backoffMs: 1, onRetry: (r) => retries.push(r) });
    assert.ok(same(bytes));
    assert.equal(hits.length, 2);
    assert.match(retries[0].reason, /0\.3 秒没有收到数据/);
  });
});

test('响应体发了一半就不再发：判为停滞并重试', async () => {
  await withServer([stallAfterHeaders, ok], async ({ url, hits }) => {
    const retries = [];
    const bytes = await download(url, { stallMs: 300, backoffMs: 1, onRetry: (r) => retries.push(r) });
    assert.ok(same(bytes));
    assert.equal(hits.length, 2);
    assert.match(retries[0].reason, /没有收到数据/);
  });
});

test('停滞按空闲时间算：只要字节还在进来，总耗时超过停滞时限也不算停滞', async () => {
  // 12 块 × 60ms ≈ 720ms 总耗时，大于 400ms 的停滞时限；每次间隔只有 60ms。
  await withServer([trickle(12, 60)], async ({ url, hits }) => {
    const retries = [];
    const startedAt = Date.now();
    const bytes = await download(url, { stallMs: 400, onRetry: (r) => retries.push(r) });
    assert.ok(Date.now() - startedAt > 400, '前提：总耗时必须超过停滞时限，否则这条测不出区别');
    assert.ok(same(bytes));
    assert.equal(hits.length, 1);
    assert.equal(retries.length, 0);
  });
});

test('404 这类地址问题不重试，直接带上 URL 和状态码失败', async () => {
  await withServer([status(404), ok], async ({ url, hits }) => {
    const retries = [];
    await assert.rejects(download(url, { backoffMs: 1, onRetry: (r) => retries.push(r) }), (error) => {
      assert.equal(error.status, 404);
      assert.ok(error.message.includes(url), error.message);
      assert.match(error.message, /HTTP 404/);
      return true;
    });
    assert.equal(hits.length, 1);
    assert.equal(retries.length, 0);
  });
});

for (const code of [408, 429, 500, 503]) {
  test(`HTTP ${code} 会重试，下一次成功就成功`, async () => {
    await withServer([status(code), ok], async ({ url, hits }) => {
      const bytes = await download(url, { backoffMs: 1 });
      assert.ok(same(bytes));
      assert.equal(hits.length, 2);
    });
  });
}

test('重试耗尽后抛出最后一次的错误，请求次数 = 首次 + retries', async () => {
  await withServer([status(503)], async ({ url, hits }) => {
    const retries = [];
    await assert.rejects(download(url, { retries: 2, backoffMs: 1, onRetry: (r) => retries.push(r) }), (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /HTTP 503/);
      return true;
    });
    assert.equal(hits.length, 3);
    assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
  });
});

test('重试前的等待逐次翻倍', async () => {
  await withServer([status(503)], async ({ url }) => {
    const delays = [];
    await assert.rejects(download(url, { retries: 3, backoffMs: 5, onRetry: (r) => delays.push(r.delayMs) }));
    assert.deepEqual(delays, [5, 10, 20]);
  });
});

test('非法 URL 立刻失败，不进重试', async () => {
  const retries = [];
  await assert.rejects(download('not a url', { backoffMs: 1, onRetry: (r) => retries.push(r) }), TypeError);
  assert.equal(retries.length, 0);
});

test('连不上会重试到耗尽，错误里带上底层错误码而不是笼统的 fetch failed', async () => {
  // 先占一个端口再释放，保证这个端口上没有人在听。
  const probe = http.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });

  const retries = [];
  await assert.rejects(
    download(`http://127.0.0.1:${port}/x`, { retries: 1, backoffMs: 1, onRetry: (r) => retries.push(r) }),
    /ECONNREFUSED/,
  );
  assert.equal(retries.length, 1);
  assert.match(retries[0].reason, /ECONNREFUSED/);
});

test('下载结束后不留定时器：进程能立刻退出，而不是再等一个停滞时限', async () => {
  // 进程内测不出定时器泄漏（测试进程本来就活着），只能看一个单独的进程什么时候退出。
  await withServer([ok], async ({ url }) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { download } from ${JSON.stringify(MODULE_URL)};\nawait download(process.env.TARGET, { stallMs: 20_000 });`,
    ], { env: { ...process.env, TARGET: url }, stdio: 'inherit' });
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await once(child, 'exit');
      assert.equal(signal, null, '5 秒内没退出：定时器没清');
      assert.equal(code, 0);
    } finally { clearTimeout(guard); }
  });
});

// ── 进度文本 ────────────────────────────────────────────────────────────────

test('formatProgress：有总量时给出已收/总量、百分比、平均速度和剩余时间', () => {
  assert.equal(
    formatProgress({ label: 'studio-stable', received: 4_000_000, total: 16_000_000, elapsedMs: 10_000 }),
    'studio-stable  4.0 / 16.0 MB  25%  400.0 KB/s  剩余约 30 秒',
  );
});

test('formatProgress：总量未知时不给百分比和剩余时间', () => {
  assert.equal(
    formatProgress({ label: 'glue', received: 2_500_000, total: null, elapsedMs: 5000 }),
    'glue  2.5 MB  500.0 KB/s',
  );
});

test('formatProgress：不足 1 秒不报速度；MB/s 与 KB/s 的切换', () => {
  assert.equal(formatProgress({ label: 'x', received: 100_000, total: 1_000_000, elapsedMs: 400 }), 'x  0.1 / 1.0 MB  10%');
  assert.match(formatProgress({ label: 'x', received: 5_000_000, total: 10_000_000, elapsedMs: 2000 }), /2\.5 MB\/s/);
  assert.match(formatProgress({ label: 'x', received: 900_000, total: 10_000_000, elapsedMs: 1000 }), /900\.0 KB\/s/);
});

test('formatProgress：剩余时间按量级用 秒 / 分钟 / 小时', () => {
  // 慢链路的量级：单连接约 11.4KB/s 时，15.4MB 的 wasm 要二十多分钟（取自一次经代理的实测，原因没查明）。
  assert.match(formatProgress({ label: 'x', received: 114_000, total: 15_439_503, elapsedMs: 10_000 }), /剩余约 22 分钟$/);
  assert.match(formatProgress({ label: 'x', received: 10_000, total: 15_439_503, elapsedMs: 10_000 }), /剩余约 4\.3 小时$/);
  assert.match(formatProgress({ label: 'x', received: 1_000_000, total: 1_050_000, elapsedMs: 5000 }), /剩余约 1 秒$/);
});

test('formatProgress：百分比没有浮点误差（先除后乘会把 29/100 算成 28%）', () => {
  for (const percent of [29, 57, 58]) {
    assert.match(formatProgress({ label: 'x', received: percent, total: 100, elapsedMs: 0 }), new RegExp(` ${percent}%$`));
  }
});

test('formatProgress：没下完不显示 100%', () => {
  assert.match(formatProgress({ label: 'x', received: 15_439_000, total: 15_439_503, elapsedMs: 2000 }), /99%/);
  assert.match(formatProgress({ label: 'x', received: 15_439_503, total: 15_439_503, elapsedMs: 2000 }), /100%/);
});
