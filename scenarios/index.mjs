// scenarios/index.mjs — **内置**场景清单：只放与具体应用无关的通用场景。
// 应用专属场景（键序、文案断言）是工程资产，放各工程的 e2e/scenarios/ 下——
// 宿主页面从 /api/manifest 的 e2e.scenarios 清单动态 import 并合进下拉框，
// e2e runner 跑的也是同一份（见 e2e.mjs）。
//
// 场景模块的约定（刻意做成纯数据 + 纯函数，零浏览器 API、零 node:fs）：
//   export default {
//     id, title, summary,
//     build(ctx) -> Array<步骤>     // ctx = { caps, driver, stage, view }
//     shotOptions?                  // 可选：全场截图的 diff 口径（tolerance/ignoreRegions/greenOnly）
//   }
// 步骤形状由 lib/driver.mjs 定义（press / pressMany / activate / back / wait / wake /
// shot / expect / do），一步只能写一个动作。仅一张图有动态区时用
// `{ shot:{ name, diffOptions } }`，不要把豁免扩散成场景级 shotOptions。

import smoke from './smoke.mjs';

export const SCENARIOS = Object.freeze([smoke]);

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id) || null;
