// e2e.test.mjs — e2e runner 的纯逻辑：参数解析、DevTools 地址提取、页面 URL 拼装、
// 场景结论口径。Chrome/CDP/服务那部分只能真跑验证（npm run e2e），这里钉的是
// 「判词写错不会当场报错」的那几处。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseE2eArgs, extractDevtoolsWsUrl, buildPageUrl, judgeScenario, summarizeNetLog,
  resolveScenarioLlm, sameLlmConfig, describeLlm, cassetteTargetFor, pinCassetteModel,
  shouldNavigateForScenario,
} from '../e2e.mjs';
import { hash16, stableStringify } from '../lib/caps/llm.mjs';

test('参数解析：场景可多次给也可逗号分隔，未知参数与坏 llm 模式当场抛', () => {
  const opts = parseE2eArgs([
    'apps/x', '--scenario', 'a,b', '--scenario', 'c',
    '--llm', 'replay', '--cassette', 'e2e/cassettes/x.json', '--accept', '--headed',
    '--runtime', 'studio-canary', '--preview', 'optical', '--lighting', 'indoor-bright',
    '--report-dir', 'artifacts/run',
  ]);
  assert.equal(opts.appDir, 'apps/x');
  assert.deepEqual(opts.scenarios, ['a', 'b', 'c']);
  assert.equal(opts.llm, 'replay');
  assert.equal(opts.cassette, 'e2e/cassettes/x.json');
  assert.equal(opts.accept, true);
  assert.equal(opts.headed, true);
  assert.equal(opts.runtime, 'studio-canary');
  assert.equal(opts.preview, 'optical');
  assert.equal(opts.lighting, 'indoor-bright');
  assert.equal(opts.reportDir, 'artifacts/run');
  assert.equal(opts.netGuard, true, '外域出网默认挡下：不给开关就是挡');
  assert.equal(parseE2eArgs(['apps/x', '--no-netguard']).netGuard, false);
  assert.equal(opts.video, true, '舞台录屏默认开：成片进 e2e/report/，随报告可再生');
  assert.equal(parseE2eArgs(['apps/x', '--no-video']).video, false);
  assert.equal(parseE2eArgs(['apps/x']).preview, 'studio', '默认回归证据必须对齐 Studio 黑底');

  assert.throws(() => parseE2eArgs(['--什么鬼']), /不认识的参数/);
  assert.throws(() => parseE2eArgs(['apps/x', '--llm', 'maybe']), /off\/live\/record\/replay/);
  assert.throws(() => parseE2eArgs(['apps/x', '--preview', 'fake']), /studio\/optical/);
});

test('DevTools 地址：从 Chrome stderr 里抠 ws url，抠不到返回 null', () => {
  const noise = 'Fontconfig warning\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-def\nother';
  assert.equal(extractDevtoolsWsUrl(noise), 'ws://127.0.0.1:9222/devtools/browser/abc-def');
  assert.equal(extractDevtoolsWsUrl('nothing here'), null);
});

test('页面 URL：E2E 永远钉死 mock 相机与蓝牙，llm 模式与录像走查询参数', () => {
  assert.equal(buildPageUrl('http://127.0.0.1:8788/'), 'http://127.0.0.1:8788/?camera=mock&bluetooth=mock');
  assert.equal(new URL(buildPageUrl('http://127.0.0.1:8788/?camera=computer')).searchParams.get('camera'), 'mock');
  assert.equal(new URL(buildPageUrl('http://127.0.0.1:8788/?bluetooth=computer')).searchParams.get('bluetooth'), 'mock');
  const u = new URL(buildPageUrl('http://127.0.0.1:8788/', {
    llmMode: 'replay', cassette: 'e2e/cassettes/a.json', model: 'inklab-cassette', documentToken: '2-x',
    runtime: 'studio-stable,studio-canary', preview: 'studio', lighting: 'absolute-dark',
  }));
  assert.equal(u.searchParams.get('llm'), 'replay');
  assert.equal(u.searchParams.get('cassette'), 'e2e/cassettes/a.json');
  assert.equal(u.searchParams.get('llm-model'), 'inklab-cassette');
  assert.equal(u.searchParams.get('e2e-doc'), '2-x');
  assert.equal(u.searchParams.get('runtimes'), 'studio-stable,studio-canary');
  assert.equal(u.searchParams.get('preview'), 'studio');
  assert.equal(u.searchParams.get('lighting'), 'absolute-dark');
  // 外域闸只在显式关掉时才写进 URL——默认值不该在地址栏里留噪声。
  assert.equal(new URL(buildPageUrl('http://127.0.0.1:8788/')).searchParams.get('netguard'), null);
  assert.equal(new URL(buildPageUrl('http://127.0.0.1:8788/', { netGuard: true })).searchParams.get('netguard'), null);
  assert.equal(new URL(buildPageUrl('http://127.0.0.1:8788/', { netGuard: false })).searchParams.get('netguard'), '0');
});

