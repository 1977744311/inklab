// media.mjs — 宿主媒体能力：拍照 / 取流 / 录制的本地模拟实现。
//
// 为什么必须显式提供，而不是"没实现就算了"：
//   glue 的 handleRequest 对 media 命名空间有独一份兜底——宿主没给某个 media 方法时，
//   它会尝试回落到 `navigator.mediaDevices`（`Di()` 那一坨）。取流/录音会因此打开真实硬件；
//   当前浏览器后端却没有 takePhoto，漏掉它会直接报“未配置”。所以默认模拟模式仍把 media
//   十个方法一个不落地占住；手动电脑相机由 browser-camera.mjs 显式替换 takePhoto。
//
// takePhoto 的返回形状（glue `wi`/`di` 实证，不是猜的）：
//   宿主返回 {data, mimeType} → 引擎编码成 `TakePhotoResult: [Array.from(data), mimeType]`。
//   `di` 硬性要求 mimeType 非空、data 是 Uint8Array/ArrayBuffer/TypedArray，
//   否则当场 TypeError。所以本模块统一出 {data: Uint8Array, mimeType: string}。
//
// 本模块的核心价值是 loadPhoto：应用的姿势点评要喂真人照片、扫码要喂二维码图，
// 两条链吃的都是 takePhoto 的原始字节（解码链吃 raw bytes，不走 base64 往返）。
// 所以"下一张拍什么"必须可脚本控制——队列 + 当前项两种口径。
//
// 照抄真机的坏行为（guide 里「宿主比 Craft 更容易骗自己」那一节的具体落实）：
//   * 拍照有 1–2 秒延迟。本地若瞬间返回，应用里的倒计时 + 总闸、
//     页面的 busy 禁用态就全都测不到，等于把真机不存在的时序固化进来。默认延迟非零。
//   * 权限拒绝是**立即**失败（不走延迟），宿主卡死是**永不结算**（不是超时 reject）——
//     真机上的"宿主永久 pending"就是这个样子，应用得靠自己的闸兜底。
//
// 纯逻辑：不 import node:fs，读图字节由 readFile 注入；时钟与延时也注入，node --test 直接跑。

import { routeOf } from './contract.mjs';

/**
 * 拍照默认延迟（ms）。真机 1–2 秒，取中间偏保守值。
 * 绝不能是 0：瞬间返回会掩盖应用的倒计时/超时/并发防护三条链。
 */
export const DEFAULT_TAKE_PHOTO_DELAY_MS = 1500;

/** 装载字节但没说 mimeType、也没有扩展名可推时的兜底。 */
export const DEFAULT_PHOTO_MIME_TYPE = 'image/jpeg';

/**
 * 默认设备表：一路摄像头 + 一路麦克风，形状对齐 Web MediaDeviceInfo。
 * glue `fi` 只认 kind ∈ {audioinput, videoinput} 且 deviceId 非空，别的当场 TypeError。
 */
export const DEFAULT_MEDIA_DEVICES = Object.freeze([
  Object.freeze({
    deviceId: 'inklab-camera', kind: 'videoinput',
    label: 'InkLab 模拟主摄', groupId: 'inklab-glasses',
  }),
  Object.freeze({
    deviceId: 'inklab-mic', kind: 'audioinput',
    label: 'InkLab 模拟麦克风', groupId: 'inklab-glasses',
  }),
]);

/**
 * 故障注入的三种形态。code 是给应用读的那一格——
 * 应用侧通常按 error/errMsg/name/message 取串再做关键词判定：
 *   'not-allowed' 命中 denied 关键词且不含 permanent 关键词 → 'denied'（可再申请）；
 *   'not-found'   一个权限关键词都不命中 → null → 应用按 capture-failed 走可重试失败。
 * 两者在应用的降级矩阵里是不同的两格，所以必须让应用能分开。
 */
