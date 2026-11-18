<script type="application/json" def>
{ "navigationBarTitleText": "IMU 引导录制", "description": "逐段提示动作，录下 IMU 真实读数", "schema": { "data": { "type": "object", "properties": {} } } }
</script>

<script setup>
// 引导录制：只在录一段时开三个传感器（60Hz 请求，真机给多少录多少），录完就关。
// 每段先倒数 3 秒（这 3 秒也录，算动作前的静止引子），再做动作。
// 日志格式与模拟 IMU 调试包的录制行相同（lib/imu-trace.mjs）：
//   [inklab-imu] {"v":1,"s":"absoluteOrientation","f":60,"r":[[ts,x,y,z,w],…]}
//   [inklab-imu] {"v":1,"ev":"segment","phase":"begin|end","id":…,"ts":…,"expect":{…}}
// ts 用传感器自己的时间戳（真机上是开机时钟毫秒），段落边界按同一个时钟估算。
// 触控板：单击开始这一段；向前滑跳过；向后滑回到上一段重录；双击退出（已录的段落照样保存）。
// 停在提示页时不开传感器：眼镜上退回卡片的实例不会销毁，而且卡片里页面仍算「显示中」（onShow），
// 传感器常开会一直耗电。录完请求退出。

import wx from 'wx';

const PREFIX = '[inklab-imu] ';
// 这个实例的编号：眼镜上之前打开过的实例（以及别的调试包的录制实例）退回卡片后不会销毁，
// InkLab 只收这次打开的这个实例的数据。
const BUILD = `guided-${Math.random().toString(16).slice(2, 10)}`;
const emit = (event) => console.log(PREFIX + JSON.stringify({ v: 1, b: BUILD, ...event }));
const r5 = (v) => Math.round(v * 100000) / 100000;
const r3 = (v) => Math.round(v * 1000) / 1000;

const SEGMENTS = [
  { id: 'still', label: '静止', text: '戴好，头摆正看前方，不要动', seconds: 30, expect: { nod: 0, shake: 0 } },
  { id: 'axes', label: '方向核对', text: '跟着提示慢慢做', seconds: 24, poses: [
    ['up', '抬头'], ['neutral', '摆正'], ['down', '低头'], ['neutral', '摆正'],
    ['turn-left', '向左转头'], ['neutral', '摆正'], ['turn-right', '向右转头'], ['neutral', '摆正'],
    ['tilt-left', '向左歪头（左耳靠左肩）'], ['neutral', '摆正'], ['tilt-right', '向右歪头（右耳靠右肩）'], ['neutral', '摆正'],
  ] },
  { id: 'nod-normal', label: '正常点头', text: '正常点头 5 次', seconds: 15, expect: { nod: 5 } },
  { id: 'nod-light', label: '轻微点头', text: '轻轻点头 5 次（幅度小一点）', seconds: 15, expect: { nod: 5 } },
  { id: 'nod-fast', label: '快速连点', text: '快速连续点头 3 次', seconds: 10, expect: { nod: 3 } },
  { id: 'look-down', label: '低头看东西', text: '慢慢低头看手里的东西，再慢慢抬头，做 3 次', seconds: 20, expect: { nod: 0 } },
  { id: 'shake-normal', label: '摇头', text: '正常摇头 3 次', seconds: 15, expect: { shake: 3 } },
  { id: 'look-around', label: '左右看', text: '慢慢向左看、再向右看，来回几次', seconds: 20, expect: { shake: 0 } },
  { id: 'tilt-sweep', label: '歪头扫动', text: '头向左歪、向右歪，来回慢慢扫', seconds: 20 },
  { id: 'talk', label: '说话和笑', text: '正常说几句话，笑一笑', seconds: 20, expect: { nod: 0, shake: 0 } },
  { id: 'walk', label: '走动', text: '站起来走几步，再坐下', seconds: 30, expect: { nod: 0, shake: 0 } },
  { id: 'drift', label: '长时间静止（可选）', text: '头摆正不动 2 分钟，看偏航漂多少', seconds: 120, expect: { nod: 0, shake: 0 }, optional: true },
];

const SENSORS = [
  ['absoluteOrientation', typeof AbsoluteOrientationSensor === 'function' ? AbsoluteOrientationSensor : null],
  ['accelerometer', typeof Accelerometer === 'function' ? Accelerometer : null],
  ['gyroscope', typeof Gyroscope === 'function' ? Gyroscope : null],
];

