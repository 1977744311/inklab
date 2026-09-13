// probe.mjs — 回声探针能力集：把引擎对每个能力方法的真实调用参数录下来。
//
// 官方对 args 形状没有任何文档。与其猜，不如让引擎自己说：探针把全部命名空间的
// 全部方法都装上，每次调用记一条 {ns, method, args}，返回一个最小可用的结果让流程走下去。
// 录到的样本回填进各能力模块的实现与测试，之后探针只在排查新能力时才用。

import { CAPABILITY_METHODS, routeOf } from './contract.mjs';

/**
 * @param {object} opts
 * @param {(rec:{ns:string,method:string,args:any,at:number}) => void} [opts.onCall] 每次调用的观察钩子
 * @param {(ns:string, method:string, args:any) => any} [opts.reply] 自定义返回值；缺省给保守的空结果
 * @param {() => number} [opts.now]
 */
export function createProbeCapabilities({ onCall, reply, now = () => Date.now() } = {}) {
  const calls = [];

  // 缺省返回值：宁可让引擎认为"能力在但没数据"，也不要抛错——抛错会把调用链打断，
  // 后面的方法就录不到了，探针的意义就没了。
  const defaultReply = (ns, method) => {
    if (ns === 'media' && method === 'enumerateDevices') return [];
    if (ns === 'media' && method === 'takePhoto') return { data: new Uint8Array(), mimeType: 'image/png' };
    if (ns === 'openService' && method === 'getVendorHeaders') return {};
    if (ns === 'openService' && method === 'getManifest') return {};
    if (ns === 'languageModel' && method === 'getConfig') return {};
    if (ns === 'payment' && method === 'canMakePayment') return false;
    return undefined;
  };

  const caps = {};
  for (const [ns, methods] of Object.entries(CAPABILITY_METHODS)) {
    caps[ns] = {};
    for (const method of methods) {
      caps[ns][method] = async (args) => {
        const rec = { ns, method, args, route: routeOf(args), at: now() };
        calls.push(rec);
        if (typeof onCall === 'function') { try { onCall(rec); } catch { /* 观察钩子不反伤 */ } }
        const custom = typeof reply === 'function' ? reply(ns, method, args) : undefined;
        return custom !== undefined ? custom : defaultReply(ns, method);
      };
    }
  }

  return {
    capabilities: caps,
    /** 已录到的调用（按发生顺序）。 */
    calls,
    /** 只看某个命名空间，排查时最常用。 */
    callsOf: (ns) => calls.filter((c) => c.ns === ns),
    /** 导出成可粘进测试的 JSON。 */
    toJSON: () => JSON.stringify(calls, (_k, v) => (v instanceof Uint8Array ? `<${v.length}B>` : v), 2),
    clear: () => { calls.length = 0; },
  };
}
