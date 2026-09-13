// lighting.mjs — Studio 效果预览 + 480×640 真机模拟 AR 合成。
//
// Studio 的「效果预览」是 480×352 normal blend + 黑底。「真机模拟」则是 480×640
// 竖帧，把同一张 480×352 AIUI 画布放在 top=144，上下各留 144 像素环境。optical
// 这个历史 id 继续用于 URL/报告兼容，对外名称改为「真机模拟 · 竖屏」。

export const PREVIEW_MODES = Object.freeze([
  Object.freeze({ id: 'studio', label: '效果预览 · 黑底', shortLabel: '效果预览' }),
  Object.freeze({ id: 'optical', label: '真机模拟 · 竖屏', shortLabel: '真机模拟' }),
]);

export const AR_FRAME = Object.freeze({ width: 480, height: 640, contentTop: 144, contentHeight: 352 });

export const LIGHTING_PROFILES = Object.freeze([
  Object.freeze({ id: 'absolute-dark', label: '绝对黑暗', shortLabel: '黑暗' }),
  Object.freeze({ id: 'indoor-bright', label: '室内明亮', shortLabel: '室内' }),
  Object.freeze({ id: 'night-low-light', label: '夜晚弱光', shortLabel: '夜晚' }),
]);

export function normalizeLightingProfile(value) {
  const id = String(value || '');
  return LIGHTING_PROFILES.some((p) => p.id === id) ? id : 'absolute-dark';
}

export function lightingProfile(value) {
  const id = normalizeLightingProfile(value);
  return LIGHTING_PROFILES.find((p) => p.id === id);
}

export function normalizePreviewMode(value) {
  const id = String(value || '');
  return PREVIEW_MODES.some((p) => p.id === id) ? id : 'studio';
}

export function previewMode(value) {
  const id = normalizePreviewMode(value);
  return PREVIEW_MODES.find((p) => p.id === id);
}

function gradient(ctx, x0, y0, x1, y1, stops, fallback) {
  if (typeof ctx.createLinearGradient !== 'function') return fallback;
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

function radialGradient(ctx, x0, y0, r0, x1, y1, r1, stops, fallback) {
  if (typeof ctx.createRadialGradient !== 'function') return fallback;
  const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

/** 在截图合成画布上画一张原创、低细节的环境底图。 */
export function paintLightingBackground(ctx, width, height, profile) {
  const id = normalizeLightingProfile(profile);
  ctx.save?.();
  if (id === 'absolute-dark') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
  } else if (id === 'indoor-bright') {
    ctx.fillStyle = gradient(ctx, 0, 0, 0, height,
      [[0, '#eef3f0'], [0.62, '#dfe5e1'], [0.625, '#c6beb2'], [1, '#8f877d']], '#dfe5e1');
    ctx.fillRect(0, 0, width, height);
    // 高亮窗面 + 地面投光：原创的低细节场景，不捆绑 Studio 的背景照片资产。
    ctx.fillStyle = 'rgba(252,255,253,.9)';
    ctx.fillRect(width * .07, height * .07, width * .38, height * .43);
    ctx.fillStyle = 'rgba(125,148,146,.24)';
    ctx.fillRect(width * .255, height * .07, Math.max(2, width * .008), height * .43);
    ctx.fillRect(width * .07, height * .275, width * .38, Math.max(2, height * .006));
    ctx.fillStyle = radialGradient(ctx, width * .27, height * .23, 0, width * .27, height * .23, width * .5,
      [[0, 'rgba(255,255,247,.68)'], [1, 'rgba(255,255,247,0)']], 'rgba(255,255,247,.32)');
    ctx.beginPath?.();
    ctx.arc?.(width * .27, height * .23, width * .48, 0, Math.PI * 2);
    ctx.fill?.();
    ctx.fillStyle = 'rgba(95,87,77,.22)';
    ctx.fillRect(width * .58, height * .47, width * .3, height * .11);
    ctx.fillRect(width * .61, height * .58, width * .025, height * .2);
    ctx.fillRect(width * .83, height * .58, width * .025, height * .2);
  } else {
    ctx.fillStyle = gradient(ctx, 0, 0, 0, height,
      [[0, '#07101a'], [0.52, '#10202c'], [1, '#0a0b10']], '#101727');
    ctx.fillRect(0, 0, width, height);
    // 透视路面。
    ctx.fillStyle = gradient(ctx, width * .5, height * .42, width * .5, height,
      [[0, 'rgba(82,74,64,.42)'], [.58, 'rgba(109,74,39,.55)'], [1, 'rgba(39,29,23,.9)']], '#261d18');
    ctx.beginPath?.();
    ctx.moveTo?.(width * .44, height * .4);
    ctx.lineTo?.(width * .57, height * .4);
    ctx.lineTo?.(width * .88, height);
    ctx.lineTo?.(width * .12, height);
    ctx.closePath?.();
    ctx.fill?.();
    // 树干与路灯剪影。
    ctx.fillStyle = 'rgba(3,8,12,.86)';
    for (const [x, w] of [[.02, .07], [.14, .045], [.82, .055], [.93, .07]]) {
      ctx.fillRect(width * x, 0, width * w, height);
    }
    for (const [x, y, scale] of [[.58, .2, 1], [.54, .38, .72], [.515, .52, .48]]) {
      const glow = radialGradient(ctx, width * x, height * y, 0, width * x, height * y, width * .16 * scale,
        [[0, 'rgba(255,214,131,.76)'], [.24, 'rgba(244,174,72,.3)'], [1, 'rgba(244,174,72,0)']], 'rgba(244,174,72,.18)');
      ctx.fillStyle = glow;
      ctx.beginPath?.();
      ctx.arc?.(width * x, height * y, width * .16 * scale, 0, Math.PI * 2);
      ctx.fill?.();
      ctx.fillStyle = 'rgba(249,211,138,.94)';
      ctx.fillRect(width * (x - .012 * scale), height * (y - .015 * scale), width * .024 * scale, height * .03 * scale);
      ctx.fillStyle = 'rgba(15,18,18,.92)';
      ctx.fillRect(width * (x + .018 * scale), height * y, Math.max(2, width * .009 * scale), height * .39 * scale);
    }
  }
  ctx.restore?.();
  return id;
}

/** Studio 同款的输出画布与 AIUI 画布摆位；所有数值按引擎 backing 等比放大。 */
export function previewGeometry(engineCanvas, mode = 'studio', { width, height } = {}) {
  const engineWidth = Number(engineCanvas?.width) || 0;
  const engineHeight = Number(engineCanvas?.height) || 0;
  if (!engineWidth || !engineHeight) throw new Error('引擎 canvas 没有有效尺寸');
  const preview = normalizePreviewMode(mode);
  const outputWidth = Number(width) || engineWidth;
  const outputHeight = Number(height) || (preview === 'optical'
    ? Math.round(outputWidth * AR_FRAME.height / AR_FRAME.width)
    : Math.round(engineHeight * outputWidth / engineWidth));
  const drawWidth = outputWidth;
  const drawHeight = engineHeight * outputWidth / engineWidth;
  return {
    mode: preview,
    width: outputWidth,
    height: outputHeight,
    content: {
      x: 0,
      y: preview === 'optical' ? (outputHeight - drawHeight) / 2 : 0,
      width: drawWidth,
      height: drawHeight,
    },
  };
}

/**
 * 黑底画面去底：以最大 RGB 通道估计覆盖度，再反除覆盖度恢复前景色。
 * 原图已经混入黑底，不能把所有非黑像素当成不透明色（会产生黑边）。
 * 这是确定性的预览约定，无法反推应用原始 alpha；重新叠到黑底应还原源图。
 */
export function unmatteBlackPixels(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const peak = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (peak === 0) { rgba[i + 3] = 0; continue; }
    rgba[i] = Math.round(rgba[i] * 255 / peak);
    rgba[i + 1] = Math.round(rgba[i + 1] * 255 / peak);
    rgba[i + 2] = Math.round(rgba[i + 2] * 255 / peak);
    rgba[i + 3] = Math.round(rgba[i + 3] * peak / 255);
  }
  return rgba;
}

