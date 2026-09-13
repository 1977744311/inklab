// The real-device lane never fabricates an InkView or host capability ledger.
// Actions share the simulator's scenario vocabulary, but use actual wall time.
export const DEVICE_STEP_KINDS = Object.freeze([
  'press', 'pressMany', 'activate', 'back', 'wait', 'wake', 'say', 'shot', 'expectText',
]);
export const DEVICE_KEYS = Object.freeze({
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'enter', Backspace: 'back', Escape: 'back',
});
export const DEVICE_CAPABILITIES = Object.freeze({
  keys: 'supported', screenshot: 'supported',
  'asr-text': 'app-debug-build', 'wake-touch': 'calibrated-rokid-touchpad',
  ocr: 'local-vision', 'app-launch': 'manual',
  'mock-caps': 'unsupported', 'storage-seed': 'unsupported',
  'llm-cassette': 'unsupported', 'tts-completion': 'unsupported',
  'sensor-injection': 'unsupported', 'runtime-eval': 'unsupported',
});

export function normalizeVisibleText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/gu, '');
}

function textSpec(value, nested = false) {
  const spec = typeof value === 'string' ? { all: [value] } : value;
  if (!spec || (!Array.isArray(spec.all) && !Array.isArray(spec.anyOf))
    || (spec.all != null && (!Array.isArray(spec.all) || !spec.all.length
      || spec.all.some((s) => typeof s !== 'string' || !s.trim() || s.length > 256)))
    || (spec.none != null && (!Array.isArray(spec.none)
      || spec.none.some((s) => typeof s !== 'string' || !s.trim() || s.length > 256)))) {
    throw new Error('expectText requires literal all[] or anyOf[{all:[]}] and optional none[] (≤256 characters each)');
  }
  if (spec.anyOf != null) {
    if (nested || !Array.isArray(spec.anyOf) || !spec.anyOf.length || spec.anyOf.length > 8) throw new Error('expectText.anyOf supports 1–8 non-nested alternatives');
    spec.anyOf.forEach((entry) => textSpec(entry, true));
  }
  return spec;
}

export function evaluateVisibleText(value, observation) {
  const spec = textSpec(value);
  if (observation?.status !== 'available') {
    return { ok: false, unsupported: true, reason: observation?.reason || '本机 OCR 不可用；不能自动判定画面' };
  }
  const text = normalizeVisibleText(observation.text);
  const missing = (spec.all || []).filter((part) => !text.includes(normalizeVisibleText(part)));
  const forbidden = (spec.none || []).filter((part) => text.includes(normalizeVisibleText(part)));
  const alternative = !spec.anyOf || spec.anyOf.some((entry) => evaluateVisibleText(entry, observation).ok);
  return { ok: !missing.length && !forbidden.length && alternative, missing, forbidden,
    reason: missing.length ? `画面未识别到：${missing.join(' / ')}`
      : forbidden.length ? `画面出现禁止文案：${forbidden.join(' / ')}`
        : !alternative ? '画面未匹配任何允许的回复形式' : null };
}

