// imu-build.mjs — 推「模拟 IMU」调试包：把应用复制到临时目录，注入传感器替身，再交给 aiui build。
//
// 你的源码不动。临时副本里：
//   __inklab__/imu.js         传感器替身（lib/device-imu/shim.js）
//   __inklab__/imu-config.js  模式、要回放的轨迹、实时通道地址
//   每个用到 AbsoluteOrientationSensor / Accelerometer / Gyroscope / Magnetometer 的 .js/.mjs/.ink
//   脚本开头加一行 import（同名导入遮住引擎原生类）；app.js 开头再加一行裸 import，
//   让替身最先求值、把 globalThis 上的同名类也换掉。
// 打出来的包装完就删（device-service 的 pkg.cleanup），临时副本也删。

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { SENSOR_CLASSES, sliceTrace } from '../imu-trace.mjs';
import { SENSOR_AXES } from '../caps/contract.mjs';

export const IMU_MODES = Object.freeze(['real', 'replay', 'live', 'record']);
export const MODE_LABELS = Object.freeze({ real: '', replay: 'IMU 回放', live: 'IMU 实时', record: 'IMU 录制' });
const CLASS_NAMES = Object.keys(SENSOR_CLASSES);
const SHIM_DIR = '__inklab__';
const SHIM_SOURCE = new URL('../device-imu/shim.js', import.meta.url);
// 打进包里的轨迹上限：AIUI 包建议 1 MB 以内，轨迹别把它吃光。更长的用实时模式。
export const MAX_BAKED_TRACE_BYTES = 600 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'e2e', 'tests', '__tests__', 'dist', 'reports', SHIM_DIR]);

/**
 * 把字符串、注释、模板字面量里的字都换成空格（长度不变），剩下的才是代码。
 * 不追求完整的 JS 词法（正则字面量里出现类名的情况忽略）；目的只是别把注释里的类名当成引用。
 */
export function codeOnly(source) {
  const src = String(source);
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          // 模板里的 ${…} 是代码：保留原样（嵌套深度够用即可）
          let depth = 1; let k = j + 2;
          while (k < src.length && depth) { if (src[k] === '{') depth += 1; else if (src[k] === '}') depth -= 1; k += 1; }
          out += blank(src.slice(i, j)) + src.slice(j, k);
          i = k; j = k;
          continue;
        }
        j += 1;
      }
      out += blank(src.slice(i, Math.min(j + 1, src.length)));
      i = Math.min(j + 1, src.length);
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** 一段模块代码里引用了哪些传感器类名、自己声明了哪些（声明了的不能再导入同名）。 */
export function sensorReferences(source) {
  const code = codeOnly(source);
  const used = [];
  const declared = [];
  for (const name of CLASS_NAMES) {
    // 前面不是标识符字符、点号（globalThis.X 是属性访问，交给全局那份）；后面不是标识符字符。
    if (new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(code)) used.push(name);
    if (new RegExp(`(?:\\b(?:class|function\\*?|const|let|var)\\s+${name}\\b|\\bimport\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b)`).test(code)) declared.push(name);
  }
  return { used: used.filter((n) => !declared.includes(n)), declared };
}

const importLine = (names, spec) => `import { ${names.join(', ')} } from '${spec}'; // InkLab 模拟 IMU 调试包注入\n`;

