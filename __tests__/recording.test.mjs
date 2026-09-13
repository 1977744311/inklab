import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanvasRecorder, describeRecordingType, recordingFilename,
  safeRecordingName, supportedRecordingFormats,
} from '../lib/recording.mjs';

test('录屏格式优先 H.264 MP4，浏览器不支持时才退到 WebM', () => {
  class Mp4AndWebm {}
  Mp4AndWebm.isTypeSupported = (type) => type.includes('mp4') || type.includes('vp8');
  assert.deepEqual(supportedRecordingFormats(Mp4AndWebm).map((x) => x.extension), ['mp4', 'mp4', 'webm']);
  assert.equal(supportedRecordingFormats(Mp4AndWebm)[0].mimeType, 'video/mp4;codecs=avc1.42E01E');

  class WebmOnly {}
  WebmOnly.isTypeSupported = (type) => type === 'video/webm;codecs=vp8';
  assert.deepEqual(supportedRecordingFormats(WebmOnly).map((x) => x.mimeType), ['video/webm;codecs=vp8']);
  assert.equal(describeRecordingType('video/mp4;codecs=avc1.42001f').pptReady, true);
  assert.equal(describeRecordingType('video/webm;codecs=vp9').pptReady, false);
});

test('录屏文件名保留场景语义，去掉跨平台非法字符并带本地时间', () => {
  assert.equal(safeRecordingName(' 场景 / A:*? '), '场景-A');
  const at = new Date(2026, 7, 28, 15, 6, 7).getTime();
  assert.equal(recordingFilename('scene-result', at, 'mp4'), 'inklab-scene-result-20260828-150607.mp4');
});

function fakeRecorderClass({ mime = 'video/mp4;codecs=avc1.42E01E' } = {}) {
  return class FakeMediaRecorder {
    static isTypeSupported(type) { return type.startsWith('video/mp4'); }
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = opts.mimeType || mime;
      this.state = 'inactive';
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x !== fn));
    }
    emit(type, event = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = 'recording'; }
    stop() {
      this.emit('dataavailable', { data: new Blob(['video-bytes'], { type: this.mimeType }) });
      this.state = 'inactive';
      queueMicrotask(() => this.emit('stop'));
    }
  };
}

test('canvas 录屏从主画布尺寸取流，stop 后得到可下载的 PPT MP4 并停轨', async () => {
  let now = new Date(2026, 7, 28, 15, 6, 7).getTime();
  let stopped = 0;
  let requested = 0;
  let fpsSeen = 0;
  const stream = {
    getTracks: () => [{ stop: () => { stopped += 1; } }],
    getVideoTracks: () => [{ requestFrame: () => { requested += 1; } }],
  };
  const canvas = {
    width: 960, height: 704,
    captureStream: (fps) => { fpsSeen = fps; return stream; },
  };
  const Recorder = fakeRecorderClass();
  const controller = createCanvasRecorder({
    MediaRecorder: Recorder,
    createObjectURL: () => 'blob:inklab-recording',
    revokeObjectURL: () => {},
    now: () => now,
  });

  const started = controller.start({ canvas, name: 'scene/result', fps: 30, meta: { scenarioId: 'result' } });
  assert.equal(started.mimeType, 'video/mp4;codecs=avc1.42E01E');
  assert.equal(started.pptReady, true);
  assert.equal(fpsSeen, 30);
  assert.equal(controller.active.name, 'scene-result');
  assert.throws(() => controller.start({ canvas }), /已有录屏/);

  now += 2345;
  const rec = await controller.stop();
  assert.equal(rec.filename, 'inklab-scene-result-20260828-150607.mp4');
  assert.equal(rec.durationMs, 2345);
  assert.equal(rec.width, 960);
  assert.equal(rec.height, 704);
  assert.equal(rec.pptReady, true);
  assert.equal(rec.objectUrl, 'blob:inklab-recording');
  assert.ok(rec.blob.size > 0);
  assert.equal(stopped, 1);
  assert.ok(requested >= 2, '开始与停止各主动要一帧，静态画面也不能是空片');
  assert.equal(controller.active, null);
  assert.equal(controller.recordings.length, 1);
});

test('没有 MediaRecorder / captureStream 时响亮失败，不生成伪视频', () => {
  const none = createCanvasRecorder({ MediaRecorder: undefined });
  assert.equal(none.supported(), false);
  assert.throws(() => none.start({ canvas: {} }), /没有 MediaRecorder/);

  class Recorder {}
  Recorder.isTypeSupported = () => true;
  const supported = createCanvasRecorder({ MediaRecorder: Recorder });
  assert.throws(() => supported.start({ canvas: {} }), /captureStream/);
});

test('MediaRecorder.start 失败时立即停掉 canvas stream，控制器可重试', () => {
  let stopped = 0;
  const stream = {
    getTracks: () => [{ stop: () => { stopped += 1; } }],
    getVideoTracks: () => [],
  };
  class BrokenRecorder {
    static isTypeSupported(type) { return type.startsWith('video/mp4'); }
    constructor(_stream, opts) { this.mimeType = opts.mimeType; }
    addEventListener() {}
    start() { throw new Error('encoder unavailable'); }
  }
  const controller = createCanvasRecorder({ MediaRecorder: BrokenRecorder });
  assert.throws(
    () => controller.start({ canvas: { width: 1, height: 1, captureStream: () => stream } }),
    /无法开始录制.*encoder unavailable/,
  );
  assert.equal(stopped, 1);
  assert.equal(controller.active, null);
});