export function deviceScenarioSupport(scenario, { asrText = false, ocr = false } = {}) {
  // Existing JS scenario build functions may seed data or inspect simulated caps.
  // A deliberate device variant is required; never execute them speculatively.
  const variant = scenario?.device;
  if (!variant || !Array.isArray(variant.steps)) {
    return { supported: false, reasons: ['没有真机步骤定义；原场景可能依赖 mock caps、存储种子或模型录带'] };
  }
  const reasons = [];
  if (variant.steps.length > 300) reasons.push('场景超过 300 步上限');
  for (let i = 0; i < variant.steps.length; i += 1) {
    const step = variant.steps[i];
    const isObject = step && typeof step === 'object' && !Array.isArray(step);
    const kinds = isObject ? DEVICE_STEP_KINDS.filter((k) => k in step) : [];
    const extraActions = isObject ? ['do', 'expect', 'emit', 'seed', 'caps'].filter((k) => k in step) : [];
    const unknown = isObject ? Object.keys(step).filter((k) => !DEVICE_STEP_KINDS.includes(k)
      && !['label', 'waitMs', 'timeoutMs'].includes(k)) : [];
    if (kinds.length !== 1 || extraActions.length || unknown.length) {
      reasons.push(`第 ${i + 1} 步不支持：必须只有一个真机动作（do/expect 函数不能在真机冒充观测）`);
      continue;
    }
    const kind = kinds[0];
    if (kind === 'say' && !asrText) reasons.push('ASR 文本模拟需要当前工程的真机调试包适配器');
    if (kind === 'expectText' && !ocr) reasons.push('画面文字断言需要本机 Vision OCR');
    if (kind === 'expectText') { try { textSpec(step.expectText); } catch (err) { reasons.push(`第 ${i + 1} 步：${err.message}`); } }
    if (kind === 'shot' && (typeof step.shot !== 'string' || !step.shot.trim())) reasons.push(`第 ${i + 1} 步 shot 必须为名称字符串；模拟器 diffOptions 不适用于真机原图`);
    if (kind === 'press' && !DEVICE_KEYS[step.press]) reasons.push(`第 ${i + 1} 步未知按键`);
    if (kind === 'pressMany' && (!Array.isArray(step.pressMany) || !DEVICE_KEYS[step.pressMany[0]]
      || !Number.isInteger(step.pressMany[1]) || step.pressMany[1] < 0 || step.pressMany[1] > 100)) reasons.push(`第 ${i + 1} 步 pressMany 参数无效`);
    if (kind === 'wait' && (!Number.isFinite(step.wait) || step.wait < 0 || step.wait > 60000)) reasons.push(`第 ${i + 1} 步 wait 必须是 0–60000ms`);
    if (kind === 'say' && (typeof step.say !== 'string' || !step.say.trim()
      || new TextEncoder().encode(step.say).length > 180)) reasons.push(`第 ${i + 1} 步语音文字必须为 1–180 UTF-8 字节`);
  }
  for (const cap of variant.requires || []) {
    if (!(cap in DEVICE_CAPABILITIES) || DEVICE_CAPABILITIES[cap] === 'unsupported'
      || cap === 'app-launch') reasons.push(`场景要求的能力不可自动执行：${cap}`);
    if (cap === 'asr-text' && !asrText) reasons.push('ASR 文本模拟需要当前工程的真机调试包适配器');
    if (cap === 'ocr' && !ocr) reasons.push('画面文字断言需要本机 Vision OCR');
  }
  return { supported: reasons.length === 0, reasons: [...new Set(reasons)],
    readOnly: variant.readOnly === true, steps: variant.steps.length };
}