/** 相对路径的 import 说明符（posix 分隔、带 ./）。 */
function specifier(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** .js/.mjs：在最前面加 import。返回 { code, names }；不用改时 names 为空。 */
export function transformModule(source, spec) {
  const { used } = sensorReferences(source);
  if (!used.length) return { code: source, names: [] };
  return { code: importLine(used, spec) + source, names: used };
}

/** .ink：给每个 <script>（非 JSON）块开头加 import。 */
export function transformInk(source, spec) {
  const names = new Set();
  const code = String(source).replace(/(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/g, (whole, open, attrs, body, close) => {
    if (/type\s*=\s*["']application\/json["']/.test(attrs)) return whole;
    const { used } = sensorReferences(body);
    if (!used.length) return whole;
    used.forEach((n) => names.add(n));
    return `${open}\n${importLine(used, spec).trimEnd()}${body.startsWith('\n') ? '' : '\n'}${body}${close}`;
  });
  return { code, names: [...names] };
}

async function walk(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...await walk(join(dir, entry.name), base));
    } else if (entry.isFile() && /\.(m?js|ink)$/.test(entry.name)) files.push(join(dir, entry.name));
  }
  return files;
}

/** 轨迹（normalizeTrace 的结构）→ 打进包里的 { 传感器: { rows, speed, loop } }。 */
export function bakeTraces(trace, { segment, loop = false, speed } = {}) {
  const picked = segment ? sliceTrace(trace, { segment }) : trace;
  const traces = {};
  for (const [name, entry] of Object.entries(picked.sensors)) {
    const axes = SENSOR_AXES[name];
    traces[name] = {
      id: `${trace.name || 'trace'}${segment ? `#${segment}` : ''}`,
      speed: speed || trace.speed || 1,
      loop: loop === true,
      rows: entry.samples.map((s) => [Math.round(s.t * 1000) / 1000, ...axes.map((a) => Math.round(s[a] * 100000) / 100000)]),
    };
  }
  return traces;
}

/**
 * 准备一份注入了替身的临时副本。
 * @param {string} appDir
 * @param {{ mode: 'replay'|'live'|'record', traces?: object, faults?: object, liveUrl?: string, label?: string, build?: string }} opts
 *   build：这一版调试包的编号。眼镜上旧版本的实例不会因为装了新包而销毁，录制行和实时通道靠它分辨新旧。
 * @returns {Promise<{ dir: string, transformed: Array<{ file: string, names: string[] }>, bytes: number, cleanup: () => Promise<void> }>}
 */
export async function stageImuBuild(appDir, { mode, traces = null, faults = null, liveUrl = '', label = '', build = '' } = {}) {
  if (!IMU_MODES.includes(mode) || mode === 'real') throw new Error(`不是模拟 IMU 模式：${mode}`);
  if (mode === 'replay' && (!traces || !Object.keys(traces).length)) throw new Error('回放模式需要先选一条轨迹');
  if (mode === 'live' && !liveUrl) throw new Error('实时模式需要 InkLab 工作台在跑（设备通过 adb reverse 连回来）');
  const root = await mkdtemp(join(tmpdir(), 'inklab-imu-'));
  const dir = join(root, 'app');
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await cp(appDir, dir, { recursive: true, filter: (path) => !path.split(sep).some((part) => part === 'node_modules' || part === '.git') });
    const config = { mode, label, build, ...(mode === 'replay' ? { traces } : {}), ...(faults ? { faults } : {}), ...(mode === 'live' ? { live: { url: liveUrl } } : {}) };
    const configText = `// InkLab 生成：模拟 IMU 调试包的配置（只在调试包里）。\nexport default ${JSON.stringify(config)};\n`;
    const bytes = Buffer.byteLength(configText);
    if (bytes > MAX_BAKED_TRACE_BYTES) {
      throw new Error(`要打进包里的轨迹太大（${Math.round(bytes / 1024)} KB，上限 ${MAX_BAKED_TRACE_BYTES / 1024} KB）：截一段，或改用实时模式`);
    }
    await mkdir(join(dir, SHIM_DIR), { recursive: true });
    const shimPath = join(dir, SHIM_DIR, 'imu.js');
    await writeFile(shimPath, await readFile(SHIM_SOURCE, 'utf8'));
    await writeFile(join(dir, SHIM_DIR, 'imu-config.js'), configText);
    const transformed = [];
    for (const file of await walk(dir)) {
      const source = await readFile(file, 'utf8');
      const spec = specifier(file, shimPath);
      const result = file.endsWith('.ink') ? transformInk(source, spec) : transformModule(source, spec);
      if (result.names.length) {
        await writeFile(file, result.code);
        transformed.push({ file: relative(dir, file).split(sep).join('/'), names: result.names });
      }
    }
    // app.js 最先求值：裸 import 一次，让 globalThis 上的同名类也是替身。
    const appJs = join(dir, 'app.js');
    try {
      const source = await readFile(appJs, 'utf8');
      await writeFile(appJs, `import './${SHIM_DIR}/imu.js'; // InkLab 模拟 IMU 调试包注入\n${source}`);
    } catch { /* 没有 app.js 就只靠逐文件导入 */ }
    return { dir, transformed, bytes, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
