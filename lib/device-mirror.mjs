import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const START = Buffer.from([0xff, 0xd8]);
const END = Buffer.from([0xff, 0xd9]);

// ffmpeg image2pipe emits complete JPEG images. Bound the parser and retain a
// split SOI byte; never retain an unbounded decoder stream or a slow client's queue.
export function createJpegFramer(onFrame, { maxBytes = 4 * 1024 * 1024 } = {}) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > maxBytes) throw new Error('视频解码帧超过缓冲上限');
      for (;;) {
        const start = pending.indexOf(START);
        if (start < 0) { pending = pending.subarray(Math.max(0, pending.length - 1)); return; }
        if (start) pending = pending.subarray(start);
        const end = pending.indexOf(END, 2);
        if (end < 0) return;
        const frame = pending.subarray(0, end + 2);
        pending = pending.subarray(end + 2);
        onFrame(frame);
      }
    },
    clear() { pending = Buffer.alloc(0); },
  };
}

export function mirrorFps(times, now, windowMs = 3000) {
  const recent = times.filter((at) => now - at <= windowMs);
  if (recent.length < 2 || now - recent[recent.length - 1] > 1000) return 0;
  return Math.round((recent.length - 1) * 10000 / Math.max(1, recent[recent.length - 1] - recent[0])) / 10;
}

export function screenrecordCommand(pidFile, duration = 170) {
  if (!/^\/data\/local\/tmp\/inklab-mirror-[a-f0-9-]+\.pid$/.test(pidFile)) throw new Error('invalid owned pid file');
  // Fixed shell tokens only. The PID file belongs to this recording, so cleanup
  // never kills an unrelated screenrecord/scrcpy instance on the device.
  return `echo $$ > ${pidFile}; exec screenrecord --output-format=h264 --size 480x640 --bit-rate 2000000 --time-limit ${duration} -`;
}

export function remoteMirrorCleanup(pidFile) {
  if (!/^\/data\/local\/tmp\/inklab-mirror-[a-f0-9-]+\.pid$/.test(pidFile)) throw new Error('invalid owned pid file');
  return `if [ -f ${pidFile} ]; then p=$(cat ${pidFile}); case "$p" in ''|*[!0-9]*) ;; *) if [ "$(cat /proc/$p/comm 2>/dev/null)" = screenrecord ]; then kill -2 "$p" 2>/dev/null; fi ;; esac; rm -f ${pidFile}; fi`;
}