// 每个引擎复用一张暂存画布，录屏每帧更新内容，不改写引擎的原始画布。
const unmattedCanvases = new WeakMap();
function unmattedCanvas(source) {
  let entry = unmattedCanvases.get(source);
  if (!entry) {
    const canvas = source.ownerDocument.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建黑底透明合成画布');
    entry = { canvas, ctx };
    unmattedCanvases.set(source, entry);
  }
  const { canvas, ctx } = entry;
  if (canvas.width !== source.width) canvas.width = source.width;
  if (canvas.height !== source.height) canvas.height = source.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  unmatteBlackPixels(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

/** 把当前预览口径画到目标 context，DOM、截图与录屏都走这一套合成规则。 */
export function paintPreviewFrame(ctx, engineCanvas, {
  mode = 'studio', lighting = 'absolute-dark', width, height,
} = {}) {
  if (!ctx || !engineCanvas) throw new TypeError('paintPreviewFrame 需要 context 和引擎 canvas');
  const preview = normalizePreviewMode(mode);
  const geometry = previewGeometry(engineCanvas, preview, { width, height });
  const w = geometry.width;
  const h = geometry.height;
  if (preview === 'studio') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
  } else {
    paintLightingBackground(ctx, w, h, lighting);
  }
  ctx.save?.();
  ctx.globalCompositeOperation = 'source-over';
  const box = geometry.content;
  ctx.drawImage(preview === 'optical' ? unmattedCanvas(engineCanvas) : engineCanvas,
    box.x, box.y, box.width, box.height);
  ctx.restore?.();
  return preview;
}

/** 合成后的画布才是截图证据；仅给 DOM 套背景会让导出与屏幕所见不一致。 */
export function compositePreviewCanvas(engineCanvas, {
  mode = 'studio', lighting = 'absolute-dark',
  createCanvas = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return canvas;
  },
} = {}) {
  if (!engineCanvas) throw new TypeError('compositePreviewCanvas 需要引擎 canvas');
  const geometry = previewGeometry(engineCanvas, mode);
  const canvas = createCanvas(geometry.width, geometry.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器拿不到 2D canvas，无法合成光照背景');
  paintPreviewFrame(ctx, engineCanvas, {
    mode, lighting, width: geometry.width, height: geometry.height,
  });
  return canvas;
}

/** 保留旧 API：明确表示这是 optical 黑底透明合成，不是 Studio 黑底。 */
export function compositeLightingCanvas(engineCanvas, profile, options = {}) {
  return compositePreviewCanvas(engineCanvas, { ...options, mode: 'optical', lighting: profile });
}