export const MEDIA_FAILURES = Object.freeze({
  denied: Object.freeze({
    name: 'NotAllowedError', code: 'not-allowed',
    message: 'NotAllowedError: 相机权限被拒绝（InkLab 注入）',
  }),
  notfound: Object.freeze({
    name: 'NotFoundError', code: 'not-found',
    message: 'NotFoundError: 找不到可用摄像头（InkLab 注入）',
  }),
  timeout: Object.freeze({
    name: 'TimeoutError', code: 'timeout',
    message: 'TimeoutError: 宿主永不结算（InkLab 注入）',
  }),
});

/** 可注入的故障种类。failNext 传别的直接抛——拼错种类若沉默放行，等于没注入故障还以为测过了。 */
export const FAILURE_KINDS = Object.freeze(Object.keys(MEDIA_FAILURES));

/** 扩展名 → mimeType。真机 0.1.95 实证出的是 480×640 WebP，所以 webp 必须在表里。 */
const MIME_BY_EXT = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
});

/** 从名字/路径尾巴推 mimeType；推不出交给调用方兜底。 */
function guessMimeType(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? (MIME_BY_EXT[m[1].toLowerCase()] || '') : '';
}

/** 任意字节形态 → Uint8Array。形状不认识就抛：装载期抛比拍照期抛容易定位得多。 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Uint8Array.from(value);
  }
  throw new TypeError('照片字节必须是 Uint8Array / ArrayBuffer / TypedArray / 0-255 数组');
}

/** 造一个应用读得懂的相机错误：error/errMsg/name/message/code 五个口都填上（各家读法不同）。 */
function makeFailure(kind) {
  const spec = MEDIA_FAILURES[kind];
  const err = new Error(spec.message);
  err.name = spec.name;
  err.error = spec.code;   // 应用常按 error 字段判定
  err.errMsg = `media:fail ${spec.code}`; // wx 回调式宿主的读法
  err.code = spec.code;    // 也有应用按 code 字段判定
  err.inklabInjected = true;
  return err;
}

/** 设备表归一：只保留引擎认的两种 kind，deviceId 空的直接剔掉（留着只会让引擎当场抛）。 */
function normalizeDevices(list) {
  if (!Array.isArray(list)) throw new TypeError('设备表必须是数组');
  return list.map((d, i) => {
    const deviceId = String((d && d.deviceId) || '').trim();
    const kind = String((d && d.kind) || '').trim();
    if (!deviceId) throw new TypeError(`设备 ${i} 缺 deviceId`);
    if (kind !== 'audioinput' && kind !== 'videoinput') {
      throw new TypeError(`设备 ${i} 的 kind 必须是 audioinput 或 videoinput，收到 ${kind || '(空)'}`);
    }
    return {
      deviceId, kind,
      label: String((d && d.label) || ''),
      groupId: d && d.groupId == null ? '' : String(d.groupId),
    };
  });
}

/** 约束里能带进 settings 的字段（对齐 glue `jt`/`xi` 的取值口径）。 */
function settingsFrom(constraint, deviceId, base) {
  const out = { deviceId, ...base };
  if (constraint && typeof constraint === 'object') {
    for (const k of ['sampleRate', 'channelCount', 'width', 'height', 'frameRate']) {
      if (constraint[k] != null && Number.isFinite(Number(constraint[k]))) out[k] = Number(constraint[k]);
    }
    if (constraint.echoCancellation != null) out.echoCancellation = !!constraint.echoCancellation;
    if (constraint.facingMode) out.facingMode = String(constraint.facingMode);
    if (constraint.deviceId) out.deviceId = String(constraint.deviceId);
  }
  return out;
}