test('场景隔离：首场配置相同可复用新页，第二场起同配置也必须整页导航', () => {
  const replay = { mode: 'replay', cassette: 'x.json', model: 'm' };
  assert.equal(shouldNavigateForScenario(0, replay, replay), false);
  assert.equal(shouldNavigateForScenario(0, { ...replay, model: 'other' }, replay), true);
  assert.equal(shouldNavigateForScenario(1, replay, replay), true,
    '只 reload InkView 会残留 Web Bluetooth wrapper，场景间必须换 document');
});

test('场景结论：步骤失败恒 fail；基线只在工程已有基线时强制；--accept 本轮只收不判', () => {
  const passSteps = { ok: true, summary: '3 步全部通过' };
  const failSteps = { ok: false, summary: '第 2/3 步失败：…' };
  const cleanShots = { hasBaselines: true, baseline: [{ name: 'a', status: 'match', stale: false }] };
  const changedShots = { hasBaselines: true, baseline: [{ name: 'a', status: 'changed', stale: false }] };
  const noBaselines = { hasBaselines: false, baseline: [{ name: 'a', status: 'new', stale: false }] };

  assert.equal(judgeScenario({ report: passSteps, shotReport: cleanShots, accepted: false }).ok, true);
  assert.equal(judgeScenario({ report: failSteps, shotReport: cleanShots, accepted: false }).ok, false);

  const changed = judgeScenario({ report: passSteps, shotReport: changedShots, accepted: false });
  assert.equal(changed.ok, false);
  assert.match(changed.problems.join('\n'), /基线/);

  // 工程还没建过基线：不逼着 fail，提示走 --accept（在 runner 输出里）
  assert.equal(judgeScenario({ report: passSteps, shotReport: noBaselines, accepted: false }).ok, true);
  // --accept 本轮收编，不拿旧基线判
  assert.equal(judgeScenario({ report: passSteps, shotReport: changedShots, accepted: true }).ok, true);

  const replayMiss = judgeScenario({
    report: passSteps,
    shotReport: cleanShots,
    accepted: false,
    llmMode: 'replay',
    llmExchanges: [{ outcome: 'replay-miss' }],
  });
  assert.equal(replayMiss.ok, false, 'replay 未命中不能被应用兜底掩盖');
  assert.match(replayMiss.problems.join('\n'), /LLM 回放未命中 1 次/);
  assert.equal(judgeScenario({
    report: passSteps,
    shotReport: cleanShots,
    accepted: false,
    llmMode: 'replay',
    llmExchanges: [{ outcome: 'replay-hit' }],
  }).ok, true);

  // 设计内非命中：场景声明 expectOutcomes 后按精确多重集对账
  const base = { report: passSteps, shotReport: cleanShots, accepted: false, llmMode: 'replay' };
  // ① 声明与实际吻合（顺序无关）→ 通过
  assert.equal(judgeScenario({
    ...base,
    llmExchanges: [{ outcome: 'fault:http' }, { outcome: 'replay-miss' }, { outcome: 'replay-hit' }],
    llmExpect: ['replay-miss', 'fault:http'],
  }).ok, true, '声明内的失灵演练不该红');
  // ② 预期的 fault 没发生 → 红（比旧闸更严的方向）
  const missingFault = judgeScenario({
    ...base,
    llmExchanges: [{ outcome: 'replay-hit' }],
    llmExpect: ['fault:http'],
  });
  assert.equal(missingFault.ok, false, '声明了的失灵没演出来同样是回归');
  assert.match(missingFault.problems.join('\n'), /与场景声明不符/);
  // ③ 冒出声明外的 miss → 红
  assert.equal(judgeScenario({
    ...base,
    llmExchanges: [{ outcome: 'replay-miss' }, { outcome: 'replay-miss' }],
    llmExpect: ['replay-miss'],
  }).ok, false, '声明外的额外 miss 照样红');
  // ④ 未声明时维持旧契约：任何 miss 即红（上面 replayMiss 用例已钉）

  // resolveScenarioLlm 透传 expectOutcomes，且只在 replay 有意义
  const decld = resolveScenarioLlm({ llm: {
    mode: 'replay', cassette: 'e2e/cassettes/x.json', model: 'm',
    expectOutcomes: ['replay-miss'],
  } }, {}, 'off');
  assert.deepEqual(decld.expectOutcomes, ['replay-miss']);
  assert.equal(resolveScenarioLlm({ llm: { mode: 'off', expectOutcomes: ['replay-miss'] } }, {}, 'off').expectOutcomes ?? null, null);
});

