// e2e.js — e2e 取证：源码指纹与截图基线比对（跑在页面里，runner 经 CDP 拿结论）。

import { CAMERA_MODES } from '/host/lib/camera-mode.mjs';
import { BLUETOOTH_MODES } from '/host/lib/bluetooth-mode.mjs';
import { createShotStore } from '/host/lib/shots.mjs';
import { createSourceStamp } from '/host/lib/stamp.mjs';
import { findScenario, hostFetch, primaryStage, state } from '/host/inklab/state.js';

// ── e2e 取证：源码指纹 + 截图基线比对（跑在页面里，runner 经 CDP 拿结论） ──

/**
 * 当前装载的源码指纹（lib/stamp.mjs）。必须用**本轮装载在内存里的那份文件表**算——
 * 渲染完回头 stat 磁盘会拼出「改后源码 + 改前画面」的假证据（stamp.mjs 头注第 6 条）。
 */
export function stampFor(scenarioId) {
  const main = primaryStage();
  if (!state.lastLoad || !main) throw new Error('还没装载完，算不了源码指纹');
  const { files } = state.lastLoad;
  const fixtureParts = [];
  // 默认 E2E 口径保持旧 stamp：Studio 黑底 + mock 相机/蓝牙 + llm off 不额外加噪。
  // 背景叠加规则进指纹，避免沿用旧 screen 混合的截图基线。
  if (state.previewMode !== 'studio') fixtureParts.push(`preview:${state.previewMode}`, 'composite:black-unmatte-v2');
  if (state.previewMode === 'optical' && state.lighting !== 'absolute-dark') {
    fixtureParts.push(`lighting:${state.lighting}`);
  }
  if (state.cameraMode !== CAMERA_MODES.MOCK) fixtureParts.push(`camera:${state.cameraMode}`);
  if (state.bluetoothMode !== BLUETOOTH_MODES.MOCK) fixtureParts.push(`bluetooth:${state.bluetoothMode}`);
  if (state.llm && state.llm.mode !== 'off') fixtureParts.push(`llm:${state.llm.mode}`);
  return createSourceStamp({
    files,
    engine: {
      build: main.runtime.engineBuild, version: main.runtime.engineVersion,
      wasmSha256: main.runtime.wasmSha256 || '',
    },
    viewport: { width: main.width, height: main.height, scaleFactor: main.scaleFactor },
    scenario: scenarioId || '',
    // LLM 模式进夹具 id：replay 喂录像跑出来的屏和 off 走离线路径跑出来的屏不是同一张证据。
    fixtures: fixtureParts.join('|'),
  });
}

/** dataUrl / objectURL → RGBA 像素（shots.mjs 吃的形状）。 */
async function decodeImage(src) {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('图像解码失败'));
    img.src = src;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

/**
 * 上一次 runScenario 的截图 vs 工程基线（<app>/e2e/baselines/<scenarioId>/）。
 * 比对在页面里做（canvas 解码 + shots.mjs 的像素 diff）；写基线不在这儿——
 * 页面落不了盘，accept 由 e2e runner 拿返回值里的 dataUrl 写文件。
 */
export async function e2eShotReport(scenarioId) {
  const report = state.lastScenario;
  if (!report || report.scenarioId !== scenarioId) {
    throw new Error(`先跑 ${scenarioId} 再要报告（lastScenario=${(report && report.scenarioId) || '无'}）`);
  }
  const scenario = findScenario(scenarioId);
  const stampInfo = stampFor(scenarioId);
  const baseDir = `e2e/baselines/${scenarioId}`;
  const known = ((state.info.e2e && state.info.e2e.baselines) || [])
    .filter((p) => p.startsWith(baseDir + '/') && p.endsWith('.png'))
    .map((p) => p.slice(baseDir.length + 1, -4));

  const readShot = async (name) => {
    const res = await hostFetch(`/app/${baseDir}/${name}.png`, { cache: 'no-store' });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    let image;
    try { image = await decodeImage(url); } finally { URL.revokeObjectURL(url); }
    let meta = {};
    try {
      const m = await hostFetch(`/app/${baseDir}/${name}.json`, { cache: 'no-store' });
      if (m.ok) meta = await m.json();
    } catch { /* 没有元数据的老基线：sourceStamp 缺席会被判 stale，正是想要的 */ }
    return { image, capturedAt: meta.capturedAt ?? null, sourceStamp: meta.sourceStamp ?? null };
  };
  const store = createShotStore({
    readShot,
    writeShot: () => { throw new Error('页面里不落盘，accept 由 e2e runner 做'); },
    listShots: () => known,
    defaultDiffOptions: (scenario && scenario.shotOptions) || {},
  });

  const shots = [];
  for (const rec of report.shots) {
    const v = rec.value || rec;
    const image = await decodeImage(v.dataUrl);
    shots.push({
      name: rec.name,
      dataUrl: v.dataUrl,
      width: image.width,
      height: image.height,
      image,
      diffOptions: rec.diffOptions || null,
    });
  }
  const baseline = await store.compareAll(
    shots.map((s) => ({ name: s.name, image: s.image, diffOptions: s.diffOptions })),
    { sourceStamp: stampInfo.stamp },
  );
  return {
    scenarioId,
    stamp: stampInfo.stamp,
    stampParts: stampInfo.parts,
    hasBaselines: known.length > 0,
    shots: shots.map(({ name, dataUrl, width, height }) => ({ name, dataUrl, width, height })),
    baseline,
  };
}