/**
 * 造媒体能力集。
 *
 * @param {object} [opts]
 * @param {(name:string, detail:object) => void} [opts.dispatchEvent] 事件回灌口
 *   （宿主侧接 view.dispatchHostCapabilityEvent）。缺席则轨道事件不回灌——能力仍可用，
 *   但引擎不知道轨道起停，只在"只用 takePhoto"的场景下可接受。
 * @param {() => number} [opts.now] 时钟（拍照记录打戳用）。
 * @param {(nameOrPath:string) => Promise<Uint8Array>} [opts.readFile] 读图片字节。
 *   本模块不碰 node:fs，宿主注真实现、测试注假的。
 * @param {(ms:number) => Promise<void>} [opts.sleep] 延时器。测试注假钟，避免真等 1.5 秒。
 * @param {Array<object>} [opts.devices] 初始设备表，默认一 video 一 audio。
 * @param {number} [opts.takePhotoDelayMs] 拍照延迟，默认 DEFAULT_TAKE_PHOTO_DELAY_MS。
 * @returns {object} { capabilities, ...控制面 }
 */
export function createMediaCapabilities({
  dispatchEvent,
  now = () => Date.now(),
  readFile,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  devices = DEFAULT_MEDIA_DEVICES,
  takePhotoDelayMs = DEFAULT_TAKE_PHOTO_DELAY_MS,
} = {}) {
  /** 照片库：name → {name, mimeType, bytes}。装载一次可反复入队。 */
  const library = new Map();
  /** 待拍队列（存 name）。takePhoto 优先吃队列，吃空后停在最后一张。 */
  let queue = [];
  /** 当前选中项：队列空时 takePhoto 拍它（连拍同一张 = 真机对着同一个人反复拍）。 */
  let current = null;
  let anonSeq = 0;

  let deviceList = normalizeDevices(devices);
  let photoDelayMs = Number(takePhotoDelayMs);
  if (!Number.isFinite(photoDelayMs) || photoDelayMs < 0) photoDelayMs = DEFAULT_TAKE_PHOTO_DELAY_MS;

  /** 一次性故障注入，被下一次 takePhoto / getUserMedia 吃掉。 */
  let pendingFailure = null;

  const streams = new Map();   // streamId → {streamId, tracks:[...]}
  const recorders = new Map(); // recorderId → {recorderId, streamId, mimeType, state, dataRequests}
  const shots = [];            // 拍照流水：给排障看"第几张拍的是谁、结局如何"
  let streamSeq = 0;

  // 事件回灌不吞异常：引擎拒事件（多半是 targetId 空）是硬错误，吞掉会变成
  // "流建好了但引擎不知道"的幽灵态——宁可让当次调用当场失败，在日志里看得见。
  const emit = (name, detail) => {
    if (typeof dispatchEvent !== 'function') return;
    dispatchEvent(name, detail);
  };

  /**
   * 事件 detail 的 targetId：优先原样带回引擎给的 targetId。
   * 引擎的 media 请求体（wasm 里的 GetUserMediaRequest / TakePhotoOptions 等结构）实测**不带**
   * targetId，而 glue 的事件校验又要求 targetId 非空；glue 自己的浏览器兜底就是拿 trackId 顶上。
   * 这里照抄同一口径：args 有就原样带回，没有才回落 trackId。
   */
  const trackDetail = (args, streamId, trackId) => {
    const route = routeOf(args);
    return {
      targetId: route.targetId || trackId,
      sessionId: route.sessionId,
      streamId,
      trackId,
    };
  };

  const hasKind = (kind) => deviceList.some((d) => d.kind === kind);

  /** 吃掉一次性故障：denied/notfound 立即抛，timeout 交给调用方挂起。 */
  const takeFailure = () => {
    if (!pendingFailure) return null;
    const kind = pendingFailure;
    pendingFailure = null;
    return kind;
  };

  const capabilities = {
    media: {
      /** 设备枚举：形状对齐 Web MediaDevices.enumerateDevices()。 */
      async enumerateDevices() {
        return deviceList.map((d) => ({ ...d }));
      },

      /**
       * 取流：不真做媒体，只出一份合法的 MediaStreamDescriptor 让引擎的流对象建起来，
       * 并按轨道逐条回灌 mediaTrackStarted——应用的"相机在跑/麦在跑"状态机靠这个事件推进。
       */
      async getUserMedia(args) {
        const kind = takeFailure();
        if (kind === 'timeout') return new Promise(() => { /* 永不结算：模拟宿主卡死 */ });
        if (kind) throw makeFailure(kind);

        const constraints = (args && args.constraints) || {};
        const wantAudio = Boolean(constraints.audio);
        const wantVideo = Boolean(constraints.video);
        // 抄浏览器的报错原文：两路都不要时 getUserMedia 本来就该拒。
        if (!wantAudio && !wantVideo) {
          throw new TypeError('MediaDevices.getUserMedia() requires audio and/or video');
        }
        if (wantVideo && !hasKind('videoinput')) throw makeFailure('notfound');
        if (wantAudio && !hasKind('audioinput')) throw makeFailure('notfound');

        const streamId = String((args && args.streamId) || '').trim() || `inklab-stream-${(streamSeq += 1)}`;
        const tracks = [];
        if (wantVideo) {
          tracks.push({
            trackId: `${streamId}-video`, kind: 'video',
            label: deviceList.find((d) => d.kind === 'videoinput').label,
            enabled: true, muted: false,
            settings: settingsFrom(constraints.video, deviceList.find((d) => d.kind === 'videoinput').deviceId, {
              // 真机主摄出的就是 480×640 竖图（0.1.95 扫码链实证），别写成 1080p 的理想值。
              width: 480, height: 640, frameRate: 30, facingMode: 'environment',
            }),
          });
        }
        if (wantAudio) {
          tracks.push({
            trackId: `${streamId}-audio`, kind: 'audio',
            label: deviceList.find((d) => d.kind === 'audioinput').label,
            enabled: true, muted: false,
            settings: settingsFrom(constraints.audio, deviceList.find((d) => d.kind === 'audioinput').deviceId, {
              sampleRate: 16000, channelCount: 1, echoCancellation: true,
            }),
          });
        }

        const descriptor = { streamId, tracks };
        streams.set(streamId, { streamId, tracks: tracks.map((t) => ({ ...t, live: true })) });
        for (const t of tracks) {
          emit('media.mediaTrackStarted', trackDetail(args, streamId, t.trackId));
        }
        return descriptor;
      },

      /** 停轨：抄 glue 浏览器兜底的口径——认不出的流/轨道静默 no-op，认得出才回灌 ended。 */
      async stopMediaTrack(args) {
        const streamId = String((args && args.streamId) || '');
        const trackId = String((args && args.trackId) || '');
        const stream = streams.get(streamId);
        if (!stream) return;
        const track = stream.tracks.find((t) => t.trackId === trackId);
        if (!track || !track.live) return;
        track.live = false;
        emit('media.mediaTrackEnded', trackDetail(args, streamId, trackId));
        if (stream.tracks.every((t) => !t.live)) streams.delete(streamId);
      },

      /**
       * 建录音器。glue `pi` 要求 recorderId 与 mimeType 都非空，所以 mimeType 空时必须兜底，
       * 否则引擎在校验返回值时就抛了，应用连"录音起不来"都收不到。
       */
      async createMediaRecorder(args) {
        const recorderId = String((args && args.recorderId) || '').trim();
        if (!recorderId) throw new TypeError('`media.createMediaRecorder()` 缺 recorderId');
        const streamId = String((args && args.streamId) || '');
        if (!streams.has(streamId)) throw new Error(`Media stream ${streamId} is unavailable.`);
        const mimeType = String((args && args.mimeType) || '').trim() || 'audio/ogg;codecs=opus';
        recorders.set(recorderId, { recorderId, streamId, mimeType, state: 'inactive', dataRequests: 0 });
        return { recorderId, mimeType };
      },

      /** 起录。状态机报错原文照抄浏览器/引擎（wasm 里就是这几句），免得应用兼容出两套文案。 */
      async startMediaRecorder(args) {
        const rec = mustRecorder(args);
        if (rec.state !== 'inactive') throw new Error('MediaRecorder is not inactive');
        rec.state = 'recording';
        rec.timesliceMs = args && args.timesliceMs != null ? Number(args.timesliceMs) : null;
      },

      async pauseMediaRecorder(args) {
        const rec = mustRecorder(args);
        if (rec.state !== 'recording') throw new Error('MediaRecorder is not recording');
        rec.state = 'paused';
      },

      async resumeMediaRecorder(args) {
        const rec = mustRecorder(args);
        if (rec.state !== 'paused') throw new Error('MediaRecorder is not paused');
        rec.state = 'recording';
      },

      /**
       * 讨一片数据。本模块不产音频，只记账——录音数据事件（media.mediaRecorderData）
       * 不在 contract.mjs 的 media 事件表里，见文件末尾对契约的存疑，先不擅自回灌。
       */
      async requestMediaRecorderData(args) {
        mustRecorder(args).dataRequests += 1;
      },

      /** 停录：认不出的 recorderId 静默 no-op（抄 glue 兜底，它这一条也不抛）。 */
      async stopMediaRecorder(args) {
        const rec = recorders.get(String((args && args.recorderId) || ''));
        if (!rec) return;
        rec.state = 'inactive';
        recorders.delete(rec.recorderId);
      },

      /**
       * 拍照。返回 {data: Uint8Array, mimeType}，由 glue `wi` 编码成 {data:number[], mimeType}。
       * 结算顺序：故障注入 → 设备缺席 → 没装照片 → 延迟 → 出图。
       * 前三步都**不走延迟**：真机的权限拒绝与"没有摄像头"是立刻回的，只有真拍才慢。
       */
      async takePhoto(args) {
        const options = {
          quality: String((args && args.quality) || ''),
          mode: String((args && args.mode) || ''),
        };
        const kind = takeFailure();
        if (kind === 'timeout') {
          shots.push({ at: now(), name: null, mimeType: '', byteLength: 0, status: 'hung', ...options });
          return new Promise(() => { /* 永不结算：真机上卡死就是这个样子，不是超时 reject */ });
        }
        if (kind) {
          shots.push({ at: now(), name: null, mimeType: '', byteLength: 0, status: kind, ...options });
          throw makeFailure(kind);
        }
        if (!hasKind('videoinput')) {
          shots.push({ at: now(), name: null, mimeType: '', byteLength: 0, status: 'notfound', ...options });
          throw makeFailure('notfound');
        }

        const name = queue.length > 0 ? queue.shift() : current;
        const entry = name == null ? null : library.get(name);
        if (!entry) {
          // 不返回空字节：空 Uint8Array 能过 glue 校验，应用会当成"拍到了但是坏图"，
          // 把 InkLab 的配置疏漏伪装成被测应用的 bad-photo-data。宁可当场报配置错。
          shots.push({ at: now(), name: null, mimeType: '', byteLength: 0, status: 'no-photo', ...options });
          const err = new Error('InkLab 没装载任何照片：先 loadPhoto() 再让应用拍');
          err.name = 'InkLabError';
          err.error = 'inklab-no-photo';
          err.code = 'inklab-no-photo';
          throw err;
        }
        current = entry.name;

        if (photoDelayMs > 0) await sleep(photoDelayMs);
        shots.push({
          at: now(), name: entry.name, mimeType: entry.mimeType,
          byteLength: entry.bytes.byteLength, status: 'ok', ...options,
        });
        // 每次给独立副本：应用若就地改字节（解码链常见），不能污染下一次拍到的同一张。
        return { data: entry.bytes.slice(), mimeType: entry.mimeType };
      },
    },
  };

  function mustRecorder(args) {
    const recorderId = String((args && args.recorderId) || '');
    const rec = recorders.get(recorderId);
    if (!rec) throw new Error(`MediaRecorder ${recorderId} is unavailable.`);
    return rec;
  }

  const mustLoaded = (name) => {
    const key = String(name);
    if (!library.has(key)) {
      throw new Error(`照片 ${key} 没装载（已装载：${[...library.keys()].join(', ') || '无'}）`);
    }
    return key;
  };

  return {
    capabilities,

    /**
     * 装载一张照片。字符串走注入的 readFile（当成路径/名字），字节形态直接收。
     * 默认入队 —— 「下一张拍什么」就是靠连续 loadPhoto 排出来的。
     *
     * @param {string|Uint8Array|ArrayBuffer|number[]} source
     * @param {{name?:string, mimeType?:string, enqueue?:boolean}} [opts]
     * @returns {Promise<{name:string, mimeType:string, byteLength:number}>}
     */
    async loadPhoto(source, { name, mimeType, enqueue = true } = {}) {
      let key = name == null ? null : String(name);
      let raw = source;
      if (typeof source === 'string') {
        if (typeof readFile !== 'function') {
          throw new TypeError('按名字装照片需要注入 readFile（本模块不碰 node:fs）');
        }
        raw = await readFile(source);
        if (key == null) key = source;
      } else if (key == null) {
        key = `photo-${(anonSeq += 1)}`;
      }
      const bytes = toBytes(raw);
      const mt = String(mimeType || '').trim()
        || guessMimeType(typeof source === 'string' ? source : key)
        || DEFAULT_PHOTO_MIME_TYPE;
      library.set(key, { name: key, mimeType: mt, bytes });
      if (enqueue) queue.push(key);
      if (current == null) current = key;
      return { name: key, mimeType: mt, byteLength: bytes.byteLength };
    },

    /** 已装载清单（不带字节，排障时打得出来）。 */
    photos: () => [...library.values()].map((e) => ({
      name: e.name, mimeType: e.mimeType, byteLength: e.bytes.byteLength,
    })),

    /** 待拍队列（按名字，队首是下一张）。 */
    queue: () => [...queue],

    /** 已装载的再入一次队：同一张连拍两次（如"重拍"路径）。 */
    enqueuePhoto(name) { queue.push(mustLoaded(name)); },

    /** 定住当前项并清队列：从现在起一直拍这张，直到再排队。 */
    usePhoto(name) { current = mustLoaded(name); queue = []; },

    /** 只清队列，当前项不动（回到"反复拍最后一张"）。 */
    clearQueue() { queue = []; },

    /**
     * 注入一次性故障，被下一次 takePhoto / getUserMedia 吃掉。
     * @param {{kind:'denied'|'notfound'|'timeout'}} spec
     */
    failNext(spec) {
      const kind = spec && spec.kind;
      if (!FAILURE_KINDS.includes(kind)) {
        throw new Error(`未知故障种类 ${String(kind)}；可选：${FAILURE_KINDS.join(' / ')}`);
      }
      pendingFailure = kind;
    },

    /** 换设备表。给空数组 = 这台机器没有摄像头/麦克风，是 failNext 之外的第二根降级杠杆。 */
    setDevices(list) { deviceList = normalizeDevices(list); },

    /** 改拍照延迟（ms）。设 0 只应出现在"专门验时序无关"的用例里。 */
    setTakePhotoDelayMs(ms) {
      const v = Number(ms);
      if (!Number.isFinite(v) || v < 0) throw new TypeError('拍照延迟必须是非负数');
      photoDelayMs = v;
    },
    takePhotoDelayMs: () => photoDelayMs,

    /** 拍照流水：第几张拍的是谁、结局如何。 */
    shots: () => shots.map((s) => ({ ...s })),

    /** 在飞的流与录音器快照（排"应用忘了 stopMediaTrack"这类漏关问题）。 */
    streams: () => [...streams.values()].map((s) => ({
      streamId: s.streamId, tracks: s.tracks.map((t) => ({ ...t })),
    })),
    recorders: () => [...recorders.values()].map((r) => ({ ...r })),

    /**
     * 复位运行态：流、录音器、拍照流水、队列、当前项、待注入故障。
     * **保留**照片库、设备表、延迟——那些是场景配置，重跑一次工程不该重装一遍照片。
     */
    reset() {
      streams.clear();
      recorders.clear();
      shots.length = 0;
      queue = [];
      current = null;
      pendingFailure = null;
    },
  };
}