// ── V3 P1-F L5：本轮的网络账面要留进 last-run.json ───────────────────────
//
// 「全程零真实外呼」此前只活在场景内的一条断言里：跑完就没了，事后翻报告看不出这一轮到底
// 有没有东西打出去、被挡下的是谁。runReport 里存两张按域名收敛的名单之后，这个结论才有留痕。

test('L5 网络账面：按域名分成「被闸挡下」与「真放行」两张名单，只看 fetch 层', () => {
  const rows = [
    // 拦截器层记的是「引擎想发什么」，与「实际出去了什么」不是一回事——账只认 fetch 层。
    { layer: 'interceptor', url: 'https://kanjian-trip.example/api/weather', method: 'GET', decision: 'continue' },
    { layer: 'fetch', url: 'https://kanjian-trip.example/api/weather', method: 'GET', decision: 'external-stub' },
    { layer: 'fetch', url: 'https://kanjian-trip.example/api/spots', method: 'GET', decision: 'external-stub' },
    { layer: 'fetch', url: 'http://127.0.0.1:5173/app/lib/x.js', method: 'GET', decision: 'pass' },
    { layer: 'fetch', url: 'http://127.0.0.1:5173/api/manifest', method: 'GET', decision: 'pass' },
    { layer: 'fetch', url: 'https://kanjian-trip.example/api/trips', method: 'POST', decision: 'status' },
    { layer: 'fetch', url: 'https://other.example/x', method: 'GET', decision: 'block' },
  ];
  const net = summarizeNetLog(rows, { truncatedLog: false });

  assert.equal(net.fetchCalls, 6, '只数 fetch 层');
  assert.deepEqual(net.externalStubs, [{ origin: 'https://kanjian-trip.example', count: 2 }],
    '被外域闸挡下的按域名收敛（挡的是谁得看得见，不能只说「挡了」）');
  assert.deepEqual(net.passed, [{ origin: 'http://127.0.0.1:5173', count: 2 }],
    '真放行的只有宿主自己 = 本轮零真实外呼');
  assert.equal(net.stubbed, 1, '场景显式桩掉的单独记，不与外域闸混为一谈');
  assert.equal(net.blocked, 1);
  assert.equal(net.truncatedLog, false);
});

test('L5 网络账面：真打到外网的域名必须出现在 passed 里（这条就是要查的事）', () => {
  const net = summarizeNetLog([
    { layer: 'fetch', url: 'https://kanjian-trip.cepio.cc/api/weather', method: 'GET', decision: 'pass' },
    { layer: 'fetch', url: 'http://127.0.0.1:5173/api/manifest', method: 'GET', decision: 'pass' },
  ]);
  assert.deepEqual(net.passed.map((p) => p.origin).sort(),
    ['http://127.0.0.1:5173', 'https://kanjian-trip.cepio.cc'],
    '闸被关掉/绕开时，账面上必须能一眼看出是哪个线上域名真出去了');
});

test('L5 网络账面：日志被闸丢过就把 truncatedLog 带进报告（账不完整不许装作完整）', () => {
  const net = summarizeNetLog([], { truncatedLog: true });
  assert.equal(net.truncatedLog, true, 'passed 是空的可能只是因为记录被丢了——这个区别必须留在报告里');
  assert.deepEqual(net.passed, []);
});

test('L5 网络账面：坏输入不炸（拿不到 caps.net 时报告照样写得出来）', () => {
  assert.deepEqual(summarizeNetLog(null).passed, []);
  assert.deepEqual(summarizeNetLog(undefined).externalStubs, []);
  assert.equal(summarizeNetLog([{ layer: 'fetch', url: '', decision: 'pass' }]).passed[0].origin, '(空)');
  assert.equal(summarizeNetLog([{ layer: 'fetch', url: 'not a url', decision: 'pass' }]).passed[0].origin, 'not a url');
});

