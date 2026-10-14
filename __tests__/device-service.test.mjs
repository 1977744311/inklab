import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createDeviceService, createDeviceHandler, readDeviceConfig, loadDeviceScenarios, parseAdbDevices, pngMetadata, MAX_DEVICE_RECORDING_BYTES } from '../lib/node/device-service.mjs';
import { parseDeviceArgs } from '../lib/node/device-e2e.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
const vision = { status: async () => ({ available: true }), read: async () => ({ status: 'available', text: '完成3组' }) };
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'inklab-device-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, 'app');
  await mkdir(join(appDir, 'e2e/device-scenarios'), { recursive: true });
  const calls = [];
  const execute = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nA device model:RG_glasses\nB unauthorized\n' };
    const pathIndex = args.indexOf('--capture');
    if (pathIndex !== -1) await writeFile(args[pathIndex + 1], png);
    return { stdout: JSON.stringify({ dispatched: true, resultVerified: false }) };
  };
  const service = createDeviceService({ appDir, enabled: true, profile: 'test-adapter', asrText: true, outputDir: join(root, 'output'), execute, vision });
  await service.status();
  return { root, appDir, calls, service, execute };
}

async function httpFixture(t, options) {
  const data = await fixture(t);
  const handler = createDeviceHandler(data.service, options);
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { ...data, server, url: `http://127.0.0.1:${server.address().port}` };
}

