// 截图基线与像素 diff。全部用手搓的 4×4 小图直接断言数值——用真截图当夹具，
// 一旦哪天图变了，测试就只能证明「和某张图一样」，证明不了 diff 算得对。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffPixels, createShotStore, formatReport, toJSON, summarize,
} from '../lib/shots.mjs';

// ── 夹具 ────────────────────────────────────────────────────────────────

/** 造一张图：fill(x, y) 返回 [r, g, b, a]，缺省全黑不透明（单绿屏的底色）。 */
function img(width, height, fill = () => [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * width + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width, height, data };
}

/** 在图上改一个像素（返回新图，别改夹具本体）。 */
function withPixel(base, x, y, rgba) {
  const copy = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
  const o = (y * base.width + x) * 4;
  [copy.data[o], copy.data[o + 1], copy.data[o + 2], copy.data[o + 3]] = rgba;
  return copy;
}

const GREEN = [0, 255, 0, 255];
const BLACK = [0, 0, 0, 255];

// ── 像素 diff ───────────────────────────────────────────────────────────

test('两张一样的图判等，且 bbox 为 null（没有变化就不该框出东西来）', () => {
  const a = img(4, 4, (x, y) => ((x + y) % 2 ? GREEN : BLACK));
  const b = img(4, 4, (x, y) => ((x + y) % 2 ? GREEN : BLACK));
  const d = diffPixels(a, b);
  assert.equal(d.equal, true);
  assert.equal(d.changedPixels, 0);
  assert.equal(d.changedRatio, 0);
  assert.equal(d.bbox, null);
  assert.equal(d.maxChannelDelta, 0);
  assert.equal(d.comparedPixels, 16);
});

test('变了几个像素就报几个：比例按真正比过的像素算，最大通道差如实给出', () => {
  const a = img(4, 4);
  let b = withPixel(a, 0, 0, GREEN);
  b = withPixel(b, 3, 3, [0, 10, 0, 255]);
  const d = diffPixels(a, b);
  assert.equal(d.equal, false);
  assert.equal(d.changedPixels, 2);
  assert.equal(d.changedRatio, 2 / 16);
  assert.equal(d.maxChannelDelta, 255, '最大通道差取所有比过的像素里最狠的那一下');
  assert.equal(d.comparedPixels, 16);
  assert.equal(d.ignoredPixels, 0);
});

test('tolerance 吸收渲染抖动：容差内不算变，超一档立刻算变（抗抖不等于装瞎）', () => {
  const a = img(4, 4, () => [0, 100, 0, 255]);
  const b = img(4, 4, () => [0, 103, 0, 255]);

  const lenient = diffPixels(a, b, { tolerance: 3 });
  assert.equal(lenient.equal, true, '|Δ|=3 在容差 3 之内');
  assert.equal(lenient.maxChannelDelta, 3, 'tolerance 不该抹掉观测到的噪声地板——调容差看的就是它');

  const strict = diffPixels(a, b, { tolerance: 2 });
  assert.equal(strict.equal, false);
  assert.equal(strict.changedPixels, 16);
});

test('ignoreRegions 盖掉必然变化的区域（时间/倒计时），且忽略的像素不进分母', () => {
  const a = img(4, 4);
  // 顶行整行都在变（就当是倒计时数字），第 (0,2) 是真变化。
  let b = a;
  for (let x = 0; x < 4; x += 1) b = withPixel(b, x, 0, GREEN);
  b = withPixel(b, 0, 2, GREEN);

  const naked = diffPixels(a, b);
  assert.equal(naked.changedPixels, 5, '不忽略的话每次都是一片红');

  const d = diffPixels(a, b, { ignoreRegions: [{ x: 0, y: 0, w: 4, h: 1 }] });
  assert.equal(d.changedPixels, 1);
  assert.equal(d.ignoredPixels, 4);
  assert.equal(d.comparedPixels, 12);
  assert.equal(d.changedRatio, 1 / 12, '忽略区不是证据，不该稀释比例把变化摊小');
  assert.deepEqual(d.bbox, { x: 0, y: 2, w: 1, h: 1 });
});