// ── 场景级 LLM 声明（「on 与 off 一条命令一起跑」）─────────────────────────
//
// 这一层要挡住的坏有四种，下面每条测试对着一种：
//   ① 声明被整轮缺省顶掉 → 在线场景在默认跑里悄悄退回 off，测的还是降级路径（正是本波要修的病）；
//   ② 命令行 `--llm live` 顶不动声明 → 真模型抽检跑不起来，得逐个场景改文件；
//   ③ replay 忘了钉 model → 录像键跟着本机 llm.local.json 的模型名走，换台机器恒 replay-miss；
//   ④ record 落盘落到 default.json → 「录一遍 → 提交 → 以后 replay」这条路闭不上环。

test('场景级 LLM：声明赢过整轮缺省（默认跑里在线场景不会被悄悄退回 off）', () => {
  const online = { id: 'llm-fc-intent', llm: { mode: 'replay', cassette: 'e2e/cassettes/fc.json', model: 'inklab-cassette' } };
  const plain = { id: 'voice-nav' };

  // 整轮缺省是 off（工程没有 default.json 时就是这样），声明照样把自己切到 replay。
  assert.deepEqual(resolveScenarioLlm(online, {}, 'off'),
    { mode: 'replay', cassette: 'e2e/cassettes/fc.json', model: 'inklab-cassette', expectOutcomes: null });
  // 没声明的场景吃缺省 —— 既有场景一个都不受影响。
  assert.deepEqual(resolveScenarioLlm(plain, {}, 'off'), { mode: 'off', cassette: null, model: null });
});

test('场景级 LLM：显式声明 off 的场景，即使整轮缺省是 replay 也照样离线', () => {
  // 工程一旦有了 e2e/cassettes/default.json，整轮缺省就变成 replay。
  // offline-degrade 那类场景必须还是离线的——它测的是「模型压根不在场」那一支。
  const offline = { id: 'offline-degrade', llm: { mode: 'off' } };
  assert.deepEqual(resolveScenarioLlm(offline, {}, 'replay'), { mode: 'off', cassette: null, model: null });
});

test('场景级 LLM：命令行 --llm 恒赢（--llm live 一把切成真模型抽检，不必逐个改声明）', () => {
  const online = { id: 'x', llm: { mode: 'replay', cassette: 'e2e/cassettes/fc.json', model: 'inklab-cassette' } };
  const offline = { id: 'y', llm: { mode: 'off' } };

  const live = resolveScenarioLlm(online, { llm: 'live' }, 'off');
  assert.equal(live.mode, 'live');
  assert.equal(live.cassette, null, 'live 不吃录像');
  assert.equal(live.model, null, '假模型名只用于回放对键；live 要打真上游，钉了只会换回 400');

  // 显式 off 也能把在线场景按下去（排查「是不是模型这一路的锅」时的 A/B）。
  assert.equal(resolveScenarioLlm(online, { llm: 'off' }, 'replay').mode, 'off');
  // 反过来，显式 replay 也能把声明 off 的场景拽上线。
  assert.equal(resolveScenarioLlm(offline, { llm: 'replay', cassette: 'e2e/cassettes/z.json' }, 'off').cassette,
    'e2e/cassettes/z.json');
});

test('场景级 LLM：replay 的 model 钉在声明里（录像键含 model，不钉就跨不了机器）', () => {
  const noModel = { id: 'x', llm: { mode: 'replay', cassette: 'e2e/cassettes/a.json' } };
  assert.equal(resolveScenarioLlm(noModel, {}, 'off').model, null,
    '没声明 model 就是 null —— 宿主会回落到 llm.local.json/环境变量里的真模型名');

  const withModel = { id: 'x', llm: { mode: 'replay', cassette: 'e2e/cassettes/a.json', model: 'inklab-cassette' } };
  assert.equal(resolveScenarioLlm(withModel, {}, 'off').model, 'inklab-cassette');
  // record 时**不能**钉假模型名：那一发是真的要打给上游的。
  assert.equal(resolveScenarioLlm(withModel, { llm: 'record' }, 'off').model, null);
});

test('场景级 LLM：--cassette 顶掉声明里的录像（换一盘录像 A/B 不用改场景文件）', () => {
  const s = { id: 'x', llm: { mode: 'replay', cassette: 'e2e/cassettes/a.json', model: 'm' } };
  assert.equal(resolveScenarioLlm(s, { cassette: 'e2e/cassettes/b.json' }, 'off').cassette, 'e2e/cassettes/b.json');
});

