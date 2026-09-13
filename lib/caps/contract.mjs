// contract.mjs — Ink 引擎宿主能力层的契约（从 ink_web 0.17.0 的 glue 反解，官方无文档）。
//
// 引擎侧形状：
//   createInkView({ ..., hostCapabilities })  或  view.setHostCapabilities(obj)
//   obj = { 命名空间: { 方法: async (args) => result } }
//   引擎调用时若某个方法缺席，直接抛
//   `Host capability {ns}.{method} is not configured on Web host`。
//
// 事件回灌走另一条路（不是回调返回值），入口是 InkView 上的**能力事件靶**：
//   view.getHostCapabilitiesTarget().dispatchEvent(new CustomEvent(name, { detail }))
//   （外层 InkView 没有可直接调用的 dispatchHostCapabilityEvent；同名的是 wasm 内部方法，
//    吃的是 JSON 字符串，不是给宿主用的。）
//
// 寻址字段分两类，别一刀切：
//   - ASR 那 11 个 speech.* 事件与四路传感器事件：detail 必须带非空 `targetId` 与 `sessionId`，
//     原样带回引擎调用能力方法时给的值。
//   - 合成事件（synthesisChunk/End/Error/Aborted）按 `synthesisId` 寻址，**不带** targetId/sessionId。
//   - media.* 事件只校验 `targetId`，不看 sessionId。
//
// ⚠️ 校验失败**不抛回宿主**，只在 console 留一行
// `InkView failed to bridge host capability event ...`，事件被丢掉。
// 也就是说字段拼错是**纯沉默失败**——这正是本层最容易自欺的地方，务必靠测试钉住。

/** 引擎认识的全部命名空间与方法。多写引擎不理，少写则该能力一被用到就抛。 */
export const CAPABILITY_METHODS = Object.freeze({
  speech: ['speak', 'synthesize', 'abortSynthesis', 'startRecognition', 'stopRecognition', 'abortRecognition'],
  geolocation: ['getCurrentPosition', 'watchPosition', 'clearWatch'],
  battery: ['start', 'stop'],
  payment: ['canMakePayment', 'show', 'abort', 'complete'],
  absoluteOrientation: ['start', 'stop'],
  accelerometer: ['start', 'stop'],
  gyroscope: ['start', 'stop'],
  magnetometer: ['start', 'stop'],
  media: [
    'enumerateDevices', 'getUserMedia', 'stopMediaTrack', 'createMediaRecorder',
    'startMediaRecorder', 'pauseMediaRecorder', 'resumeMediaRecorder',
    'requestMediaRecorderData', 'stopMediaRecorder', 'takePhoto',
  ],
  openService: ['getManifest', 'getVendorHeaders'],
  languageModel: ['getConfig'],
});

/**
 * 引擎认识的全部事件名。dispatchHostCapabilityEvent 传别的名字会被引擎拒绝。
 * 传感器三件套的 reading 载荷轴不同：三轴 {x,y,z}，姿态四元数 {x,y,z,w}。
 */
export const CAPABILITY_EVENTS = Object.freeze({
  // 注意没有 `speech.synthesisStarted`：引擎的事件表里根本没这一项。
  // 「合成已开始」是 `synthesize()` 的**返回值**（必须给全 {synthesisId, mimeType, audioConfig}，
  // 缺一项整个调用 TypeError），引擎据此自己造 SynthesisStarted。
  // 往这个名字上 dispatch 没有 listener，静默落地。
  speech: [
    'speech.start', 'speech.audiostart', 'speech.soundstart', 'speech.speechstart',
    'speech.result', 'speech.nomatch', 'speech.error',
    'speech.speechend', 'speech.soundend', 'speech.audioend', 'speech.end',
    'speech.synthesisChunk', 'speech.synthesisEnd',
    'speech.synthesisError', 'speech.synthesisAborted',
  ],
  accelerometer: ['accelerometer.activate', 'accelerometer.reading', 'accelerometer.error'],
  gyroscope: ['gyroscope.activate', 'gyroscope.reading', 'gyroscope.error'],
  magnetometer: ['magnetometer.activate', 'magnetometer.reading', 'magnetometer.error'],
  absoluteOrientation: [
    'absoluteOrientation.activate', 'absoluteOrientation.reading', 'absoluteOrientation.error',
  ],
  geolocation: ['geolocation.position', 'geolocation.error'],
  battery: ['battery.statuschange'],
  media: [
    'media.mediaTrackStarted', 'media.mediaTrackEnded', 'media.mediaTrackMuted',
    'media.mediaTrackUnmuted', 'media.mediaTrackError',
    'media.mediaRecorderStarted', 'media.mediaRecorderData', 'media.mediaRecorderPaused',
    'media.mediaRecorderResumed', 'media.mediaRecorderStopped', 'media.mediaRecorderError',
    'media.mediaDevicesChanged',
  ],
});

