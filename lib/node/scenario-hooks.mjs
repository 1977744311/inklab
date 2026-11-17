// scenario-hooks.mjs — 在 Node 里装载模拟器场景时，把浏览器里的 /app/… 路径映射回应用目录。
// 模拟器里场景由 InkLab 服务端按 /app/ 提供，所以场景常写 import '/app/e2e/support/x.mjs'；
// 真机运行要在 Node 里调用同一个 build()，这里用 module.register 的 resolve 钩子做同样的映射。
let roots = [];

export async function initialize(data) {
  roots = Array.isArray(data?.roots) ? data.roots : [];
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/app/') && String(context.parentURL || '').startsWith('file://')) {
    const root = roots.find((url) => context.parentURL.startsWith(url));
    if (root) return next(new URL(specifier.slice('/app/'.length), root).href, context);
  }
  return next(specifier, context);
}
