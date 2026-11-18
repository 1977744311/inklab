// 真机联动的纯逻辑与流程：设备识别、触控板手势、调试包安装 / 打开 / 退出、保存即推送。
// 全部用假 adb，不需要眼镜；样本取自 RG1（Android 12，Ink 0.20.0-rc）实测输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deviceWarnings, parseDeviceInfo } from '../lib/node/device-info.mjs';
import { GESTURES, KEY_TO_GESTURE, gestureScript, profileById, touchpadProfileFor } from '../lib/node/device-input.mjs';
import {
  assistantLogCommand, assistantProgress, closeAssistant, developCall, installAgent, instanceReady, openAgent, parseDevelopResult, parseDeveloperManifest, presentedSince, teardownSince,
  parseProviderReply, projectAgent, projectSlug, requireNoError, withDeveloperMode,
} from '../lib/node/device-agent.mjs';
import { createDeviceService } from '../lib/node/device-service.mjs';
import { createDeviceLogs, notableLogs, parseLogLine } from '../lib/node/device-logs.mjs';
import { EventEmitter } from 'node:events';
import { parseSubcommand } from '../lib/node/device-e2e.mjs';
import { matchDeviceRuntime } from '../lib/runtime-lock.mjs';
import { readAppConfig } from '../lib/node/app-config.mjs';

const INFO = [
  'model=RG-glasses', 'device=glasses', 'android=12', 'build=SKQ1.240613.001 release-keys',
  'inkVersion=0.20.0-rc.20261109092921', 'inkBuildTime=2026-11-09T09:29:21Z', 'developerMode=1',
  'screenOffTimeout=10000', 'accessibility=null', 'wear.event1=0 1', '@inputs',
  'add device 1: /dev/input/event1', '  name:     "ROKID,PSOC-TP-R"',
  'add device 2: /dev/input/event0', '  name:     "qpnp_pon"', '',
].join('\n');

test('设备识别：版本、触控板档案、佩戴状态；只看触控板那块的佩戴传感器', () => {
  const info = parseDeviceInfo(INFO, 'SN1');
  assert.equal(info.model, 'RG-glasses');
  assert.equal(info.ink.version, '0.20.0-rc.20261109092921');
  assert.equal(info.developerMode, '1');
  assert.equal(info.screenOffTimeoutMs, 10000);
  assert.deepEqual(info.accessibility, []);
  assert.deepEqual(info.touchpad, { path: '/dev/input/event1', name: 'ROKID,PSOC-TP-R', profile: 'rokid-psoc-tp-r' });
  assert.deepEqual(info.wear, { psensor: 0, lowPower: 1 });
});

test('会让真机测试失真的状态逐条说出来：没戴、无障碍服务接管按键、没有触控板档案、开发者模式', () => {
  const worn = deviceWarnings(parseDeviceInfo(INFO.replace('wear.event1=0 1', 'wear.event1=1 0')));
  assert.deepEqual(worn, []);
  const codes = (text) => deviceWarnings(parseDeviceInfo(text)).map((w) => w.code);
  assert.deepEqual(codes(INFO), ['not-worn']);
  assert.deepEqual(codes(INFO.replace('accessibility=null', 'accessibility=com.rokid.dialmenu/com.rokid.dialmenu.RingKeyService')),
    ['not-worn', 'accessibility']);
  assert.deepEqual(codes(INFO.replace('ROKID,PSOC-TP-R', 'OTHER-TP').replace('developerMode=1', 'developerMode=null')),
    ['touchpad-unknown', 'developer-mode']);
  assert.deepEqual(codes(INFO.replace('inkVersion=0.20.0-rc.20261109092921', 'inkVersion=')).slice(0, 1), ['ink-version-unknown']);
});

test('真机的 Ink 版本对到本机最接近的 lane', () => {
  const lane = (id, build) => ({ id, engineVersion: build.split('-')[0], engineBuild: build, glueSha256: 'g', wasmSha256: 'w' });
  const lanes = [lane('craft-0.18.0', '0.18.0'), lane('npm-ink-0.20.0', '0.20.0'), lane('npm-ink-0.21.0-daily.1', '0.21.0-daily.1')];
  assert.deepEqual(matchDeviceRuntime('0.21.0-daily.1', lanes), { id: 'npm-ink-0.21.0-daily.1', match: 'exact' });
  assert.deepEqual(matchDeviceRuntime('0.20.0-rc.20261109092921', lanes), { id: 'npm-ink-0.20.0', match: 'same-version' });
  assert.deepEqual(matchDeviceRuntime('0.21.3', lanes), { id: 'npm-ink-0.21.0-daily.1', match: 'same-minor' });
  assert.deepEqual(matchDeviceRuntime('0.19.2', lanes), { id: 'craft-0.18.0', match: 'nearest-older' });
  assert.equal(matchDeviceRuntime('garbage', lanes), null);
  assert.equal(matchDeviceRuntime('0.20.0', []), null);
});

