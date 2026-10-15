import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechCapabilities } from '../lib/caps/speech.mjs';
import { createMediaCapabilities } from '../lib/caps/media.mjs';

function clock() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(fn) { const id = ++next; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    flush() { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    pending,
  };
}
const route = sessionId => ({ targetId: 'recognition-target', sessionId });

test('stream recognition opens, accepts audio, receives injected text and finishes with routed events', async () => {
  const events = [];
  const speech = createSpeechCapabilities({ dispatchEvent: (name, detail) => events.push({ name, detail }) });
  const api = speech.capabilities.speech;
  const formats = await api.getRecognitionCapabilities({});
  assert.equal(formats.audioFormats[0].mimeType, 'audio/wav');
  formats.audioFormats[0].mimeType = 'changed';
  assert.equal((await api.getRecognitionCapabilities({})).audioFormats[0].mimeType, 'audio/wav');
  await api.openRecognitionStream({ ...route('stream-1'), audio: { mimeType: 'audio/wav' }, interimResults: true });
  await api.writeRecognitionAudio({ ...route('stream-1'), bytes: new Uint8Array(684), isLastPart: true });
  assert.equal(speech.isListening(), true);
  assert.equal(events.filter(e => e.name === 'speech.result').length, 0);
  speech.say('打开设置');
  assert.equal(events.find(e => e.name === 'speech.result').detail.alternatives[0].transcript, '打开设置');
  await api.finishRecognitionStream(route('stream-1'));
  assert.equal(speech.isListening(), false);
  for (const e of events) assert.deepEqual({ targetId: e.detail.targetId, sessionId: e.detail.sessionId }, route('stream-1'));
  const write = speech.calls.find(c => c.method === 'writeRecognitionAudio');
  assert.equal(write.args.byteLength, 684);
  assert.equal(write.args.bytes, undefined);
});

test('ending a superseded stream does not close the current recognition', async () => {
  const timers = clock(), events = [];
  const speech = createSpeechCapabilities({ dispatchEvent: (name, detail) => events.push({ name, detail }), ...timers });
  const api = speech.capabilities.speech;
  await api.openRecognitionStream(route('old'));
  speech.say('stale', { delayMs: 10 });
  await api.openRecognitionStream(route('new'));
  await api.abortRecognitionStream(route('old'));
  timers.flush();
  assert.equal(speech.currentSession().sessionId, 'new');
  assert.ok(!events.some(e => e.name === 'speech.result'));
  await api.abortRecognitionStream(route('new'));
  assert.equal(speech.isListening(), false);
});

test('native mock WAV recorder emits start, PCM warmup, final chunk and stop, then releases its stream', async () => {
  const timers = clock(), events = [];
  const media = createMediaCapabilities({ allowImplicitAudioStreams: true, ...timers,
    dispatchEvent: (name, detail) => events.push({ name, detail }) });
  const api = media.capabilities.media;
  const args = { streamId: 'engine-native-stream', recorderId: 'recorder', mimeType: 'audio/wav' };
  await api.createMediaRecorder(args);
  await api.startMediaRecorder({ recorderId: 'recorder', timesliceMs: 100 });
  assert.equal(events.length, 0);
  timers.flush();
  assert.deepEqual(events.map(e => e.name), ['media.mediaRecorderStarted', 'media.mediaRecorderData']);
  assert.equal(events[1].detail.bytes.byteLength, 640);
  assert.ok(events[1].detail.bytes.every(byte => byte === 0));
  assert.equal(events[1].detail.targetId, 'recorder');
  await api.stopMediaRecorder({ recorderId: 'recorder' });
  assert.equal(events.at(-1).detail.isLastChunk, true);
  timers.flush();
  assert.equal(events.at(-1).name, 'media.mediaRecorderStopped');
  assert.deepEqual(media.recorders(), []);
  assert.deepEqual(media.streams(), []);
});

test('implicit browser stream adoption is opt-in and audio-only; reset cancels pending events', async () => {
  const args = { streamId: 'unknown', recorderId: 'recorder', mimeType: 'audio/wav' };
  const ordinary = createMediaCapabilities();
  await assert.rejects(ordinary.capabilities.media.createMediaRecorder(args), /unavailable/);
  const timers = clock(), events = [];
  const media = createMediaCapabilities({ allowImplicitAudioStreams: true, ...timers,
    dispatchEvent: (name, detail) => events.push({ name, detail }) });
  await assert.rejects(media.capabilities.media.createMediaRecorder({ ...args, mimeType: 'video/webm' }), /unavailable/);
  await media.capabilities.media.createMediaRecorder(args);
  await media.capabilities.media.startMediaRecorder({ recorderId: 'recorder' });
  media.reset();
  timers.flush();
  assert.deepEqual(events, []);
  assert.equal(timers.pending.size, 0);
});