export function createDeviceDriver({ command, capture, capabilities = {},
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onStep = () => {},
  shouldStop = () => false } = {}) {
  if (typeof command !== 'function' || typeof capture !== 'function') throw new TypeError('device command and capture functions required');
  const emit = (event) => { try { onStep(event); } catch { /* observer only */ } };
  const bounded = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(60000, value)) : fallback;
  async function runScenario(scenario) {
    const support = deviceScenarioSupport(scenario, capabilities);
    const startedAt = now();
    const report = { schema: 'inklab.device-run.v1', target: 'real-glasses',
      scenarioId: scenario.id, title: scenario.title, startedAt, endedAt: null,
      status: 'running', ok: false, businessVerified: false,
      evidence: { image: 'adb-raw-png', voiceInput: scenario.device?.steps?.some((s) => s?.say) ? 'simulated-asr-text' : 'none',
        microphoneVerified: false, ttsCompletionVerified: false },
      steps: [], shots: [], skipped: 0, failure: null };
    if (!support.supported) {
      return { ...report, endedAt: now(), status: 'unsupported', skipped: scenario.device?.steps?.length || 0,
        summary: support.reasons.join('；'), support };
    }
    let assertions = 0;
    const steps = scenario.device.steps;
    for (let index = 0; index < steps.length; index += 1) {
      if (shouldStop()) { report.status = 'cancelled'; break; }
      const step = steps[index];
      const kind = DEVICE_STEP_KINDS.find((k) => k in step);
      const label = step.label || `${kind} ${typeof step[kind] === 'string' ? step[kind] : ''}`.trim();
      emit({ phase: 'start', index, kind, label });
      const at = now();
      let outcome = { ok: true, verification: 'dispatch-only' };
      try {
        if (kind === 'press' || kind === 'activate' || kind === 'back') {
          const key = kind === 'press' ? DEVICE_KEYS[step.press] : kind === 'activate' ? 'enter' : 'back';
          outcome.receipt = await command({ command: 'key', value: key,
            waitMs: bounded(step[kind]?.settleMs, kind === 'press' ? 250 : 1300) });
        } else if (kind === 'pressMany') {
          for (let n = 0; n < step.pressMany[1]; n += 1) {
            if (shouldStop()) throw new Error('场景已停止');
            await command({ command: 'key', value: DEVICE_KEYS[step.pressMany[0]], waitMs: 250 });
          }
        } else if (kind === 'wait') {
          // Keep cancellation responsive without inventing a device clock.
          for (let remaining = step.wait; remaining > 0 && !shouldStop(); remaining -= 250) {
            await sleep(Math.min(250, remaining));
          }
          outcome.verification = 'elapsed';
        } else if (kind === 'wake') {
          outcome.receipt = await command({ command: 'wake-assistant', waitMs: 300 });
        } else if (kind === 'say') {
          // Replies can disappear before a fixed six-second wait ends. Observe
          // promptly; expectText polls actual frames while slow replies resolve.
          outcome.receipt = await command({ command: 'say', value: step.say, waitMs: bounded(step.waitMs, 250) });
        } else if (kind === 'shot' || kind === 'expectText') {
          const name = kind === 'shot' ? (typeof step.shot === 'string' ? step.shot : step.shot?.name)
            : `assert-${index + 1}`;
          const deadline = now() + (kind === 'expectText' ? bounded(step.timeoutMs, 10000) : 0);
          let attempt = 0;
          do {
            attempt += 1;
            const screenshot = await capture(name || `step-${index + 1}`, { ocr: kind === 'expectText' });
            report.shots.push({ ...screenshot, step: index, attempt });
            outcome.screenshot = screenshot;
            outcome.verification = kind === 'shot' ? 'captured-unreviewed' : 'screenshot-ocr';
            if (kind !== 'expectText') break;
            outcome = { ...outcome, ...evaluateVisibleText(step.expectText, screenshot.ocr), attempts: attempt };
            if (outcome.ok || outcome.unsupported || shouldStop() || now() >= deadline || attempt >= 12) break;
            await sleep(500);
          } while (true);
          if (kind === 'expectText' && outcome.ok) assertions += 1;
        }
      } catch (err) { outcome = { ok: false, reason: err.message || String(err) }; }
      const result = { index, kind, label, ms: now() - at, ...outcome };
      report.steps.push(result);
      emit({ phase: 'end', ...result });
      if (!outcome.ok) {
        report.status = outcome.unsupported ? 'unsupported' : 'failed';
        report.failure = { index, label, reason: outcome.reason };
        break;
      }
    }
    if (shouldStop() && report.status === 'running') report.status = 'cancelled';
    if (report.status === 'running') report.status = assertions > 0 ? 'passed' : 'pending-review';
    report.businessVerified = report.status === 'passed';
    report.ok = report.businessVerified;
    report.skipped = steps.length - report.steps.length;
    report.endedAt = now();
    report.summary = report.failure ? `第 ${report.failure.index + 1} 步：${report.failure.reason}`
      : report.status === 'passed' ? `${assertions} 项真实截图文字断言通过；其余输入仅记发送完成`
        : report.status === 'cancelled' ? '已停止；后续步骤未执行'
          : '操作与取图完成，尚无画面业务断言；待人工检查原始截图';
    return report;
  }
  return { runScenario };
}