test('LLM 配置比对：同一份配置不重复重载，任何一项变了都要重载', () => {
  const a = { mode: 'replay', cassette: 'x.json', model: 'm' };
  assert.equal(sameLlmConfig(a, { ...a }), true);
  assert.equal(sameLlmConfig(a, { ...a, cassette: 'y.json' }), false, '换录像必须重载：录像是装载期读进去的');
  assert.equal(sameLlmConfig(a, { ...a, model: 'other' }), false, '换 model 会换掉所有录像键');
  assert.equal(sameLlmConfig(a, { ...a, mode: 'live' }), false);
  // 缺省形状与显式 off 是同一个（首次装载那份配置就是缺省形状）。
  assert.equal(sameLlmConfig(null, { mode: 'off', cassette: null, model: null }), true);
});

test('LLM 配置人话化：off 就一个字，在线时把录像与钉死的模型都说出来', () => {
  assert.equal(describeLlm({ mode: 'off' }), 'off');
  assert.equal(describeLlm(null), 'off');
  assert.equal(describeLlm({ mode: 'replay', cassette: 'e2e/cassettes/fc.json', model: 'inklab-cassette' }),
    'replay · fc.json · model=inklab-cassette');
  assert.equal(describeLlm({ mode: 'live' }), 'live');
});

test('record 落盘目标：优先落回场景自己声明的录像带（「录一遍 → 提交 → 以后 replay」闭环）', () => {
  const s = { id: 'x', llm: { mode: 'replay', cassette: 'e2e/cassettes/fc.json', model: 'm' } };
  assert.equal(cassetteTargetFor(s, {}), 'e2e/cassettes/fc.json');
  // --save-cassette 显式点名时听它的。
  assert.equal(cassetteTargetFor(s, { saveCassette: 'e2e/cassettes/tmp.json' }), 'e2e/cassettes/tmp.json');
  // 没声明也没点名 → 老口径 default.json。
  assert.equal(cassetteTargetFor({ id: 'y' }, {}), 'e2e/cassettes/default.json');
});

test('场景级 LLM：坏形状不炸（llm 写成字符串/null/缺 mode 都按缺省处理）', () => {
  assert.equal(resolveScenarioLlm({ id: 'x', llm: 'replay' }, {}, 'off').mode, 'off');
  assert.equal(resolveScenarioLlm({ id: 'x', llm: null }, {}, 'off').mode, 'off');
  assert.equal(resolveScenarioLlm({ id: 'x', llm: {} }, {}, 'replay').mode, 'replay');
  assert.equal(resolveScenarioLlm(null, {}, 'off').mode, 'off');
  assert.equal(resolveScenarioLlm(undefined, {}).mode, 'off');
});

test('录完即清洗：键钉到场景声明的假模型名上（不钉的话录像带只在录它那台机器上命中）', () => {
  const raw = {
    version: 1,
    apiStyle: 'openai-chat-completions',
    entries: [{
      key: 'ffffffffffffffff', // 录制时按真模型名算出来的键
      label: '意图分类',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: [DONE]\n\n',
      request: { model: 'dashscope/qwen3.7-plus', stream: true, messages: [{ role: 'user', content: '你好' }], tools: [] },
    }],
  };
  const pinned = pinCassetteModel(raw, 'inklab-cassette');
  const entry = pinned.entries[0];

  assert.equal(entry.request.model, 'inklab-cassette', '请求里的模型名要换成钉死的那个');
  assert.notEqual(entry.key, raw.entries[0].key, '换了 model 就必须换键——不换等于没钉');
  // 键 = hash16(stableStringify(归一化请求))，与 llm.mjs 的 cassetteKey 同一口径。
  assert.equal(entry.key, hash16(stableStringify(entry.request)));
  assert.equal(entry.body, raw.entries[0].body, '正文一个字节都不该动');
  assert.equal(entry.headers['content-type'], 'text/event-stream');
});

test('录完即清洗：没声明 model 就原样不动（别悄悄改一份不知道要钉成什么的录像）', () => {
  const raw = { version: 1, entries: [{ key: 'abc', request: { model: 'real-model' } }] };
  assert.deepEqual(pinCassetteModel(raw, null).entries, raw.entries);
  assert.deepEqual(pinCassetteModel(raw, '   ').entries, raw.entries);
});

test('录完即清洗：手写录像带（没有 request 元数据）原样留着，不写坏它', () => {
  const handWritten = { version: 1, entries: [{ key: '256edcf5c80e2a91', body: 'data: [DONE]\n\n' }] };
  const out = pinCassetteModel(handWritten, 'inklab-cassette');
  assert.deepEqual(out.entries[0], handWritten.entries[0], '重算不了键就别动——静默改键会让整盘录像失效');
  assert.deepEqual(pinCassetteModel({}, 'm').entries, []);
});
