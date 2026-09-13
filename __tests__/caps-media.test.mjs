// 媒体能力：拍照喂图（队列/当前项）、轨道事件回灌、故障注入三态、真机延迟。
// 纯逻辑：假钟 + 假 readFile，零 IO 零定时器，node --test 直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMediaCapabilities, DEFAULT_TAKE_PHOTO_DELAY_MS, DEFAULT_MEDIA_DEVICES, FAILURE_KINDS,
} from '../lib/caps/media.mjs';
import { CAPABILITY_METHODS, composeCapabilities } from '../lib/caps/contract.mjs';

// ── 测试替身 ────────────────────────────────────────────────────────────

/** 排空微任务：断言"还没结算"之前必须先排空，否则测的是调度时机不是逻辑。 */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

/** 假钟：sleep 挂账不真等，advance 推进时间并放行到期的等待。 */
function createFakeClock(start = 0) {
  let t = start;
  let waiters = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => { waiters.push({ at: t + ms, resolve }); }),
    async advance(ms) {
      t += ms;
      const due = waiters.filter((w) => w.at <= t);
      waiters = waiters.filter((w) => w.at > t);
      for (const w of due) w.resolve();
      await flush();
    },
  };
}

/** 观察一个 promise 是否已结算——不 await，免得永不结算的用例把测试挂死。 */
function watch(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => { state.settled = true; state.value = v; },
    (e) => { state.settled = true; state.error = e; },
  );
  return state;
}

const bytesOf = (...ns) => Uint8Array.from(ns);

/** 一套装好的场景：假钟 + 事件收集 + 假 readFile（名字 → 字节）。 */
function setup({ files = {}, ...opts } = {}) {
  const clock = createFakeClock(1000);
  const events = [];
  const media = createMediaCapabilities({
    dispatchEvent: (name, detail) => events.push({ name, detail }),
    now: clock.now,
    sleep: clock.sleep,
    readFile: async (name) => {
      if (!(name in files)) throw new Error(`假 readFile 没有 ${name}`);
      return files[name];
    },
    ...opts,
  });
  return { clock, events, media, api: media.capabilities.media };
}

/** 拍一张并把延迟走完（默认延迟非零，不推钟拿不到结果）。 */
async function shoot(media, clock, args = {}) {
  const p = media.capabilities.media.takePhoto(args);
  await clock.advance(media.takePhotoDelayMs());
  return p;
}

// ── 拍照喂图 ────────────────────────────────────────────────────────────

test('takePhoto 出 {data:Uint8Array, mimeType}——形状不对引擎在编码阶段就 TypeError', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(1, 2, 3), { name: 'squat.png' });

  const photo = await shoot(media, clock);
  assert.ok(photo.data instanceof Uint8Array, 'data 必须是 Uint8Array');
  assert.deepEqual([...photo.data], [1, 2, 3]);
  assert.equal(photo.mimeType, 'image/png');
});

test('拍照按队列走：loadPhoto 排几张就依次拍几张（姿势照 → 二维码图 可脚本编排）', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(0xa1), { name: 'squat.png' });
  await media.loadPhoto(bytesOf(0xb2), { name: 'gear-qr.webp' });
  assert.deepEqual(media.queue(), ['squat.png', 'gear-qr.webp']);

  const first = await shoot(media, clock);
  const second = await shoot(media, clock);
  assert.deepEqual([...first.data], [0xa1]);
  assert.equal(first.mimeType, 'image/png');
  assert.deepEqual([...second.data], [0xb2]);
  assert.equal(second.mimeType, 'image/webp');
  assert.deepEqual(media.queue(), [], '队列被逐张吃掉');
  assert.deepEqual(media.shots().map((s) => s.name), ['squat.png', 'gear-qr.webp']);
});

test('队列拍空后停在最后一张：等于对着同一个人连拍，而不是突然拍不出来', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(7), { name: 'a.png' });
  await shoot(media, clock);

  const again = await shoot(media, clock);
  assert.deepEqual([...again.data], [7], '重拍路径不该因为队列空了就报错');
});