test('ignoreRegions 重叠只算一次，越界坐标裁进画面（否则分母会算出负数）', () => {
  const a = img(4, 4);
  const b = img(4, 4, () => GREEN);
  const d = diffPixels(a, b, {
    ignoreRegions: [
      { x: 0, y: 0, w: 3, h: 1 },
      { x: 1, y: 0, w: 3, h: 1 },   // 与上一块重叠 2 px
      { x: -5, y: 3, w: 100, h: 9 }, // 整块越界，裁成最后一行
    ],
  });
  assert.equal(d.ignoredPixels, 8, '4(首行) + 4(末行)，重叠部分不重复计');
  assert.equal(d.comparedPixels, 8);
  assert.equal(d.changedPixels, 8);
});

test('ignoreRegions 字段名写错要当场报错，不能静默失效让人对着一屏红图猜', () => {
  const a = img(4, 4);
  const b = img(4, 4);
  assert.throws(
    () => diffPixels(a, b, { ignoreRegions: [{ x: 0, y: 0, width: 4, height: 1 }] }),
    /ignoreRegions\[0\]\.w/,
  );
  assert.throws(() => diffPixels(a, b, { ignoreRegions: [null] }), /ignoreRegions\[0\]/);
  assert.throws(
    () => diffPixels(a, b, { ignoreRegions: { x: 0, y: 0, w: 1, h: 1 } }),
    /ignoreRegions 必须.*数组/,
  );
  assert.throws(
    () => diffPixels(a, b, { ignoreRegions: [{ x: 0, y: 0, w: 0, h: 1 }] }),
    /w\/h 必须大于 0/,
  );
  assert.throws(
    () => diffPixels(a, b, { ignoreRegions: [{ x: 0, y: 0, w: 4, h: 4 }] }),
    /不能覆盖整张图/,
  );
});

test('greenOnly 只看绿通道与 alpha：红蓝噪声不算变，绿或透明度变了照样算', () => {
  const a = img(4, 4, () => [0, 200, 0, 255]);

  // 单绿屏上 R/B 本来就不承载信息，别让它们每次都把屏染红。
  const rbNoise = img(4, 4, () => [7, 200, 9, 255]);
  assert.equal(diffPixels(a, rbNoise).equal, false, '默认四通道会把 R/B 噪声算成变化');
  assert.equal(diffPixels(a, rbNoise, { greenOnly: true }).equal, true);

  const greenShift = img(4, 4, () => [7, 180, 9, 255]);
  assert.equal(diffPixels(a, greenShift, { greenOnly: true }).changedPixels, 16);
  assert.equal(diffPixels(a, greenShift, { greenOnly: true }).maxChannelDelta, 20);

  // alpha 不能省：全透明和全黑在绿通道上看起来一样。
  const alphaShift = img(4, 4, () => [0, 200, 0, 0]);
  assert.equal(diffPixels(a, alphaShift, { greenOnly: true }).changedPixels, 16);
});

test('尺寸不一致直接报错，绝不按最小尺寸裁着比（画面变小本身就是要抓的问题）', () => {
  assert.throws(
    () => diffPixels(img(4, 4), img(4, 5)),
    (err) => err instanceof RangeError && /4×4/.test(err.message) && /4×5/.test(err.message),
  );
});

test('data 长度与 width×height×4 对不上要报错（半张图会比出假绿）', () => {
  const half = { width: 4, height: 4, data: new Uint8ClampedArray(32) };
  assert.throws(() => diffPixels(img(4, 4), half), /data 长度 32/);
  assert.throws(() => diffPixels(img(4, 4), { width: 0, height: 4, data: new Uint8ClampedArray(0) }), /正整数/);
  assert.throws(() => diffPixels(img(4, 4), null), /图像对象/);
  assert.throws(() => diffPixels(img(4, 4), img(4, 4), { tolerance: -1 }), /tolerance/);
});

test('bbox 恰好框住变化区域：单点是 1×1，跨行跨列取外接矩形', () => {
  const a = img(4, 4);
  assert.deepEqual(diffPixels(a, withPixel(a, 2, 1, GREEN)).bbox, { x: 2, y: 1, w: 1, h: 1 });

  let b = withPixel(a, 1, 1, GREEN);
  b = withPixel(b, 3, 2, GREEN);
  assert.deepEqual(diffPixels(a, b).bbox, { x: 1, y: 1, w: 3, h: 2 }, '两点的外接矩形,不是两个点');
});

