// recording.mjs — 主舞台 canvas 录屏。
//
// 这不是「录浏览器窗口」：InkLab 只把 InkView 绑定的 canvas 交给 captureStream，
// 所以成片没有控制台、鼠标、浏览器边框，也不需要屏幕录制权限。默认优先 H.264 MP4，
// 让产物可以直接插进 PowerPoint；浏览器没有 MP4 MediaRecorder 时才降级为 WebM，
// 并把 pptReady=false 明确带给 UI，不能把一个兼容性未知的文件冒充 PPT 交付物。

export const RECORDING_FORMATS = Object.freeze([
  Object.freeze({ mimeType: 'video/mp4;codecs=avc1.42E01E', extension: 'mp4', pptReady: true }),
  Object.freeze({ mimeType: 'video/mp4', extension: 'mp4', pptReady: true }),
  Object.freeze({ mimeType: 'video/webm;codecs=vp9', extension: 'webm', pptReady: false }),
  Object.freeze({ mimeType: 'video/webm;codecs=vp8', extension: 'webm', pptReady: false }),
  Object.freeze({ mimeType: 'video/webm', extension: 'webm', pptReady: false }),
]);

/** MIME → 文件后缀与 PPT 兼容性。MediaRecorder 有时会把实际 codec 补进 blob.type。 */
export function describeRecordingType(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.startsWith('video/mp4')) return { mimeType: mimeType || 'video/mp4', extension: 'mp4', pptReady: true };
  if (type.startsWith('video/webm')) return { mimeType: mimeType || 'video/webm', extension: 'webm', pptReady: false };
  return { mimeType: mimeType || 'application/octet-stream', extension: 'video', pptReady: false };
}

/**
 * 返回浏览器声明支持的录制格式，按 PPT 友好度排序。
 * isTypeSupported 缺席时不猜格式；createCanvasRecorder 最后还会尝试无 mimeType 构造。
 */
export function supportedRecordingFormats(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (typeof MediaRecorderCtor !== 'function') return [];
  if (typeof MediaRecorderCtor.isTypeSupported !== 'function') return [];
  return RECORDING_FORMATS.filter((format) => {
    try { return MediaRecorderCtor.isTypeSupported(format.mimeType); } catch { return false; }
  });
}

/** 文件名只去掉各平台明确不能放进文件名的字符；中文与场景 id 都保留，方便回看。 */
export function safeRecordingName(value) {
  const cleaned = String(value || 'recording')
    .trim()
    // eslint-disable-next-line no-control-regex -- 文件名里的控制字符本来就要剔除
    .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return (cleaned || 'recording').slice(0, 96);
}

function localStamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function recordingFilename(name, at, extension = 'mp4') {
  return `inklab-${safeRecordingName(name)}-${localStamp(at)}.${safeRecordingName(extension)}`;
}

function stopTracks(stream) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop?.();
  } catch { /* 录屏收尾不能被某条已结束的 track 拦住 */ }
}

function once(target, type, fn) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(type, fn, { once: true });
    return () => target.removeEventListener?.(type, fn);
  }
  const key = `on${type}`;
  const prev = target[key];
  target[key] = (event) => { target[key] = prev || null; fn(event); };
  return () => { if (target[key] !== prev) target[key] = prev || null; };
}

/**
 * 浏览器 canvas 录制控制器。所有环境依赖均可注入，Node 单测不需要 DOM。
 *
 * start() 同步返回录制摘要；stop() 等 MediaRecorder 的最终 dataavailable + stop，
 * 返回带 Blob/objectUrl 的成片。一次只能录一条，避免两个 MediaRecorder 抢同一舞台。
 */