test('usePhoto 定住当前项并清队列：从此一直拍这张', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  await media.loadPhoto(bytesOf(2), { name: 'b.png' });
  media.usePhoto('b.png');
  assert.deepEqual(media.queue(), [], 'usePhoto 的意图是"从现在起拍这张"，残留队列会打脸');

  assert.deepEqual([...(await shoot(media, clock)).data], [2]);
  assert.deepEqual([...(await shoot(media, clock)).data], [2]);
});

test('enqueuePhoto 让已装载的照片再排一次（重拍走同一张）', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  await media.loadPhoto(bytesOf(2), { name: 'b.png' });
  media.enqueuePhoto('a.png');
  assert.deepEqual(media.queue(), ['a.png', 'b.png', 'a.png']);

  const names = [];
  for (let i = 0; i < 3; i += 1) {
    await shoot(media, clock);
    names.push(media.shots().at(-1).name);
  }
  assert.deepEqual(names, ['a.png', 'b.png', 'a.png']);
});

test('按名字装照片走注入 readFile，mimeType 从扩展名推（真机实际出的是 webp）', async () => {
  const { media, clock } = setup({ files: { 'fixtures/bind-qr.webp': bytesOf(9, 9) } });
  const entry = await media.loadPhoto('fixtures/bind-qr.webp');
  assert.deepEqual(entry, { name: 'fixtures/bind-qr.webp', mimeType: 'image/webp', byteLength: 2 });
  assert.deepEqual(media.photos(), [entry]);

  const photo = await shoot(media, clock);
  assert.equal(photo.mimeType, 'image/webp');
  assert.deepEqual([...photo.data], [9, 9]);
});

test('usePhoto/enqueuePhoto 认不出名字直接抛：拼错照片名若沉默放行，会以为在测另一张', async () => {
  const { media } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  assert.throws(() => media.usePhoto('typo.png'), /没装载/);
  assert.throws(() => media.enqueuePhoto('typo.png'), /没装载/);
});

// ── 真机延迟 ────────────────────────────────────────────────────────────

test('默认拍照延迟非零：延迟走完前 takePhoto 不结算，否则应用的倒计时与 8s 闸全测不到', async () => {
  const { media, clock } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  assert.ok(DEFAULT_TAKE_PHOTO_DELAY_MS > 0, '默认延迟必须非零');
  assert.equal(media.takePhotoDelayMs(), DEFAULT_TAKE_PHOTO_DELAY_MS);

  const shot = watch(media.capabilities.media.takePhoto({}));
  await clock.advance(DEFAULT_TAKE_PHOTO_DELAY_MS - 1);
  assert.equal(shot.settled, false, '差一毫秒也不能提前给照片');

  await clock.advance(1);
  assert.equal(shot.settled, true);
  assert.equal(media.shots().at(-1).at, 1000 + DEFAULT_TAKE_PHOTO_DELAY_MS, '流水打的是拍成那一刻的戳');
});

// ── 轨道事件回灌 ────────────────────────────────────────────────────────

test('getUserMedia 起流并逐轨回灌 mediaTrackStarted，targetId/sessionId 原样带回', async () => {
  const { media, api, events } = setup();
  const stream = await api.getUserMedia({
    targetId: 'tgt-7', sessionId: 'sess-7',
    streamId: 'stream-1', constraints: { video: true, audio: true },
  });

  assert.equal(stream.streamId, 'stream-1');
  assert.deepEqual(stream.tracks.map((t) => t.kind), ['video', 'audio']);
  assert.deepEqual(stream.tracks.map((t) => t.trackId), ['stream-1-video', 'stream-1-audio']);
  assert.equal(stream.tracks[0].settings.width, 480, '真机主摄出的是 480×640 竖图，不写理想值');

  assert.deepEqual(events.map((e) => e.name),
    ['media.mediaTrackStarted', 'media.mediaTrackStarted']);
  assert.deepEqual(events[0].detail, {
    targetId: 'tgt-7', sessionId: 'sess-7', streamId: 'stream-1', trackId: 'stream-1-video',
  });
  assert.equal(events[1].detail.trackId, 'stream-1-audio');
});

test('args 没带 targetId 时回落 trackId：引擎的 media 请求体本就不带，抄 glue 浏览器兜底同一口径', async () => {
  const { api, events } = setup();
  await api.getUserMedia({ streamId: 's1', constraints: { video: true } });
  assert.equal(events[0].detail.targetId, 's1-video', 'targetId 为空引擎会拒事件，必须顶上');
  assert.equal(events[0].detail.sessionId, '');
});

