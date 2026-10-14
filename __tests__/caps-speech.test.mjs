// InkLab 语音能力：ASR 脚本注入与 TTS 播报记录。假钟 + 假 dispatchEvent，零真实等待。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpeechCapabilities } from '../lib/caps/speech.mjs';

// ── 测试替身 ────────────────────────────────────────────────────────────

/** 假钟：只有 tick() 才推进时间，delayMs 的行为因此完全可断言。 */
function createClock(start = 0) {
  let at = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => at,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { due: at + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout: (id) => { pending.delete(id); },
    tick(ms) {
      const target = at + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, task]) => task.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        if (!due.length) break;
        const [id, task] = due[0];
        pending.delete(id);
        at = Math.max(at, task.due);
        task.fn();
      }
      at = target;
    },
  };
}

/** 假事件总线：记下 (name, detail)，顺序就是引擎会看到的顺序。 */
function createBus() {
  const events = [];
  return {
    events,
    dispatchEvent: (name, detail) => { events.push({ name, detail }); },
    names: () => events.map((e) => e.name),
    detailsOf: (name) => events.filter((e) => e.name === name).map((e) => e.detail),
    clear: () => { events.length = 0; },
  };
}

/** 起一套能力 + 一路已经在聆听的 session，绝大多数用例都从这里开始。 */
async function listening(opts = {}) {
  const bus = createBus();
  const clock = createClock(1_000);
  const speech = createSpeechCapabilities({
    dispatchEvent: bus.dispatchEvent,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...opts,
  });
  await speech.capabilities.speech.startRecognition({
    targetId: 'page-home', sessionId: 'asr-1', lang: 'zh-CN', continuous: true, interimResults: true, maxAlternatives: 1,
  });
  return { bus, clock, speech };
}

// ── ASR 生命周期 ────────────────────────────────────────────────────────

test('startRecognition 只开麦：start/audiostart 立刻到，声音那两拍要等真的说话', async () => {
  const { bus, speech } = await listening();
  assert.deepEqual(bus.names(), ['speech.start', 'speech.audiostart']);
  assert.equal(speech.isListening(), true);

  bus.clear();
  speech.say('开始深蹲');
  assert.deepEqual(bus.names(), ['speech.soundstart', 'speech.speechstart', 'speech.result']);

  // 第二句不再重复 soundstart/speechstart：一路 session 只"起声"一次。
  bus.clear();
  speech.say('下一组');
  assert.deepEqual(bus.names(), ['speech.result']);
});

test('每条事件都原样带回引擎给的 targetId/sessionId（带不回引擎认不出是哪一路）', async () => {
  const { bus, speech } = await listening();
  speech.say('体重六十公斤');
  await speech.capabilities.speech.stopRecognition({ targetId: 'page-home', sessionId: 'asr-1' });

  assert.ok(bus.events.length >= 7);
  for (const { name, detail } of bus.events) {
    assert.equal(detail.targetId, 'page-home', `${name} 丢了 targetId`);
    assert.equal(detail.sessionId, 'asr-1', `${name} 丢了 sessionId`);
  }
});

test('interim 改写同一个 result 槽，final 才置 isFinal 并换槽', async () => {
  const { bus, speech } = await listening();
  speech.say('深蹲', { interim: true });
  speech.say('深蹲三组', { interim: true });
  speech.say('深蹲三组每组十二个');
  speech.say('下一组', { interim: true });

  const results = bus.detailsOf('speech.result');
  assert.deepEqual(results.map((r) => r.isFinal), [false, false, true, false]);
  assert.deepEqual(results.map((r) => r.alternatives[0].transcript),
    ['深蹲', '深蹲三组', '深蹲三组每组十二个', '下一组']);
  // 前三条都在 0 号槽（interim 是同一句的成长过程），final 落定后新句子才进 1 号槽。
  assert.deepEqual(results.map((r) => r.resultIndex), [0, 0, 0, 1]);
});

test('alternatives 是 {transcript,confidence} 数组；interim 不伪造置信度（真机恒 0）', async () => {
  const { bus, speech } = await listening();
  speech.say('再来一组', { interim: true });
  speech.say('再来一组');
  speech.say('再来一组', { confidence: 0.42 });

  const [interim, final, custom] = bus.detailsOf('speech.result');
  assert.deepEqual(interim.alternatives, [{ transcript: '再来一组', confidence: 0 }]);
  assert.deepEqual(final.alternatives, [{ transcript: '再来一组', confidence: 0.9 }]);
  assert.equal(custom.alternatives[0].confidence, 0.42);
});

