// Real encoded display frames; neither this canvas nor its JPEG compression is
// used as the raw PNG/OCR evidence path.
import { createCanvasRecorder } from '/host/lib/recording.mjs';

export async function saveMirrorRecording(result, { api, link, note, onNote = () => {}, fetchFn = globalThis.fetch }) {
  // Publish the original Blob first and keep it alive even if the server is gone.
  link.href = result.objectUrl; link.download = result.filename; link.hidden = false;
  link.textContent = `下载真实投屏录像（${result.extension.toUpperCase()}）`;
  const detail = `${(result.durationMs / 1000).toFixed(1)}s · 无声视频 · ${result.width}×${result.height}`;
  note.textContent = `${detail} · 正在保存到本机`;
  try {
    // A restarted local service has a new token; the existing recording survives
    // without refreshing the page or relying on the browser's download manager.
    const { token } = await api('status');
    const response = await fetchFn('/api/device/recording', { method: 'POST',
      headers: { 'content-type': result.mimeType, 'x-inklab-device-token': token }, body: result.blob });
    const saved = await response.json();
    if (!response.ok) throw new Error(saved.error || `HTTP ${response.status}`);
    if (!/^\/api\/device\/artifact\/[a-f0-9-]{36}$/.test(saved.url || '')
      || saved.bytes !== result.blob.size || !/^[a-f0-9]{64}$/.test(saved.sha256 || '')) {
      throw new Error('本机保存回执不完整');
    }
    result.saved = saved;
    link.href = saved.url; link.download = saved.filename;
    link.textContent = `下载已保存录像（${result.extension.toUpperCase()}）`;
    note.textContent = `${detail} · 已保存：${saved.path}`;
    return saved;
  } catch (err) {
    note.textContent = `${detail} · 本机保存失败，原录像仍保留在本页`;
    onNote(`录像保存失败：${err.message}。原 Blob 下载链接仍可用，请勿刷新页面。`, true);
    return null;
  }
}

