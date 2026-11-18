// imu-trace.mjs — IMU 轨迹文件（v2）与真机录制行的读写。模拟器、真机调试包、录制三处共用。
//
// 文件格式（e2e/traces/<名字>.json）：
//   {
//     "format": "inklab-imu-trace", "version": 2,
//     "name": "rg1-guided", "note": "…", "recordedAt": "2026-…",
//     "device": { "model": "RG_glasses", "ink": "0.20.0-rc…", "source": "guided|record|synthetic" },
//     "sensors": {
//       "absoluteOrientation": { "frequency": 60, "rows": [[t, x, y, z, w], …] },
//       "accelerometer":       { "frequency": 60, "rows": [[t, x, y, z], …] }
//     },
//     "segments": [{ "id": "nod-normal", "label": "正常点头 5 次", "from": 1200, "to": 16200, "expect": { "nod": 5 } }],
//     "marks": [{ "t": 3400, "label": "…" }]
//   }
// t 是毫秒，所有传感器共用同一个零点（多传感器回放才对得齐）；样本按真机到手的真实时间戳存，
// **不重采样**——真机请求 60Hz、加速度计实际给 ~101Hz、偶尔还有时间戳相同的重复读数，
// 这些都是要在模拟器里复现的东西。
//
// 也认旧格式：样本数组 [{t,x,y,z}] 或 { sensor, speed, samples }（sensor-trace.mjs / 控制台导入用的）。
//
// 真机录制行（调试包写进 console.log，InkLab 从 logcat 收）：
//   [inklab-imu] {"v":1,"s":"absoluteOrientation","f":60,"r":[[ts,x,y,z,w],…]}   ts = 真机 sensor.timestamp
//   [inklab-imu] {"v":1,"ev":"start|stop|error|segment|mark|hello", …}
// 一行不超过约 3.9KB（RG1 实测 Ink 的 console 行在 ~3979 字节处截断），所以调试包按 3KB 分批。

import { SENSOR_AXES } from './caps/contract.mjs';

export const TRACE_FORMAT = 'inklab-imu-trace';
export const TRACE_VERSION = 2;
export const RECORD_PREFIX = '[inklab-imu] ';
export const TRACE_SENSORS = Object.freeze(Object.keys(SENSOR_AXES));

/** Ink 里的传感器类名 → 轨迹里的传感器名。 */
export const SENSOR_CLASSES = Object.freeze({
  AbsoluteOrientationSensor: 'absoluteOrientation',
  Accelerometer: 'accelerometer',
  Gyroscope: 'gyroscope',
  Magnetometer: 'magnetometer',
});

const round = (v, digits = 5) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function assertSensor(name) {
  if (!TRACE_SENSORS.includes(name)) throw new TypeError(`不认识的传感器：${name}（可用：${TRACE_SENSORS.join(' / ')}）`);
  return name;
}

/** 一条样本 → 统一的 { t, 轴… }；t 非法或轴不是有限数就抛（脏数据宁可当场炸）。 */
function sampleOf(name, raw, index) {
  const axes = SENSOR_AXES[name];
  const fields = Array.isArray(raw) ? { t: raw[0], ...Object.fromEntries(axes.map((axis, i) => [axis, raw[i + 1]])) } : raw;
  const t = Number(fields && fields.t);
  if (!Number.isFinite(t)) throw new TypeError(`${name} 第 ${index} 条样本缺合法的 t`);
  const sample = { t };
  for (const axis of axes) {
    const v = Number(fields[axis]);
    if (!Number.isFinite(v)) throw new TypeError(`${name} 第 ${index} 条样本的 ${axis} 不是有限数`);
    sample[axis] = v;
  }
  return sample;
}

function sortByT(samples) {
  return samples.every((s, i) => i === 0 || s.t >= samples[i - 1].t) ? samples : [...samples].sort((a, b) => a.t - b.t);
}

/**
 * 读任意一种轨迹 → 统一结构：
 *   { name, note, device, recordedAt, speed, durationMs,
 *     sensors: { 传感器: { frequency, samples: [{ t, 轴… }] } }, segments, marks }
 * 时间零点挪到所有传感器最早的那条样本上。
 */