test('stopMediaTrack 回灌 mediaTrackEnded 并把流收干净；重复停是 no-op 不重复发事件', async () => {
  const { media, api, events } = setup();
  await api.getUserMedia({ targetId: 't', sessionId: 's', streamId: 's1', constraints: { video: true } });
  events.length = 0;

  await api.stopMediaTrack({ targetId: 't', sessionId: 's', streamId: 's1', trackId: 's1-video' });
  assert.deepEqual(events, [{
    name: 'media.mediaTrackEnded',
    detail: { targetId: 't', sessionId: 's', streamId: 's1', trackId: 's1-video' },
  }]);
  assert.deepEqual(media.streams(), [], '轨道全停后流不该留在账上');

  await api.stopMediaTrack({ streamId: 's1', trackId: 's1-video' });
  assert.equal(events.length, 1, '认不出的流静默 no-op（抄 glue 兜底）');
});

// ── 故障注入 ────────────────────────────────────────────────────────────

test('failNext denied：错误形状让应用判成"可再申请"的 denied，走权限降级那一格', async () => {
  const { media, api } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  media.failNext({ kind: 'denied' });

  const err = await api.takePhoto({}).then(() => null, (e) => e);
  assert.ok(err, '拒权必须抛，不能悄悄给张照片');
  assert.equal(err.name, 'NotAllowedError');
  assert.equal(media.shots().at(-1).status, 'denied');
});

test('failNext notfound：非权限错误，应用走可重试的 capture-failed 而不是权限降级', async () => {
  const { media, api } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  media.failNext({ kind: 'notfound' });

  const err = await api.takePhoto({}).then(() => null, (e) => e);
  assert.equal(err.name, 'NotFoundError');
  assert.equal(err.error, 'not-found');
});

test('failNext timeout：永不结算（真机的"宿主永久 pending"），应用只能靠自己的闸兜底', async () => {
  const { media, api, clock } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  media.failNext({ kind: 'timeout' });

  const shot = watch(api.takePhoto({}));
  await clock.advance(60000); // 远超应用 8s 总闸
  assert.equal(shot.settled, false, '超时不是 reject，宿主就是不回——这才是要测的降级前提');
  assert.equal(media.shots().at(-1).status, 'hung');
});

test('failNext 是一次性的：只吃掉下一次调用，第二次照常出图', async () => {
  const { media, api, clock } = setup();
  await media.loadPhoto(bytesOf(5), { name: 'a.png' });
  media.failNext({ kind: 'denied' });

  await assert.rejects(() => api.takePhoto({}));
  const photo = await shoot(media, clock);
  assert.deepEqual([...photo.data], [5], '注入一次就该恢复，否则测不到"重试成功"的路径');
});

test('failNext 未知种类直接抛：拼错种类若沉默放行，等于没注故障还以为测过了', () => {
  const { media } = setup();
  assert.throws(() => media.failNext({ kind: 'refused' }), /未知故障种类/);
  assert.throws(() => media.failNext({}), /未知故障种类/);
  assert.deepEqual(FAILURE_KINDS, ['denied', 'notfound', 'timeout']);
});

// ── 设备表 ──────────────────────────────────────────────────────────────

test('enumerateDevices 形状对齐 Web MediaDeviceInfo，默认一路 videoinput 一路 audioinput', async () => {
  const { api } = setup();
  const list = await api.enumerateDevices();
  assert.equal(list.length, 2);
  for (const d of list) {
    assert.deepEqual(Object.keys(d).sort(), ['deviceId', 'groupId', 'kind', 'label']);
    assert.ok(d.deviceId.length > 0, 'deviceId 为空 glue 会当场 TypeError');
    assert.ok(['videoinput', 'audioinput'].includes(d.kind));
  }
  assert.deepEqual(list.map((d) => d.kind), ['videoinput', 'audioinput']);
  assert.deepEqual(list, DEFAULT_MEDIA_DEVICES.map((d) => ({ ...d })));
});