// ── 基线仓库 ────────────────────────────────────────────────────────────

/** 内存假存储：IO 全注入的意义就是这里能三行搭完，不碰盘也不碰浏览器。 */
function fakeStore(overrides = {}) {
  const disk = new Map();
  const store = createShotStore({
    readShot: (name) => disk.get(name) ?? null,
    writeShot: (name, record) => disk.set(name, record),
    listShots: () => [...disk.keys()],
    now: () => 1_700_000_000_000,
    ...overrides,
  });
  return { store, disk };
}

test('没有基线时报 new 且不写盘：新增一屏不等于这屏通过了', async () => {
  const { store, disk } = fakeStore();
  const r = await store.compare('home/default', img(4, 4), { sourceStamp: 'src-1' });
  assert.equal(r.status, 'new');
  assert.equal(r.baseline, null);
  assert.equal(r.diff, null);
  assert.equal(r.stale, false);
  assert.equal(disk.size, 0, 'compare 只读不写，接受基线必须是显式动作');
  assert.equal(summarize([r]).ok, false, '有 new 就不算通过——没有前置证据可比');
});

test('没有基线也先校验 diff 口径：首次 --accept 不能把坏 mask 或负容差收进去', async () => {
  const { store, disk } = fakeStore();
  const shot = img(4, 4);
  await assert.rejects(
    () => store.compareAll([{
      name: 'new-bad-mask', image: shot,
      diffOptions: { ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }] },
    }], { sourceStamp: 'src-1' }),
    /ignoreRegions\[0\]\.w/,
  );
  await assert.rejects(
    () => store.compareAll([{
      name: 'new-negative-tolerance', image: shot, diffOptions: { tolerance: -1 },
    }], { sourceStamp: 'src-1' }),
    /tolerance 必须是非负/,
  );
  assert.equal(disk.size, 0);
});

