export default {
  id: 'aiui-017-conformance',
  title: 'AIUI 0.17：API 与组件探针',
  summary: '先记录 Battery/OPFS/World Awareness/Media/TTS 状态，再等待 0.17 组件页首次与增量渲染。',
  build({ caps, view, lab }) {
    const nod = [];
    for (let t = 0; t <= 1500; t += 20) {
      const moving = t >= 300 && t < 1100;
      const angle = moving ? 0.38 * Math.sin((2 * Math.PI * (t - 300)) / 400) : 0;
      nod.push({ t, x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) });
    }
    return [
      { wait: 500, label: '等待 World Awareness 会话建立' },
      {
        do: () => caps.sensors.playTrace('absoluteOrientation', nod),
        label: '注入合成点头四元数',
      },
      { wait: 1700, label: '等待手势检测与 API 探针完成' },
      {
        do: () => {
          const observed = lab.logTail(240).some((line) => line.includes('[conformance] head-gesture'));
          console.log('[conformance] result', JSON.stringify({
            feature: 'head-gesture', status: observed ? 'supported' : 'not-observed',
          }));
        },
        label: '记录头部手势检测结果',
      },
      { shot: 'api-conformance', label: 'API 支持度存证' },
      { wait: 1900, label: '等待自动进入组件页并完成增量更新' },
      {
        label: '组件页已执行',
        expect: () => lab.pagesLoaded().some((page) => page.includes('pages/components/index'))
          || `组件页未加载；日志：${lab.logTail(8).join(' | ')}`,
      },
      { shot: 'component-conformance', label: 'table/timed-text/streamdown/video 存证' },
      {
        label: '引擎仍在运行态',
        expect: () => view.isRunning?.() !== false || '组件探针后引擎已停止',
      },
    ];
  },
};
