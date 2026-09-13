// shots.mjs — 截图基线与像素 diff（纯逻辑：零 node:fs、零浏览器 API，IO 全注入）。
//
// 为什么要有这个文件：36 屏视觉验收一直靠人在 Craft 里反复重采、逐张肉眼并排比
// （见 reports/iron-coach-craft-2026-07-31/CAPTURE-PLAN.md），慢，而且很容易把
// 「我没看出差别」当成「没有差别」。目标是把「改一行样式就知道哪屏变了」变成一条命令。
//
// 采集纪律里最要命的一条是 **截图晚于源码修改才算数**。靠人记这条一定会漏，所以这里把它
// 固化进数据结构：每张基线都记 capturedAt + sourceStamp（源码指纹），比对时指纹对不上就带
// stale——让「旧图冒充新证据」在工具层就显形，而不是等到并排复核时才靠人发现。
//
// 边界：本模块只认「像素数组进、结论出」。怎么把画面从 canvas 取下来、怎么落盘、
// 源码指纹怎么算，都由调用方注入（驱动层/CI）。这样 node --test 能直接跑，不需要浏览器。

// ── 像素 diff ───────────────────────────────────────────────────────────

const ALL_CHANNELS = [0, 1, 2, 3];
// 这是单绿单色屏（黑底 + 一个绿通道）：R/B 通道不承载信息，只会带来无意义噪声。
// greenOnly 时只比绿与 alpha——alpha 不能省，透明区与全黑区在绿通道上看起来一样。
const GREEN_CHANNELS = [1, 3];

/** 图像形状校验。半张图/错尺寸会把 diff 比成假绿，所以宁可当场抛。 */
function assertImage(image, label) {
  if (!image || typeof image !== 'object') {
    throw new TypeError(`${label}：不是图像对象（需要 { width, height, data }）`);
  }
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`${label}：width/height 必须是正整数，收到 ${width}×${height}`);
  }
  if (!data || typeof data.length !== 'number') {
    throw new TypeError(`${label}：data 必须是 RGBA 像素数组（Uint8ClampedArray）`);
  }
  const need = width * height * 4;
  if (data.length !== need) {
    throw new RangeError(
      `${label}：data 长度 ${data.length}，但 ${width}×${height} 的 RGBA 需要 ${need}——半张图会比出假绿`,
    );
  }
  return image;
}

/**
 * 把 ignoreRegions 铺成掩码。用掩码而不是逐像素遍历区域列表，是为了让**重叠区只算一次**——
 * 否则 ignoredPixels 会超过总像素数，changedRatio 的分母就荒唐了。
 */
function buildIgnoreMask(width, height, regions) {
  if (regions == null) return null;
  if (!Array.isArray(regions)) {
    throw new TypeError('ignoreRegions 必须是 { x, y, w, h } 数组');
  }
  if (regions.length === 0) return null;
  const mask = new Uint8Array(width * height);
  let ignored = 0;
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    if (!r || typeof r !== 'object') throw new TypeError(`ignoreRegions[${i}]：不是 { x, y, w, h }`);
    for (const key of ['x', 'y', 'w', 'h']) {
      // 常见手滑是写成 {x,y,width,height}：那样 w/h 是 undefined，区域会静默失效、
      // 每次都红。当场抛比让人对着一屏红图猜半天强。
      if (!Number.isFinite(r[key])) {
        throw new TypeError(`ignoreRegions[${i}].${key} 不是有限数字（字段名是 w/h，不是 width/height）`);
      }
    }
    if (r.w <= 0 || r.h <= 0) {
      throw new TypeError(`ignoreRegions[${i}] 的 w/h 必须大于 0，收到 ${r.w}×${r.h}`);
    }
    // 边界向外取整：忽略区是人手写的，边缘半像素抖动本来就是要盖掉的东西。
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.w));
    const y1 = Math.min(height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const p = y * width + x;
        if (!mask[p]) {
          mask[p] = 1;
          ignored += 1;
        }
      }
    }
  }
  if (ignored >= width * height) {
    throw new RangeError('ignoreRegions 不能覆盖整张图：没有参与比较的像素就不构成视觉证据');
  }
  return { mask, ignored };
}