export function createDeviceMirror({ spawnProcess = spawn, execute = exec, now = Date.now,
  adb = process.env.ADB || 'adb', ffmpeg = process.env.FFMPEG || 'ffmpeg',
  inputBusy = () => false, orphanMs = 2500, firstFrameMs = 10000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null;
  let generation = 0;
  let starting = false;

  function snapshot() {
    if (!current) return { status: 'stopped', mode: 'h264-video', frames: 0, fps: 0 };
    return { id: current.id, serial: current.serial, status: current.status,
      mode: 'h264-video', transport: 'ADB H.264 → ffmpeg JPEG → local event stream',
      width: 480, height: 640, frames: current.frames, fps: mirrorFps(current.times, now()),
      lastFrameAt: current.lastFrameAt, decodedFrameAgeMs: current.lastFrameAt ? now() - current.lastFrameAt : null,
      firstFrameMs: current.firstFrameMs, restarts: current.restarts, viewers: current.clients.size,
      startedAt: current.startedAt, error: current.error, keepAwake: current.keepAwake,
      evidence: 'compressed-preview-only', endToEndLatencyMeasured: false };
  }
  function writeEvent(res, event, value) {
    if (res.destroyed || res.writableEnded) return false;
    if (res.writableLength > 512 * 1024) return false; // latest frames win
    return res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function broadcast(event, value, session = current) {
    for (const res of session?.clients || []) writeEvent(res, event, value);
  }
  function changeStatus(status, error = null, session = current) {
    if (!session) return;
    session.status = status; session.error = error;
    broadcast('state', snapshot(), session);
  }
  async function cleanupPipeline(session) {
    const pipeline = session.pipeline;
    if (!pipeline) return;
    session.pipeline = null;
    pipeline.closed = true;
    clearTimer(pipeline.firstTimer);
    clearTimer(pipeline.rollTimer);
    pipeline.encoder.stdout?.unpipe(pipeline.decoder.stdin);
    pipeline.decoder.stdin?.destroy();
    for (const child of [pipeline.encoder, pipeline.decoder]) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    // Closing the ADB pipe normally ends screenrecord. Also stop our exact remote
    // PID so a stalled encoder cannot outlive the page or local server.
    await execute(adb, ['-s', session.serial, 'shell', '-T', remoteMirrorCleanup(pipeline.pidFile)],
      { timeout: 3000, maxBuffer: 4096 }).catch(() => {});
  }
  async function stop(reason = 'stopped') {
    generation += 1;
    const session = current;
    if (!session) return snapshot();
    session.stopped = true;
    clearTimer(session.orphanTimer);
    clearTimer(session.wakeTimer);
    clearTimer(session.statusTimer);
    changeStatus(reason === 'stopped' ? 'stopped' : 'error', reason === 'stopped' ? null : reason, session);
    for (const res of session.clients) { try { res.end(); } catch { /* disconnected */ } }
    session.clients.clear();
    await cleanupPipeline(session);
    return snapshot();
  }
  function scheduleOrphan(session) {
    clearTimer(session.orphanTimer);
    session.orphanTimer = setTimer(() => {
      if (current === session && !session.clients.size) stop().catch(() => {});
    }, orphanMs);
  }
  function statusTick(session) {
    if (session.stopped || current !== session) return;
    broadcast('state', snapshot(), session);
    session.statusTimer = setTimer(() => statusTick(session), 1000);
  }
  function wakeTick(session) {
    if (session.stopped || current !== session || !session.keepAwake) return;
    // Temporary wake events only: no persistent settings changes. Skip protocol
    // input frames while the scenario/command owns the input lane.
    if (!inputBusy()) execute(adb, ['-s', session.serial, 'shell', 'input', 'keyevent', '224'],
      { timeout: 3000, maxBuffer: 4096 }).catch(() => {});
    session.wakeTimer = setTimer(() => wakeTick(session), 8000);
  }
  async function launchPipeline(session) {
    const epoch = generation;
    const pidFile = `/data/local/tmp/inklab-mirror-${randomUUID()}.pid`;
    const encoder = spawnProcess(adb, ['-s', session.serial, 'shell', '-T', screenrecordCommand(pidFile)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = spawnProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-probesize', '32',
      '-analyzeduration', '0', '-flags', 'low_delay', '-f', 'h264', '-i', 'pipe:0',
      '-an', '-sn', '-threads', '1', '-fps_mode', 'passthrough', '-c:v', 'mjpeg',
      '-q:v', '4', '-flush_packets', '1', '-f', 'image2pipe', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const pipeline = { encoder, decoder, pidFile, closed: false, stderr: '', firstTimer: null, rollTimer: null };
    session.pipeline = pipeline;
    const fail = (message) => {
      if (pipeline.closed || session.stopped || epoch !== generation || current !== session) return;
      stop(message || '视频流中断').catch(() => {});
    };
    for (const child of [encoder, decoder]) {
      child.on('error', (err) => fail(err.message));
      child.stderr?.on('data', (bytes) => { pipeline.stderr = (pipeline.stderr + bytes.toString()).slice(-2000); });
      child.on('close', (code) => fail(`视频进程结束 (${code})${pipeline.stderr ? `：${pipeline.stderr.trim()}` : ''}`));
    }
    decoder.stdin?.on('error', (err) => { if (err.code !== 'EPIPE') fail(err.message); });
    encoder.stdout.pipe(decoder.stdin);
    const parser = createJpegFramer((jpeg) => {
      if (session.stopped || epoch !== generation || current !== session) return;
      const at = now();
      session.frames += 1; session.lastFrameAt = at;
      session.times.push(at);
      session.times = session.times.filter((t) => at - t <= 3000).slice(-500);
      if (session.firstFrameMs == null) session.firstFrameMs = at - session.startedAt;
      clearTimer(pipeline.firstTimer);
      if (session.status !== 'streaming') changeStatus('streaming', null, session);
      const frame = { seq: session.frames, at, width: 480, height: 640, data: jpeg.toString('base64') };
      session.lastFrame = frame;
      broadcast('frame', frame, session);
    });
    decoder.stdout.on('data', (chunk) => { try { parser.push(chunk); } catch (err) { fail(err.message); } });
    pipeline.firstTimer = setTimer(() => fail(`设备未在 ${firstFrameMs / 1000} 秒内输出视频帧${pipeline.stderr ? `：${pipeline.stderr}` : ''}`), firstFrameMs);
    // Android screenrecord caps each recording at 180 seconds. Rotate early,
    // before the process exits; each JPEG is independently decodable by viewers.
    pipeline.rollTimer = setTimer(async () => {
      if (session.stopped || current !== session || epoch !== generation) return;
      changeStatus('restarting', null, session);
      await cleanupPipeline(session);
      if (session.stopped || current !== session || epoch !== generation) return;
      session.restarts += 1;
      launchPipeline(session).catch((err) => stop(err.message).catch(() => {}));
    }, 165000);
  }
  async function start(serial, { keepAwake = true } = {}) {
    if (starting) throw Object.assign(new Error('正在启动投屏'), { statusCode: 409 });
    if (current && !current.stopped && current.serial === serial) return snapshot();
    starting = true;
    try {
      await stop();
      const startEpoch = generation;
      if (typeof serial !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(serial)) throw new Error('invalid device serial');
      await execute(ffmpeg, ['-version'], { timeout: 5000, maxBuffer: 4096 });
      if (generation !== startEpoch) throw new Error('投屏启动已取消');
      const session = { id: randomUUID(), serial, startedAt: now(), status: 'starting', frames: 0,
        times: [], lastFrameAt: null, firstFrameMs: null, lastFrame: null, restarts: 0,
        clients: new Set(), stopped: false, keepAwake: keepAwake !== false, error: null };
      current = session;
      wakeTick(session);
      statusTick(session);
      await launchPipeline(session);
      scheduleOrphan(session);
      return snapshot();
    } finally { starting = false; }
  }
  function subscribe(id, res) {
    const session = current;
    if (!session || session.id !== id || session.stopped) throw new Error('投屏会话已结束，请重新开始');
    clearTimer(session.orphanTimer);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no' });
    session.clients.add(res);
    writeEvent(res, 'state', snapshot());
    if (session.lastFrame) writeEvent(res, 'frame', session.lastFrame);
    res.on('close', () => { session.clients.delete(res); if (!session.clients.size && !session.stopped) scheduleOrphan(session); });
  }
  return { start, stop, subscribe, snapshot, close: stop };
}
