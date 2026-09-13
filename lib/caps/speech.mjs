// speech.mjs — 语音能力：ASR 脚本注入 + TTS 播报记录。
//
// 这一层的价值不是"能出声"，而是把"用户说了什么"变成可脚本化、可断言的输入：
// 本地宿主既不接麦克风也不发声，转写全由 say() 注入，播报只把文本记进 spokenTexts
// （宿主页面打字幕）。断言"应用说了什么"从此不用听，读数组就行。
//
// 事件形状取自 ink_web 0.17.0 的 glue（反解口径同 contract.mjs）：
//   speech.result → {targetId, sessionId, resultIndex, isFinal, alternatives:[{transcript,confidence}]}
//   speech.error  → {targetId, sessionId, error, message}
//   其余 ASR 生命周期事件 → {targetId, sessionId}
//   合成事件按 synthesisId 寻址，不带 targetId/sessionId（引擎只校验 synthesisId 非空）
// 引擎对事件 detail 的校验失败只 console.error 一行就把事件丢掉，不会抛回宿主——
// 所以字段少一个是沉默失败，本模块宁可在拼装处早失败。
//
// 纪律：照抄真机已知的坏行为，不照理想契约写。目前抄了两条：
//   1) ASR 会中途自行 abort，且不补 audioend 收尾 —— abortMidway()；
//   2) TTS 的"播完"不可靠 —— speak()/synthesize() 默认不自动发 synthesisEnd。
//      更狠的是 speak() 在引擎里压根没有回灌通道（详见 finishSpeaking 的注释）。

import { composeCapabilities, routeOf } from './contract.mjs';

/** 引擎把 synthesize() 的返回值直接拿去造 SynthesisStarted，格式非法就 TypeError。 */
const DEFAULT_AUDIO_CONFIG = Object.freeze({
  format: 'ogg_opus', sampleRate: 16_000, channels: 1, sampleFormat: null,
});

const GRANULARITIES = ['sentence', 'word', 'none'];

/**
 * @param {object} opts
 * @param {(name:string, detail:object) => void} opts.dispatchEvent 必填。事件回灌的唯一出口
 *   （宿主页面接 view.getHostCapabilitiesTarget()，测试接收集器）。
 * @param {() => number} [opts.now]
 * @param {(fn:Function, ms:number) => any} [opts.setTimeout] 延迟注入用；测试必须喂假钟
 * @param {(handle:any) => void} [opts.clearTimeout]
 * @param {boolean} [opts.autoEnd=false] 合成任务自动结束（不关心 TTS 的场景省事）
 * @param {string} [opts.mimeType] 合成任务对外宣称的音频类型
 * @param {object} [opts.audioConfig]
 * @param {string} [opts.language] 合成任务的默认语种（引擎没给 language 时用）
 */