/**
 * 在读基线前校验 diff 口径。首轮没有基线或直接 --accept 时也必须尽早拦住坏 mask；
 * 不能等到下一轮真的进入 diffPixels 才发现基线是按错误豁免收进去的。
 */
function validateDiffOptions(image, opts = {}) {
  const tolerance = Number(opts.tolerance ?? 0);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError(`tolerance 必须是非负有限数字，收到 ${opts.tolerance}`);
  }
  buildIgnoreMask(image.width, image.height, opts.ignoreRegions);
}

/**
 * 两张 RGBA 图的像素差异。
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} a 基线（before）
 * @param {{width:number,height:number,data:Uint8ClampedArray}} b 本次（after）
 * @param {object} [opts]
 * @param {number} [opts.tolerance=0]        单通道容差，用来吸收渲染抖动（|Δ| <= tolerance 不算变）
 * @param {Array<{x:number,y:number,w:number,h:number}>} [opts.ignoreRegions=[]]
 *        屏上必然变化的区域（时间、倒计时、心率读数…）。不忽略的话每次都红，红久了就没人看了。
 * @param {boolean} [opts.greenOnly=false]   只比绿通道与 alpha（单绿单色屏）
 * @returns {{equal:boolean, changedPixels:number, changedRatio:number,
 *            bbox:{x:number,y:number,w:number,h:number}|null, maxChannelDelta:number,
 *            comparedPixels:number, ignoredPixels:number,
 *            width:number, height:number, tolerance:number, greenOnly:boolean}}
 */
export function diffPixels(a, b, opts = {}) {
  assertImage(a, '基线图');
  assertImage(b, '本次图');
  if (a.width !== b.width || a.height !== b.height) {
    // 绝不按最小尺寸裁着比：「画面变小了 / 采集分辨率不对」本身就是要抓的问题，
    // 静默裁剪会把它比没（宿主 canvas 是 480×352）。
    throw new RangeError(
      `图像尺寸不一致：基线 ${a.width}×${a.height}，本次 ${b.width}×${b.height}`
      + '——不做裁剪也不做缩放，先确认两边是同一采集口径',
    );
  }

  validateDiffOptions(a, opts);
  const tolerance = Number(opts.tolerance ?? 0);
  const greenOnly = Boolean(opts.greenOnly);
  const channels = greenOnly ? GREEN_CHANNELS : ALL_CHANNELS;

  const { width, height } = a;
  const masked = buildIgnoreMask(width, height, opts.ignoreRegions);
  const mask = masked ? masked.mask : null;
  const ignoredPixels = masked ? masked.ignored : 0;
  const comparedPixels = width * height - ignoredPixels;

  const A = a.data;
  const B = b.data;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (mask && mask[p]) continue;
      const o = p * 4;
      let worst = 0;
      for (let c = 0; c < channels.length; c += 1) {
        const d = Math.abs(A[o + channels[c]] - B[o + channels[c]]);
        if (d > worst) worst = d;
      }
      // maxChannelDelta 统计的是**比过的**像素（忽略区不算），且不受 tolerance 过滤——
      // 它是观测到的噪声地板，调 tolerance 时要看的就是它。
      if (worst > maxChannelDelta) maxChannelDelta = worst;
      if (worst > tolerance) {
        changedPixels += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  return {
    equal: changedPixels === 0,
    changedPixels,
    // 分母是真正比过的像素：忽略区不是证据，不该稀释比例把变化摊小。
    changedRatio: comparedPixels > 0 ? changedPixels / comparedPixels : 0,
    bbox: changedPixels > 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    maxChannelDelta,
    comparedPixels,
    ignoredPixels,
    width,
    height,
    // 口径随结论一起返回：CI 里的一条 JSON 要能自证是用什么容差比出来的。
    tolerance,
    greenOnly,
    // 报告保留实际采用的区域，不能只给 ignoredPixels 而让审阅者猜豁免了哪里。
    ignoreRegions: Array.isArray(opts.ignoreRegions)
      ? opts.ignoreRegions.map(({ x, y, w, h }) => ({ x, y, w, h }))
      : [],
  };
}

// ── 基线管理 ────────────────────────────────────────────────────────────

/** 源码指纹归一化：空串等同没给；非字符串（比如塞了个对象）会 String 成 '[object Object]'，必须拦。 */
function normalizeStamp(stamp) {
  if (stamp == null) return null;
  if (typeof stamp !== 'string') throw new TypeError(`sourceStamp 必须是字符串，收到 ${typeof stamp}`);
  const s = stamp.trim();
  return s ? s : null;
}

/** now() 允许返回 ms / Date / 已经成型的字符串，统一存 ISO：基线元数据是给人看的。 */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}

