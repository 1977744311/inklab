import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createComputerCameraTakePhoto, requestComputerCameraPermission,
} from '../lib/browser-camera.mjs';

test('电脑摄像头授权：明确调用才申请权限，成功后不取图并立即停轨', async () => {
  let requested = null;
  let stopped = 0;
  const track = { stop: () => { stopped += 1; } };
  const mediaDevices = {
    getUserMedia(constraints) {
      requested = constraints;
      return Promise.resolve({
        getVideoTracks: () => [track],
        getTracks: () => [track],
      });
    },
  };

  assert.equal(requested, null);
  const result = await requestComputerCameraPermission({ mediaDevices });
  assert.deepEqual(requested, { video: true, audio: false });
  assert.deepEqual(result, { videoTracks: 1 });
  assert.equal(stopped, 1);
});

test('电脑摄像头：应用调用时才 getUserMedia，返回 Ink takePhoto 字节形状并立即停轨', async () => {
  let requested = null;
  let stopped = 0;
  const track = { stop: () => { stopped += 1; } };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
  class FakeImageCapture {
    constructor(got) { assert.equal(got, track); }
    async takePhoto() { return new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' }); }
  }
  const takePhoto = createComputerCameraTakePhoto({
    mediaDevices: {
      getUserMedia(constraints) { requested = constraints; return Promise.resolve(stream); },
    },
    ImageCaptureCtor: FakeImageCapture,
    documentRef: null,
  });

  assert.equal(requested, null, '创建适配器和切换模式都不应提前请求摄像头');
  const result = await takePhoto({ quality: 'high' });
  assert.deepEqual(requested, { video: true, audio: false });
  assert.deepEqual([...result.data], [7, 8, 9]);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(stopped, 1, '拍完立即停轨，不能让电脑摄像头指示灯常亮');
});

test('电脑摄像头：浏览器无 mediaDevices 时给清晰的不支持错误', async () => {
  const takePhoto = createComputerCameraTakePhoto({ mediaDevices: null, documentRef: null });
  await assert.rejects(takePhoto(), (err) => (
    err && err.name === 'NotSupportedError' && /mediaDevices/.test(err.message)
  ));
});

test('电脑摄像头：没有 ImageCapture 时退到 video + canvas 采帧', async () => {
  let drawn = false;
  let stopped = false;
  const track = {
    stop: () => { stopped = true; },
    getSettings: () => ({ width: 320, height: 240 }),
  };
  const video = {
    videoWidth: 320, videoHeight: 240, srcObject: null,
    pause: () => {},
  };
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage: () => { drawn = true; } }),
    toBlob: (done, type) => done(new Blob([new Uint8Array([4, 5])], { type })),
  };
  const documentRef = {
    createElement: (tag) => (tag === 'video' ? video : canvas),
  };
  const takePhoto = createComputerCameraTakePhoto({
    mediaDevices: {
      getUserMedia: async () => ({
        getVideoTracks: () => [track],
        getTracks: () => [track],
      }),
    },
    ImageCaptureCtor: null,
    documentRef,
  });

  const result = await takePhoto({ quality: 'medium' });
  assert.equal(drawn, true);
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 240);
  assert.deepEqual([...result.data], [4, 5]);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(stopped, true);
  assert.equal(video.srcObject, null, '采帧后解除 video 对流的引用');
});