export function createCanvasRecorder({
  MediaRecorder: MediaRecorderCtor = globalThis.MediaRecorder,
  Blob: BlobCtor = globalThis.Blob,
  createObjectURL = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectURL = (url) => globalThis.URL.revokeObjectURL(url),
  now = () => Date.now(),
} = {}) {
  let active = null;
  const recordings = [];

  const supported = () => typeof MediaRecorderCtor === 'function';

  function start({ canvas, name = 'manual', fps = 30, videoBitsPerSecond = 4_000_000, meta = null } = {}) {
    if (!supported()) throw new Error('当前浏览器没有 MediaRecorder，不能录屏');
    if (active) throw new Error(`已有录屏正在进行：${active.name}`);
    if (!canvas || typeof canvas.captureStream !== 'function') {
      throw new Error('当前浏览器不支持 canvas.captureStream，不能录主舞台');
    }
    if (!Number.isFinite(fps) || fps <= 0) throw new TypeError(`fps 必须大于 0，收到 ${fps}`);

    const stream = canvas.captureStream(fps);
    const formats = supportedRecordingFormats(MediaRecorderCtor);
    let recorder = null;
    let selected = null;
    const failures = [];
    for (const format of formats) {
      try {
        recorder = new MediaRecorderCtor(stream, { mimeType: format.mimeType, videoBitsPerSecond });
        selected = format;
        break;
      } catch (err) {
        failures.push(`${format.mimeType}: ${err?.message || err}`);
      }
    }
    // 一些实现能录但没有 isTypeSupported；最后允许浏览器自己选容器。
    if (!recorder) {
      try {
        recorder = new MediaRecorderCtor(stream, { videoBitsPerSecond });
        selected = describeRecordingType(recorder.mimeType);
      } catch (err) {
        stopTracks(stream);
        const detail = [...failures, err?.message || String(err)].filter(Boolean).join('；');
        throw new Error(`浏览器无法创建舞台录屏${detail ? `：${detail}` : ''}`, { cause: err });
      }
    }

    const chunks = [];
    recorder.addEventListener?.('dataavailable', (event) => {
      if (event?.data && event.data.size > 0) chunks.push(event.data);
    });
    // 兼容只有 ondataavailable、没有 EventTarget 方法的极简实现与测试替身。
    if (typeof recorder.addEventListener !== 'function') {
      recorder.ondataavailable = (event) => {
        if (event?.data && event.data.size > 0) chunks.push(event.data);
      };
    }

    const startedAt = now();
    active = {
      recorder, stream, chunks, name: safeRecordingName(name), startedAt,
      width: Number(canvas.width) || 0, height: Number(canvas.height) || 0,
      fps, selected, meta,
    };
    // 1s 分片避免长场景把所有编码数据都憋到 stop；stop 仍会发最后一片。
    try {
      recorder.start(1000);
      stream.getVideoTracks?.()[0]?.requestFrame?.();
    } catch (err) {
      active = null;
      stopTracks(stream);
      throw new Error(`MediaRecorder 无法开始录制：${err?.message || err}`, { cause: err });
    }
    return {
      name: active.name, startedAt, width: active.width, height: active.height,
      fps, mimeType: recorder.mimeType || selected.mimeType, pptReady: selected.pptReady,
      meta,
    };
  }

  async function stop() {
    if (!active) return null;
    const current = active;
    const { recorder, stream, chunks } = current;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupListeners = [];
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        for (const clean of cleanupListeners) clean();
        stopTracks(stream);
        active = null;
        fn(value);
      };
      cleanupListeners.push(once(recorder, 'error', (event) => {
        finish(reject, event?.error || new Error('MediaRecorder 录制失败'));
      }));
      cleanupListeners.push(once(recorder, 'stop', () => {
        try {
          const stoppedAt = now();
          const actualMime = chunks.find((chunk) => chunk?.type)?.type
            || recorder.mimeType || current.selected.mimeType;
          const type = describeRecordingType(actualMime);
          const blob = new BlobCtor(chunks, { type: actualMime });
          if (!blob.size) throw new Error('录屏结果是空文件');
          const objectUrl = createObjectURL(blob);
          const rec = {
            name: current.name,
            filename: recordingFilename(current.name, current.startedAt, type.extension),
            startedAt: current.startedAt,
            stoppedAt,
            durationMs: Math.max(0, Number(stoppedAt) - Number(current.startedAt)),
            width: current.width,
            height: current.height,
            fps: current.fps,
            mimeType: actualMime,
            extension: type.extension,
            pptReady: type.pptReady,
            blob,
            objectUrl,
            meta: current.meta,
          };
          recordings.push(rec);
          finish(resolve, rec);
        } catch (err) {
          finish(reject, err);
        }
      }));

      try {
        stream.getVideoTracks?.()[0]?.requestFrame?.();
        if (recorder.state === 'inactive') {
          // 已被浏览器自行停掉时仍走统一 stop 收尾；极端实现不会再派 stop，只能报清楚。
          throw new Error('MediaRecorder 已提前停止，未取得完整成片');
        }
        recorder.stop();
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  function dispose() {
    if (active) {
      try { active.recorder.stop(); } catch { /* 页面卸载时只求停轨 */ }
      stopTracks(active.stream);
      active = null;
    }
    for (const rec of recordings) {
      try { revokeObjectURL(rec.objectUrl); } catch { /* URL 可能已经被浏览器回收 */ }
    }
    recordings.length = 0;
  }

  return {
    supported,
    formats: () => supportedRecordingFormats(MediaRecorderCtor),
    start,
    stop,
    dispose,
    recordings,
    get active() { return active; },
  };
}