export function normalizeTrace(input, { fallbackSensor = 'accelerometer', name = '' } = {}) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!parsed || typeof parsed !== 'object') throw new TypeError('IMU 轨迹必须是对象或样本数组');
  let sensors = {};
  let speed;
  if (Array.isArray(parsed) || Array.isArray(parsed.samples)) {
    const envelope = Array.isArray(parsed) ? { samples: parsed } : parsed;
    const sensor = assertSensor(typeof envelope.sensor === 'string' && envelope.sensor.trim() ? envelope.sensor.trim() : fallbackSensor);
    speed = envelope.speed === undefined ? 1 : Number(envelope.speed);
    sensors[sensor] = { frequency: Number(envelope.frequency) || null, samples: envelope.samples.map((s, i) => sampleOf(sensor, s, i)) };
  } else if (parsed.sensors && typeof parsed.sensors === 'object') {
    if (parsed.format && parsed.format !== TRACE_FORMAT) throw new TypeError(`不是 InkLab IMU 轨迹：format=${parsed.format}`);
    for (const [sensor, entry] of Object.entries(parsed.sensors)) {
      assertSensor(sensor);
      const rows = Array.isArray(entry && entry.rows) ? entry.rows : Array.isArray(entry && entry.samples) ? entry.samples : null;
      if (!rows) throw new TypeError(`${sensor} 缺 rows`);
      sensors[sensor] = { frequency: Number(entry.frequency) || null, samples: rows.map((r, i) => sampleOf(sensor, r, i)) };
    }
    speed = parsed.speed === undefined ? 1 : Number(parsed.speed);
  } else {
    throw new TypeError('IMU 轨迹必须是样本数组、{ sensor, samples } 或 { format, sensors }');
  }
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError('IMU 轨迹的 speed 必须是正数');
  sensors = Object.fromEntries(Object.entries(sensors).filter(([, v]) => v.samples.length).map(([k, v]) => [k, { ...v, samples: sortByT(v.samples) }]));
  if (!Object.keys(sensors).length) throw new TypeError('IMU 轨迹里没有样本');
  const origin = Math.min(...Object.values(sensors).map((v) => v.samples[0].t));
  const end = Math.max(...Object.values(sensors).map((v) => v.samples[v.samples.length - 1].t));
  // 旧格式的 t 本来就从 0 起；v2 由写入方保证从 0 起。这里只在整体偏移时挪，段落与标记一起挪。
  const shift = origin;
  // 挪零点后按微秒取整：真机时间戳在 4e7 量级，直接相减会留下 1e-11 级的尾巴。
  const rebase = (t) => round(t - shift, 6);
  for (const entry of Object.values(sensors)) entry.samples = entry.samples.map((s) => ({ ...s, t: rebase(s.t) }));
  const segments = (Array.isArray(parsed.segments) ? parsed.segments : []).map((seg, i) => {
    const from = rebase(Number(seg.from));
    const to = rebase(Number(seg.to));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new TypeError(`第 ${i} 个段落的 from/to 不合法`);
    return { id: String(seg.id || `segment-${i + 1}`), label: String(seg.label || seg.id || ''), from, to,
      ...(seg.expect && typeof seg.expect === 'object' ? { expect: { ...seg.expect } } : {}) };
  });
  const marks = (Array.isArray(parsed.marks) ? parsed.marks : [])
    .map((m) => ({ t: rebase(Number(m.t)), label: String(m.label || '') })).filter((m) => Number.isFinite(m.t));
  return {
    name: String(parsed.name || name || ''),
    note: String(parsed.note || ''),
    device: parsed.device && typeof parsed.device === 'object' ? { ...parsed.device } : null,
    recordedAt: parsed.recordedAt ? String(parsed.recordedAt) : null,
    speed,
    durationMs: rebase(end),
    sensors,
    segments,
    marks,
  };
}

/** 统一结构 → v2 文件对象（数字按 5 位小数收紧，t 保留 3 位）。 */
export function encodeTrace(trace) {
  const sensors = {};
  for (const [sensor, entry] of Object.entries(trace.sensors)) {
    const axes = SENSOR_AXES[assertSensor(sensor)];
    sensors[sensor] = {
      ...(entry.frequency ? { frequency: entry.frequency } : {}),
      rows: entry.samples.map((s) => [round(s.t, 3), ...axes.map((axis) => round(s[axis]))]),
    };
  }
  return {
    format: TRACE_FORMAT,
    version: TRACE_VERSION,
    ...(trace.name ? { name: trace.name } : {}),
    ...(trace.note ? { note: trace.note } : {}),
    ...(trace.recordedAt ? { recordedAt: trace.recordedAt } : {}),
    ...(trace.device ? { device: trace.device } : {}),
    ...(trace.speed && trace.speed !== 1 ? { speed: trace.speed } : {}),
    sensors,
    ...(trace.segments && trace.segments.length ? { segments: trace.segments } : {}),
    ...(trace.marks && trace.marks.length ? { marks: trace.marks } : {}),
  };
}

/**
 * 截一段（按段落 id 或 from/to 毫秒），t 重新从 0 起。只要部分传感器时传 sensors。
 * 截出来的样本数为 0 的传感器直接丢掉。
 */