test('触控板手势：按实测时序写原始按键，先确认屏幕亮着', () => {
  const profile = touchpadProfileFor('ROKID,PSOC-TP-R');
  assert.equal(profile, profileById('rokid-psoc-tp-r'));
  const script = (name, opts) => gestureScript(profile, name, { path: '/dev/input/event1', ...opts });
  assert.match(script('tap'), /^dumpsys display .*mScreenState=ON.*input keyevent 224/);
  assert.match(script('tap'), /P=\/dev\/input\/event1; k\(\)\{ sendevent \$P 1 \$1 1; sendevent \$P 0 0 0; sendevent \$P 1 \$1 0; sendevent \$P 0 0 0; \}; k 204; sleep 0\.48; k 28$/);
  assert.match(script('double-tap'), /k 204; sleep 0\.18; k 204; sleep 0\.30; k 158$/);
  assert.match(script('long-press', { holdMs: 1500 }), /k 204; sleep 0\.48; sendevent \$P 1 148 1; sendevent \$P 0 0 0; sleep 1\.50; sendevent \$P 1 148 0; sendevent \$P 0 0 0$/);
  assert.match(script('forward'), /k 204; sleep 0\.18; k 106; k 108$/);
  assert.match(script('backward'), /k 204; sleep 0\.18; k 105; k 103$/);
  assert.equal(script('wake'), 'input keyevent 224');
  assert.doesNotMatch(script('tap', { wake: false }), /dumpsys/);
  assert.throws(() => script('pinch'), /不支持的手势/);
  assert.throws(() => gestureScript(profile, 'tap', { path: '/dev/input/../x' }), /不是输入设备节点/);
});

test('没有触控板档案时退回 input keyevent；双击退回返回键，长按做不了', () => {
  assert.match(gestureScript(null, 'tap'), /input keyevent 66$/);
  assert.match(gestureScript(null, 'double-tap'), /input keyevent 4$/);
  assert.throws(() => gestureScript(null, 'long-press'), /做不了/);
  assert.deepEqual(GESTURES, ['tap', 'double-tap', 'long-press', 'forward', 'backward', 'wake']);
  assert.equal(KEY_TO_GESTURE.down, 'forward');
  assert.equal(KEY_TO_GESTURE.back, 'double-tap');
});

test('调试包身份：ID 默认 develop.rokid.inklab.<项目>，名字带（调试），权限照 Studio 的写法补齐', () => {
  assert.equal(projectSlug('/x/aiui-zhenghuo/app'), 'zhenghuo');
  assert.equal(projectSlug('/x/My App'), 'my-app');
  const agent = projectAgent({
    appDir: '/x/aiui-chuzhaoba/app',
    appJson: { permissions: ['INTERNET', 'RECORD_AUDIO', 'CAMERA'], window: { navigationBarTitleText: '标题' } },
    agentsMd: '# Agent Manifest\n\n- **Name**: 出招吧！\n- **Summary**: 卡牌对战\n',
    packageVersion: '1.2.0',
  });
  assert.equal(agent.agentId, 'develop.rokid.inklab.chuzhaoba');
  assert.equal(agent.agentName, '出招吧！（调试）');
  assert.equal(agent.agentPrompt, '打开出招吧！调试');
  assert.equal(agent.nativeVersion, '1.2.0');
  assert.deepEqual(agent.permissions, ['RECORD_AUDIO', 'CAMERA', 'network', 'microphone', 'audio', 'camera', 'accelerometer']);
  assert.equal(projectAgent({ appDir: '/x/app', device: { agentId: 'develop.rokid.mine.dev', agentName: '自定' } }).agentName, '自定');
  assert.throws(() => projectAgent({ appDir: '/x/app', device: { agentId: 'com.example.app' } }), /develop\.rokid/);
  assert.throws(() => projectAgent({ appDir: '/x/app', device: { agentId: 'develop.rokid.single' } }), /<业务>\.<id>/, '官方要求 develop.rokid.<业务>.<id>');
});

