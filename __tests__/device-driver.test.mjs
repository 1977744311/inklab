import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceDriver, deviceScenarioSupport, evaluateVisibleText } from '../lib/node/device-driver.mjs';

const scene = (steps) => ({ id: 'query', device: { readOnly: true, steps } });
const caps = { asrText: true, ocr: true };
const observation = (text) => ({ status: 'available', engine: 'test-fixture', text });

test('legacy build and simulated caps are rejected before any physical input', async () => {
  let touched = 0;
  const driver = createDeviceDriver({ command: () => { touched += 1; }, capture: () => { touched += 1; } });
  const legacy = { id: 'seeded', build() { throw new Error('must never execute'); } };
  assert.equal((await driver.runScenario(legacy)).status, 'unsupported');
  assert.equal(deviceScenarioSupport(scene([{ do() {} }]), caps).supported, false);
  assert.equal(deviceScenarioSupport(scene([{ press: 'Enter', do() {} }]), caps).supported, false);
  assert.equal(deviceScenarioSupport(scene([{ press: 'Enter', offline: true }]), caps).supported, false);
  assert.equal(deviceScenarioSupport(scene([12]), caps).supported, false);
  assert.equal(touched, 0);
});

test('all steps are preflighted; unsupported later step prevents earlier input', async () => {
  let touched = false;
  const driver = createDeviceDriver({ command() { touched = true; }, capture() {}, capabilities: caps });
  const report = await driver.runScenario(scene([{ press: 'ArrowDown' }, { press: 'KEY_DELETE' }]));
  assert.equal(report.status, 'unsupported');
  assert.equal(touched, false);
});

test('dispatch and screenshot success alone remain pending-review', async () => {
  const inputs = [];
  const driver = createDeviceDriver({ command: async (value) => { inputs.push(value); return { dispatched: true }; },
    capture: async () => ({ source: 'adb-raw-png', width: 480, height: 640 }), capabilities: caps });
  const report = await driver.runScenario(scene([{ pressMany: ['ArrowRight', 2] }, { shot: 'actual' }]));
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].waitMs, 250, 'each real CLI input includes a real cooldown in addition to host wake settling');
  assert.equal(report.status, 'pending-review');
  assert.equal(report.ok, false);
  assert.equal(report.businessVerified, false);
  assert.equal(report.shots[0].height, 640);
});

test('only current raw screenshot OCR can satisfy a business assertion', async () => {
  let captures = 0;
  const driver = createDeviceDriver({ command: async () => ({ dispatched: true, resultVerified: false }),
    capture: async (name) => ({ name, sha256: `actual-${++captures}`, ocr: observation('今天已经练了 2 个动作，完成 3 组，共 48 次。') }), capabilities: caps });
  const report = await driver.runScenario(scene([{ say: '今天练了几组了' },
    { expectText: { all: ['今天', '完成3组'], none: ['练完再聊'] } }]));
  assert.equal(report.status, 'passed');
  assert.equal(report.businessVerified, true);
  assert.equal(report.evidence.microphoneVerified, false);
  assert.equal(report.steps[0].verification, 'dispatch-only');
  assert.equal(report.steps[1].verification, 'screenshot-ocr');
  assert.equal(report.shots[0].sha256, 'actual-1');
});

test('visible refusal fails and prevents later navigation', async () => {
  let commands = 0;
  const driver = createDeviceDriver({ command: async () => { commands += 1; },
    capture: async () => ({ ocr: observation('今天练完再聊') }), capabilities: caps });
  const report = await driver.runScenario(scene([{ expectText: { all: ['今天'], none: ['练完再聊'] }, timeoutMs: 0 }, { back: true }]));
  assert.equal(report.status, 'failed');
  assert.equal(report.skipped, 1);
  assert.equal(commands, 0);
});

test('OCR unavailable is unsupported, never a blank-screen pass', async () => {
  const driver = createDeviceDriver({ command() {}, capture: async () => ({ ocr: { status: 'unavailable', reason: 'Vision failed' } }), capabilities: caps });
  const report = await driver.runScenario(scene([{ expectText: '今天' }]));
  assert.equal(report.status, 'unsupported');
  assert.equal(report.ok, false);
  assert.equal(report.failure.reason, 'Vision failed');
});

test('slow replies are matched from a later real frame; every attempt is retained', async () => {
  let captures = 0;
  let now = 0;
  const driver = createDeviceDriver({ command: async () => ({ dispatched: true }),
    capture: async () => ({ id: `frame-${++captures}`, ocr: observation(captures === 1 ? '正在思考' : '今天完成3组') }),
    capabilities: caps, now: () => now, sleep: async (ms) => { now += ms; } });
  const report = await driver.runScenario(scene([{ expectText: '今天完成3组' }]));
  assert.equal(report.status, 'passed');
  assert.equal(report.shots.length, 2);
  assert.equal(report.steps[0].attempts, 2);
  assert.equal(report.shots[0].id, 'frame-1');
  assert.equal(report.shots[1].id, 'frame-2');
});

test('valid zero-training reply is accepted without hardcoding a daily count', () => {
  const spec = { anyOf: [{ all: ['今天', '动作', '完成', '组', '共', '次'] }, { all: ['今天还没有完成的训练组'] }], none: ['练完再聊'] };
  assert.equal(evaluateVisibleText(spec, observation('今天还没有完成的训练组。')).ok, true);
  assert.equal(evaluateVisibleText(spec, observation('今天已经练了10个动作，完成20组，共200次。')).ok, true);
  assert.equal(evaluateVisibleText(spec, observation('今天练完再聊')).ok, false);
});

test('cancellation ends waits without continuing to keys', async () => {
  let stopped = false;
  let pressed = false;
  const driver = createDeviceDriver({ command() { pressed = true; }, capture() {}, capabilities: caps,
    sleep: async () => { stopped = true; }, shouldStop: () => stopped });
  const report = await driver.runScenario(scene([{ wait: 50000 }, { activate: true }]));
  assert.equal(report.status, 'cancelled');
  assert.equal(report.skipped, 1);
  assert.equal(pressed, false);
});

test('invalid UTF-8 size, timing, assertions and required capability are rejected', () => {
  for (const step of [{ say: '中'.repeat(61) }, { wait: Infinity }, { pressMany: ['ArrowRight', -1] },
    { expectText: { none: ['anything'] } }, { shot: { name: 'screen', diffOptions: { tolerance: 100 } } }]) assert.equal(deviceScenarioSupport(scene([step]), caps).supported, false);
  assert.equal(deviceScenarioSupport({ id: 'offline', device: { steps: [], requires: ['mock-caps'] } }, caps).supported, false);
});
