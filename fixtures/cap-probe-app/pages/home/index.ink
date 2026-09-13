<script type="application/json" def>
{ "navigationBarTitleText": "AIUI 0.17 Conformance", "description": "运行时契约探针", "schema": { "data": { "type": "object", "properties": {} } } }
</script>

<script setup>
const log = (...args) => console.log('[conformance]', ...args);

function apiState(available, ok, error) {
  if (!available) return 'unsupported';
  if (ok) return 'supported';
  if (error && error.name === 'NotSupportedError') return 'unsupported';
  return 'contract-drift';
}

export default {
  data: {
    runtimeText: 'runtime: detecting',
    batteryText: 'battery: probing',
    opfsText: 'opfs: probing',
    worldText: 'world: probing',
    mediaText: 'media: probing',
    ttsText: 'tts task: probing',
    hintText: 'API probe first; component probe opens next.',
  },

  onLoad() {
    this.alive = true;
    this.componentTimer = null;
    this.batteryManager = null;
    this.batteryListener = null;
    let userAgent = 'unknown';
    try { userAgent = String(navigator.userAgent || 'unknown'); } catch (_) {}
    this.setData({ runtimeText: `runtime: ${userAgent}` });
    this.probeWorldAwareness();
    this.probeMediaAndTts();
    this.probeBattery();
    this.probeOpfs();
    this.componentTimer = setTimeout(() => {
      if (this.alive) wx.navigateTo({ url: '/pages/components/index' });
    }, 3200);
  },

  onUnload() {
    this.alive = false;
    if (this.componentTimer) clearTimeout(this.componentTimer);
    if (this.batteryManager && this.batteryListener) {
      this.batteryManager.removeEventListener('levelchange', this.batteryListener);
    }
  },

  onHeadGesture(event) {
    const gesture = event && event.gesture ? event.gesture : 'unknown';
    this.setData({ worldText: `world: supported · ${gesture}` });
    log('head-gesture', gesture);
    log('result', JSON.stringify({ feature: 'head-gesture', status: 'supported', gesture }));
  },

  onOrientationStabilityChange(event) {
    const stable = Boolean(event && event.stable);
    this.setData({ worldText: `world: supported · stable=${stable}` });
    log('orientation-stability', stable);
  },

  probeWorldAwareness() {
    const available = typeof this.enableWorldAwareness === 'function';
    if (!available) {
      this.setData({ worldText: 'world: unsupported' });
      log('result', JSON.stringify({ feature: 'world-awareness', status: 'unsupported' }));
      return;
    }
    try {
      this.enableWorldAwareness({ mode: 'micro' });
      const sensor = this.orientationSensor;
      const status = sensor ? 'supported' : 'partial';
      this.setData({ worldText: `world: ${status}` });
      log('result', JSON.stringify({ feature: 'world-awareness', status, sensor: Boolean(sensor) }));
    } catch (error) {
      this.setData({ worldText: `world: contract-drift · ${error && error.name || 'Error'}` });
      log('result', JSON.stringify({ feature: 'world-awareness', status: 'contract-drift', error: String(error) }));
    }
  },

  probeMediaAndTts() {
    const media = {
      mediaDevices: Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices),
      MediaRecorder: typeof MediaRecorder === 'function',
      ImageCapture: typeof ImageCapture === 'function',
    };
    const count = Object.values(media).filter(Boolean).length;
    const mediaStatus = count === 3 ? 'supported' : count > 0 ? 'partial' : 'unsupported';
    const synthesize = Boolean(typeof speechSynthesis !== 'undefined' && typeof speechSynthesis.synthesize === 'function');
    const speak = Boolean(typeof speechSynthesis !== 'undefined' && typeof speechSynthesis.speak === 'function');
    const ttsStatus = synthesize ? 'supported' : speak ? 'partial' : 'unsupported';
    this.setData({ mediaText: `media: ${mediaStatus} · ${count}/3`, ttsText: `tts task: ${ttsStatus}` });
    log('result', JSON.stringify({ feature: 'media', status: mediaStatus, detail: media }));
    log('result', JSON.stringify({ feature: 'tts-task', status: ttsStatus, synthesize, speak }));
  },

  async probeBattery() {
    const available = Boolean(typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function');
    if (!available) {
      this.setData({ batteryText: 'battery: unsupported' });
      log('result', JSON.stringify({ feature: 'battery', status: 'unsupported' }));
      return;
    }
    try {
      const battery = await navigator.getBattery();
      if (!this.alive) return;
      this.batteryManager = battery;
      this.batteryListener = () => {
        this.setData({ batteryText: `battery: supported · ${Math.round(battery.level * 100)}%` });
        log('battery-change', battery.level, battery.charging);
      };
      battery.addEventListener('levelchange', this.batteryListener);
      this.batteryListener();
      log('result', JSON.stringify({ feature: 'battery', status: 'supported', level: battery.level, charging: battery.charging }));
    } catch (error) {
      const status = apiState(true, false, error);
      this.setData({ batteryText: `battery: ${status} · ${error && error.name || 'Error'}` });
      log('result', JSON.stringify({ feature: 'battery', status, error: String(error) }));
    }
  },

  async probeOpfs() {
    const available = Boolean(typeof navigator !== 'undefined' && navigator.storage
      && typeof navigator.storage.getDirectory === 'function');
    if (!available) {
      this.setData({ opfsText: 'opfs: unsupported' });
      log('result', JSON.stringify({ feature: 'opfs', status: 'unsupported' }));
      return;
    }
    const name = 'inklab-conformance.tmp';
    try {
      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write('AIUI-0.17');
      await writable.close();
      const file = await fileHandle.getFile();
      const bytes = await file.arrayBuffer();
      await root.removeEntry(name, { recursive: false });
      if (!this.alive) return;
      const ok = bytes.byteLength === 9;
      const status = ok ? 'supported' : 'contract-drift';
      this.setData({ opfsText: `opfs: ${status} · ${bytes.byteLength}B` });
      log('result', JSON.stringify({ feature: 'opfs', status, bytes: bytes.byteLength }));
    } catch (error) {
      const status = apiState(true, false, error);
      if (this.alive) this.setData({ opfsText: `opfs: ${status} · ${error && error.name || 'Error'}` });
      log('result', JSON.stringify({ feature: 'opfs', status, error: String(error) }));
    }
  },
};
</script>