test('inklab.config.json 的 device 段：校验 agentId 前缀与类型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inklab-device-config-'));
  try {
    await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ device: { agentId: 'develop.rokid.inklab.demo', autoPush: false, page: 'pages/a/index' } }));
    assert.deepEqual((await readAppConfig(dir)).device, { agentId: 'develop.rokid.inklab.demo', autoPush: false, page: 'pages/a/index' });
    await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ device: { agentId: 'demo' } }));
    await assert.rejects(readAppConfig(dir), /develop\.rokid/);
    await writeFile(join(dir, 'inklab.config.json'), JSON.stringify({ device: { autoPush: 'yes' } }));
    await assert.rejects(readAppConfig(dir), /autoPush/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('固件回执解析：开发者接口（按括号配对，消息里带括号也不乱）、错误码、调试包清单', () => {
  assert.deepEqual(parseDevelopResult('Result: Bundle[{result_data={"errorCode":"","message":"a } ] b","ready":true}}]'),
    { errorCode: '', message: 'a } ] b', ready: true });
  assert.deepEqual(parseDevelopResult('{"ok":true}'), { ok: true });
  assert.throws(() => parseDevelopResult('Error: oops'), /result_data/);
  assert.equal(parseProviderReply('Result: Bundle[{result_data={"ok":true,"operationId":"op-1"}}]').operationId, 'op-1');
  assert.throws(() => parseProviderReply('Result: Bundle[{result_data={"ok":false,"errorCode":"DEVELOPER_MODE_DISABLED"}}]'), /DEVELOPER_MODE_DISABLED/);
  assert.equal(requireNoError({ errorCode: '', x: 1 }, 'apply').x, 1);
  assert.throws(() => requireNoError({ errorCode: 'ENTRYPOINT_DISABLED' }, 'prepare'), /开发者模式没开/);
  assert.throws(() => requireNoError({ errorCode: 'ENGINE_INCOMPATIBLE', message: '0.21 required' }, 'status'), /引擎范围.*0\.21 required/);
  assert.throws(() => requireNoError({ errorCode: 'X', message: 'y' }, 'apply'), /apply 失败（X）：y/);
  assert.equal(developCall('status', 'op 1'), "'content' 'call' '--uri' 'content://com.rokid.aiui.develop' '--method' 'status' '--arg' 'op 1'");
  assert.deepEqual(parseDeveloperManifest('{"packages":[{"agentId":"develop.rokid.a.b","agentName":"A","fileMd5":"m"}]}').map((p) => p.agentId), ['develop.rokid.a.b']);
  assert.deepEqual(parseDeveloperManifest('not json'), []);
});

const aiui = (at, fields) => `  ${at}  2009  2009 I AIUI: [AIUI] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`;

test('打开核验只看这次操作之后的日志：真的全屏显示了才算，旧的显示记录不算', () => {
  const log = [
    aiui(1, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.a', outcome: 'COMMITTED' }),
    aiui(101, { event: 'runtime_state', trace_id: 'op', agent_id: 'develop.rokid.a', to_state: 'READY' }),
    aiui(102, { event: 'fullscreen_host_teardown', instance_id: 'x' }),
  ].join('\n');
  assert.equal(presentedSince(log, { agentId: 'develop.rokid.a', since: 100 }), false, '操作前的显示记录不能冒充这次');
  assert.equal(presentedSince(log, { agentId: 'develop.rokid.a', since: 0 }), true);
  assert.equal(presentedSince(`${log}\n${aiui(103, { event: 'presentation_result', agent_id: 'develop.rokid.a', surface: 'ASSISTANT_FULLSCREEN', outcome: 'COMMITTED' })}`, { agentId: 'develop.rokid.a', since: 100 }), true);
  assert.equal(presentedSince(`${log}\n${aiui(103, { event: 'presentation_result', agent_id: 'develop.rokid.a', surface: 'ASSISTANT_CARD', outcome: 'COMMITTED' })}`, { agentId: 'develop.rokid.a', since: 100 }), false, '退回卡片不算全屏');
  assert.equal(instanceReady(log, { operationId: 'op', since: 100 }), true);
  assert.equal(teardownSince(log, 100), true);
  assert.equal(teardownSince(log, 102.5), false);
});

/** 假 adb：按命令内容应答，记下每次调用。 */
function fakeAdb({ manifest = () => '{"packages":[]}', aiuiLog = () => '', developerMode = '1', settings = [], prepareError = '',
  focus = () => '', assistantLog = () => '' } = {}) {
  const calls = [];
  const pushed = {};
  const execute = async (file, args) => {
    calls.push(args);
    const script = args[2] === 'shell' ? args[3] : '';
    if (args[0] === 'devices' || args[1] === 'devices') return { stdout: 'List of devices attached\nSN1 device model:RG_glasses\n' };
    if (args[2] === 'push') {
      if (args[3].endsWith('agent.json')) pushed.agentId = JSON.parse(await readFile(args[3], 'utf8')).agentId;
      return { stdout: '1 file pushed' };
    }
    if (args[2] === 'exec-out') return { stdout: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex') };
    if (script.startsWith('settings get global')) return { stdout: `${developerMode}\n` };
    if (script.startsWith('settings')) { settings.push(script); return { stdout: '' }; }
    if (script.startsWith('cat /sdcard/aiui/package/developer_manifest.json')) return { stdout: manifest() };
    const method = /'--method' '(\w+)'/.exec(script)?.[1];
    if (method === 'prepare') return { stdout: `Result: Bundle[{result_data=${JSON.stringify({ errorCode: prepareError, ready: true, inboxPath: '/sdcard/aiui/package/.staging/adb/' })}}]` };
    if (method === 'apply') return { stdout: `Result: Bundle[{result_data=${JSON.stringify({ errorCode: '', agentId: pushed.agentId, outcome: 'UPDATED', operationId: 'ap-1' })}}]` };
    if (method === 'status') return { stdout: 'Result: Bundle[{result_data={"errorCode":"","publishState":"QUEUED"}}]' };
    if (method === 'open') return { stdout: 'Result: Bundle[{result_data={"ok":true,"operationId":"op-9"}}]' };
    if (script.includes("grep -F '[AIUI]'")) return { stdout: aiuiLog() };
    if (script.includes('mCurrentFocus')) return { stdout: focus() };
    if (script.includes('Dropping Ink instance')) return { stdout: assistantLog() };
    if (script.includes("grep -F 'event=ink_performance'")) return { stdout: aiuiLog().split('\n').filter((l) => l.includes('event=ink_performance')).join('\n') };
    if (script.startsWith('date')) return { stdout: '100.5\n' };
    if (script.includes('echo "model=')) return { stdout: INFO.replace('wear.event1=0 1', 'wear.event1=1 0') };
    return { stdout: '' };
  };
  return { calls, execute, settings };
}

test('开发者模式按借用处理：没开就临时打开，结束（包括失败）后恢复原值', async () => {
  const off = fakeAdb({ developerMode: '0' });
  await withDeveloperMode(off.execute, 'SN1', async () => 'ok');
  assert.deepEqual(off.settings, ['settings put global rokid_aiui_developer_mode 1', "settings put global rokid_aiui_developer_mode '0'"]);
  const missing = fakeAdb({ developerMode: 'null' });
  await assert.rejects(withDeveloperMode(missing.execute, 'SN1', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(missing.settings, ['settings put global rokid_aiui_developer_mode 1', 'settings delete global rokid_aiui_developer_mode']);
  const on = fakeAdb({ developerMode: '1' });
  await withDeveloperMode(on.execute, 'SN1', async () => 'ok');
  assert.deepEqual(on.settings, []);
});

test('安装走官方协议：prepare → 清掉收件目录旧文件 → 推包和 agent.json → apply → status；等清单里出现同一 MD5', async () => {
  const agent = { agentId: 'develop.rokid.inklab.demo' };
  let polls = 0;
  const adb = fakeAdb({ manifest: () => (++polls >= 2 ? '{"packages":[{"agentId":"develop.rokid.inklab.demo","fileMd5":"abc"}]}' : '{"packages":[]}') });
  const result = await installAgent({ execute: adb.execute, serial: 'SN1', aixPath: '/tmp/x.aix', md5: 'abc', agent, wait: async () => {} });
  assert.deepEqual({ inbox: result.inbox, outcome: result.outcome, operationId: result.operationId, publishState: result.publishState },
    { inbox: '/sdcard/aiui/package/.staging/adb', outcome: 'UPDATED', operationId: 'ap-1', publishState: 'QUEUED' });
  const shell = adb.calls.filter((a) => a[2] === 'shell').map((a) => a[3]);
  const methods = shell.map((cmd) => /'--method' '(\w+)'/.exec(cmd)?.[1]).filter(Boolean);
  assert.deepEqual(methods, ['prepare', 'apply', 'status']);
  assert.ok(shell.includes("rm -f '/sdcard/aiui/package/.staging/adb/package.aix' '/sdcard/aiui/package/.staging/adb/agent.json'"));
  assert.ok(shell.some((cmd) => cmd.endsWith("'--method' 'status' '--arg' 'ap-1'")));
  const pushes = adb.calls.filter((a) => a[2] === 'push').map((a) => a[4]);
  assert.deepEqual(pushes, ['/sdcard/aiui/package/.staging/adb/package.aix', '/sdcard/aiui/package/.staging/adb/agent.json']);

  const stale = fakeAdb({ manifest: () => '{"packages":[{"agentId":"develop.rokid.inklab.demo","fileMd5":"old"}]}' });
  await assert.rejects(installAgent({ execute: stale.execute, serial: 'SN1', aixPath: '/tmp/x.aix', md5: 'abc', agent, wait: async () => {}, timeoutMs: 0 }), /仍是旧包 old/);
  const disabled = fakeAdb({ prepareError: 'ENTRYPOINT_DISABLED' });
  await assert.rejects(installAgent({ execute: disabled.execute, serial: 'SN1', aixPath: '/tmp/x.aix', md5: 'abc', agent, wait: async () => {} }), /开发者模式没开/);
});

test('打开：之后出现全屏显示才算；被挡住时做真双击让前台退下，退不掉如实说', async () => {
  const shown = fakeAdb({ aiuiLog: () => [aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }),
    aiui(102, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.a', outcome: 'COMMITTED' })].join('\n') });
  const opened = await openAgent({ execute: shown.execute, serial: 'SN1', agentId: 'develop.rokid.a', page: 'pages/home/index', wait: async () => {} });
  assert.deepEqual({ presented: opened.presented, ready: opened.ready, tries: opened.tries, operationId: opened.operationId },
    { presented: true, ready: true, tries: 0, operationId: 'op-9' });
  const open = shown.calls.find((a) => String(a[3]).startsWith("'content'") && a[3].includes("'open'"))[3];
  assert.match(open, /'--arg' '\{"agentId":"develop\.rokid\.a","path":"pages\/home\/index","target":"_blank","params":\{\}\}'/);

  // 前台有旧实例挡着：第一次双击后它退下，排着的新实例显示出来。
  let taps = 0;
  const blocked = fakeAdb({ aiuiLog: () => [aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }),
    ...(taps ? [aiui(103, { event: 'fullscreen_host_teardown' }), aiui(104, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.a', outcome: 'COMMITTED' })] : [])].join('\n') });
  const original = blocked.execute;
  const counting = async (file, args) => { if (/k 158/.test(args[3] || '')) taps += 1; return original(file, args); };
  const front = await openAgent({ execute: counting, serial: 'SN1', agentId: 'develop.rokid.a', page: 'p/x', wait: async () => {}, timeoutMs: 0,
    bringToFront: true, touchpad: { path: '/dev/input/event1', profile: 'rokid-psoc-tp-r' } });
  assert.equal(front.presented, true);
  assert.equal(front.tries, 1);
  assert.match(front.note, /双击 1 次让它退下后显示/);

  // 前台开始退回但排着的实例没显示出来（退回过程被打断时会这样）：不再连续双击，重新打开一次。
  let opens = 0;
  const returning = fakeAdb({ aiuiLog: () => [aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }),
    aiui(103, { event: 'fullscreen_return_begin' }),
    ...(opens >= 2 ? [aiui(105, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.a', outcome: 'COMMITTED' })] : [])].join('\n') });
  const base = returning.execute;
  const reopening = async (file, args) => { if (String(args[3] || '').includes("'open'")) opens += 1; return base(file, args); };
  const again = await openAgent({ execute: reopening, serial: 'SN1', agentId: 'develop.rokid.a', page: 'p/x', wait: async () => {}, timeoutMs: 0, bringToFront: true });
  assert.deepEqual({ presented: again.presented, tries: again.tries, reopened: again.reopened, opens }, { presented: true, tries: 1, reopened: true, opens: 2 });
  assert.match(again.note, /重新打开/);

  const stuck = fakeAdb({ aiuiLog: () => aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }) });
  const still = await openAgent({ execute: stuck.execute, serial: 'SN1', agentId: 'develop.rokid.a', page: 'p/x', wait: async () => {}, timeoutMs: 0, bringToFront: true, attempts: 2 });
  assert.equal(still.presented, false);
  assert.equal(still.tries, 2);
  assert.match(still.note, /双击 2 次后仍没显示/);
  const queued = await openAgent({ execute: stuck.execute, serial: 'SN1', agentId: 'develop.rokid.a', page: 'p/x', wait: async () => {}, timeoutMs: 0 });
  assert.match(queued.note, /它退出后才会显示/);
});

const ASSIST = 'mCurrentFocus=Window{109d6af u0 com.rokid.os.sprite.assistserver}';
const LAUNCHER = 'mCurrentFocus=Window{38090e7 u0 com.rokid.os.sprite.launcher/com.rokid.os.sprite.launcher.main.SpriteMainActivity}';
const sys = (at, tag, text) => `  ${at}  2009  2009 I ${tag}: ${text}`;

test('助手收起进度：退回卡片、结束这一轮、整个关掉各认各的，之前的日志不算', () => {
  const log = [
    sys(99, 'Ink', 'ink::instance: Dropping Ink instance old'),
    aiui(101, { event: 'fullscreen_return_begin' }),
    sys(102, 'AssistServer_Log', 'AIAssist -> RokidAIController    userExit'),
    sys(103, 'AssistServer_Log', 'AiAssistantDialog -> loadFinish onAnimationEnd pagView：  finish_last'),
    sys(104, 'AssistServer_Log', 'AIAssist -> JsuiFullscreenCoordinator exitFullscreen Card commit observed'),
  ].join('\n');
  assert.deepEqual(assistantProgress(log, 100), { returned: true, ended: true, settled: true, dismissed: false, dropped: 0 });
  const closing = `${log}\n${sys(105, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    exit')}\n${sys(105.1, 'Ink', 'ink::instance: Dropping Ink instance a')}\n${sys(105.2, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    dismiss clearModeData=true')}`;
  assert.deepEqual(assistantProgress(closing, 104.5), { returned: false, ended: false, settled: false, dismissed: true, dropped: 1 });
  assert.equal(assistantProgress(closing, 0).dropped, 2);
  const self = sys(106, 'adbd', "RKD-- daemon_service_to_fd : shell,v2,raw:logcat -d | grep -aF -e 'clearModeData' -e 'Dropping Ink instance'");
  assert.deepEqual(assistantProgress(self, 0), { returned: false, ended: false, settled: false, dismissed: false, dropped: 0 }, 'adbd 记下的这条命令本身不算');
  assert.equal(assistantLogCommand(1794965000.5),
    "logcat -d -v epoch -t 1794965000.500 2>/dev/null | grep -aF -e 'fullscreen_return_begin' -e 'fullscreen_host_teardown' -e 'userExit' -e 'finish_last' -e 'clearModeData' -e 'Dropping Ink instance' | grep -vF daemon_service_to_fd");
});

test('关掉助手：双击一步步退（卡片 → 结束这一轮 → 关掉），每步等日志确认；助手没开就不动', async () => {
  // 模拟眼镜：每次真双击往前走一步，日志按设备时间往后记。
  let clock = 100;
  let taps = 0;
  const lines = [];
  const device = fakeAdb({ focus: () => (taps >= 3 ? LAUNCHER : ASSIST), assistantLog: () => lines.join('\n') });
  const execute = async (file, args) => {
    const script = String(args[3] || '');
    if (script.startsWith('date')) return { stdout: `${(clock += 1).toFixed(3)}\n` };
    if (/k 158/.test(script)) {
      taps += 1;
      const at = clock + 0.5;
      if (taps === 1) lines.push(sys(at, 'Ink', 'ink::instance: Instance x close request denied by host: RootBackspace'), aiui(at, { event: 'fullscreen_return_begin' }));
      if (taps === 2) lines.push(sys(at, 'AssistServer_Log', 'AIAssist -> RokidAIController    userExit'), sys(at + 0.1, 'AssistServer_Log', 'AiAssistantDialog -> loadFinish onAnimationEnd pagView：  finish_last'));
      if (taps === 3) lines.push(sys(at, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    exit'), sys(at, 'Ink', 'ink::instance: Dropping Ink instance a'),
        sys(at, 'Ink', 'ink::instance: Dropping Ink instance b'), sys(at, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    dismiss clearModeData=true'));
    }
    return device.execute(file, args);
  };
  const touchpad = { path: '/dev/input/event1', profile: 'rokid-psoc-tp-r' };
  assert.deepEqual(await closeAssistant({ execute, serial: 'SN1', touchpad, wait: async () => {}, stepTimeoutMs: 0 }),
    { closed: true, already: false, taps: 3, dropped: 2 });
  assert.ok(device.calls.some((a) => /k 204; sleep 0\.18; k 204; sleep 0\.30; k 158/.test(a[3] || '')), '用的是真双击');

  const idle = fakeAdb({ focus: () => LAUNCHER });
  assert.deepEqual(await closeAssistant({ execute: idle.execute, serial: 'SN1', touchpad, wait: async () => {} }),
    { closed: true, already: true, taps: 0, dropped: 0 });
  assert.ok(!idle.calls.some((a) => /k 158|keyevent 4/.test(a[3] || '')), '助手没开时不双击（不往桌面发返回）');

  // 应用把返回当成「上一层」：每一下都没进展，试满次数后如实说。
  const stuck = fakeAdb({ focus: () => ASSIST, assistantLog: () => sys(1, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    exit') });
  const result = await closeAssistant({ execute: stuck.execute, serial: 'SN1', touchpad, wait: async () => {}, maxTaps: 2, stepTimeoutMs: 0 });
  assert.deepEqual({ closed: result.closed, taps: result.taps }, { closed: false, taps: 2 }, '操作之前的关闭记录不算');
  assert.match(result.note, /双击 2 次后助手还开着/);
});

// 假 logcat：启动后吐两行（一行应用告警，一行无关），记下启动参数。
const logcatStarts = [];
function fakeLogcat(bin, args) {
  logcatStarts.push(args);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => child.emit('close');
  setTimeout(() => child.stdout.emit('data', '  1794927391.297  2009  9153 W Ink     : ink_script::console: [audio] 播放失败 music\n  1.0  1 1 I Other: noise\n'), 0);
  return child;
}

async function serviceFixture(t, { build, adbOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'inklab-device-push-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, 'aiui-demo', 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'app.json'), JSON.stringify({ pages: ['pages/home/index'], permissions: [] }));
  let installed = '';
  const adb = fakeAdb({
    manifest: () => `{"packages":[{"agentId":"develop.rokid.inklab.demo","fileMd5":"${installed}"}]}`,
    aiuiLog: () => [aiui(101, { event: 'runtime_state', trace_id: 'op-9', to_state: 'READY' }),
      aiui(102, { event: 'fullscreen_present_result', agent_id: 'develop.rokid.inklab.demo', outcome: 'COMMITTED' }),
      aiui(200, { event: 'ink_performance', agent_id: 'develop.rokid.inklab.demo' })].join('\n'),
    ...adbOptions,
  });
  const builds = [];
  const fakeBuild = build || (async (dir) => { builds.push(dir); installed = `md5-${builds.length}`; return { aixPath: join(root, 'x.aix'), md5: installed, bytes: 10, cleanup: async () => {} }; });
  const service = createDeviceService({ appDir, enabled: true, serial: 'SN1', execute: adb.execute, outputDir: join(root, 'out'),
    vision: { status: async () => ({ available: false }), read: async () => ({}) }, sleepFn: async () => {}, build: fakeBuild,
    runtimeMatcher: (version) => ({ id: `lane-for-${version}`, match: 'exact' }), logStream: createDeviceLogs({ spawnProcess: fakeLogcat }) });
  return { service, adb, builds, appDir };
}

test('推到真机：打包 → 安装 → 打开 → 等第一帧 → 截图，状态里写清结果', async (t) => {
  const { service, builds, appDir } = await serviceFixture(t);
  const status = await service.status();
  assert.equal(status.agent.agentId, 'develop.rokid.inklab.demo');
  assert.deepEqual(status.pages, ['pages/home/index']);
  assert.equal(status.runtimeMatch.id, 'lane-for-0.20.0-rc.20261109092921');
  assert.equal(status.push.auto, true, '保存即推送默认开');
  const result = await service.push();
  assert.deepEqual(builds, [appDir]);
  assert.equal(result.status, 'done');
  assert.equal(result.installed.outcome, 'UPDATED');
  assert.equal(result.opened.presented, true);
  assert.equal(result.opened.firstFrame, true);
  assert.equal(result.page, 'pages/home/index');
  assert.ok(result.screenshot.file);
  assert.deepEqual(logcatStarts.at(-1), ['-s', 'SN1', 'logcat', '-v', 'epoch', '-T', '1']);
  assert.deepEqual(result.logs.map((entry) => [entry.source, entry.level, entry.text]), [['app', 'warn', '[audio] 播放失败 music']]);
  assert.deepEqual(result.reclaimed, { closed: true, already: true, taps: 0, dropped: 0 }, '助手没开：不双击');
});

test('推到真机：打开之前先把助手整个关掉，旧实例一起销毁，结果写进状态', async (t) => {
  const closing = [sys(101, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    exit'), sys(101, 'Ink', 'ink::instance: Dropping Ink instance old-1'),
    sys(101, 'Ink', 'ink::instance: Dropping Ink instance old-2'), sys(101, 'AssistServer_Log', 'AIAssist -> AiAssistantDialog    dismiss clearModeData=true')].join('\n');
  const { service, adb } = await serviceFixture(t, { adbOptions: { focus: () => ASSIST, assistantLog: () => closing } });
  await service.status();
  const result = await service.push();
  assert.deepEqual(result.reclaimed, { closed: true, already: false, taps: 1, dropped: 2 });
  const scripts = adb.calls.map((a) => String(a[3] || ''));
  const tapAt = scripts.findIndex((cmd) => /k 158|keyevent 4$/.test(cmd));
  const openAt = scripts.findIndex((cmd) => cmd.includes("'--method' 'open'"));
  assert.ok(tapAt >= 0 && tapAt < openAt, '先关助手再打开');
  const exited = await service.exit();
  assert.equal(exited.left, true);
  assert.match(exited.note, /已关掉助手，销毁了 2 个实例/);
});

test('日志解析：应用日志、引擎日志、运行时事件摘要，其余丢掉', () => {
  const app = parseLogLine('  1794927391.297  2009  9153 W Ink     : ink_script::console: [audio] 播放失败 music');
  assert.deepEqual(app, { at: 1794927391297, pid: 2009, level: 'warn', source: 'app', text: '[audio] 播放失败 music' });
  assert.equal(parseLogLine('  1794927393.274  2009  9768 I Ink     : ink::instance: Extracting .aix package: "/sdcard/x.aix"').text, 'instance: Extracting .aix package: "/sdcard/x.aix"');
  const event = parseLogLine('  1794927201.398  2009  2009 I AIUI_AiuiRuntimeCoordinator: [AIUI] event=fullscreen_present_result level=INFO agent_id=develop.rokid.a surface=ASSISTANT_FULLSCREEN error_code=NONE outcome=COMMITTED');
  assert.equal(event.source, 'aiui');
  assert.equal(event.text, 'fullscreen_present_result · develop.rokid.a · ASSISTANT_FULLSCREEN · COMMITTED');
  assert.equal(parseLogLine('  1.0  1 1 I BatteryService: level=100'), null);
  assert.deepEqual(notableLogs([app, { ...app, source: 'ink', level: 'info' }, { ...app, source: 'ink', level: 'error' }]).length, 2);
});

test('保存即推送：推送进行中又保存的，结束后合成一次再推；关掉后不再推', async (t) => {
  const { service, builds } = await serviceFixture(t);
  await service.status();
  assert.equal(service.sourceChanged(), true); // 立刻开始推
  assert.equal(service.sourceChanged(), true); // 推送进行中：记一次待推
  assert.equal(service.sourceChanged(), true); // 再保存：仍只是那一次待推
  for (let i = 0; i < 50 && (await service.status()).push.status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(builds.length, 2, '第一次 + 进行中攒下的那一次');
  assert.equal((await service.status()).push.trigger, 'save');
  assert.deepEqual(service.setAutoPush(false), { auto: false });
  assert.equal(service.sourceChanged(), false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(builds.length, 2);
});

test('推送失败时状态里记下卡在哪一步', async (t) => {
  const { service } = await serviceFixture(t, { build: async () => { throw new Error('aiui build 失败：包太大'); } });
  await service.status();
  await assert.rejects(service.push(), /包太大/);
  const { push } = await service.status();
  assert.equal(push.status, 'failed');
  assert.equal(push.stage, '打包');
  assert.match(push.error, /包太大/);
});

test('inklab-device 子命令参数', () => {
  assert.deepEqual(parseSubcommand(['push', 'app', '--page', 'pages/a/index', '--serial', 'SN1']),
    { command: 'push', serial: 'SN1', page: 'pages/a/index', input: 'app', agent: '', gesture: '', holdMs: undefined, json: false,
      imu: '', trace: '', loop: false, name: '', seconds: undefined, note: '', overwrite: false, push: false });
  assert.equal(parseSubcommand(['open', '--agent', 'd59988baa3904de8822978c1b4ec15af', '--page', 'pages/home/index']).agent, 'd59988baa3904de8822978c1b4ec15af');
  assert.throws(() => parseSubcommand(['open']), /--agent/);
  assert.equal(parseSubcommand(['gesture', 'long-press', '--hold-ms', '1500']).holdMs, 1500);
  assert.throws(() => parseSubcommand(['gesture', 'pinch']), /用法/);
  assert.throws(() => parseSubcommand(['push']), /用法/);
  const replay = parseSubcommand(['push', 'app', '--imu', 'replay', '--trace', 'guided#nod-normal', '--loop']);
  assert.deepEqual([replay.imu, replay.trace, replay.loop], ['replay', 'guided#nod-normal', true]);
  assert.throws(() => parseSubcommand(['push', 'app', '--imu', 'replay']), /--trace/);
  assert.throws(() => parseSubcommand(['push', 'app', '--imu', 'live']), /工作台/);
  assert.throws(() => parseSubcommand(['push', 'app', '--imu', 'fly']), /--imu 只能是/);
  const rec = parseSubcommand(['imu-record', 'app', '--name', 'walk-1', '--seconds', '30', '--push']);
  assert.deepEqual([rec.name, rec.seconds, rec.push], ['walk-1', 30, true]);
  assert.throws(() => parseSubcommand(['imu-record', 'app']), /--name/);
  assert.throws(() => parseSubcommand(['imu-record', 'app', '--name', 'x', '--seconds', '0']), /--seconds/);
  assert.equal(parseSubcommand(['imu-guide', '../aiui-zhenghuo/app', '--name', 'rg1-guided']).input, '../aiui-zhenghuo/app');
});

test('模拟器 .mjs 场景拿到真机：调用 build() 取步骤，/app/ 引入映射回应用目录；需要模拟器上下文的标出原因', async (t) => {
  const { loadDeviceScenarios } = await import('../lib/node/device-service.mjs');
  const { deviceScenarioSupport } = await import('../lib/node/device-driver.mjs');
  const root = await mkdtemp(join(tmpdir(), 'inklab-sim-scenes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'e2e/scenarios'), { recursive: true });
  await mkdir(join(root, 'e2e/support'), { recursive: true });
  await mkdir(join(root, 'e2e/device-scenarios'), { recursive: true });
  await writeFile(join(root, 'e2e/support/steps.mjs'), "export const nav = [{ press: 'ArrowDown' }, { wait: 100 }];\n");
  await writeFile(join(root, 'e2e/scenarios/menus.mjs'), "import { nav } from '/app/e2e/support/steps.mjs';\nexport default { id: 'menus', title: '菜单', build() { return [...nav, { activate: true }, { shot: { name: 'lobby' } }]; } };\n");
  await writeFile(join(root, 'e2e/scenarios/probe.mjs'), "export default { id: 'probe', build() { return [{ do: () => 1 }]; } };\n");
  await writeFile(join(root, 'e2e/scenarios/caps.mjs'), "export default { id: 'caps', build({ caps }) { return [caps]; } };\n");
  await writeFile(join(root, 'e2e/scenarios/dup.mjs'), "export default { id: 'dup', build() { return [{ wait: 1 }]; } };\n");
  await writeFile(join(root, 'e2e/device-scenarios/dup.json'), JSON.stringify({ id: 'dup', device: { steps: [{ shot: 'x' }] } }));
  const list = await loadDeviceScenarios(root);
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(byId.dup.source, 'project-device', '同 id 时专门写的真机场景优先');
  assert.equal(byId.menus.source, 'project-simulator');
  assert.deepEqual(byId.menus.device.steps, [{ press: 'ArrowDown' }, { wait: 100 }, { activate: true }, { shot: 'lobby' }]);
  assert.equal(deviceScenarioSupport(byId.menus, {}).supported, true);
  assert.match(deviceScenarioSupport(byId.probe, {}).reasons[0], /do\/expect 函数不能在真机冒充观测/);
  assert.match(byId['invalid-caps.mjs'].error, /需要模拟器提供的上下文/);
});

test('对照页：同名截图配对，模拟器优先用基线、没有再用最近报告，缺的列出来', async (t) => {
  const { writeCompareReport } = await import('../lib/node/device-service.mjs');
  const root = await mkdtemp(join(tmpdir(), 'inklab-compare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await mkdir(join(root, 'e2e/baselines/menus'), { recursive: true });
  await mkdir(join(root, 'e2e/report/menus'), { recursive: true });
  await writeFile(join(root, 'e2e/baselines/menus/lobby.png'), png);
  await writeFile(join(root, 'e2e/report/menus/settings.png'), png);
  await writeFile(join(root, 'd1.png'), png);
  const shots = [{ name: 'lobby', file: join(root, 'd1.png') }, { name: 'settings', file: join(root, 'd1.png') }, { name: 'extra', file: join(root, 'd1.png') }];
  const result = await writeCompareReport({ appDir: root, scenarioId: 'menus', title: '菜单', shots, directory: root });
  assert.equal(result.pairs, 2);
  assert.deepEqual(result.missing, ['extra']);
  const html = await (await import('node:fs/promises')).readFile(result.file, 'utf8');
  assert.equal(html.match(/data:image\/png;base64,/g).length, 5);
  assert.match(html, /模拟器没有这张图/);
});
