// device-input.mjs — 在真机上做出和手指一模一样的触控板手势。
//
// Rokid 眼镜的触控板是「按键型」设备：手势在触控板固件里识别好，直接发 Linux 按键。
// 所以只要按录到的时序往同一个 /dev/input/eventN 写同样的按键，系统收到的就和真手势完全一样
// （扫描码、来源设备都对得上）；`input keyevent` 做不到这点（扫描码 0、来自虚拟设备），
// 也做不出双击、长按。adb 的 shell 用户在 input 组里，可以写这个设备节点。
//
// 档案按触控板的设备名匹配。时序取自实测录制（RG1，2026-11-17）：
//   每次手指接触先发 KEY_DASHBOARD（系统里是 KEYCODE_NOTIFICATION）；
//   单击：约 0.5 秒后发 ENTER（固件在等是不是双击）；
//   双击：两次接触相隔约 0.2 秒，第一次接触后约 0.5 秒发 BACK；
//   长按：约 0.5 秒后按下 PROG1（系统里是 KEYCODE_PROG_BLUE），松手时抬起；
//   向前滑：接触后约 0.2 秒同时发 RIGHT 与 DOWN；向后滑：LEFT 与 UP。
// 眼镜 10 秒就熄屏，熄屏时的第一个键只会唤醒屏幕，所以每个手势前先确认屏幕亮着。

export const TOUCHPAD_PROFILES = Object.freeze([
  Object.freeze({
    id: 'rokid-psoc-tp-r',
    inputName: 'ROKID,PSOC-TP-R',
    measured: 'RG1 · Android 12 · 2026-11-17',
    codes: Object.freeze({ touch: 204, enter: 28, back: 158, hold: 148, right: 106, down: 108, left: 105, up: 103 }),
  }),
]);

export const GESTURES = Object.freeze(['tap', 'double-tap', 'long-press', 'forward', 'backward', 'wake']);

// 没有档案时退回 input keyevent：能动，但不是真手势（双击、长按做不了）。
const KEYEVENT_FALLBACK = Object.freeze({ tap: '66', 'double-tap': '4', forward: '22', backward: '21', wake: '224' });

// 旧的方向键 / 确认 / 返回按真触控板上对应的手势做：触控板只能前后滑，前滑同时带出右和下。
export const KEY_TO_GESTURE = Object.freeze({
  right: 'forward', down: 'forward', left: 'backward', up: 'backward', enter: 'tap', back: 'double-tap', wake: 'wake',
});

export function touchpadProfileFor(inputName) {
  return TOUCHPAD_PROFILES.find((profile) => profile.inputName === inputName) || null;
}

export function profileById(id) {
  return TOUCHPAD_PROFILES.find((profile) => profile.id === id) || null;
}

const WAKE = "dumpsys display 2>/dev/null | grep -q 'mScreenState=ON' || { input keyevent 224; sleep 0.6; }";

/**
 * 一个手势 → 一段设备端 sh 脚本（纯函数）。
 * @param {object|null} profile  触控板档案；null 时退回 input keyevent
 * @param {string} gesture       GESTURES 之一
 * @param {{ path?: string, holdMs?: number, wake?: boolean }} opts  path 是触控板设备节点
 */
export function gestureScript(profile, gesture, { path = '', holdMs = 1000, wake = true } = {}) {
  if (!GESTURES.includes(gesture)) throw new Error(`不支持的手势：${gesture}（可用：${GESTURES.join('、')}）`);
  if (gesture === 'wake') return 'input keyevent 224';
  const prefix = wake ? `${WAKE}; ` : '';
  if (!profile || !path) {
    if (!KEYEVENT_FALLBACK[gesture]) throw new Error(`没有这台眼镜的触控板档案，做不了「${gesture}」`);
    return `${prefix}input keyevent ${KEYEVENT_FALLBACK[gesture]}`;
  }
  if (!/^\/dev\/input\/event\d+$/.test(path)) throw new Error(`不是输入设备节点：${path}`);
  const hold = Math.max(100, Math.min(10000, Math.round(Number(holdMs) || 1000)));
  const c = profile.codes;
  const press = (code) => `k ${code}`;
  const wait = (ms) => `sleep ${(ms / 1000).toFixed(2)}`;
  const steps = {
    tap: [press(c.touch), wait(480), press(c.enter)],
    'double-tap': [press(c.touch), wait(180), press(c.touch), wait(300), press(c.back)],
    'long-press': [press(c.touch), wait(480), `sendevent $P 1 ${c.hold} 1; sendevent $P 0 0 0`, wait(hold), `sendevent $P 1 ${c.hold} 0; sendevent $P 0 0 0`],
    forward: [press(c.touch), wait(180), press(c.right), press(c.down)],
    backward: [press(c.touch), wait(180), press(c.left), press(c.up)],
  }[gesture];
  return `${prefix}P=${path}; k(){ sendevent $P 1 $1 1; sendevent $P 0 0 0; sendevent $P 1 $1 0; sendevent $P 0 0 0; }; ${steps.join('; ')}`;
}

/** 手势大约要多久（毫秒），调用方据此安排等待与超时。 */
export function gestureDurationMs(gesture, { holdMs = 1000 } = {}) {
  return { tap: 500, 'double-tap': 500, 'long-press': 500 + Number(holdMs || 1000), forward: 200, backward: 200, wake: 300 }[gesture] ?? 500;
}