export function createSpeechCapabilities({
  dispatchEvent,
  now = () => Date.now(),
  // 默认绑到全局定时器只为宿主页面省事；模块内部一律走这两个引用，
  // 测试注入假钟后就没有任何真实等待，异常路径也能一拍一拍地断言。
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (handle) => globalThis.clearTimeout(handle),
  autoEnd = false,
  mimeType = 'audio/ogg; codecs=opus',
  audioConfig = DEFAULT_AUDIO_CONFIG,
  language = 'zh-CN',
} = {}) {
  if (typeof dispatchEvent !== 'function') {
    throw new TypeError('createSpeechCapabilities 需要 dispatchEvent(name, detail)');
  }

  const calls = [];        // 引擎 → 宿主的每次能力调用（排查"引擎到底调没调"）
  const spokenTexts = [];  // 播报过的文本，按发生顺序
  const sessions = [];     // 全部 ASR session，含已结束与被顶掉的
  const tasks = [];        // 全部合成任务
  const timers = new Set();
  let sessionSeq = 0;
  let synthSeq = 0;
  let current = null;

  const record = (method, args) => {
    calls.push({ method, args, route: routeOf(args), at: now() });
  };

  const emit = (name, detail) => { dispatchEvent(name, detail); };
  const emitOn = (session, name, extra) => emit(name, {
    targetId: session.targetId, sessionId: session.sessionId, ...extra,
  });

  // 只有"当前这一路"才配发事件。旧 session 的延迟事件必须在这里被拦下，
  // 否则应用会看到两路 sessionId 交替冒泡——真机上这叫串台，本地也不许出现。
  const isLive = (session) => session === current && session.phase === 'listening';

  const schedule = (delayMs, fn) => {
    const ms = Number(delayMs) || 0;
    if (ms <= 0) { fn(); return null; } // 不给延迟就同步发：脚本读起来是一条直线
    let handle;
    handle = setT(() => { timers.delete(handle); fn(); }, ms);
    timers.add(handle);
    return handle;
  };

  const requireListening = (what) => {
    if (!current || current.phase !== 'listening') {
      // 没 session 却注入转写，事件必然被引擎的非空 sessionId 校验丢掉。
      // 与其让脚本静默失效，不如在这里炸，把"引擎还没开麦"这件事说清楚。
      throw new Error(`${what}：当前没有在聆听的 session（引擎还没调用 speech.startRecognition）`);
    }
    return current;
  };

  /**
   * 收尾。tail=true 走自然结束的完整尾巴，false 是被打断——真机中断时只补一个 end，
   * 不补 audioend/soundend，这里照抄：应用不能指望没保证的事件。
   */
  const closeSession = (session, { tail, reason }) => {
    if (!session || session.phase !== 'listening') return false;
    if (tail) {
      if (session.sounding) {
        emitOn(session, 'speech.speechend');
        emitOn(session, 'speech.soundend');
        session.sounding = false;
      }
      emitOn(session, 'speech.audioend');
    }
    emitOn(session, 'speech.end');
    session.phase = 'ended';
    session.reason = reason;
    session.endedAt = now();
    if (current === session) current = null;
    return true;
  };

  // 引擎按 sessionId 指名道姓地停某一路；停已经结束的那路是空操作，不能误伤当前这路。
  const sessionOf = (args) => {
    const { sessionId } = routeOf(args);
    if (!sessionId) return current;
    return sessions.find((s) => s.sessionId === sessionId && s.phase === 'listening') || null;
  };

  // ── ASR：引擎侧 ────────────────────────────────────────────────────────

  const startRecognition = async (args) => {
    record('startRecognition', args);
    const route = routeOf(args);
    if (!route.targetId || !route.sessionId) {
      throw new TypeError('speech.startRecognition 的 args 缺 targetId/sessionId，事件将无法回灌');
    }
    // 连开两次：旧 session 直接作废，且不给它体面的 end。真机上后开的那一路才连着
    // 麦克风，旧的就是没了下文——补个 end 反而会把"应用得自己扛悬空 session"这件事掩盖掉。
    if (current && current.phase === 'listening') {
      current.phase = 'superseded';
      current.endedAt = now();
    }
    const session = {
      seq: ++sessionSeq,
      targetId: route.targetId,
      sessionId: route.sessionId,
      options: {
        lang: args && args.lang ? String(args.lang) : '',
        continuous: Boolean(args && args.continuous),
        interimResults: Boolean(args && args.interimResults),
        maxAlternatives: Number((args && args.maxAlternatives) || 1),
      },
      phase: 'listening',
      resultIndex: 0,
      sounding: false,
      startedAt: now(),
      endedAt: null,
      reason: null,
    };
    sessions.push(session);
    current = session;
    // 开麦这两拍是确定会有的；有没有声音要等真的说话（见 say()）。
    emitOn(session, 'speech.start');
    emitOn(session, 'speech.audiostart');
    return undefined;
  };

  const stopRecognition = async (args) => {
    record('stopRecognition', args);
    closeSession(sessionOf(args), { tail: true, reason: 'stop' });
    return undefined;
  };

  const abortRecognition = async (args) => {
    record('abortRecognition', args);
    closeSession(sessionOf(args), { tail: false, reason: 'abort' });
    return undefined;
  };

  // ── ASR：控制面（脚本注入） ─────────────────────────────────────────────

  /**
   * 把一段转写喂给当前 session。默认是 final；interim 用来模拟"边说边出字"。
   * 注意：final 不结束 session——真机 continuous 模式收到 final 也不会停流，
   * 收口靠应用侧那 2.5s final grace 与 12s watchdog。这里替它收口就等于把
   * 应用自己的定时器绕过去，问题会被藏起来。
   * @param {string} text 完整假设文本（不是增量：引擎的一条 result 只带一个 result 槽）
   * @param {{interim?:boolean, confidence?:number, delayMs?:number}} [opts]
   */
  const say = (text, { interim = false, confidence, delayMs = 0 } = {}) => {
    const session = requireListening('say()');
    const transcript = String(text ?? '');
    // 真机 interim 不给置信度（恒 0），别在本地伪造一个漂亮的数。
    const conf = Number.isFinite(confidence) ? Number(confidence) : (interim ? 0 : 0.9);
    schedule(delayMs, () => {
      if (!isLive(session)) return;
      if (!session.sounding) {
        session.sounding = true;
        emitOn(session, 'speech.soundstart');
        emitOn(session, 'speech.speechstart');
      }
      emitOn(session, 'speech.result', {
        resultIndex: session.resultIndex,
        isFinal: !interim,
        alternatives: [{ transcript, confidence: conf }],
      });
      // 照 Web Speech：interim 一直改写同一个槽，final 落定后下一句才换槽。
      if (!interim) session.resultIndex += 1;
    });
    return { targetId: session.targetId, sessionId: session.sessionId, isFinal: !interim, delayMs };
  };

  /**
   * 本轮说完了，识别器自然收尾（完整尾巴：speechend/soundend/audioend/end）。
   *
   * 为什么 say() 不替你做这件事、而要单独给一个出口：两种模式的真机行为不一样，
   * 假体不能替应用选一种。`continuous:true` 下收到 final **不**停流（收口是应用自己的活，
   * 替它收就把应用的 grace/watchdog 绕过去了）；`continuous:false` 下真机收到 final 会
   * 自己把这一轮结束掉——**只在 onend 里落定转写的应用**（看见崇左的 AssistantRouter 就是，
   * 它缓存最近一次 result 的文本、等 end 才分类执行）没有这一拍就永远不执行。
   *
   * 所以这里既不自动收、也不逼脚本拿 abortMidway 去凑：abortMidway 演的是「识别器中途自己
   * 罢工」，尾巴是残的（没有 audioend），拿它当正常收尾会把两种现场混成一种。
   * @param {{delayMs?:number}} [opts]
   */
  const endTurn = ({ delayMs = 0 } = {}) => {
    const session = requireListening('endTurn()');
    schedule(delayMs, () => {
      if (!isLive(session)) return;
      closeSession(session, { tail: true, reason: 'turn-end' });
    });
    return { targetId: session.targetId, sessionId: session.sessionId };
  };

  /** 听见了但没识别出来。真机在 nomatch 之后会把尾巴补完，应用只能靠 end 收口。 */
  const nomatch = ({ delayMs = 0 } = {}) => {
    const session = requireListening('nomatch()');
    schedule(delayMs, () => {
      if (!isLive(session)) return;
      emitOn(session, 'speech.nomatch');
      closeSession(session, { tail: true, reason: 'nomatch' });
    });
    return { targetId: session.targetId, sessionId: session.sessionId };
  };

  /** 各类错误：no-speech / network / not-allowed / service-not-allowed …… */
  const errorOut = (error = 'no-speech', message = '', { delayMs = 0 } = {}) => {
    const session = requireListening('errorOut()');
    schedule(delayMs, () => {
      if (!isLive(session)) return;
      emitOn(session, 'speech.error', { error: String(error), message: String(message) });
      closeSession(session, { tail: false, reason: `error:${error}` });
    });
    return { targetId: session.targetId, sessionId: session.sessionId, error: String(error) };
  };

  /**
   * 真机与 Craft 实测：ASR 会在一轮没说完时自己中止。两种见过的形态都要能演——
   * 默认发 error(aborted)+end；silent:true 则只有一个光秃秃的 end（应用只能从
   * onend 里察觉，走的是另一条代码路径）。
   */
  const abortMidway = ({
    error = 'aborted', message = 'recognition aborted by host', silent = false, delayMs = 0,
  } = {}) => {
    const session = requireListening('abortMidway()');
    schedule(delayMs, () => {
      if (!isLive(session)) return;
      if (!silent) emitOn(session, 'speech.error', { error: String(error), message: String(message) });
      closeSession(session, { tail: false, reason: 'abort-midway' });
    });
    return { targetId: session.targetId, sessionId: session.sessionId, silent };
  };

  // ── TTS ────────────────────────────────────────────────────────────────

  const pendingTasks = () => tasks.filter((t) => t.state === 'speaking');
  const pickTask = (synthesisId) => {
    if (synthesisId) {
      return tasks.find((t) => t.synthesisId === String(synthesisId) && t.state === 'speaking') || null;
    }
    const pending = pendingTasks();
    return pending.length ? pending[pending.length - 1] : null; // 覆盖式单槽：最后一条才在播
  };

  const speak = async (args) => {
    record('speak', args);
    const text = String((args && args.text) || '');
    spokenTexts.push(text);
    // 引擎只要一个 Success。speak() 这条路没有 synthesisId，也就没有任何完播回灌通道。
    return undefined;
  };

  const synthesize = async (args) => {
    record('synthesize', args);
    const text = String((args && args.text) || '');
    spokenTexts.push(text);
    const requested = String((args && args.synthesisId) || '').trim();
    const task = {
      synthesisId: requested || `inklab-syn-${++synthSeq}`,
      text,
      state: 'speaking',
      sequence: 0,
      startedAt: now(),
      language: String((args && (args.language || args.lang)) || language),
      subtitleGranularity: GRANULARITIES.includes(args && args.subtitleGranularity)
        ? args.subtitleGranularity : 'sentence',
    };
    tasks.push(task);
    // autoEnd 必须排到下一拍：引擎是先收下这个返回值才认得这个 synthesisId 的，
    // 同步就发 synthesisEnd 会打在一个还不存在的任务上。
    if (autoEnd) schedule(1, () => finishSpeaking(task.synthesisId));
    // 引擎拿这个返回值造 SynthesisStarted 事件；三个必填项少一个就整调用 TypeError。
    return {
      synthesisId: task.synthesisId,
      mimeType,
      audioConfig: {
        format: audioConfig.format,
        sampleRate: audioConfig.sampleRate,
        channels: audioConfig.channels,
        sampleFormat: audioConfig.sampleFormat,
      },
      language: task.language,
      subtitleGranularity: task.subtitleGranularity,
    };
  };

  const abortSynthesis = async (args) => {
    record('abortSynthesis', args);
    const task = pickTask(args && args.synthesisId);
    if (!task) return undefined;
    task.state = 'aborted';
    emit('speech.synthesisAborted', { synthesisId: task.synthesisId });
    return undefined;
  };

  /**
   * 送一块合成音频 + 字幕 cue。引擎要求 audio 是二进制，缺了直接拒事件；
   * 本地宿主不出声，默认给等长的静音占位，只为把字幕通路走通。
   */
  const sendSynthesisChunk = ({ synthesisId, audio, cues, text, bytes = 0 } = {}) => {
    const task = pickTask(synthesisId);
    if (!task) return { ok: false, reason: 'no-pending-synthesis' };
    const cueText = String(text ?? task.text);
    const elapsed = Math.max(0, Math.trunc(now() - task.startedAt));
    emit('speech.synthesisChunk', {
      synthesisId: task.synthesisId,
      sequence: task.sequence,
      audio: audio instanceof Uint8Array ? audio : new Uint8Array(Math.max(0, bytes)),
      cues: Array.isArray(cues) ? cues : [{
        id: `${task.synthesisId}-${task.sequence}`,
        text: cueText,
        startTimeMs: 0,
        endTimeMs: elapsed,
        charIndex: 0,
        charLength: cueText.length,
      }],
    });
    task.sequence += 1;
    return { ok: true, synthesisId: task.synthesisId, sequence: task.sequence - 1 };
  };

  /**
   * 显式宣告播完。默认不自动发，就是为了不把真机上不可靠的 onend 伪装成可靠。
   *
   * speak() 那条路更彻底：引擎的 SpeechSynthesisRequest 里没有任何 id，宿主根本
   * 没有地方回灌"播完了"——应用看到的 utterance.onend 是引擎自己造的。所以这里
   * 没有可结束的合成任务时明确报 speak-has-no-completion-channel，而不是假装成功。
   */
  const finishSpeaking = (synthesisId) => {
    const task = pickTask(synthesisId);
    if (!task) {
      return {
        ok: false,
        reason: spokenTexts.length ? 'speak-has-no-completion-channel' : 'no-pending-synthesis',
      };
    }
    task.state = 'ended';
    const durationMs = Math.max(0, Math.trunc(now() - task.startedAt));
    emit('speech.synthesisEnd', { synthesisId: task.synthesisId, durationMs });
    return { ok: true, synthesisId: task.synthesisId, durationMs };
  };

  /** 合成失败（TTS 服务不可用 / 超时）。 */
  const failSpeaking = (error = 'synthesis-failed', message = '', synthesisId) => {
    const task = pickTask(synthesisId);
    if (!task) return { ok: false, reason: 'no-pending-synthesis' };
    task.state = 'failed';
    emit('speech.synthesisError', {
      synthesisId: task.synthesisId, error: String(error), message: String(message),
    });
    return { ok: true, synthesisId: task.synthesisId };
  };

  // 只让 composeCapabilities 过一遍：方法名拼错是沉默失败的常见来源，让它当场炸。
  const capabilities = composeCapabilities({
    speech: {
      speak, synthesize, abortSynthesis, startRecognition, stopRecognition, abortRecognition,
    },
  });

  const reset = () => {
    for (const handle of timers) clearT(handle);
    timers.clear();
    calls.length = 0;
    spokenTexts.length = 0;
    sessions.length = 0;
    tasks.length = 0;
    current = null;
  };

  return Object.freeze({
    capabilities,
    // 观察面（都是活数组，宿主页面可直接看）
    calls,
    spokenTexts,
    sessions,
    lastSpokenText: () => (spokenTexts.length ? spokenTexts[spokenTexts.length - 1] : ''),
    isListening: () => Boolean(current && current.phase === 'listening'),
    currentSession: () => (current ? { ...current } : null),
    pendingSynthesis: () => pendingTasks().map((t) => ({ ...t })),
    // ASR 控制面
    say,
    endTurn,
    nomatch,
    errorOut,
    abortMidway,
    // TTS 控制面
    finishSpeaking,
    failSpeaking,
    sendSynthesisChunk,
    reset,
  });
}
