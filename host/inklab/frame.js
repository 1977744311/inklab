// frame.js — 帧调度：rAF 保活（rAF 停摆时计时器续上队列）与手动 pump 摇帧。必须先于引擎 glue 加载。

// ── rAF 保活 ────────────────────────────────────────────────────────────
//
// 无头/被判遮挡的 Chrome 可能长时间不派发 rAF（实测 >8s），而引擎 glue 的调度器——
// 页面挂载的续段、startRendering 的渲染循环——全排在 rAF 上。饿死的症状极隐蔽：
// 「页面模块 eval 了但 onLoad 永远不来」「语音导航随机丢」（e2e 实测约一半概率）。
// 手动 pump 只摇 wasm 帧，救不了 glue 层排队的 rAF 任务，反遮挡的 Chrome 旗子也治不住。
// 这里给每个 rAF 回调加一个 32ms 计时器保底：谁先到谁执行、只执行一次——
// 前台时真 rAF（约 16ms）更快，行为不变；rAF 停摆时计时器把队列续上。
// 必须在 import 引擎 glue 之前装好（glue 模块初始化时就会取 rAF 引用）。

const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const rafEntries = new Map();
window.requestAnimationFrame = (cb) => {
  const entry = { done: false, rafId: 0, timerId: 0 };
  const fire = (ts) => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timerId);
    nativeCancelRaf(entry.rafId);
    rafEntries.delete(entry.rafId);
    cb(typeof ts === 'number' ? ts : performance.now());
  };
  entry.rafId = nativeRaf(fire);
  entry.timerId = setTimeout(fire, 32);
  rafEntries.set(entry.rafId, entry);
  return entry.rafId;
};
window.cancelAnimationFrame = (id) => {
  const entry = rafEntries.get(id);
  if (entry) {
    entry.done = true;
    clearTimeout(entry.timerId);
    rafEntries.delete(id);
  }
  nativeCancelRaf(id);
};

// ── 帧泵 ────────────────────────────────────────────────────────────────

/** pump 一次最多摇多少帧。够一次 setData → 布局 → 绘制走完，又不至于卡住 UI 线程。 */
export const PUMP_MAX = 24;

/**
 * 同步摇帧，直到引擎报告没有更多要画的（连续两次 render() 返回 false）。
 *
 * `view.render()` 是公开同步方法，返回「这一帧画了东西没有」。startRendering 的循环
 * 调的也是它，只是排在 rAF 上——页面不可见时 rAF 停摆，那条循环就断了。
 * 手动调用与可见性无关，这正是脚本驱动能在后台标签页里跑通的原因。
 */
export function pump(view, max = PUMP_MAX) {
  let painted = 0;
  let idle = 0;
  for (let i = 0; i < max; i += 1) {
    let more;
    try { more = view.render() === true; } catch { break; } // 视图已销毁等：不该让输入路径炸掉
    if (more) { painted += 1; idle = 0; } else { idle += 1; if (idle >= 2) break; }
  }
  return painted;
}
