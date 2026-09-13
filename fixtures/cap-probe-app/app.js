// 能力接线探针 fixture：只做一件事——开机就去碰每个宿主能力，把引擎实际调没调宿主暴露出来。
// 用来把「能力没被调用」从被测应用里隔离出去。入口形态对齐 AIUI：默认导出对象，不用 App()。
export default {
  onLaunch() { console.log('[capprobe] app onLaunch'); },
  onError(e) { console.error('[capprobe] app onError', e); },
};