test('自然结束的一轮：stopRecognition 才补 speechend/soundend/audioend/end', async () => {
  const { bus, speech } = await listening();
  speech.say('开始训练');
  await speech.capabilities.speech.stopRecognition({ targetId: 'page-home', sessionId: 'asr-1' });

  assert.deepEqual(bus.names(), [
    'speech.start', 'speech.audiostart',
    'speech.soundstart', 'speech.speechstart', 'speech.result',
    'speech.speechend', 'speech.soundend', 'speech.audioend', 'speech.end',
  ]);
  assert.equal(speech.isListening(), false);
});

test('say() 的 final 不结束 session：收口是应用侧 grace/watchdog 的活，宿主不替它做', async () => {
  const { bus, speech } = await listening();
  speech.say('深蹲三组');
  assert.equal(bus.names().includes('speech.end'), false);
  assert.equal(speech.isListening(), true, 'continuous 模式下真机收到 final 也不停流');
});

test('delayMs 走注入的假钟：不推钟就一个事件都没有（模块不许碰全局定时器）', async () => {
  const { bus, clock, speech } = await listening();
  bus.clear();
  speech.say('慢慢说的一句', { delayMs: 300 });
  assert.deepEqual(bus.names(), [], '还没到点就不该有转写');

  clock.tick(299);
  assert.deepEqual(bus.names(), []);
  clock.tick(1);
  assert.deepEqual(bus.names(), ['speech.soundstart', 'speech.speechstart', 'speech.result']);
});

test('没在聆听时 say() 直接抛，不静默把转写丢进空气', async () => {
  const { speech } = await listening();
  await speech.capabilities.speech.abortRecognition({ targetId: 'page-home', sessionId: 'asr-1' });
  assert.throws(() => speech.say('没人听'), /startRecognition/);
  assert.throws(() => speech.nomatch(), /startRecognition/);
  assert.throws(() => speech.errorOut('network'), /startRecognition/);
});

// ── 异常路径：真机的坏行为 ──────────────────────────────────────────────

test('ASR 中途自行 abort：只有 error(aborted)+end，没有 audioend 收尾', async () => {
  const { bus, speech } = await listening();
  speech.say('深蹲', { interim: true });
  bus.clear();
  speech.abortMidway();

  assert.deepEqual(bus.names(), ['speech.error', 'speech.end']);
  assert.equal(bus.detailsOf('speech.error')[0].error, 'aborted');
  assert.equal(speech.isListening(), false);
});

test('中途 abort 的另一种形态：什么都不说，应用只能从光秃秃的 end 里察觉', async () => {
  const { bus, speech } = await listening();
  speech.say('深蹲', { interim: true });
  bus.clear();
  speech.abortMidway({ silent: true });

  assert.deepEqual(bus.names(), ['speech.end']);
});

test('endTurn：这一轮说完了，识别器自然收尾（完整尾巴，和被掐断不是一回事）', async () => {
  const { bus, speech } = await listening();
  speech.say('看线索');
  bus.clear();
  speech.endTurn();

  // 完整尾巴：与 abortMidway 的残尾（无 audioend）区分开——只在 end 里落定转写的应用
  // （某真实应用的助手路由）靠这一拍才执行，拿 abort 冒充会把两种现场混成一种。
  assert.deepEqual(bus.names(), [
    'speech.speechend', 'speech.soundend', 'speech.audioend', 'speech.end',
  ]);
  assert.equal(speech.isListening(), false);
});

test('endTurn：没在聆听时明确报错，而不是静默失效', async () => {
  const bus = createBus();
  const speech = createSpeechCapabilities({ dispatchEvent: bus.dispatchEvent });
  assert.throws(() => speech.endTurn(), /startRecognition/);
});

test('nomatch：听见了没识别出来，之后把尾巴补完（应用只能靠 end 收口）', async () => {
  const { bus, speech } = await listening();
  speech.say('唔……', { interim: true });
  bus.clear();
  speech.nomatch();

  assert.deepEqual(bus.names(), [
    'speech.nomatch', 'speech.speechend', 'speech.soundend', 'speech.audioend', 'speech.end',
  ]);
});

test('error：error/message 原样带回，之后只有一个 end', async () => {
  const { bus, speech } = await listening();
  bus.clear();
  speech.errorOut('not-allowed', '用户拒绝了麦克风权限');

  assert.deepEqual(bus.names(), ['speech.error', 'speech.end']);
  assert.deepEqual(bus.detailsOf('speech.error')[0], {
    targetId: 'page-home', sessionId: 'asr-1', error: 'not-allowed', message: '用户拒绝了麦克风权限',
  });
});

