import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Resolve the browser's existing host alias without starting a browser/server.
const source = (await readFile(new URL('../host/device-mirror.js', import.meta.url), 'utf8'))
  .replace("'/host/lib/recording.mjs'", JSON.stringify(new URL('../lib/recording.mjs', import.meta.url).href));
const { saveMirrorRecording } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture() {
  const result = { objectUrl: 'blob:original-recording', filename: 'original.mp4', extension: 'mp4',
    blob: new Blob(['actual-video-bytes'], { type: 'video/mp4' }), mimeType: 'video/mp4',
    durationMs: 121100, width: 480, height: 640 };
  const saved = { id: '12345678-1234-1234-1234-123456789012',
    url: '/api/device/artifact/12345678-1234-1234-1234-123456789012',
    filename: 'saved.mp4', path: '/private/device-output/recordings/saved.mp4',
    bytes: result.blob.size, sha256: 'a'.repeat(64), mimeType: 'video/mp4' };
  const link = {}, note = {}, notices = [];
  const options = { link, note, onNote: (...args) => notices.push(args),
    api: async (route) => { assert.equal(route, 'status'); return { token: 'fresh-session-token' }; } };
  return { result, saved, link, note, notices, options };
}

test('finished recording uploads original Blob with current token and publishes the controlled local artifact', async () => {
  const { result, saved, link, note, notices, options } = fixture();
  const blob = result.blob;
  const actual = await saveMirrorRecording(result, { ...options, fetchFn: async (url, init) => {
    assert.equal(url, '/api/device/recording');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'video/mp4');
    assert.equal(init.headers['x-inklab-device-token'], 'fresh-session-token');
    assert.equal(init.body, blob, 'no base64/JSON conversion or re-encoding');
    assert.equal(link.href, result.objectUrl, 'the Blob is available even while the upload is pending');
    return { ok: true, json: async () => saved };
  } });
  assert.equal(actual, saved);
  assert.equal(result.saved, saved);
  assert.equal(link.href, saved.url);
  assert.equal(link.download, saved.filename);
  assert.match(note.textContent, /121\.1s.*480×640.*已保存/);
  assert.equal(notices.length, 0);
  assert.equal(result.blob, blob);
});

test('upload/receipt/token failures keep the original Blob and visible download instead of losing the movie', async () => {
  for (const failure of ['offline', 'oversized', 'wrong-bytes', 'external-url', 'token-status']) {
    const { result, saved, link, note, notices, options } = fixture();
    const blob = result.blob;
    if (failure === 'token-status') options.api = async () => { throw new Error('server stopped'); };
    const response = await saveMirrorRecording(result, { ...options, fetchFn: async () => {
      if (failure === 'offline') throw new Error('connection refused');
      if (failure === 'oversized') return { ok: false, json: async () => ({ error: '录像超过上传大小上限' }) };
      return { ok: true, json: async () => ({ ...saved,
        ...(failure === 'wrong-bytes' ? { bytes: 0 } : { url: 'https://elsewhere.invalid/movie.mp4' }) }) };
    } });
    assert.equal(response, null, failure);
    assert.equal(link.href, result.objectUrl);
    assert.equal(link.download, result.filename);
    assert.equal(link.hidden, false);
    assert.equal(result.blob, blob);
    assert.equal(result.saved, undefined);
    assert.match(note.textContent, /原录像仍保留/);
    assert.equal(notices.length, 1);
    assert.match(notices[0][0], /请勿刷新/);
  }
});
