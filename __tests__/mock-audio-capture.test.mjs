import test from 'node:test';
import assert from 'node:assert/strict';
import { installMockAudioCapture } from '../lib/mock-audio-capture.mjs';

class Track {
  constructor() { this.kind = 'audio'; this.stopped = false; }
  stop() { this.stopped = true; }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
}

test('simulated ASR never requests the real microphone; disposal stops owned tracks and restores the native method', async () => {
  const calls = [];
  const original = async constraints => { calls.push(constraints); return 'native-video'; };
  const navigatorRef = { mediaDevices: { getUserMedia: original } };
  const adapter = installMockAudioCapture({ navigatorRef, TrackGenerator: Track, MediaStreamCtor: Stream });
  const stream = await navigatorRef.mediaDevices.getUserMedia({ audio: true, video: false });
  assert.equal(stream.getTracks()[0].kind, 'audio');
  assert.deepEqual(calls, []);
  assert.equal(await navigatorRef.mediaDevices.getUserMedia({ video: true }), 'native-video');
  await assert.rejects(navigatorRef.mediaDevices.getUserMedia({ audio: true, video: true }), /audio-only/);
  assert.equal(calls.length, 1);
  adapter.dispose();
  assert.equal(stream.getTracks()[0].stopped, true);
  assert.equal(navigatorRef.mediaDevices.getUserMedia, original);
  adapter.dispose();
});

test('stopping a track releases it without disposal clobbering a newer capture owner', async () => {
  const navigatorRef = { mediaDevices: { getUserMedia: async () => {} } };
  const adapter = installMockAudioCapture({ navigatorRef, TrackGenerator: Track, MediaStreamCtor: Stream });
  const stream = await navigatorRef.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks()[0].stop();
  const newer = async () => 'newer';
  navigatorRef.mediaDevices.getUserMedia = newer;
  adapter.dispose();
  assert.equal(navigatorRef.mediaDevices.getUserMedia, newer);
  assert.equal(stream.getTracks()[0].stopped, true);
});

test('AudioContext fallback stays suspended and closes its destination on cleanup', async () => {
  let closed = 0;
  class Context {
    createMediaStreamDestination() { return { stream: new Stream([new Track()]) }; }
    close() { closed++; return Promise.resolve(); }
  }
  const navigatorRef = { mediaDevices: { getUserMedia: async () => { throw new Error('Real microphone contacted'); } } };
  const adapter = installMockAudioCapture({ navigatorRef, TrackGenerator: null, AudioContextCtor: Context });
  await navigatorRef.mediaDevices.getUserMedia({ audio: true });
  adapter.dispose();
  assert.equal(closed, 1);
});
