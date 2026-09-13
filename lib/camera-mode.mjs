// camera-mode.mjs — InkLab 的相机来源开关。
//
// 当前引擎的浏览器 media 后端覆盖取流/录音，但**没有 takePhoto**；直接删掉 media.takePhoto
// 只会得到“未配置”错误，并不会拍照。因此 computer 模式保留其余模拟媒体方法，只替换
// takePhoto 为 InkLab 的浏览器摄像头适配器。

export const CAMERA_MODES = Object.freeze({
  MOCK: 'mock',
  COMPUTER: 'computer',
});

/** 未知值一律回到 mock：自动化环境绝不能因为拼错参数意外点亮摄像头。 */
export function normalizeCameraMode(value) {
  return String(value || '').trim().toLowerCase() === CAMERA_MODES.COMPUTER
    ? CAMERA_MODES.COMPUTER
    : CAMERA_MODES.MOCK;
}

export function cameraModeFromSearch(search = '') {
  return normalizeCameraMode(new URLSearchParams(String(search)).get('camera'));
}

/**
 * mock：原样注入完整能力集；computer：只替换 media.takePhoto，其余方法保持原样。
 * 返回浅拷贝，避免为一次手动切换改写 createHostCapabilities() 的完整控制面。
 */
export function hostCapabilitiesForCameraMode(capabilities, mode, { computerTakePhoto } = {}) {
  const selected = normalizeCameraMode(mode);
  if (selected === CAMERA_MODES.MOCK) return capabilities || {};
  if (typeof computerTakePhoto !== 'function') {
    throw new TypeError('InkLab: computer 相机模式需要 computerTakePhoto 适配器');
  }
  return {
    ...(capabilities || {}),
    media: { ...((capabilities && capabilities.media) || {}), takePhoto: computerTakePhoto },
  };
}