function keyOf(e) {
  const d = (e && e.detail) || {};
  const names = [e && e.key, e && e.code, d.key, d.code];
  const codes = [e && e.keyCode, e && e.which, d.keyCode];
  if (names.includes('Enter') || names.includes('NumpadEnter') || codes.includes(66) || codes.includes(13) || codes.includes(23)) return 'tap';
  // 向前滑同时发 RIGHT 和 DOWN、向后滑发 LEFT 和 UP：各只认一个，免得一次滑动算两下
  if (names.includes('ArrowRight') || codes.includes(22) || codes.includes(39)) return 'forward';
  if (names.includes('ArrowLeft') || codes.includes(21) || codes.includes(37)) return 'backward';
  return '';
}

export default {
  data: { title: '', main: '', hint: '' },

  onLoad() {
    this.index = 0;
    this.phase = 'prompt';
    this.logging = false;
    this.rows = {};
    this.lastTs = null;
    this.lastPerf = 0;
    this.timers = [];
    this.lastKey = 0;
    this.sensors = [];
    emit({ ev: 'hello', mode: 'guided', segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label, seconds: s.seconds, expect: s.expect, optional: !!s.optional })) });
    this.prompt();
  },

  onUnload() {
    for (const t of this.timers) clearTimeout(t);
    this.flush();
    this.stopSensors();
    if (this.phase !== 'done') emit({ ev: 'guide-abort', at: this.index });
  },
  onHide() {
    // 正在录的这段作废，回到这段的提示（重新单击再录）
    if (this.phase !== 'countdown' && this.phase !== 'action' && this.phase !== 'warming') return;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.logging = false;
    this.flush();
    this.stopSensors();
    emit({ ev: 'segment-cancelled', id: SEGMENTS[this.index].id });
    this.prompt();
  },

  startSensors() {
    if (this.sensors.length) return;
    for (const [kind, Ctor] of SENSORS) {
      if (!Ctor) { emit({ ev: 'error', s: kind, error: 'NotSupportedError', message: '没有这个传感器类' }); continue; }
      try {
        const s = new Ctor({ frequency: 60 });
        s.addEventListener('reading', () => this.onReading(kind, s));
        s.addEventListener('error', (e) => emit({ ev: 'error', s: kind, error: e && e.error && e.error.name, message: e && e.error && e.error.message }));
        s.start();
        this.sensors.push(s);
      } catch (e) { emit({ ev: 'error', s: kind, error: e && e.name, message: String(e && e.message) }); }
    }
  },
  stopSensors() {
    for (const s of this.sensors) { try { s.stop(); } catch (e) { /* 已停 */ } }
    this.sensors = [];
  },

  onReading(kind, s) {
    const values = kind === 'absoluteOrientation' ? Array.from(s.quaternion || []) : [s.x, s.y, s.z];
    if (!values.length || !values.every((v) => typeof v === 'number')) return;
    this.lastTs = s.timestamp;
    this.lastPerf = performance.now();
    if (!this.logging) return;
    const list = this.rows[kind] || (this.rows[kind] = []);
    list.push([r3(s.timestamp), ...values.map(r5)]);
    if (list.length >= (kind === 'absoluteOrientation' ? 50 : 60)) this.flushKind(kind);
  },
  flushKind(kind) {
    const rows = this.rows[kind];
    if (!rows || !rows.length) return;
    this.rows[kind] = [];
    for (let i = 0; i < rows.length; i += 50) emit({ s: kind, f: 60, r: rows.slice(i, i + 50) });
  },
  flush() { for (const [kind] of SENSORS) this.flushKind(kind); },
  /** 传感器时钟上的「现在」：最后一条读数的时间戳加上之后过去的时间。 */
  clock() { return this.lastTs == null ? null : r3(this.lastTs + (performance.now() - this.lastPerf)); },

  later(fn, ms) { const t = setTimeout(fn, ms); this.timers.push(t); return t; },

  prompt() {
    this.phase = 'prompt';
    const seg = SEGMENTS[this.index];
    this.setData({
      title: `第 ${this.index + 1}/${SEGMENTS.length} 段 · ${seg.label}（${seg.seconds} 秒）`,
      main: seg.text,
      hint: `单击开始 · 向前滑${seg.optional ? '跳过（结束录制）' : '跳过'} · 向后滑重录上一段 · 双击退出`,
    });
  },

  begin() {
    const seg = SEGMENTS[this.index];
    // 先开传感器，等到第一条读数（段落边界要用传感器时钟）
    this.phase = 'warming';
    this.lastTs = null;
    this.startSensors();
    this.setData({ main: '准备…', hint: seg.text });
    const startedAt = performance.now();
    const wait = () => {
      if (this.phase !== 'warming') return;
      if (this.clock() != null) { this.countdown(seg); return; }
      if (performance.now() - startedAt > 3000) { this.stopSensors(); this.prompt(); this.setData({ hint: '传感器没有数据，单击再试' }); return; }
      this.later(wait, 50);
    };
    wait();
  },

  countdown(seg) {
    this.phase = 'countdown';
    this.logging = true;
    const ts = this.clock();
    emit({ ev: 'segment', phase: 'begin', id: seg.id, label: seg.label, ts, expect: seg.expect || null });
    let n = 3;
    const tick = () => {
      if (n > 0) { this.setData({ main: `准备 ${n}`, hint: seg.text }); n -= 1; this.later(tick, 1000); return; }
      this.action(seg);
    };
    tick();
  },

  action(seg) {
    this.phase = 'action';
    const started = performance.now();
    const poses = seg.poses || null;
    const poseMs = poses ? (seg.seconds * 1000) / poses.length : 0;
    let lastPose = -1;
    const tick = () => {
      const elapsed = performance.now() - started;
      const left = Math.max(0, Math.ceil((seg.seconds * 1000 - elapsed) / 1000));
      if (poses) {
        const p = Math.min(poses.length - 1, Math.floor(elapsed / poseMs));
        if (p !== lastPose) { lastPose = p; emit({ ev: 'mark', ts: this.clock(), label: `${seg.id}:${poses[p][0]}` }); }
        this.setData({ main: poses[p][1], hint: `剩 ${left} 秒` });
      } else {
        this.setData({ main: seg.text, hint: `开始！剩 ${left} 秒` });
      }
      if (elapsed >= seg.seconds * 1000) { this.end(seg); return; }
      this.later(tick, poses ? 250 : 1000);
    };
    tick();
  },

  end(seg) {
    emit({ ev: 'segment', phase: 'end', id: seg.id, ts: this.clock() });
    this.logging = false;
    this.flush();
    this.stopSensors();
    this.index += 1;
    if (this.index >= SEGMENTS.length) this.finish();
    else this.prompt();
  },

  finish() {
    this.phase = 'done';
    this.stopSensors();
    emit({ ev: 'guide-done' });
    this.setData({ title: '录完了', main: '可以摘下眼镜', hint: 'InkLab 正在保存轨迹' });
    // 请求退出；前台时宿主可能不放行，那就等用户双击退回卡片（传感器已经关了）
    this.later(() => { try { if (wx && typeof wx.exitMiniProgram === 'function') wx.exitMiniProgram({}); } catch (e) { /* 退不了就算了 */ } }, 3000);
  },

  onKeyDown(e) {
    const key = keyOf(e);
    if (!key) return;
    const now = performance.now();
    if (now - this.lastKey < 350) { if (e && e.preventDefault) e.preventDefault(); return false; }
    this.lastKey = now;
    if (this.phase === 'prompt') {
      if (key === 'tap') this.begin();
      else if (key === 'forward') {
        const seg = SEGMENTS[this.index];
        this.index += 1;
        if (this.index >= SEGMENTS.length || seg.optional) this.finish(); else this.prompt();
      } else if (key === 'backward' && this.index > 0) { this.index -= 1; this.prompt(); }
    }
    if (e && e.preventDefault) e.preventDefault();
    return false;
  },
};
</script>

<page><view class="root">
  <text class="title">{{title}}</text>
  <text class="main">{{main}}</text>
  <text class="hint">{{hint}}</text>
</view></page>

<style>
.root { padding: 32px; }
.title { font-size: 24px; color: #9fffb0; }
.main { font-size: 40px; color: #40ff5e; margin-top: 16px; }
.hint { font-size: 22px; color: #9fffb0; margin-top: 12px; }
</style>