/**
 * 截图基线仓库。IO 全注入，模块本身不碰磁盘，方便单测与换存储后端。
 *
 * @param {object} io
 * @param {(name:string) => (Promise<object|null>|object|null)} io.readShot
 *        读基线记录 `{ image, capturedAt, sourceStamp }`；没有就返回 null
 * @param {(name:string, record:object) => any} io.writeShot 写基线记录
 * @param {() => (Promise<string[]>|string[])} [io.listShots] 盘上已有的基线名（compareAll 用来查漏采）
 * @param {() => (number|Date|string)} [io.now] 时钟，默认 Date.now
 * @param {boolean} [io.requireSourceStamp=true]
 *        默认强制要源码指纹。关掉它等于允许「不知道哪版源码跑出来的图」进基线——
 *        那正是这个模块想根治的病，所以只在明确知道自己在干嘛时才关。
 * @param {object} [io.defaultDiffOptions] 全局 diff 口径（容差 / greenOnly / 忽略区）
 */
export function createShotStore({
  readShot,
  writeShot,
  listShots = () => [],
  now = () => Date.now(),
  requireSourceStamp = true,
  defaultDiffOptions = {},
} = {}) {
  if (typeof readShot !== 'function') throw new TypeError('createShotStore 需要注入 readShot');
  if (typeof writeShot !== 'function') throw new TypeError('createShotStore 需要注入 writeShot');

  /** 本次运行拿不出源码指纹时，任何结论都不是当前源码的证据——统一判 stale。 */
  function judgeStale(baseline, stamp) {
    if (requireSourceStamp && !stamp) return { stale: true, staleReason: 'missing-stamp' };
    // 基线没记指纹（老基线 / 关了 requireSourceStamp 时写进来的）同样算对不上：
    // 「不知道」和「不一样」在证据上是一回事。
    if (baseline && stamp && baseline.sourceStamp !== stamp) {
      return { stale: true, staleReason: 'stamp-mismatch' };
    }
    return { stale: false, staleReason: null };
  }

  /**
   * 与基线比一屏。
   * @returns {Promise<{name:string,status:'new'|'match'|'changed',stale:boolean,
   *                    staleReason:string|null,sourceStamp:string|null,
   *                    baseline:{capturedAt:string,sourceStamp:string|null}|null,
   *                    diff:object|null}>}
   */
  async function compare(name, image, options = {}) {
    assertImage(image, `截图「${name}」`);
    const stamp = normalizeStamp(options.sourceStamp);
    const effectiveDiffOptions = { ...defaultDiffOptions, ...options };
    validateDiffOptions(image, effectiveDiffOptions);
    const record = await readShot(name);

    if (!record) {
      const { stale, staleReason } = judgeStale(null, stamp);
      // 新增不等于通过：这一屏还没有任何前置证据，得先 accept 才谈得上比对。
      return { name, status: 'new', stale, staleReason, sourceStamp: stamp, baseline: null, diff: null };
    }
    if (!record.image) throw new TypeError(`基线「${name}」缺 image 字段（存储层没把像素带回来？）`);

    const diff = diffPixels(record.image, image, effectiveDiffOptions);
    const { stale, staleReason } = judgeStale(record, stamp);
    return {
      name,
      status: diff.equal ? 'match' : 'changed',
      stale,
      staleReason,
      sourceStamp: stamp,
      baseline: { capturedAt: record.capturedAt ?? null, sourceStamp: record.sourceStamp ?? null },
      diff,
    };
  }

  /** 写入/更新一屏基线。记 capturedAt 与 sourceStamp——这两样是这套纪律的全部底气。 */
  async function accept(name, image, options = {}) {
    assertImage(image, `截图「${name}」`);
    const stamp = normalizeStamp(options.sourceStamp);
    if (requireSourceStamp && !stamp) {
      throw new Error(
        `拒绝写入没有源码指纹的基线「${name}」：不知道它是哪版源码跑出来的，`
        + '将来它只会是一张能冒充证据的旧图',
      );
    }
    const record = {
      name,
      capturedAt: toIso(now()),
      sourceStamp: stamp,
      width: image.width,
      height: image.height,
      image,
    };
    await writeShot(name, record);
    // 返回不带像素的元数据：调用方要写台账/打印，不需要几十万字节。
    return { name, capturedAt: record.capturedAt, sourceStamp: stamp, width: image.width, height: image.height };
  }

  /**
   * 比一整批。除了逐屏 compare，还会把「盘上有基线、本次却没采」的屏标成 missing——
   * 少采一屏而报告全绿，是这套流程另一个自欺的入口。
   * @param {Array<{name:string,image:object,diffOptions?:object}>} shots
   */
  async function compareAll(shots, options = {}) {
    const list = Array.isArray(shots) ? shots : [];
    const seen = new Set();
    const results = [];
    for (const shot of list) {
      if (!shot || typeof shot.name !== 'string' || !shot.name) {
        throw new TypeError('compareAll：每一项都要有非空的 name');
      }
      // 同名重复采集会让后一张悄悄盖掉前一张的结论，直接拦。
      if (seen.has(shot.name)) throw new Error(`compareAll：同一次运行里出现了两张「${shot.name}」`);
      seen.add(shot.name);
      if (shot.diffOptions != null
        && (typeof shot.diffOptions !== 'object' || Array.isArray(shot.diffOptions))) {
        throw new TypeError(`compareAll：截图「${shot.name}」的 diffOptions 必须是对象`);
      }
      // 单图口径只覆盖 diff 字段；本轮 sourceStamp 始终由调用方掌控，场景不能伪造。
      const perShot = shot.diffOptions || {};
      results.push(await compare(shot.name, shot.image, {
        ...options,
        ...perShot,
        sourceStamp: options.sourceStamp,
      }));
    }

    const known = (await listShots()) || [];
    for (const name of known) {
      if (seen.has(name)) continue;
      const record = await readShot(name);
      results.push({
        name,
        status: 'missing',
        stale: false,
        staleReason: null,
        sourceStamp: normalizeStamp(options.sourceStamp),
        baseline: record
          ? { capturedAt: record.capturedAt ?? null, sourceStamp: record.sourceStamp ?? null }
          : null,
        diff: null,
      });
    }
    return results;
  }

  return { compare, accept, compareAll };
}