export function sliceTrace(trace, { segment, from, to, sensors } = {}) {
  let start = 0;
  let end = trace.durationMs;
  let picked = null;
  if (segment) {
    picked = trace.segments.find((s) => s.id === segment);
    if (!picked) throw new Error(`轨迹 ${trace.name || ''} 里没有段落 ${segment}（有：${trace.segments.map((s) => s.id).join('、') || '无'}）`);
    start = picked.from;
    end = picked.to;
  }
  if (from !== undefined) start = Number(from);
  if (to !== undefined) end = Number(to);
  if (!(end >= start)) throw new RangeError('截取范围不合法');
  const wanted = sensors ? sensors.map(assertSensor) : Object.keys(trace.sensors);
  const out = {};
  for (const name of wanted) {
    const entry = trace.sensors[name];
    if (!entry) continue;
    const samples = entry.samples.filter((s) => s.t >= start && s.t <= end).map((s) => ({ ...s, t: round(s.t - start, 6) }));
    if (samples.length) out[name] = { ...entry, samples };
  }
  if (!Object.keys(out).length) throw new Error('截出来的这一段没有样本');
  const inside = (t) => t >= start && t <= end;
  return {
    ...trace,
    durationMs: round(end - start, 6),
    sensors: out,
    segments: (picked ? [picked] : trace.segments.filter((s) => inside(s.from) && inside(s.to)))
      .map((s) => ({ ...s, from: round(s.from - start, 6), to: round(s.to - start, 6) })),
    marks: trace.marks.filter((m) => inside(m.t)).map((m) => ({ ...m, t: round(m.t - start, 6) })),
  };
}

/** 列表里展示用的摘要：各传感器的样本数与实际频率、时长、段落。 */
export function traceSummary(trace) {
  const sensors = {};
  for (const [name, entry] of Object.entries(trace.sensors)) {
    const span = entry.samples.length > 1 ? entry.samples[entry.samples.length - 1].t - entry.samples[0].t : 0;
    sensors[name] = { samples: entry.samples.length, hz: span > 0 ? round(((entry.samples.length - 1) * 1000) / span, 1) : null };
  }
  return { name: trace.name, durationMs: round(trace.durationMs, 1), device: trace.device, sensors,
    segments: trace.segments.map((s) => ({ id: s.id, label: s.label, durationMs: round(s.to - s.from, 1), expect: s.expect })) };
}

/**
 * 在模拟器里放一条（多传感器）轨迹：每个传感器各自交给 caps.sensors。
 * mode='play' 立刻切给正在跑的会话（并作为之后新会话的轨迹）；'load' 只对之后新开的会话生效。
 */
export function playTraceInSimulator(sensorCaps, trace, { mode = 'play', loop = false, speed } = {}) {
  const rate = speed === undefined ? trace.speed || 1 : Number(speed);
  const result = {};
  for (const [name, entry] of Object.entries(trace.sensors)) {
    result[name] = mode === 'load'
      ? sensorCaps.loadTrace(name, entry.samples, { speed: rate, loop })
      : sensorCaps.playTrace(name, entry.samples, { speed: rate, loop });
  }
  return result;
}

// ── 真机录制行 ─────────────────────────────────────────────────────────────

/** logcat 里应用 console 的一行 → 录制事件；不是录制行返回 null。 */
export function decodeRecordLine(text) {
  const at = String(text).indexOf(RECORD_PREFIX);
  if (at < 0) return null;
  try {
    const event = JSON.parse(String(text).slice(at + RECORD_PREFIX.length));
    return event && typeof event === 'object' && event.v === 1 ? event : null;
  } catch {
    return { v: 1, ev: 'broken', length: String(text).length };
  }
}

/**
 * 把一串录制事件拼成轨迹。时间轴用真机 sensor.timestamp（同一台设备上各传感器同一时钟）。
 * 段落事件 { ev:'segment', phase:'begin'|'end', id, label, ts, expect } 由引导录制包发出。
 * 内存上限按每个传感器保留最近 maxSeconds 秒。
 */