// ── 多 session 隔离 ─────────────────────────────────────────────────────

test('连开两次：旧 session 的延迟转写不许串到新 session', async () => {
  const { bus, clock, speech } = await listening();
  speech.say('旧的那句', { delayMs: 500 });

  await speech.capabilities.speech.startRecognition({
    targetId: 'page-home', sessionId: 'asr-2', lang: 'zh-CN', continuous: true, interimResults: true,
  });
  bus.clear();
  clock.tick(500); // 旧 session 的定时器到点了

  assert.deepEqual(bus.names(), [], '被顶掉的 session 一个事件都不许再发');

  // 新 session 自己说话照常，并且只带新 sessionId。
  speech.say('新的那句');
  assert.deepEqual(bus.detailsOf('speech.result').map((r) => r.sessionId), ['asr-2']);
});

test('被顶掉的旧 session 不补 end：应用得自己扛悬空 session，别在宿主里美化', async () => {
  const { bus, speech } = await listening();
  bus.clear();
  await speech.capabilities.speech.startRecognition({ targetId: 'page-home', sessionId: 'asr-2' });

  assert.deepEqual(bus.names(), ['speech.start', 'speech.audiostart']);
  assert.equal(bus.names().includes('speech.end'), false);
  assert.equal(speech.currentSession().sessionId, 'asr-2');
});

test('stopRecognition/abortRecognition 认 sessionId：收旧的那路不能误伤新的', async () => {
  const { bus, speech } = await listening();
  await speech.capabilities.speech.startRecognition({ targetId: 'page-home', sessionId: 'asr-2' });
  bus.clear();

  await speech.capabilities.speech.abortRecognition({ targetId: 'page-home', sessionId: 'asr-1' });
  assert.deepEqual(bus.names(), [], '旧 session 已经作废，收它是空操作');
  assert.equal(speech.isListening(), true);
  assert.equal(speech.currentSession().sessionId, 'asr-2');
});

// ── TTS ────────────────────────────────────────────────────────────────

test('TTS 默认不自动结束：真机 onend 不可靠，宿主不许把它伪装成可靠', async () => {
  const { bus, speech } = await listening();
  bus.clear();
  await speech.capabilities.speech.speak({ text: '深蹲三组，每组十二个' });
  await speech.capabilities.speech.synthesize({ text: '开始吧', targetId: 'page-home', sessionId: 'asr-1' });

  assert.deepEqual(bus.names(), [], 'speak/synthesize 自己不发任何完播事件');
  assert.equal(speech.pendingSynthesis().length, 1);

  const done = speech.finishSpeaking();
  assert.equal(done.ok, true);
  assert.deepEqual(bus.names(), ['speech.synthesisEnd']);
  assert.equal(bus.detailsOf('speech.synthesisEnd')[0].synthesisId, done.synthesisId);
  assert.equal(speech.pendingSynthesis().length, 0);
});

test('speak() 没有完播通道：finishSpeaking 明说做不到，不假装成功', async () => {
  const { bus, speech } = await listening();
  await speech.capabilities.speech.speak({ text: '保持核心收紧' });
  bus.clear();

  // 引擎的 speak 请求里没有任何 id，宿主无处回灌"播完了"——应用看到的
  // utterance.onend 是引擎自己造的。这里必须报出来，而不是悄悄返回成功。
  assert.deepEqual(speech.finishSpeaking(), { ok: false, reason: 'speak-has-no-completion-channel' });
  assert.deepEqual(bus.names(), []);
});

test('spokenTexts 记下应用到底说了什么（本地宿主不发声，这是唯一的断言手段）', async () => {
  const { speech } = await listening();
  await speech.capabilities.speech.speak({ text: '第一组开始' });
  await speech.capabilities.speech.synthesize({ text: '还剩三个' });
  await speech.capabilities.speech.speak({ text: '' }); // 应用用空 utterance 收声

  assert.deepEqual(speech.spokenTexts, ['第一组开始', '还剩三个', '']);
  assert.equal(speech.lastSpokenText(), '');
});

test('synthesize 必须返回引擎能造 SynthesisStarted 的任务描述（少一项引擎直接 TypeError）', async () => {
  const { speech } = await listening();
  const task = await speech.capabilities.speech.synthesize({ text: '深蹲', subtitleGranularity: 'word' });

  assert.equal(typeof task.synthesisId, 'string');
  assert.ok(task.synthesisId.length > 0);
  assert.ok(task.mimeType.length > 0);
  assert.deepEqual(task.audioConfig, {
    format: 'ogg_opus', sampleRate: 16_000, channels: 1, sampleFormat: null,
  });
  assert.equal(task.subtitleGranularity, 'word');
  assert.equal(task.language, 'zh-CN');
});

