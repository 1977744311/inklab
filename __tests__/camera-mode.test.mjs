import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMERA_MODES, cameraModeFromSearch, hostCapabilitiesForCameraMode, normalizeCameraMode,
} from '../lib/camera-mode.mjs';

test('相机模式：缺省和未知值安全回落 mock，只有 computer 显式开启电脑摄像头', () => {
  assert.equal(normalizeCameraMode(), CAMERA_MODES.MOCK);
  assert.equal(normalizeCameraMode('wat'), CAMERA_MODES.MOCK);
  assert.equal(normalizeCameraMode('COMPUTER'), CAMERA_MODES.COMPUTER);
  assert.equal(cameraModeFromSearch('?camera=computer'), CAMERA_MODES.COMPUTER);
  assert.equal(cameraModeFromSearch('?camera=real'), CAMERA_MODES.MOCK);
});

test('能力选择：mock 保留媒体模拟，computer 只替换 takePhoto 且不改写原对象', () => {
  const capabilities = {
    sensors: { start: () => {} },
    speech: { speak: () => {} },
    media: { takePhoto: () => {} },
    llm: { getConfig: () => {} },
  };

  assert.equal(hostCapabilitiesForCameraMode(capabilities, 'mock'), capabilities);

  const takePhoto = async () => ({ data: new Uint8Array([1]), mimeType: 'image/jpeg' });
  const computer = hostCapabilitiesForCameraMode(capabilities, 'computer', { computerTakePhoto: takePhoto });
  assert.deepEqual(Object.keys(computer), ['sensors', 'speech', 'media', 'llm']);
  assert.equal(computer.sensors, capabilities.sensors);
  assert.equal(computer.media.takePhoto, takePhoto);
  assert.equal(capabilities.media.takePhoto === takePhoto, false, '原始模拟能力不能被改写');
  assert.throws(
    () => hostCapabilitiesForCameraMode(capabilities, 'computer'),
    /computerTakePhoto/,
    '电脑模式缺适配器要在启动时响亮失败',
  );
});