export function createRecordingAssembler({ maxSeconds = 900 } = {}) {
  const rows = new Map();
  const segments = [];
  const marks = [];
  const meta = { frequency: {}, errors: [], broken: 0, lines: 0, device: null, plan: null, finished: null };
  let open = null;
  let latest = -Infinity;

  function trim(name) {
    const list = rows.get(name);
    const cutoff = latest - maxSeconds * 1000;
    let drop = 0;
    while (drop < list.length && list[drop][0] < cutoff) drop += 1;
    if (drop) list.splice(0, drop);
  }

  return {
    push(event) {
      if (!event) return;
      meta.lines += 1;
      if (event.ev === 'broken') { meta.broken += 1; return; }
      if (event.s && Array.isArray(event.r)) {
        if (!TRACE_SENSORS.includes(event.s)) return;
        if (!rows.has(event.s)) rows.set(event.s, []);
        const list = rows.get(event.s);
        const width = SENSOR_AXES[event.s].length + 1;
        for (const row of event.r) {
          if (Array.isArray(row) && row.length === width && row.every(Number.isFinite)) {
            list.push(row);
            if (row[0] > latest) latest = row[0];
          }
        }
        if (event.f) meta.frequency[event.s] = event.f;
        trim(event.s);
        return;
      }
      if (event.ev === 'hello' && event.device) meta.device = event.device;
      if (event.ev === 'hello' && Array.isArray(event.segments)) meta.plan = event.segments;
      if (event.ev === 'guide-done' || event.ev === 'guide-abort') meta.finished = event.ev;
      if (event.ev === 'error') meta.errors.push({ sensor: event.s, error: event.error, message: event.message });
      if (event.ev === 'mark' && Number.isFinite(event.ts)) marks.push({ ts: event.ts, label: String(event.label || '') });
      if (event.ev === 'segment' && Number.isFinite(event.ts)) {
        if (event.phase === 'begin') open = { id: String(event.id), label: String(event.label || event.id), from: event.ts, expect: event.expect };
        else if (event.phase === 'end' && open && open.id === String(event.id)) {
          // 同一段重录：留最后一次
          const again = segments.findIndex((s) => s.id === open.id);
          if (again >= 0) segments.splice(again, 1);
          segments.push({ ...open, to: event.ts });
          open = null;
        }
      }
    },
    /** 现在攒了多少：{ sensors: { 名: { samples, seconds } }, latest, segments, errors } */
    stats() {
      const sensors = {};
      for (const [name, list] of rows) {
        sensors[name] = { samples: list.length, seconds: list.length > 1 ? round((list[list.length - 1][0] - list[0][0]) / 1000, 1) : 0 };
      }
      return { sensors, latest: Number.isFinite(latest) ? latest : null, segments: segments.map((s) => s.id),
        recording: open ? open.id : null, plan: meta.plan, finished: meta.finished,
        errors: meta.errors.slice(-5), broken: meta.broken, lines: meta.lines };
    },
    /** 真机时钟上最新的时间戳（ms）；外部打标记时用来换算。 */
    latest: () => (Number.isFinite(latest) ? latest : null),
    mark(ts, label) { if (Number.isFinite(ts)) marks.push({ ts, label: String(label || '') }); },
    clear() {
      rows.clear(); segments.length = 0; marks.length = 0; open = null; latest = -Infinity;
      meta.errors.length = 0; meta.broken = 0; meta.lines = 0; meta.plan = null; meta.finished = null;
    },
    /**
     * 取一段拼成轨迹：lastSeconds（最近 N 秒）或 from/to（真机时钟 ms），缺省取全部。
     * 返回 normalizeTrace 的统一结构（t 从 0 起）。
     */
    toTrace({ lastSeconds, from, to, name = '', note = '', device = null, source = 'record', recordedAt = null } = {}) {
      if (!rows.size) throw new Error('还没有收到真机的 IMU 数据（调试包是录制模式吗？应用打开了传感器吗？）');
      let start = from !== undefined ? Number(from) : -Infinity;
      const end = to !== undefined ? Number(to) : Infinity;
      if (lastSeconds !== undefined) start = latest - Number(lastSeconds) * 1000;
      const sensors = {};
      for (const [sensor, list] of rows) {
        const picked = list.filter((r) => r[0] >= start && r[0] <= end);
        if (picked.length) sensors[sensor] = { frequency: meta.frequency[sensor] || null, rows: picked };
      }
      if (!Object.keys(sensors).length) throw new Error('这段时间里没有 IMU 数据');
      const inside = (ts) => ts >= start && ts <= end;
      return normalizeTrace({
        format: TRACE_FORMAT, version: TRACE_VERSION, name, note, recordedAt,
        device: { ...(meta.device || {}), ...(device || {}), source },
        sensors,
        segments: segments.filter((s) => inside(s.from) && inside(s.to)),
        marks: marks.filter((m) => inside(m.ts)).map((m) => ({ t: m.ts, label: m.label })),
      }, { name });
    },
  };
}

/** 轨迹名只许小写字母、数字、横线、下划线、点（落盘到 e2e/traces/<名>.json）。 */
export function traceFileName(name) {
  const value = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) throw new Error(`轨迹名只能用小写字母、数字、点、横线、下划线（1–80 个字符）：${value || '（空）'}`);
  return `${value}.json`;
}
