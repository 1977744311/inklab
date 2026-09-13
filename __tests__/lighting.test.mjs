import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AR_FRAME, LIGHTING_PROFILES, PREVIEW_MODES, normalizeLightingProfile, normalizePreviewMode,
  paintLightingBackground, unmatteBlackPixels, previewGeometry, compositePreviewCanvas, compositeLightingCanvas,
} from '../lib/lighting.mjs';

function fakeContext(calls) {
  return {
    fillStyle: '', globalCompositeOperation: 'source-over',
    save: () => calls.push('save'), restore: () => calls.push('restore'),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    beginPath: () => calls.push('beginPath'), arc: (...args) => calls.push(['arc', ...args]),
    moveTo: (...args) => calls.push(['moveTo', ...args]), lineTo: (...args) => calls.push(['lineTo', ...args]),
    closePath: () => calls.push('closePath'), fill: () => calls.push('fill'),
    drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
    createLinearGradient: () => ({ addColorStop: (at, color) => calls.push(['stop', at, color]) }),
    createRadialGradient: () => ({ addColorStop: (at, color) => calls.push(['radial-stop', at, color]) }),
  };
}

test('三种光照 profile 固定存在，未知值安全回退绝对黑暗', () => {
  assert.deepEqual(LIGHTING_PROFILES.map((p) => p.id), ['absolute-dark', 'indoor-bright', 'night-low-light']);
  assert.equal(normalizeLightingProfile('indoor-bright'), 'indoor-bright');
  assert.equal(normalizeLightingProfile('nope'), 'absolute-dark');
});

test('预览口径分开效果预览与 480×640 真机模拟，默认走横向效果预览', () => {
  assert.deepEqual(PREVIEW_MODES.map((p) => p.id), ['studio', 'optical']);
  assert.deepEqual(AR_FRAME, { width: 480, height: 640, contentTop: 144, contentHeight: 352 });
  assert.equal(normalizePreviewMode('optical'), 'optical');
  assert.equal(normalizePreviewMode('nope'), 'studio');
});

test('真机模拟等比输出 3:4 竖帧，AIUI 画布在上下正中', () => {
  const engine = { width: 960, height: 704 };
  assert.deepEqual(previewGeometry(engine, 'studio'), {
    mode: 'studio', width: 960, height: 704,
    content: { x: 0, y: 0, width: 960, height: 704 },
  });
  assert.deepEqual(previewGeometry(engine, 'optical'), {
    mode: 'optical', width: 960, height: 1280,
    content: { x: 0, y: 288, width: 960, height: 704 },
  });
});

test('效果预览导出横幅 source-over，真机模拟导出竖幅黑底透明合成', () => {
  const calls = [];
  const ctx = fakeContext(calls);
  paintLightingBackground(ctx, 480, 352, 'night-low-light');
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'fillRect'));

  const output = { width: 0, height: 0, getContext: () => ctx };
  const pixelData = new Uint8ClampedArray([0, 0, 0, 255, 0, 180, 0, 255]);
  let keyedPixels;
  const scratch = { width: 0, height: 0, getContext: () => ({
    clearRect() {}, drawImage() {},
    getImageData: () => ({ data: pixelData.slice() }),
    putImageData: ({ data }) => { keyedPixels = data; },
  }) };
  const engine = { width: 480, height: 352, ownerDocument: { createElement: () => scratch } };
  assert.equal(compositePreviewCanvas(engine, { mode: 'studio', lighting: 'indoor-bright', createCanvas: (w, h) => {
    output.width = w; output.height = h; return output;
  } }), output);
  assert.deepEqual({ width: output.width, height: output.height }, { width: 480, height: 352 });
  assert.equal(ctx.globalCompositeOperation, 'source-over');

  assert.equal(compositeLightingCanvas(engine, 'indoor-bright', { createCanvas: (w, h) => {
    output.width = w; output.height = h; return output;
  } }), output);
  assert.deepEqual({ width: output.width, height: output.height }, { width: 480, height: 640 });
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  assert.deepEqual([...keyedPixels], [0, 0, 0, 0, 0, 255, 0, 180]);
  assert.equal(pixelData[3], 255, '不得改写引擎源像素');
  assert.deepEqual(calls.filter((c) => Array.isArray(c) && c[0] === 'drawImage').at(-1),
    ['drawImage', 0, 144, 480, 352]);
});


test('黑底污染边缘还原成绿色半透明前景，不再是不透明暗绿', () => {
  const pixels = new Uint8ClampedArray([0,0,0,255, 0,64,0,255, 0,1,0,255, 51,255,80,255]);
  assert.deepEqual([...unmatteBlackPixels(pixels)],
    [0,0,0,0, 0,255,0,64, 0,255,0,1, 51,255,80,255]);
  // 25% 覆盖度的绿色边缘叠到灰底，应是浅绿色，而非原先的 #004000 黑边。
  const edge = pixels.slice(4,8), a = edge[3] / 255;
  const overGray = [0,1,2].map((i) => Math.round(edge[i] * a + 240 * (1-a)));
  assert.deepEqual(overGray, [180,244,180]);
});

test('重新叠到黑底恢复原始明暗层级，透明源与彩色源同样成立', () => {
  const samples = [[0,1,0,255],[0,80,0,255],[13,64,20,255],[140,255,182,255],
    [64,128,96,128],[200,30,15,255],[0,0,0,128],[255,255,255,255],[100,200,50,0]];
  for (const sample of samples) {
    const result = unmatteBlackPixels(new Uint8ClampedArray(sample));
    for (let channel = 0; channel < 3; channel++) {
      const before = Math.round(sample[channel] * sample[3] / 255);
      const after = Math.round(result[channel] * result[3] / 255);
      assert.ok(Math.abs(before-after) <= 1, `${sample}: channel ${channel} drift`);
    }
  }
});
