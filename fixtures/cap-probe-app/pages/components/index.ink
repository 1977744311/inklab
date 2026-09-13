<script type="application/json" def>
{ "navigationBarTitleText": "0.17 Components", "description": "组件渲染探针" }
</script>

<script setup>
const columns = JSON.stringify([
  { key: 'name', title: 'Primitive', align: 'left' },
  { key: 'state', title: 'State', align: 'right' },
]);
const rows = JSON.stringify([
  { name: 'table', state: 'rendered' },
  { name: 'timed-text', state: 'rendered' },
]);

export default {
  data: {
    columns,
    rows,
    activeStart: 0,
    activeLength: 4,
    markdown: '**streamdown** initial frame',
    phaseText: 'phase: initial',
  },
  onLoad() {
    console.log('[conformance] component-page loaded');
    this.updateTimer = setTimeout(() => {
      this.setData({
        activeStart: 5,
        activeLength: 6,
        markdown: '**streamdown** incremental update complete',
        phaseText: 'phase: incremental update',
      });
      console.log('[conformance] component-page incremental-update');
    }, 700);
  },
  onUnload() { if (this.updateTimer) clearTimeout(this.updateTimer); },
};
</script>

<page><view class="root">
  <view class="header">
    <text class="kicker">0.17 PRIMITIVES</text>
    <text class="title">Component conformance</text>
    <text class="phase">{{phaseText}}</text>
  </view>
  <view class="probe-row">
    <view class="probe timed">
      <text class="label">timed-text</text>
      <timed-text text="alpha beta gamma" active-start="{{activeStart}}" active-length="{{activeLength}}"></timed-text>
    </view>
    <view class="probe stream">
      <text class="label">streamdown</text>
      <streamdown content="{{markdown}}" streaming="false"></streamdown>
    </view>
  </view>
  <view class="table-shell">
    <table caption="Native table" columns="{{columns}}" rows="{{rows}}" empty-text="No rows"></table>
  </view>
  <view class="video-shell">
    <text class="label">video · empty-source lifecycle</text>
    <video id="probeVideo" class="video" muted="true" object-fit="contain"></video>
  </view>
</view></page>

<style>
.root { width: 480px; height: 352px; padding: 22px 26px; box-sizing: border-box; background-color: #000000; display: flex; flex-direction: column; gap: 10px; }
.header { display: flex; flex-direction: column; border-left: 4px solid #40ff5e; padding-left: 10px; }
.kicker,.label,.phase { font-size: 10px; color: rgba(64,255,94,.62); }
.title { font-size: 22px; color: #40ff5e; font-weight: 800; }
.probe-row { display: flex; flex-direction: row; gap: 8px; }
.probe { width: 206px; height: 58px; padding: 7px; box-sizing: border-box; overflow: hidden; border: 1px solid rgba(64,255,94,.45); color: #40ff5e; font-size: 12px; }
.probe streamdown { width: 100%; max-width: 100%; overflow: hidden; word-break: break-all; color: #40ff5e; font-size: 11px; }
.table-shell { height: 112px; overflow: hidden; color: #40ff5e; font-size: 11px; }
.table-shell table { width: 100%; }
.video-shell { height: 66px; border-top: 1px solid rgba(64,255,94,.35); padding-top: 5px; overflow: hidden; }
.video { width: 100%; height: 42px; background-color: #050805; }
</style>