<page><view class="page-root">
  <view class="header">
    <text class="kicker">INKLAB / AIUI 0.17</text>
    <text class="title">Runtime conformance</text>
    <text class="runtime">{{runtimeText}}</text>
  </view>
  <view class="checks">
    <text class="check">{{batteryText}}</text>
    <text class="check">{{opfsText}}</text>
    <text class="check">{{worldText}}</text>
    <text class="check">{{mediaText}}</text>
    <text class="check">{{ttsText}}</text>
  </view>
  <text class="hint">{{hintText}}</text>
</view></page>

<style>
.page-root { width: 480px; height: 352px; padding: 28px 32px; box-sizing: border-box; background-color: #000000; display: flex; flex-direction: column; gap: 18px; }
.header { display: flex; flex-direction: column; gap: 3px; border-left: 4px solid #40ff5e; padding-left: 12px; }
.kicker { font-size: 11px; color: rgba(64,255,94,.64); letter-spacing: 2px; }
.title { font-size: 25px; color: #40ff5e; font-weight: 800; }
.runtime { font-size: 10px; color: rgba(64,255,94,.68); white-space: nowrap; overflow: hidden; }
.checks { display: flex; flex-direction: column; gap: 7px; padding: 14px 16px; border: 1px solid rgba(64,255,94,.48); }
.check { font-size: 14px; color: #40ff5e; }
.hint { margin-top: auto; font-size: 11px; color: rgba(64,255,94,.62); }
</style>
