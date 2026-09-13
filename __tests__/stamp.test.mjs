// 源码指纹：截图基线的 stale 检测靠它。每条断言对着一种「旧图冒充新证据」的路子。
import test from 'node:test';
import assert from 'node:assert/strict';

import { hashFile, bundleHash, createSourceStamp, explainStampDiff } from '../lib/stamp.mjs';

const ENGINE = { build: '0.17.0-daily.202608180107', wasmSha256: 'a08b26b9514ad082f36941b4d1fd057e' };
const VIEW = { width: 480, height: 352, scaleFactor: 2 };
const FILES = { 'app.json': '{"pages":["p"]}', 'app.js': 'export default {}' };
const stampOf = (over = {}) => createSourceStamp({ files: FILES, engine: ENGINE, viewport: VIEW, ...over });

test('同内容同口径 → 同指纹（否则每次跑都 stale，人两周内就学会无视它）', () => {
  assert.equal(stampOf().stamp, stampOf().stamp);
});

test('改一个字节就换指纹——「改了样式没提交」正是最常见的调试态，git sha 在这里是失灵的', () => {
  const changed = createSourceStamp({
    files: { ...FILES, 'app.js': 'export default { x: 1 }' }, engine: ENGINE, viewport: VIEW,
  });
  assert.notEqual(changed.stamp, stampOf().stamp);
});

test('文件表遍历顺序不影响指纹（排序后再整体哈希）', () => {
  const reordered = createSourceStamp({
    files: { 'app.js': FILES['app.js'], 'app.json': FILES['app.json'] }, engine: ENGINE, viewport: VIEW,
  });
  assert.equal(reordered.stamp, stampOf().stamp);
});

test('新增或删除文件都换指纹（少打一个页面进包也是画面差异的来源）', () => {
  const more = createSourceStamp({ files: { ...FILES, 'x.ink': 'a' }, engine: ENGINE, viewport: VIEW });
  assert.notEqual(more.stamp, stampOf().stamp);
});

test('引擎构建变了就换指纹——Craft 同时挂 0.16.1 与 0.17.0-daily，换引擎重排版是真会发生的', () => {
  const other = createSourceStamp({ files: FILES, engine: { ...ENGINE, build: '0.16.1' }, viewport: VIEW });
  assert.notEqual(other.stamp, stampOf().stamp);
  assert.deepEqual(explainStampDiff(stampOf(), other).map((d) => d.part), ['engineBuild']);
});

test('画布尺寸/DPR 变了就换指纹：换个尺寸截的图不是同一张证据', () => {
  for (const v of [{ ...VIEW, width: 960 }, { ...VIEW, scaleFactor: 1 }]) {
    assert.notEqual(createSourceStamp({ files: FILES, engine: ENGINE, viewport: v }).stamp, stampOf().stamp);
  }
});

test('场景与能力夹具进指纹：注入不同转写走到的同名屏，不能互相顶替', () => {
  assert.notEqual(stampOf({ scenario: 'onboarding' }).stamp, stampOf({ scenario: 'workout' }).stamp);
  assert.notEqual(stampOf({ fixtures: 'asr-a' }).stamp, stampOf({ fixtures: 'asr-b' }).stamp);
});

test('缺引擎身份或画布尺寸直接抛：这两样缺一样，指纹就防不住它对应的漂移', () => {
  assert.throws(() => createSourceStamp({ files: FILES, viewport: VIEW }), /引擎身份/);
  assert.throws(() => createSourceStamp({ files: FILES, engine: ENGINE }), /画布尺寸/);
});

test('空文件表直接抛：空指纹会让任意两次运行都"匹配"', () => {
  assert.throws(() => bundleHash({}), /文件表是空的/);
});

test('文本与字节按同一口径哈希：同内容不该因载体类型算出两个指纹', () => {
  assert.equal(hashFile('abc'), hashFile(new TextEncoder().encode('abc')));
  assert.throws(() => hashFile(42), /只接受/);
});

test('指纹差异要说清是哪一部分变了，而不只是「不一样」', () => {
  const a = stampOf();
  const b = createSourceStamp({
    files: { ...FILES, 'app.js': 'changed' },
    engine: { ...ENGINE, build: '0.16.1' }, viewport: { ...VIEW, width: 960 },
  });
  assert.deepEqual(explainStampDiff(a, b).map((d) => d.part).sort(),
    ['bundleHash', 'engineBuild', 'viewport']);
});

test('对外展示取 12 位，完整值与各分量都留着备查', () => {
  const s = stampOf();
  assert.equal(s.stamp.length, 12);
  assert.equal(s.full.length, 16);
  assert.deepEqual(Object.keys(s.parts).sort(),
    ['bundleHash', 'engineBuild', 'fixtures', 'scenario', 'viewport', 'wasmSha256']);
});
