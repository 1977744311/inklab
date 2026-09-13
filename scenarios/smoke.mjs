// smoke.mjs — 唯一的内置通用场景：不依赖任何具体应用的键序与文案，任何工程都能跑。
// 应用相关的场景是工程资产，放各工程的 e2e/scenarios/（宿主页面与 e2e runner 都会加载）。
export default {
  id: 'smoke',
  title: '冒烟：应用能跑起来',
  summary: '装载后等首屏落定、截一张图、确认引擎在运行态。适用于任何工程；'
    + '应用专属场景写在工程自己的 e2e/scenarios/ 里。',

  build({ view }) {
    return [
      { wait: 800, label: '等首屏落定' },
      { shot: 'smoke-boot', label: '首屏存证' },
      {
        label: '引擎在运行态',
        expect: () => (view && view.isRunning?.() !== false)
          || '引擎不在运行态：装载多半失败了，看「启动」页签的报错',
      },
    ];
  },
};