test('setDevices([]) = 这台没摄像头：takePhoto 与 getUserMedia 都按 not-found 拒（第二根降级杠杆）', async () => {
  const { media, api } = setup();
  await media.loadPhoto(bytesOf(1), { name: 'a.png' });
  media.setDevices([]);

  assert.deepEqual(await api.enumerateDevices(), []);
  const photoErr = await api.takePhoto({}).then(() => null, (e) => e);
  assert.equal(photoErr.error, 'not-found');
  await assert.rejects(() => api.getUserMedia({ streamId: 's', constraints: { video: true } }),
    /找不到可用摄像头/);
});

test('设备表形状不合法当场抛：坏 kind 留到运行期只会变成引擎的 TypeError', () => {
  const { media } = setup();
  assert.throws(() => media.setDevices([{ deviceId: 'x', kind: 'videooutput' }]), /kind 必须是/);
  assert.throws(() => media.setDevices([{ kind: 'videoinput' }]), /缺 deviceId/);
});

test('一张照片都没装时报 InkLab 配置错，绝不返回空字节假装拍到了', async () => {
  const { api, media } = setup();
  const err = await api.takePhoto({}).then(() => null, (e) => e);
  assert.equal(err.name, 'InkLabError');
  assert.match(err.message, /loadPhoto/);
  assert.equal(media.shots().at(-1).status, 'no-photo',
    '空 Uint8Array 能过引擎校验，会把宿主没配好伪装成应用的 bad-photo-data');
});

// ── 录音器最小实现 ──────────────────────────────────────────────────────

test('录音器状态机照抄浏览器坏行为：流不在先抛、重复 start 抛、pause/resume 必须按序', async () => {
  const { api, media } = setup();
  await assert.rejects(() => api.createMediaRecorder({ recorderId: 'r1', streamId: 'nope' }),
    /Media stream nope is unavailable/);

  await api.getUserMedia({ streamId: 's1', constraints: { audio: true } });
  const desc = await api.createMediaRecorder({ recorderId: 'r1', streamId: 's1' });
  assert.deepEqual(desc, { recorderId: 'r1', mimeType: 'audio/ogg;codecs=opus' },
    'mimeType 空会被 glue 拒，必须兜底成非空');

  await assert.rejects(() => api.pauseMediaRecorder({ recorderId: 'r1' }), /is not recording/);
  await api.startMediaRecorder({ recorderId: 'r1', timesliceMs: 200 });
  await assert.rejects(() => api.startMediaRecorder({ recorderId: 'r1' }), /is not inactive/);
  await api.pauseMediaRecorder({ recorderId: 'r1' });
  assert.equal(media.recorders()[0].state, 'paused');
  await api.resumeMediaRecorder({ recorderId: 'r1' });
  await api.requestMediaRecorderData({ recorderId: 'r1' });
  assert.equal(media.recorders()[0].dataRequests, 1);

  await api.stopMediaRecorder({ recorderId: 'r1' });
  assert.deepEqual(media.recorders(), []);
  await assert.rejects(() => api.startMediaRecorder({ recorderId: 'r1' }), /is unavailable/);
});

// ── 契约对齐与复位 ──────────────────────────────────────────────────────

test('capabilities.media 正好覆盖契约的十个方法：少取流方法会碰真实硬件，少 takePhoto 会直接未配置', () => {
  const { media } = setup();
  assert.deepEqual(
    Object.keys(media.capabilities.media).sort(),
    [...CAPABILITY_METHODS.media].sort(),
  );
  const composed = composeCapabilities(media.capabilities);
  assert.equal(Object.keys(composed.media).length, CAPABILITY_METHODS.media.length);
});

test('reset 清运行态但留住照片库与设备表：重跑一次工程不该重装一遍照片', async () => {
  const { media, api, clock } = setup();
  await media.loadPhoto(bytesOf(3), { name: 'a.png' });
  await api.getUserMedia({ streamId: 's1', constraints: { video: true } });
  await shoot(media, clock);
  media.failNext({ kind: 'denied' });

  media.reset();
  assert.deepEqual(media.streams(), []);
  assert.deepEqual(media.shots(), []);
  assert.deepEqual(media.queue(), []);
  assert.deepEqual(media.photos(), [{ name: 'a.png', mimeType: 'image/png', byteLength: 1 }]);

  media.usePhoto('a.png'); // 复位后当前项被清掉，重新点名即可继续拍
  const photo = await shoot(media, clock);
  assert.deepEqual([...photo.data], [3], '待注入的故障也一并清掉了');
});