test('autoEnd:true 给不关心 TTS 的场景省事：推一拍钟就结束（不能同步结束，引擎还没收下 id）', async () => {
  const bus = createBus();
  const clock = createClock(1_000);
  const speech = createSpeechCapabilities({
    dispatchEvent: bus.dispatchEvent, now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, autoEnd: true,
  });

  await speech.capabilities.speech.synthesize({ text: '开始吧' });
  assert.deepEqual(bus.names(), [], '返回值还没交给引擎之前不许发 synthesisEnd');

  clock.tick(1);
  assert.deepEqual(bus.names(), ['speech.synthesisEnd']);
});

test('synthesisChunk 带二进制 audio 与字幕 cue，且按 synthesisId 寻址（没有 targetId）', async () => {
  const { bus, speech } = await listening();
  await speech.capabilities.speech.synthesize({ text: '深蹲三组' });
  bus.clear();
  speech.sendSynthesisChunk();

  const chunk = bus.detailsOf('speech.synthesisChunk')[0];
  assert.ok(chunk.audio instanceof Uint8Array, '引擎缺二进制 audio 会直接拒掉整条事件');
  assert.equal(chunk.sequence, 0);
  assert.equal(chunk.cues[0].text, '深蹲三组');
  assert.equal(chunk.cues[0].charLength, 4);
  assert.equal(chunk.targetId, undefined, '合成事件按 synthesisId 寻址，不带 ASR 的路由');
  assert.ok(chunk.synthesisId);
});

test('引擎撤回合成时回 synthesisAborted；合成失败走 synthesisError', async () => {
  const { bus, speech } = await listening();
  const first = await speech.capabilities.speech.synthesize({ text: '被打断的播报' });
  bus.clear();
  await speech.capabilities.speech.abortSynthesis({ synthesisId: first.synthesisId });
  assert.deepEqual(bus.detailsOf('speech.synthesisAborted'), [{ synthesisId: first.synthesisId }]);

  await speech.capabilities.speech.synthesize({ text: '再来一条' });
  bus.clear();
  speech.failSpeaking('network', 'TTS 服务不可达');
  const err = bus.detailsOf('speech.synthesisError')[0];
  assert.equal(err.error, 'network');
  assert.equal(err.message, 'TTS 服务不可达');
  assert.equal(speech.pendingSynthesis().length, 0);
});

// ── 契约面 ──────────────────────────────────────────────────────────────

test('能力集正好装引擎认识的 6 个 speech 方法（多一个引擎不理，少一个一用就抛）', async () => {
  const { speech } = await listening();
  assert.deepEqual(Object.keys(speech.capabilities), ['speech']);
  assert.deepEqual(Object.keys(speech.capabilities.speech).sort(), [
    'abortRecognition', 'abortSynthesis', 'speak', 'startRecognition', 'stopRecognition', 'synthesize',
  ]);
  for (const fn of Object.values(speech.capabilities.speech)) assert.equal(typeof fn, 'function');
});

test('startRecognition 缺 targetId/sessionId 当场抛：否则每条事件都会被引擎静默丢掉', async () => {
  const bus = createBus();
  const speech = createSpeechCapabilities({ dispatchEvent: bus.dispatchEvent });
  await assert.rejects(() => speech.capabilities.speech.startRecognition({ targetId: 'page-home' }), TypeError);
  await assert.rejects(() => speech.capabilities.speech.startRecognition({}), TypeError);
  assert.deepEqual(bus.names(), []);
});

test('引擎的每次调用都留痕，排查"引擎到底调没调"用得上', async () => {
  const { speech } = await listening();
  await speech.capabilities.speech.speak({ text: '开始' });
  await speech.capabilities.speech.stopRecognition({ targetId: 'page-home', sessionId: 'asr-1' });

  assert.deepEqual(speech.calls.map((c) => c.method), ['startRecognition', 'speak', 'stopRecognition']);
  assert.deepEqual(speech.calls[2].route, { targetId: 'page-home', sessionId: 'asr-1' });
});

test('createSpeechCapabilities 少了 dispatchEvent 就没有回灌出口，构造时就得炸', () => {
  assert.throws(() => createSpeechCapabilities(), TypeError);
  assert.throws(() => createSpeechCapabilities({ dispatchEvent: 'nope' }), TypeError);
});