test('accept 记下 capturedAt 与 sourceStamp，下一次 compare 能读回并判 match', async () => {
  const { store, disk } = fakeStore();
  const shot = img(4, 4, (x) => (x === 0 ? GREEN : BLACK));
  const meta = await store.accept('home/default', shot, { sourceStamp: 'src-1' });
  assert.equal(meta.capturedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(meta.sourceStamp, 'src-1');
  assert.equal(disk.get('home/default').image, shot);

  const r = await store.compare('home/default', img(4, 4, (x) => (x === 0 ? GREEN : BLACK)), { sourceStamp: 'src-1' });
  assert.equal(r.status, 'match');
  assert.equal(r.stale, false);
  assert.equal(r.staleReason, null);
  assert.deepEqual(r.baseline, { capturedAt: '2023-11-14T22:13:20.000Z', sourceStamp: 'src-1' });
});

test('基线的 sourceStamp 与本次不同就标 stale——像素一致也不许算成当前源码的证据', async () => {
  const { store } = fakeStore();
  const shot = img(4, 4, (x) => (x === 0 ? GREEN : BLACK));
  await store.accept('home/default', shot, { sourceStamp: 'src-old' });

  const r = await store.compare('home/default', shot, { sourceStamp: 'src-new' });
  assert.equal(r.status, 'match', '画面确实没变');
  assert.equal(r.stale, true, '但基线来自另一版源码，旧图不能冒充新证据');
  assert.equal(r.staleReason, 'stamp-mismatch');
  assert.equal(summarize([r]).ok, false, '只要有 stale，整轮就不算通过');
});

test('本次不给 sourceStamp 一律判 stale：说不清哪版源码跑出来的图不是证据', async () => {
  const { store } = fakeStore();
  const shot = img(4, 4);
  await store.accept('home/default', shot, { sourceStamp: 'src-1' });

  const r = await store.compare('home/default', shot);
  assert.equal(r.status, 'match');
  assert.equal(r.stale, true);
  assert.equal(r.staleReason, 'missing-stamp');

  // 明确关掉这条纪律才允许沉默（比如临时排障），默认不给这个后门。
  const loose = createShotStore({
    readShot: () => ({ image: shot, capturedAt: 'x', sourceStamp: 'src-1' }),
    writeShot: () => {},
    requireSourceStamp: false,
  });
  assert.equal((await loose.compare('home/default', shot)).stale, false);
});

test('accept 拒绝写入没有源码指纹的基线（那种基线将来只会冒充证据）', async () => {
  const { store, disk } = fakeStore();
  await assert.rejects(() => store.accept('home/default', img(4, 4)), /拒绝写入没有源码指纹/);
  await assert.rejects(() => store.accept('home/default', img(4, 4), { sourceStamp: '   ' }), /拒绝写入/);
  await assert.rejects(() => store.accept('home/default', img(4, 4), { sourceStamp: { v: 1 } }), /必须是字符串/);
  assert.equal(disk.size, 0);
});

test('compare 把容差与忽略区透传给 diff：基线口径由调用方一处决定', async () => {
  const { store } = fakeStore({ defaultDiffOptions: { greenOnly: true, tolerance: 2 } });
  const base = img(4, 4, () => [0, 100, 0, 255]);
  await store.accept('set-live/live', base, { sourceStamp: 'src-1' });

  // 红蓝噪声 + 绿通道 2 档抖动：默认口径下应当判一致。
  const noisy = img(4, 4, () => [40, 102, 60, 255]);
  assert.equal((await store.compare('set-live/live', noisy, { sourceStamp: 'src-1' })).status, 'match');

  // 单次调用可以收紧口径，覆盖默认值。
  const strict = await store.compare('set-live/live', noisy, { sourceStamp: 'src-1', tolerance: 0 });
  assert.equal(strict.status, 'changed');

  // 倒计时那一行照样能单独豁免。
  let ticking = base;
  for (let x = 0; x < 4; x += 1) ticking = withPixel(ticking, x, 0, GREEN);
  const ignored = await store.compare('set-live/live', ticking, {
    sourceStamp: 'src-1', ignoreRegions: [{ x: 0, y: 0, w: 4, h: 1 }],
  });
  assert.equal(ignored.status, 'match');
  assert.equal(ignored.diff.ignoredPixels, 4);
});

test('compare 遇到尺寸不一致把错误抛出去，不吞成一个「变了」了事', async () => {
  const { store } = fakeStore();
  await store.accept('home/default', img(4, 4), { sourceStamp: 'src-1' });
  await assert.rejects(() => store.compare('home/default', img(4, 5), { sourceStamp: 'src-1' }), /尺寸不一致/);
});

test('compareAll 把「盘上有基线、本次没采」的屏标成 missing：少采一屏不能算全绿', async () => {
  const { store } = fakeStore();
  await store.accept('home/default', img(4, 4), { sourceStamp: 'src-1' });
  await store.accept('logbook/three', img(4, 4), { sourceStamp: 'src-1' });

  const results = await store.compareAll([{ name: 'home/default', image: img(4, 4) }], { sourceStamp: 'src-1' });
  assert.equal(results.length, 2);
  const missing = results.find((r) => r.status === 'missing');
  assert.equal(missing.name, 'logbook/three');
  assert.equal(missing.baseline.capturedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(summarize(results).ok, false);
});

test('compareAll 撞见同名两张直接报错：后一张会悄悄盖掉前一张的结论', async () => {
  const { store } = fakeStore();
  await assert.rejects(
    () => store.compareAll([
      { name: 'home/default', image: img(4, 4) },
      { name: 'home/default', image: img(4, 4) },
    ], { sourceStamp: 'src-1' }),
    /两张「home\/default」/,
  );
  await assert.rejects(
    () => store.compareAll([{ image: img(4, 4) }], { sourceStamp: 'src-1' }),
    /非空的 name/,
  );
});

test('compareAll 的单图 diffOptions 只豁免点名截图，且不能覆盖 sourceStamp', async () => {
  const { store } = fakeStore();
  const base = img(4, 4, () => BLACK);
  await store.accept('live', base, { sourceStamp: 'src-1' });
  await store.accept('static', base, { sourceStamp: 'src-1' });
  const changed = withPixel(base, 0, 0, GREEN);

  const results = await store.compareAll([
    {
      name: 'live', image: changed,
      diffOptions: {
        sourceStamp: 'forged',
        ignoreRegions: [{ x: 0, y: 0, w: 1, h: 1 }],
      },
    },
    { name: 'static', image: changed },
  ], { sourceStamp: 'src-1' });

  const live = results.find((row) => row.name === 'live');
  const strict = results.find((row) => row.name === 'static');
  assert.equal(live.status, 'match');
  assert.equal(live.sourceStamp, 'src-1');
  assert.equal(live.diff.ignoredPixels, 1);
  assert.deepEqual(live.diff.ignoreRegions, [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.equal(strict.status, 'changed');

  await assert.rejects(
    () => store.compareAll([{ name: 'live', image: base, diffOptions: [] }], { sourceStamp: 'src-1' }),
    /diffOptions 必须是对象/,
  );
});

test('单图口径继承默认 greenOnly/tolerance，但声明 ignoreRegions 时整组替换默认区域', async () => {
  const { store } = fakeStore({
    defaultDiffOptions: {
      greenOnly: true,
      tolerance: 2,
      ignoreRegions: [{ x: 0, y: 0, w: 1, h: 1 }],
    },
  });
  const base = img(4, 4, () => [0, 100, 0, 255]);
  await store.accept('inherit', base, { sourceStamp: 'src-1' });
  await store.accept('replace', base, { sourceStamp: 'src-1' });

  const rbAndGreenNoise = img(4, 4, () => [40, 102, 60, 255]);
  const inherited = await store.compareAll([
    { name: 'inherit', image: rbAndGreenNoise },
  ], { sourceStamp: 'src-1' });
  assert.equal(inherited[0].status, 'match');
  assert.equal(inherited[0].diff.greenOnly, true);
  assert.equal(inherited[0].diff.tolerance, 2);
  assert.deepEqual(inherited[0].diff.ignoreRegions, [{ x: 0, y: 0, w: 1, h: 1 }]);

  const changed = withPixel(base, 0, 0, GREEN);
  const replaced = await store.compareAll([{
    name: 'replace', image: changed,
    diffOptions: {
      tolerance: 0,
      ignoreRegions: [{ x: 3, y: 3, w: 1, h: 1 }],
    },
  }], { sourceStamp: 'src-1' });
  assert.equal(replaced[0].status, 'changed', '单图 ignoreRegions 应替换默认，不能把旧盲区继续追加进去');
  assert.equal(replaced[0].diff.greenOnly, true, '未覆盖的 greenOnly 仍继承默认');
  assert.equal(replaced[0].diff.tolerance, 0, '单图 tolerance 覆盖默认');
  assert.deepEqual(replaced[0].diff.ignoreRegions, [{ x: 3, y: 3, w: 1, h: 1 }]);
});

// ── 报告 ────────────────────────────────────────────────────────────────

const okResults = [
  { name: 'home/default', status: 'match', stale: false, staleReason: null, sourceStamp: 's1', baseline: { capturedAt: 't', sourceStamp: 's1' }, diff: { equal: true, changedPixels: 0 } },
  { name: 'exercises/list', status: 'match', stale: false, staleReason: null, sourceStamp: 's1', baseline: { capturedAt: 't', sourceStamp: 's1' }, diff: { equal: true, changedPixels: 0 } },
];

test('formatReport 全通过时把话说清楚：几张、哪几屏、以及凭什么算通过', () => {
  const text = formatReport(okResults);
  assert.match(text, /共 2 张（一致 2 · 变了 0 · 新增 0 · 未采 0）/);
  assert.match(text, /一致：home\/default、exercises\/list/);
  assert.match(text, /结论：通过/);
  assert.doesNotMatch(text, /陈旧/);
});

test('formatReport 有失败时逐条列出变了/新增/未采/陈旧，结论落在不通过', () => {
  const results = [
    ...okResults.slice(0, 1),
    {
      name: 'set-report/report',
      status: 'changed',
      stale: true,
      staleReason: 'stamp-mismatch',
      sourceStamp: 's2',
      baseline: { capturedAt: '2026-07-31T00:00:00.000Z', sourceStamp: 's1' },
      diff: { changedPixels: 1234, changedRatio: 0.0731, bbox: { x: 12, y: 40, w: 96, h: 24 }, maxChannelDelta: 255 },
    },
    { name: 'gear/card', status: 'new', stale: false, staleReason: null, sourceStamp: 's2', baseline: null, diff: null },
    {
      name: 'logbook/three',
      status: 'missing',
      stale: false,
      staleReason: null,
      sourceStamp: 's2',
      baseline: { capturedAt: '2026-07-31T00:00:00.000Z', sourceStamp: 's1' },
      diff: null,
    },
  ];
  const text = formatReport(results);
  assert.match(text, /共 4 张（一致 1 · 变了 1 · 新增 1 · 未采 1）/);
  assert.match(text, /变了（1）：/);
  assert.match(text, /set-report\/report\s+1234 px \/ 7\.31%\s+bbox x=12 y=40 96×24\s+最大通道差 255/);
  assert.match(text, /新增（1）：[\s\S]*gear\/card/);
  assert.match(text, /未采（1）：[\s\S]*logbook\/three\s+盘上还有 2026-07-31T00:00:00\.000Z 的基线/);
  assert.match(text, /陈旧（1）[\s\S]*set-report\/report\s+基线 s1 ≠ 本次 s2：基线指纹与本次源码不符/);
  assert.match(text, /结论：不通过（变了 1 · 新增 1 · 未采 1 · 陈旧 1）/);
});

test('formatReport 对「本次一屏都没采」明说不通过，不让空结果假装全绿', () => {
  const text = formatReport([]);
  assert.match(text, /共 0 张/);
  assert.match(text, /一屏都没采到/);
  assert.match(text, /结论：不通过/);
});

test('formatReport 只给 missing-stamp 也能说明白：图说不清是哪版源码跑出来的', () => {
  const text = formatReport([
    { name: 'home/default', status: 'match', stale: true, staleReason: 'missing-stamp', sourceStamp: null, baseline: { capturedAt: 't', sourceStamp: 's1' }, diff: { equal: true } },
  ]);
  assert.match(text, /基线 s1 ≠ 本次 （未给）：本次没给 sourceStamp/);
  assert.match(text, /结论：不通过（陈旧 1）/);
});

test('toJSON 给 CI 一份可 diff 的结论：ok 只在全 match 且无 stale 时为真', () => {
  const good = toJSON(okResults, { sourceStamp: 's1' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.summary, { total: 2, new: 0, match: 2, changed: 0, missing: 0, stale: 0, ok: true });
  assert.deepEqual(good.meta, { sourceStamp: 's1' });
  assert.equal(good.results[0].name, 'home/default');

  const stale = toJSON([{ ...okResults[0], stale: true, staleReason: 'stamp-mismatch' }]);
  assert.equal(stale.ok, false, '像素全一致但基线过期，CI 不能放行');
  assert.equal(toJSON([]).ok, false, '空结果不是通过');
});

test('toJSON 不把像素塞进产物：图不是结论，几十万字节进 JSON 只会让产物没法看', async () => {
  const { store } = fakeStore();
  await store.accept('home/default', img(4, 4), { sourceStamp: 'src-1' });
  const results = await store.compareAll(
    [{ name: 'home/default', image: withPixel(img(4, 4), 1, 1, GREEN) }],
    { sourceStamp: 'src-2', ignoreRegions: [{ x: 0, y: 0, w: 1, h: 1 }] },
  );
  const json = toJSON(results);
  const text = JSON.stringify(json);
  assert.doesNotMatch(text, /"data"/);
  assert.equal(json.results[0].status, 'changed');
  assert.equal(json.results[0].stale, true);
  assert.deepEqual(json.results[0].diff.bbox, { x: 1, y: 1, w: 1, h: 1 });
  assert.equal(json.results[0].diff.tolerance, 0);
  assert.equal(json.results[0].diff.greenOnly, false);
  assert.deepEqual(json.results[0].diff.ignoreRegions, [{ x: 0, y: 0, w: 1, h: 1 }]);
});