// ── 报告 ────────────────────────────────────────────────────────────────

/** 计数与结论。ok 的口径写死在这里，报告与 CI JSON 共用一套，防止两边各说各话。 */
export function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const counts = { total: list.length, new: 0, match: 0, changed: 0, missing: 0, stale: 0 };
  for (const r of list) {
    if (r && Object.hasOwn(counts, r.status)) counts[r.status] += 1;
    if (r && r.stale) counts.stale += 1;
  }
  return {
    ...counts,
    // 空结果不算通过：一屏都没采跟全部通过是两回事。
    // 新增(new)也不算通过——没有前置证据可比；stale 更不算——那张图说不清是哪版源码。
    ok: counts.total > 0 && counts.match === counts.total && counts.stale === 0,
  };
}

const PERCENT = (ratio) => `${(Number(ratio || 0) * 100).toFixed(2)}%`;

const STALE_TEXT = {
  'missing-stamp': '本次没给 sourceStamp——说不清这张图是哪版源码跑出来的',
  'stamp-mismatch': '基线指纹与本次源码不符',
};

/** 人看的一段文本摘要：几张新增/一致/变了/漏采，以及哪几张不能当当前证据。 */
export function formatReport(results) {
  const list = Array.isArray(results) ? results : [];
  const s = summarize(list);
  const lines = [
    `截图基线比对：共 ${s.total} 张（一致 ${s.match} · 变了 ${s.changed} · 新增 ${s.new} · 未采 ${s.missing}）`,
  ];

  if (s.total === 0) {
    lines.push('本次一屏都没采到——空结果不算通过。');
    lines.push('结论：不通过（没有任何证据）');
    return lines.join('\n');
  }

  const pick = (status) => list.filter((r) => r && r.status === status);
  const width = Math.max(...list.map((r) => String((r && r.name) || '').length), 1);
  const pad = (name) => String(name).padEnd(width);

  const changed = pick('changed');
  if (changed.length) {
    lines.push(`变了（${changed.length}）：`);
    for (const r of changed) {
      const d = r.diff || {};
      const box = d.bbox ? `bbox x=${d.bbox.x} y=${d.bbox.y} ${d.bbox.w}×${d.bbox.h}` : 'bbox 无';
      lines.push(`  · ${pad(r.name)}  ${d.changedPixels} px / ${PERCENT(d.changedRatio)}  ${box}  最大通道差 ${d.maxChannelDelta}`);
    }
  }

  const added = pick('new');
  if (added.length) {
    lines.push(`新增（${added.length}）：`);
    for (const r of added) lines.push(`  · ${pad(r.name)}  尚无基线；accept 之后才有可比证据`);
  }

  const missing = pick('missing');
  if (missing.length) {
    lines.push(`未采（${missing.length}）：`);
    for (const r of missing) {
      const at = (r.baseline && r.baseline.capturedAt) || '时间未知';
      lines.push(`  · ${pad(r.name)}  盘上还有 ${at} 的基线，但本次没采到这一屏`);
    }
  }

  const stale = list.filter((r) => r && r.stale);
  if (stale.length) {
    lines.push(`陈旧（${stale.length}）——下面这些不能算当前源码的视觉证据：`);
    for (const r of stale) {
      const was = (r.baseline && r.baseline.sourceStamp) || '（无）';
      const nowStamp = r.sourceStamp || '（未给）';
      const why = STALE_TEXT[r.staleReason] || r.staleReason || '原因未知';
      lines.push(`  · ${pad(r.name)}  基线 ${was} ≠ 本次 ${nowStamp}：${why}`);
    }
  }

  if (s.ok) {
    // 全通过时才把屏名列全：失败的报告要让人一眼看见坏消息，不该被一长串绿名淹掉。
    lines.push(`一致：${pick('match').map((r) => r.name).join('、')}`);
    lines.push('结论：通过（全部与基线一致，且基线指纹与本次源码相同）');
  } else {
    const why = [];
    if (s.changed) why.push(`变了 ${s.changed}`);
    if (s.new) why.push(`新增 ${s.new}`);
    if (s.missing) why.push(`未采 ${s.missing}`);
    if (s.stale) why.push(`陈旧 ${s.stale}`);
    lines.push(`结论：不通过（${why.join(' · ')}）`);
  }
  return lines.join('\n');
}

/**
 * 给 CI 消费的结构化结果。刻意不带像素：基线记录里的 data 有几十万字节，
 * 而且图本身不是结论，落进 JSON 只会让产物没法看也没法 diff。
 */
export function toJSON(results, meta = {}) {
  const list = Array.isArray(results) ? results : [];
  const summary = summarize(list);
  return {
    ok: summary.ok,
    summary,
    meta,
    results: list.map((r) => ({
      name: r.name,
      status: r.status,
      stale: Boolean(r.stale),
      staleReason: r.staleReason ?? null,
      sourceStamp: r.sourceStamp ?? null,
      baseline: r.baseline ?? null,
      diff: r.diff
        ? {
          equal: r.diff.equal,
          changedPixels: r.diff.changedPixels,
          changedRatio: r.diff.changedRatio,
          bbox: r.diff.bbox,
          maxChannelDelta: r.diff.maxChannelDelta,
          comparedPixels: r.diff.comparedPixels,
          ignoredPixels: r.diff.ignoredPixels,
          width: r.diff.width,
          height: r.diff.height,
          tolerance: r.diff.tolerance,
          greenOnly: r.diff.greenOnly,
          ignoreRegions: r.diff.ignoreRegions,
        }
        : null,
    })),
  };
}