export function createMirrorView({ api, onState = () => {}, onNote = () => {}, hasEvidence = () => false }) {
  const $ = (id) => document.getElementById(id);
  const canvas = $('mirror-canvas');
  const context = canvas.getContext('2d', { alpha: false });
  let stream = null;
  let id = null;
  let active = false;
  let mode = 'evidence';
  let queue = null;
  let decoding = false;
  let lastPaintedAt = 0;
  let paintMs = null;
  let times = [];
  let server = { status: 'stopped' };
  let ticker = null;
  let epoch = 0;
  let starting = false;
  const recorder = createCanvasRecorder();
  let recording = false;
  let recordingStopping = false;
  function renderStats() {
    const now = Date.now();
    times = times.filter((t) => now - t < 3000);
    const fps = times.length > 1 && now - times[times.length - 1] < 1000
      ? ((times.length - 1) * 1000 / (times[times.length - 1] - times[0])).toFixed(1) : '0.0';
    $('mirror-stats').textContent = active
      ? `H.264 连续视频 · 实收 ${fps} fps · 最近绘制 ${lastPaintedAt ? now - lastPaintedAt : '—'} ms前${paintMs == null ? '' : ` · 解码→显示 ${paintMs} ms`}${server.status === 'restarting' ? ' · 正在续接' : ''}`
      : server.error ? `投屏已停止：${server.error}` : '投屏未开启 · 原始截图与视频预览分别保存';
  }
  function show(which) {
    mode = which;
    canvas.hidden = which !== 'live';
    $('screen').style.display = which === 'evidence' && hasEvidence() ? 'block' : 'none';
    $('empty').hidden = which === 'live' || hasEvidence();
    $('mirror-show').classList.toggle('selected', which === 'live');
    $('evidence-show').classList.toggle('selected', which === 'evidence');
    $('frame-meta').textContent = which === 'live' ? '480×640 · H.264 视频预览（压缩）'
      : $('frame-meta').dataset.evidence || 'ADB 原图 · 不合成环境，不裁切';
  }
  function buttons() {
    $('mirror-toggle').textContent = active || starting ? '停止投屏' : '开始实时投屏';
    $('mirror-show').disabled = !lastPaintedAt;
    $('evidence-show').disabled = !hasEvidence();
    $('mirror-record').disabled = recordingStopping || (!recording && (!active || !lastPaintedAt));
    $('mirror-record').textContent = recording ? '停止录制' : '录制视频';
    onState({ active, starting });
  }
  async function paint() {
    if (decoding || !queue) return;
    decoding = true;
    const session = epoch;
    try {
      while (queue && active && session === epoch) {
        const frame = queue; queue = null; // drop old frames while decoding
        const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (!active || session !== epoch) { bitmap.close(); break; }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0); bitmap.close();
        lastPaintedAt = Date.now(); paintMs = Math.max(0, lastPaintedAt - frame.at);
        times.push(lastPaintedAt);
        buttons();
      }
    } catch (err) { onNote(`投屏帧无法解码：${err.message}`, true); }
    finally { decoding = false; }
  }
  function detach() {
    epoch += 1;
    stream?.close(); stream = null;
    active = false; starting = false; queue = null;
    clearInterval(ticker); ticker = null;
    renderStats(); buttons();
  }
  async function finishRecording() {
    if (!recording || recordingStopping) return;
    recordingStopping = true; buttons();
    try {
      const result = await recorder.stop();
      if (result) {
        await saveMirrorRecording(result, { api, link: $('mirror-recording'), note: $('recording-note'), onNote });
      }
    } finally { recording = false; recordingStopping = false; buttons(); }
  }
  async function stop() {
    await finishRecording();
    detach();
    server = await api('mirror/stop', {});
    renderStats();
    if (hasEvidence()) show('evidence');
  }
  async function start() {
    if (active || starting) return;
    starting = true; buttons();
    try {
      server = await api('mirror/start', { keepAwake: true });
      id = server.id; active = true; starting = false; times = []; paintMs = null;
      const session = ++epoch;
      stream = new EventSource(`/api/device/mirror/events/${encodeURIComponent(id)}`);
      stream.addEventListener('frame', (event) => {
        if (session !== epoch || !active) return;
        queue = JSON.parse(event.data); paint();
      });
      stream.addEventListener('state', (event) => {
        if (session !== epoch) return;
        server = JSON.parse(event.data);
        if (server.status === 'error' || server.status === 'stopped') {
          finishRecording().catch((err) => onNote(err.message, true)); detach();
        }
        renderStats();
      });
      stream.onerror = () => {
        if (session !== epoch || !active) return;
        // A dead stream is not a frozen "live" preview. Close it; the server's
        // viewer lease is the backstop when an explicit stop cannot reach it.
        server = { status: 'error', error: '视频连接已断开，请重新开始' };
        finishRecording().catch((err) => onNote(err.message, true));
        detach(); api('mirror/stop', {}).catch(() => {});
      };
      ticker = setInterval(renderStats, 500);
      show('live'); renderStats(); buttons();
    } catch (err) {
      server = { status: 'error', error: err.message }; detach(); throw err;
    }
  }
  window.addEventListener('pagehide', () => {
    stream?.close();
    recorder.dispose();
    // The event stream close reclaims the remote encoder after the short lease.
    // No settings were changed, so there is no persisted power mode to restore.
    detach();
  });
  $('mirror-show').onclick = () => show('live');
  $('evidence-show').onclick = () => show('evidence');
  $('mirror-record').onclick = async () => {
    try {
      if (recording) await finishRecording();
      else {
        recorder.start({ canvas, name: 'real-glasses', fps: 30,
          meta: { source: 'real-device-h264-preview', rawEvidence: false, microphone: false } });
        recording = true; buttons();
        $('recording-note').textContent = '正在录制真实投屏 · 无声';
      }
    } catch (err) { onNote(err.message, true); }
  };
  return { start, stop, toggle: () => active || starting ? stop() : start(),
    showEvidence: () => { buttons(); show('evidence'); },
    evidenceChanged: () => { buttons(); show(active && mode === 'live' ? 'live' : 'evidence'); },
    state: () => ({ active, starting, mode, id }) };
}
