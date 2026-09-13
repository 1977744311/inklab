// browser-camera.mjs — 把电脑摄像头的一帧适配成 Ink `media.takePhoto` 返回值。
//
// 这里只在应用真正调用 takePhoto 时才执行 getUserMedia；切换模式、启动 InkView 都不会
// 请求权限或取景。引擎仍负责“必须来自用户交互调用栈”的闸，本层只做浏览器采集与字节编码。

const DEFAULT_MIME_TYPE = 'image/jpeg';
const DEFAULT_FRAME_TIMEOUT_MS = 8_000;

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop?.(); } catch { /* 权限灯收尾尽力 */ }
  }
}

/**
 * 只申请/确认电脑摄像头权限，不读取或保存画面。成功拿到流后立即停轨。
 * 必须由宿主在真实 select/click 处理器里直接调用，不能隔一个异步重载再调用。
 */
export async function requestComputerCameraPermission({
  mediaDevices = globalThis.navigator?.mediaDevices,
} = {}) {
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    throw namedError('NotSupportedError', '当前浏览器没有 navigator.mediaDevices.getUserMedia');
  }
  // 第一次 await 前发起，保留当前用户交互调用栈。
  const streamPromise = mediaDevices.getUserMedia({ video: true, audio: false });
  const stream = await streamPromise;
  try {
    const tracks = stream?.getVideoTracks?.() || [];
    if (!tracks.length) throw namedError('NotFoundError', '电脑上没有可用的视频轨道');
    return { videoTracks: tracks.length };
  } finally {
    stopStream(stream);
  }
}

function canvasQuality(quality) {
  const value = String(quality || '').toLowerCase();
  if (value === 'low') return 0.7;
  if (value === 'medium' || value === 'normal') return 0.82;
  return 0.92;
}

async function canvasBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  if (typeof canvas.toBlob !== 'function') {
    throw namedError('NotSupportedError', '当前浏览器不能把摄像头画面编码成图片');
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(namedError('EncodingError', '电脑摄像头画面编码失败'));
    }, mimeType, quality);
  });
}

async function waitForVideoFrame(video, { setTimeoutFn, clearTimeoutFn, timeoutMs }) {
  if (Number(video.videoWidth) > 0 && Number(video.videoHeight) > 0) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'error']) {
        video.removeEventListener?.(name, name === 'error' ? onError : onReady);
      }
      if (err) reject(err); else resolve();
    };
    const onReady = () => {
      if (Number(video.videoWidth) > 0 && Number(video.videoHeight) > 0) finish();
    };
    const onError = () => finish(namedError('NotReadableError', '电脑摄像头没有产出可读取画面'));
    timer = setTimeoutFn(
      () => finish(namedError('TimeoutError', `电脑摄像头 ${timeoutMs}ms 内没有产出画面`)),
      timeoutMs,
    );
    for (const name of ['loadedmetadata', 'loadeddata', 'canplay']) {
      video.addEventListener?.(name, onReady);
    }
    video.addEventListener?.('error', onError);
    Promise.resolve(video.play?.()).then(onReady, finish);
  });
}

async function frameViaVideo(stream, track, {
  documentRef, mimeType, quality, setTimeoutFn, clearTimeoutFn, frameTimeoutMs,
}) {
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw namedError('NotSupportedError', '当前宿主不能创建视频画面，无法调用电脑摄像头拍照');
  }
  const video = documentRef.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await waitForVideoFrame(video, {
      setTimeoutFn, clearTimeoutFn, timeoutMs: frameTimeoutMs,
    });
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const width = Math.max(1, Number(video.videoWidth) || Number(settings.width) || 640);
    const height = Math.max(1, Number(video.videoHeight) || Number(settings.height) || 480);
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext?.('2d');
    if (!ctx || typeof ctx.drawImage !== 'function') {
      throw namedError('NotSupportedError', '当前宿主不能读取电脑摄像头画面');
    }
    ctx.drawImage(video, 0, 0, width, height);
    return canvasBlob(canvas, mimeType, quality);
  } finally {
    try { video.pause?.(); } catch { /* 尽力收画面 */ }
    video.srcObject = null;
  }
}

/**
 * 返回可直接替换 `capabilities.media.takePhoto` 的方法。
 * 依赖可注入，单测使用假摄像头，不会访问开发机硬件。
 */
export function createComputerCameraTakePhoto({
  mediaDevices = globalThis.navigator?.mediaDevices,
  documentRef = globalThis.document,
  ImageCaptureCtor = globalThis.ImageCapture,
  mimeType = DEFAULT_MIME_TYPE,
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (handle) => clearTimeout(handle),
} = {}) {
  return async function takePhoto(args = {}) {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw namedError('NotSupportedError', '当前浏览器没有 navigator.mediaDevices.getUserMedia');
    }

    // 必须在第一次 await 前就发起：浏览器和 Ink 引擎都以当前用户交互调用栈判权限。
    const streamPromise = mediaDevices.getUserMedia({ video: true, audio: false });
    const stream = await streamPromise;
    try {
      const track = stream?.getVideoTracks?.()[0];
      if (!track) throw namedError('NotFoundError', '电脑上没有可用的视频轨道');

      let blob = null;
      if (typeof ImageCaptureCtor === 'function') {
        try {
          const capture = new ImageCaptureCtor(track);
          if (typeof capture.takePhoto === 'function') blob = await capture.takePhoto();
        } catch {
          // 部分桌面摄像头能出视频帧但不实现原生 takePhoto；下面退到 video + canvas。
        }
      }
      if (!(blob instanceof Blob) || blob.size === 0) {
        blob = await frameViaVideo(stream, track, {
          documentRef,
          mimeType,
          quality: canvasQuality(args && args.quality),
          setTimeoutFn,
          clearTimeoutFn,
          frameTimeoutMs,
        });
      }
      return {
        data: new Uint8Array(await blob.arrayBuffer()),
        mimeType: String(blob.type || mimeType),
      };
    } finally {
      stopStream(stream);
    }
  };
}