function rawUpload(url, headers, chunks = [], end = true) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/api/device/recording`, { method: 'POST', headers }, (res) => {
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(data).toString()) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end(); else req.flushHeaders();
  });
}

test('ADB inventory preserves unauthorized/offline states instead of auto-selecting them', () => {
  const devices = parseAdbDevices('List of devices attached\nA device product:glasses model:RG_glasses transport_id:1\nB unauthorized\nC offline\n');
  assert.deepEqual(devices.map((d) => d.state), ['device', 'unauthorized', 'offline']);
  assert.equal(devices[0].model, 'RG_glasses');
});

test('explicit selected device, fixed argv, and unmodified raw PNG evidence', async (t) => {
  const { service, calls } = await fixture(t);
  await assert.rejects(service.select('B'), /未连接|尚未授权/);
  await assert.rejects(service.manual({ command: 'key', value: 'right' }), /请选择/);
  await service.select('A');
  await service.manual({ command: 'say', value: '今天练了几组了', waitMs: 0 });
  assert.ok(calls.some((c) => c.args.includes('今天练了几组了') && c.args.includes('A')));
  const shot = await service.screenshot('proof', { ocr: true });
  assert.deepEqual(await readFile(shot.file), png);
  assert.equal(shot.modified, false);
  assert.equal(shot.source, 'adb-raw-png');
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 1, height: 1 });
  assert.equal(shot.ocr.text, '完成3组');
  assert.equal(pngMetadata(png).sha256, shot.sha256);
  await assert.rejects(service.manual({ command: 'shell', value: 'reboot' }), /不支持/);
  await assert.rejects(service.manual({ command: 'key', value: 'right; reboot' }), /不支持/);
});

test('scene evidence is saved to local run.json and no package identity is fabricated', async (t) => {
  const { service, appDir } = await fixture(t);
  await service.select('A');
  await writeFile(join(appDir, 'e2e/device-scenarios/query.json'), JSON.stringify({ id: 'query',
    device: { steps: [{ say: '今天练了几组了', waitMs: 0 }, { expectText: '完成3组' }] } }));
  const started = await service.startRun('query');
  while (service.run(started.id).status === 'running') await new Promise((r) => setTimeout(r, 1));
  const result = service.run(started.id);
  assert.equal(result.status, 'passed');
  const report = JSON.parse(await readFile(result.reportFile));
  assert.equal(report.businessVerified, true);
  assert.equal(report.package.verification, 'not-observed-by-inklab');
  assert.equal(report.serial, 'A');
});

test('cross-origin and missing-token writes cannot reach ADB', async (t) => {
  const { service, calls } = await fixture(t);
  const handler = createDeviceHandler(service);
  const server = createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const before = calls.length;
  let response = await fetch(`${url}/api/device/select`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"serial":"A"}' });
  assert.equal(response.status, 403);
  response = await fetch(`${url}/api/device/status`, { headers: { Origin: 'https://example.org' } });
  assert.equal(response.status, 403);
  response = await fetch(`${url}/api/device/select`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-inklab-device-token': service.token, Origin: url }, body: '{"serial":"A"}' });
  assert.equal(response.status, 200);
  assert.equal(calls.length, before + 1, 'only same-origin token-authenticated selection enumerates ADB');
});

test('disabled real-device service never probes ADB', async () => {
  const service = createDeviceService({ appDir: '/tmp/no-app', execute() { throw new Error('must not execute'); } });
  assert.equal((await service.status()).enabled, false);
  await assert.rejects(service.manual({ command: 'key', value: 'right' }), /未启用/);
  await assert.rejects(service.saveRecording(mp4, 'video/mp4'), /未启用/);
});

test('binary recordings persist privately under generated names and registered artifacts preserve exact bytes', async (t) => {
  const { service, root, url, calls } = await httpFixture(t);
  const before = calls.length;
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
  const ids = new Set();
  for (const [mimeType, body] of [['video/mp4;codecs=avc1.42E01E', mp4], ['video/webm', webm], ['video/mp4', mp4]]) {
    const response = await fetch(`${url}/api/device/recording?filename=../../outside.html`, {
      method: 'POST', headers: { 'content-type': mimeType, 'x-inklab-device-token': service.token,
        'content-disposition': 'attachment; filename="../../outside.html"' }, body,
    });
    assert.equal(response.status, 201);
    const saved = await response.json();
    ids.add(saved.id);
    assert.match(saved.filename, /^inklab-real-glasses-[a-f0-9-]{36}\.(mp4|webm)$/);
    assert.equal(saved.path, join(root, 'output/recordings', saved.filename));
    assert.equal(saved.bytes, body.length);
    assert.equal(saved.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'output/recordings'))).mode & 0o777, 0o700);
    assert.deepEqual(await readFile(saved.path), body);
    const artifact = await fetch(`${url}${saved.url}`);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('content-type'), mimeType.split(';')[0]);
    assert.equal(artifact.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), body);
    assert.equal((await fetch(`${url}${saved.url}`, { headers: { Origin: 'https://elsewhere.invalid' } })).status, 403);
  }
  assert.equal(ids.size, 3, 'repeated saves cannot overwrite a previous recording');
  assert.equal(calls.length, before, 'saving/reading finished video never touches ADB or the device lock');
  assert.equal((await fetch(`${url}/api/device/artifact/unregistered-id`)).status, 404);
  assert.equal((await fetch(`${url}/api/device/artifact/%2e%2e%2foutside.html`)).status, 404);
});

test('recording upload rejects cross-origin, DNS-rebound and unauthenticated writes before saving', async (t) => {
  const { service, url, root } = await httpFixture(t);
  for (const headers of [
    {}, { 'x-inklab-device-token': 'old-session-token' },
    { 'x-inklab-device-token': service.token, Origin: 'https://elsewhere.invalid' },
    { 'x-inklab-device-token': service.token, 'sec-fetch-site': 'cross-site' },
    { 'x-inklab-device-token': service.token, Host: 'rebound.invalid:8790' },
  ]) {
    const response = await rawUpload(url, { 'content-type': 'video/mp4', ...headers }, [mp4]);
    assert.equal(response.status, 403);
  }
  await assert.rejects(readdir(join(root, 'output/recordings')), { code: 'ENOENT' });
});

test('recording upload bounds declared and chunked bodies and stops stalled uploads', { timeout: 5000 }, async (t) => {
  const { service, url, root } = await httpFixture(t, { recordingMaxBytes: 32, recordingTimeoutMs: 40 });
  const headers = { 'content-type': 'video/mp4', 'x-inklab-device-token': service.token };
  const declared = await rawUpload(url, { ...headers, 'content-length': String(MAX_DEVICE_RECORDING_BYTES + 1) });
  assert.equal(declared.status, 413);
  const chunked = await rawUpload(url, headers, [mp4, mp4]);
  assert.equal(chunked.status, 413);
  const stalled = await rawUpload(url, headers, [mp4], false);
  assert.equal(stalled.status, 408);
  assert.match(stalled.body.error, /超时/);
  await assert.rejects(readdir(join(root, 'output/recordings')), { code: 'ENOENT' });
});

test('recording upload rejects empty or mismatched containers without creating an artifact', async (t) => {
  const { service, url, root } = await httpFixture(t);
  for (const [type, body, status] of [['application/json', mp4, 415], ['video/mp4', Buffer.alloc(0), 400],
    ['video/webm', mp4, 400], ['video/mp4', Buffer.from('<html>not a movie</html>'), 400]]) {
    const response = await rawUpload(url, { 'content-type': type, 'x-inklab-device-token': service.token }, [body]);
    assert.equal(response.status, status);
  }
  assert.equal(service.artifacts.size, 0);
  await assert.rejects(readdir(join(root, 'output/recordings')), { code: 'ENOENT' });
});

test('aborted recording upload leaves no partial movie or registered artifact', async (t) => {
  const { service, url, root } = await httpFixture(t);
  await new Promise((resolve) => {
    const req = request(`${url}/api/device/recording`, { method: 'POST', headers: {
      'content-type': 'video/mp4', 'x-inklab-device-token': service.token,
    } });
    req.on('error', () => {});
    req.write(mp4);
    setTimeout(() => { req.destroy(); resolve(); }, 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.artifacts.size, 0);
  await assert.rejects(readdir(join(root, 'output/recordings')), { code: 'ENOENT' });
});

test('device CLI requires explicit scenario and serial', () => {
  assert.throws(() => parseDeviceArgs(['apps/a']), /Usage/);
  assert.deepEqual(parseDeviceArgs(['apps/a', '--serial', 'A', '--scenario', 'one', '--scenario', 'two', '--out', '/tmp/report']),
    { input: 'apps/a', serial: 'A', scenarios: ['one', 'two'], output: '/tmp/report', list: false });
});

// The standalone host discovers capability declarations at the selected app, not a sibling repository.
test('project device config supplies ASR capability and a relocatable control script', async (t) => {
  const { root, appDir, calls, service: unused, execute } = await fixture(t);
  t.after(() => unused.close());
  assert.deepEqual(readDeviceConfig(appDir), {});
  await writeFile(join(appDir, 'inklab.device.json'), JSON.stringify({ profile: 'custom', asrText: true, controlScript: 'adapters/control.mjs' }));
  assert.equal(readDeviceConfig(appDir).asrText, true);
  const service = createDeviceService({ appDir, enabled: true, execute, vision, outputDir: join(root, 'configured-output') });
  t.after(() => service.close());
  const status = await service.status();
  assert.equal(status.profile, 'custom');
  assert.equal(status.capabilities.asrText, true);
  await service.select('A');
  await service.manual({ command: 'say', value: '测试', waitMs: 0 });
  assert.ok(calls.some(call => call.file === process.execPath && call.args[0] === join(appDir, 'adapters/control.mjs')));
});

// Packaged inputs are files; optional source-project sidecars must not block loading them.
test('an AIX input has no source project device config or scenarios', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'inklab-package-input-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'app.aix');
  await writeFile(input, Buffer.from('package'));
  assert.deepEqual(readDeviceConfig(input), {});
  assert.deepEqual(await loadDeviceScenarios(input), []);
  const service = createDeviceService({ appDir: input, enabled: false });
  assert.equal((await service.status()).enabled, false);
});