/** 传感器 reading 事件的轴清单（引擎按名取值，缺的按 0 算）。 */
export const SENSOR_AXES = Object.freeze({
  accelerometer: ['x', 'y', 'z'],
  gyroscope: ['x', 'y', 'z'],
  magnetometer: ['x', 'y', 'z'],
  absoluteOrientation: ['x', 'y', 'z', 'w'],
});

/**
 * `speech.result` 的 detail 除了 route 与 alternatives，还必须带 `isFinal` 与 `resultIndex`。
 * **漏掉 isFinal 是最致命的一条**：引擎按 `!!detail.isFinal` 取值，漏了就恒 false，
 * 应用侧的「收到 final」判定永不为真，一句话只能等它自己的静音 watchdog 兜底。
 */
export const SPEECH_RESULT_FIELDS = Object.freeze(['targetId', 'sessionId', 'isFinal', 'resultIndex', 'alternatives']);

/**
 * bluetooth 已于 ink_web 0.17.0 实测确认：它不走本文件这张 hostCapabilities 编解码表，
 * 而由 `packages/ink-web/src/platform/web_bluetooth.rs` 独立桥到浏览器的
 * `navigator.bluetooth`。InkLab 的实现因此在 caps/bluetooth.mjs 造浏览器对象树，
 * 由 bluetooth-mode.mjs 安装；绝不能把 bluetooth 塞进 composeCapabilities()。
 */
export const BROWSER_BRIDGED_NAMESPACES = Object.freeze(['bluetooth']);
export const UNCONFIRMED_NAMESPACES = Object.freeze([]);

export const ALL_EVENT_NAMES = Object.freeze(Object.values(CAPABILITY_EVENTS).flat());
export const ALL_NAMESPACES = Object.freeze(Object.keys(CAPABILITY_METHODS));

/** 某个命名空间.方法 是否在引擎的能力表里。 */
export function isKnownMethod(ns, method) {
  const list = CAPABILITY_METHODS[ns];
  return Array.isArray(list) && list.includes(method);
}

export const isKnownEvent = (name) => ALL_EVENT_NAMES.includes(name);

/**
 * 引擎给的 args 里一定带 targetId/sessionId，事件回灌必须原样带回。
 * 这里集中做提取，免得每个能力模块各写一遍、各漏一遍。
 */
export function routeOf(args) {
  const a = args && typeof args === 'object' ? args : {};
  return { targetId: String(a.targetId || ''), sessionId: String(a.sessionId || '') };
}

/** 组一个能力集：只保留引擎认识的方法，未知方法直接报错（拼错方法名是沉默失败的常见来源）。 */
export function composeCapabilities(...groups) {
  const out = {};
  for (const group of groups) {
    if (!group) continue;
    for (const [ns, methods] of Object.entries(group)) {
      if (!CAPABILITY_METHODS[ns]) throw new Error(`未知能力命名空间: ${ns}`);
      out[ns] = out[ns] || {};
      for (const [name, fn] of Object.entries(methods || {})) {
        if (!isKnownMethod(ns, name)) throw new Error(`引擎不认识 ${ns}.${name}`);
        if (typeof fn !== 'function') throw new TypeError(`${ns}.${name} 必须是函数`);
        out[ns][name] = fn;
      }
    }
  }
  return out;
}
