# InkLab 运行时实测笔记

最初基线引擎为 `ink_web 0.17.0-daily.202608180107`；2026-09-03 起同时锁定并实测
Studio `0.16.1` 与 `0.17.0-daily.202608251310`。官方没写清的条目均以本地实测为准。
与推断区分：本文只写**跑出来过的**，推断一律标注。

## USB 真机驱动与取证（2026-09-09 实测）

目标 RG_glasses，某应用的 Studio `0.2.11` 调试包。用户从手机
保持连接并手动进入一次应用后，InkLab `/device` 服务真实执行了三条只读场景：

- 问答场景：两次提问的回复内容均从原始 PNG 识别出来。
- 设置场景：导航设置，读取设置列表，再导航首页，未切换任何选项。
- 唤醒后提问场景：重放镜腿长按，取图确认进入聆听画面，随后注入识别
  文字并捕获回复。这证明该设备版本可以串行运行 `wake → say`；麦克风实际识音仍未验证。

首次固定 `say → 等 6s → 另起 capture` 的问答测试失败，原图只剩首页；改为 `say` 后
250ms 进入真实截图轮询，原图可见回复。因为离线查询的回复会自动收起，晚截图不能用来
证明输入被吞。所有截图仍是 ADB 返回的完整 `480×640` 字节，未做模拟器光照合成或裁切。
OCR 使用本机 Apple Vision，包含原文、置信度和原图 SHA-256；“通过”仅覆盖声明的文字
条件，不把发送回执、mock caps 或未观测的安装包身份当业务证据。

同日晚补验持续视频：目标 `screenrecord v1.3` 虽然 `--help` 没列出 `--output-format`，
实际接受 `--output-format=h264 --size 480x640 --bit-rate 2000000 ... -`，输出 H.264 High
profile、无 B 帧。InkLab 用一个持续 ADB 进程与一个 ffmpeg 解码进程推送完整预览帧；
不是周期截屏。首帧实测约 1.49–1.59 秒，本机解码完成到浏览器绘制观测约 2–8ms，
后者不包含设备编码和 USB 传输，不能称为端到端延迟。静止首页会减少出帧，FPS 按实际
接收时刻计算，不设一个伪造固定帧率。

投屏和浏览器录像期间再次运行唤醒后提问场景，两项原始 PNG/OCR 断言
通过。导出的 MP4 经 ffprobe 确认为 H.264、480×640、34.90 秒、337231 字节、无声。
停止投屏和刷新页面两种方式均实测回收眼镜 screenrecord 与本机 ffmpeg/ADB 流进程。
实际未改持久常亮设置（验证时原值仍为 0），只在投屏存在且输入空闲时临时唤醒。

## 命名运行时矩阵（2026-09-03 实测）

同一浏览器 document 内可并行初始化三份独立 glue module + WASM，每条 lane 各自创建 InkView、
host capabilities 与 appId。`0.16.1`、两个 0.17 daily 同时打开 `cap-probe-app` 均达到
`isRunning=true`，键盘与语音唤醒可由宿主镜像。二进制按 `runtimes.lock.json` 的 SHA-256 校验，
不入 git；旧 daily 的 CDN URL 已返回 404，但盘上锁定缓存仍可复现，因此 `npm run engine`
先验本地哈希、只在缺失或漂移时才重新下载。

同一 conformance 场景单 lane 复跑得到的差异：

- Studio 0.16.1：Battery/OPFS/Media Capture globals 为 unsupported，TTS 只有 `speak()`（partial）；
  World Awareness 的页面私有 orientationSensor 可用，但同一条合成 nod 未观察到 head-gesture 回调。
- Studio 0.17 daily：Battery、OPFS 写/关/读/删、Media Capture globals、独立 TTS synthesize task、
  World Awareness 与合成 nod 全部 supported。
- 原生 `table` 与 0.17 primitives 的 PNG 内容在 0.16/0.17 间不同；矩阵只报
  `visual-changed`，是否属于回归仍需人审，不能仅凭哈希自动判坏。

## AIUI Studio 1.1.0 预览几何与合成口径（2026-09-03 实测）

Studio 对话里的缩略卡只是 `448×150 px`（backing `896×300`），不是权威设备视口。
点「进入」后，右侧「效果预览」显示的交互画布仍是逻辑 `480×352`，backing `960×704`；
在当时右栏里 CSS 缩放为 `360×264`。Studio canvas 的 `mix-blend-mode` 是 `normal`，应用
自己绘出黑底。

2026-09-04 补验 Studio 右侧「真机模拟」后，确认它又多一层竖帧合成：

- `.device-screen` 逻辑尺寸是 `480×640`，当时按 `scale(.75)` 显示为 `360×480`；
- 环境输出 `.glimmer-output-canvas` backing 是 `480×640`；
- `.ink-canvas-host` 仍是 `480×352`，绝对定位 `top:144px`，即上下各留 `144px`；
- 环境下拉实测可见「绝对黑暗 / 室内明亮 / 夜晚弱光」。

因此 InkLab 保留两个不可混用的证据口径：「效果预览」输出 480×352 黑底横幅；
「真机模拟」输出 480×640 环境竖帧，内容在 y=144..496。
2026-09-08 修正背景合成：screen 会让绿色主体发白；随后尝试的纯黑硬扣色又把已经混入
黑底的抗锯齿/低亮像素保留成不透明色，出现黑边、小字发黑。最终按最大 RGB 通道估算
覆盖度，再反除覆盖度恢复前景色，用 source-over 合成。它是预览约定，不能从成图恢复
原始 alpha；重新叠到黑底的通道误差应不超过 1，满亮绿色保持不变。
实时预览、截图、录屏统一调用 paintPreviewFrame；原始引擎画布保留输入，只在环境模式
隐藏显示，另一个不可交互画布显示合成结果。预览定时器随舞台销毁，后台跳过实时合成。
背景同样共用程序化绘制器，不再另写 CSS 窗户。
后者的几何对齐 Studio，但内置环境是 InkLab 原创程序化场景，不冒充 Studio 照片资产或真机光学证据。

## 引擎 API 的坑

### 主舞台 canvas 录屏（2026-08-28 实测）

宿主可直接对 InkView 绑定的 canvas 调 `captureStream(30)`，再交给浏览器 `MediaRecorder`；
这条路径不需要 `getDisplayMedia`，因此不会弹系统录屏权限，也不会把控制台、鼠标或浏览器边框录进去。

在本机 Chrome 152 的实测结果：`video/mp4;codecs=avc1.42E01E` 被支持；`480×352 @2` 主舞台
产出 `960×704`、H.264/AVC、`yuv420p` 的 MP4。17.00 秒手动成片，以及自动跑完 44 步、
覆盖 5 页的 15.41 秒 `capability-run` 场景成片，均可由浏览器内嵌 `<video>` 完整解码；
`ffprobe` 识别为 MP4/H.264。抽查自动成片 1/4/8/11/14 秒的五个页面均为完整主舞台，
没有此前把 4:3 页面塞进 16:9 捕获画布时出现的灰色侧边填充。
切到「真机模拟」后，同一 @2 画布的录屏尺寸改为 `960×1280`，AIUI 内容居中位于
`y=288..992`，而不是把横幅伸满竖帧。

浏览器支持面不能靠这台机器外推：宿主按 MP4 → WebM 排序逐项试建 `MediaRecorder`，实际只拿到
WebM 时必须显示「插入 PPT 前需转 MP4」。画面录屏也不包含音轨；InkLab 的模拟 ASR/TTS 调用账
不是可混入视频的真实音频证据。

### `dispatchInput(type, key, timestamp?)`

- `type` 只认 `'keydown'` / `'keyup'`。`'key'`、`'keypress'` 会抛
  `Unsupported input event type: ...`。
- `key` 是字符串键名（`'Enter'`、`'ArrowDown'`、`'Backspace'`）。
- 第三参是**显式时间戳**，缺省 `Date.now()`。
- **传错类型会让 wasm `memory access out of bounds`**（例如把对象当 key 传）。这不是普通异常，
  之后引擎状态可能已经脏了，最稳妥是重建 InkView。所以驱动层必须在进 wasm 前做类型校验。

### `startRendering()` 不能省

只调 `requestRender()` 是单帧。装载完不开渲染循环时，**状态会推进但画面不重绘**——
表现成「按键没反应」，排查时极易误判成输入没送达。已在宿主里修掉；写别的宿主时注意。

### 引擎日志走 `console.*`，不是 `onMessage`

引擎内部直接往浏览器 console 打日志，带 Rust 源码路径：

```
INFO packages/ink-web/src/lib.rs:504 InkWebView::open_bundle start app_id=... file_count=247
INFO packages/ink-runtime/src/app/mod.rs:973 Loading initial page: pages/home/index
INFO packages/ink-runtime/src/page/mod.rs:247 Page "pages/home/index" method "onLoad" took 1.6ms
INFO packages/ink-core/src/layout/mod.rs:232 Initializing Taffy layout engine
```

`onMessage` / `setOnMessage` 是**应用侧 postMessage** 的通道，不是引擎日志。宿主要看日志就接管
`console`（宿主已这么做，落在 `window.__inklab_engineLog`）。

顺带确认的内部实现：布局引擎是 **Taffy**，脚本运行时是 **QuickJS**，与官方文档说的一致。

> ⚠️ **`Page "…" method "onLoad|onShow" took …` 缺席，什么都不说明。** 这行是**采样式**性能日志
> （`ink-runtime/src/page/mod.rs:247`），同一棵树多次装载里时有时无，跟页面到底跑没跑没有必然联系。
> 2026-08-27 在另一个应用上栽第二次：引擎日志停在 `eval_module pages/onboarding/index.js`、那行 onLoad
> 永远不来，据此下了「引导页在本引擎上装载不完」的 P0 结论；实际把 onLoad 全程打点跑一遍是 7 个探针
> 全过，截图里整条引导（闪屏→欢迎→…→生成→首页）一直是好的。同一份代码，只加两句 `console.log`
> 那行日志就一会儿出现一会儿不出现。
>
> **判页面到没到只认两样**：`eval_module namespace success module='…/pages/x/index.js'`（模块求值，
> 同步必打、有缓存所以每实例一次），以及**截图 / 能力面证据**（应用真调了哪些宿主能力）。
> 想确认某个生命周期方法跑没跑，别去翻日志——在方法里 `console.log` 打点，那条是自己的、必打。

### 指针事件在被测应用里不产生 tap（2026-08-26 实测）

点画布上的按钮不会激活它。**不是宿主接线的问题**：绕开 `bindDomEvents` 直接调
`view.dispatchPointer('pointerdown'/'pointerup', x, y, ...)`（CSS 坐标系与背板坐标系都试过）
同样毫无反应，画面不变、应用也没播报。眼镜本来就没有触屏（触控板映射成按键），
所以这条路没通对产品没影响——但排查时别把「点了没反应」当成引擎坏了。

**InkLab 的驱动只走键盘与语音唤醒。**

### `dispatchVoiceWakeup(keyword, ts?)`

`keyword` 必须是非空字符串，否则抛 `TypeError`。

### `openBundle` 的签名

```js
view.openBundle({ appId: <非空字符串>, files, initialPage?, query?, hostOptions? })
```

`appId` 空会抛。另有 `open(path, ...)` 与 `openFromVfs({appId, baseUrl, ...})`。
`hostOptions.initialTarget` ∈ `_current` / `_blank` / `_widget`。

## 驱动应用时的时序规律（这条最影响脚本化）

被实测的那个应用自己有两道闸，**两道的时钟来源不同**：

| 闸 | 时钟 | 能不能用虚拟时间戳跨过 |
| --- | --- | --- |
| 同向导航键去重闸（约 700ms） | 事件自带的 `timeStamp` | **能**——`dispatchInput` 第三参推进即可 |
| 换页后的激活冷却（约 1.2s） | 应用自己的 `Date.now()` | **不能**——只能等真实时间 |

所以脚本驱动的正确配方是：**时间戳按虚拟时钟推进（跨去重闸）+ 换页后真实等待 ≥1.3s（跨冷却）**。
只推时间戳不等真实时间，会出现「一批按键只有第一个生效」的现象——我在实测里正是这样被卡住的。

**冷启动同样有这道闸（2026-08-26 被它坑过一下午）**：冷却看的是每页 `onShow` 起的 1.2s
（该应用 `lib/interaction.js` 的 `PAGE_SHOW_ACTIVATE_COOLDOWN_MS`，两边都用真实 `Date.now()`），
而宿主的「装载完成」早于首页 onShow 数百 ms。**装载完立刻发的第一个 Enter 会被吞**，
之后整条键序错位——症状极具迷惑性：焦点键落到错误的屏上、断言在下游某步失败、
且因为骑在 1.2s 临界线上而时好时坏（页面开久了再跑就恒过，e2e 冷启动立跑就恒挂）。
场景脚本的第一个 activate 之前要真实等 ≥2.5s；被吞的 activate 在应用侧「不记账」，
但**不要**用连按 Enter 补偿——第一发如果其实被接受了，第二发会把下一屏也激活掉。

> 这也说明 InkLab 只能加速到「换页 1.3s 一步」，再快就要改应用侧的冷却常数（不建议为了测试改产品代码）。

## 存储

引擎自带的宿主身份写在浏览器 `localStorage`：`ink.host.identity.device_seed.v1` /
`ink.host.identity.local_salt.v1`。应用自己的 `wx.*StorageSync` 数据**不出现在 localStorage 里**，
其后端与 OPFS 是否共用仍未定位。

0.17 的 `navigator.storage.getDirectory()` 已在 InkLab Web 宿主实测跑通：创建文件 →
`createWritable()` → 写字符串 → `close()` 提交 → `getFile().arrayBuffer()` 读回 9B →
`removeEntry(name, {recursive:false})` 删除。0.16.1 明确 unsupported。当前实现的 `removeEntry`
要传第二个 options 参数；只传文件名会报“期望 2 个参数”的 TypeError。

实测影响：**同一个 InkView 实例内持久化成立**（应用重进页面读得回），但换 document/浏览器重启后的
持久化范围仍未闭环验证。
场景脚本要「干净开局」时，稳妥做法是重建 InkView 而不是依赖清 localStorage。

## 宿主能力层

契约见 `lib/caps/contract.mjs`（从 glue 反解）。要点：

- `hostCapabilities` = `{ 命名空间: { 方法: async (args) => result } }`
- 方法缺席时引擎抛 `Host capability {ns}.{method} is not configured on Web host`
- 数据回灌的入口是**能力事件靶**：`view.getHostCapabilitiesTarget().dispatchEvent(new CustomEvent(name, { detail }))`
  （`lib/caps/index.mjs` 的 `createEventBridge` 就是这个）。外层 InkView 上那个同名的
  `dispatchHostCapabilityEvent` 是 wasm 内部方法、吃 JSON 字符串，**不是给宿主用的**——
  早先这里写反了，接驱动层时踩过一次：`driver.emit()` 按名字调它，得由宿主用事件桥转接
- detail **必须原样带回引擎给的 `targetId` 与 `sessionId`**，否则引擎认不出是哪一路
- `media` 方法宿主不提供时会尝试回落到 glue 的浏览器后端；但当前 `Di()` 只实现设备枚举、
  取流和录音，**没有 `takePhoto`**。因此直接省略 `media.takePhoto` 只会报
  `Host capability media.takePhoto is not configured on Web host`，并不能拍照。InkLab 默认与所有 E2E
  都显式提供模拟 `media`；手动选 `camera=computer` 时只把 `takePhoto` 换成
  `lib/browser-camera.mjs` 的浏览器适配器，其余录音能力仍模拟。下拉切换本身是用户交互，宿主会
  在这一步申请权限并立即停轨（不读取/保存照片）；直接用 URL 打开则必须点「授权 / 重试」。真正的
  `takePhoto()` 仍必须发生在用户交互调用栈里；采完同样立即停止视频轨道。

### Bluetooth 不走 `hostCapabilities`（2026-08-27 实测）

wasm 的方法名里能搜到 `bluetooth.GetDevices/RequestDevice/...`，但不能据此给
`setHostCapabilities()` 加一个 `bluetooth` 命名空间：glue 的严格编解码表没有它。当前
`ink_web 0.17.0` 由 `packages/ink-web/src/platform/web_bluetooth.rs` 的独立桥直接读取
`window.navigator.bluetooth`。因此 InkLab 的模拟器装在 navigator 上，控制面才挂到
`__inklab.bluetooth` / `caps.bluetooth`；后者只给场景驱动，不会传进引擎能力表。

用上游 Bluetooth 心率样例做过完整活体探针：

1. 页面先调 `getAvailability()`；
2. AIUI `scanDevices()` 在 Web bridge 中落到浏览器 `requestDevice()`；
3. 选中设备后依次走 `device.gatt.connect()`、`getPrimaryService()`、
   `getCharacteristic()`、`startNotifications()`；
4. 在 Characteristic 上派发 `characteristicvaluechanged`，`value` 放 `DataView([0, 88])`，
   样例画面更新成 88 BPM。

假体必须是结构完整的浏览器对象树。尤其 `characteristic.properties` 不能省；只给 UUID/value/
事件方法时，引擎会在 Rust/JS 边界报 `Reflect.get called on non-object`。模拟器因此覆盖设备、GATT
server、Service、Characteristic、Descriptor、读写、通知、断连和调用账，而不是只伪造一次扫描结果。

证据边界：上述结果确认的是 InkLab/浏览器桥和应用协议逻辑。电脑蓝牙模式可验证浏览器实际的
设备选择与 GATT 路径；目标硬件的广播、配对、服务 UUID、固件通知格式、50Hz 持续吞吐/丢包仍须
真实设备复核，不能拿模拟或电脑侧成功替代。

### 电脑 Web Bluetooth 真表校正（2026-09-02）

被测应用配套的 BLE 腕表经 macOS Chrome + InkLab + USB 状态面交叉验证后，补了三条不能靠 mock 推断的规则：

- AIUI `scanDevices()` 最终虽会调用浏览器 `requestDevice()`，但 QuickJS bridge 可能已跨出最初 Enter 的
  transient user activation，Chrome 会报 `SecurityError: Must be handling a user gesture...`。电脑适配器
  只挂起原生 `requestDevice`；控制台的“选择真实设备”在 DOM click 的同步调用栈里用同一 filters 授权，
  随后解析原 Promise。不要在宿主上补一个普通 JS `scanDevices`：真实 `BluetoothDevice` 经这种自造
  scan handle 回调时会丢在 WASM/QuickJS 边界；让 ink_web 自己完成 scan 事件与 GATT 对象代理。
- `device.gatt.connected === true` 早于服务发现、四路订阅、HELLO/TIME_SYNC、计划同步和腕表页 READY。
  真机驱动不能拿它当完成信号后立刻换页；本次过早换页曾产生 4 次 GATT 写失败，等待应用握手稳定后
  相同帧全部成功。
- Ink Web 0.17 不转发原生 `gattserverdisconnected`，`server.connected` 也可能停在连接时快照。应用以真实
  写入返回的 `NetworkError: GATT Server is disconnected` 作为补充断线信号并启动清理/重连；InkLab
  工程热重载则主动断开真实 GATT，避免 50–60Hz 通知继续打到已销毁的 QuickJS channel。Chrome 若把
  重新广播后的 peripheral 视为新设备，仍需用户重新选择；不能把 mock 的无权限自动重连冒充真表结果。

本轮真表证据为：协议 `link=ready`；应用写出 SET_RATE + START_STREAM；USB 侧 60Hz 期间
`tx_packets 6512 → 9448`、`dropped_samples=0`；真实六轴完成俯身划船 8 次并进入组报告。跨页快照版本
原先由每个页面从 1 重启，真表会拒绝下一组；改为 GATT 会话统一递增后，上一组 revision 240 后下一组
以 revision 269 正确进入 `set_index=2 / screen=active`。

排查新能力时把 `lib/caps/probe.mjs` 的回声探针挂上，它会把引擎的真实调用参数录进
`window.__inklab.probe.calls`。

## 焦点与帧：两个「程序化输入推不动」的真凶（2026-08-26 实测）

这一节推翻了先前两条推断。结论都能按本节末尾的配方复现。

### 1. InkView 焦点是引擎内部标志，而且**新建即 focused**

唯一开关是 `view.focus()` / `view.blur()`（glue 里就是转给 wasm 的一行）。实测三条：

- 把宿主装载期的 `view.focus()` **整行删掉**，驱动到目标步再 `dispatchVoiceWakeup`，
  `speech.startRecognition` 照样被调用。→「装载期程序化 focus() 翻不动它」是误判：
  **根本不需要装载期 focus**，新建的视图本来就是 focused。
- `view.blur()` 之后唤醒：引擎不再调 `startRecognition`（`caps.speech.calls` 里只剩装载期那次 `speak`），
  **宿主侧一条错误日志都没有**——`InvalidStateError: ... is unavailable while InkView is blurred`
  抛在应用 realm 里被应用自己 catch 了。所以「blurred」的现场特征是**没有现场**：
  只能靠「唤醒了但 startRecognition 没来」反推。（这句文案在 engine.wasm 里全库只有一处。）
- DOM 焦点与它无关：`canvas.blur()` + 把 DOM 焦点给宿主按钮，ASR 照常起。

### 2. 唯一会把它翻成 blurred 的接线是 `syncFocus`

`bindDomEvents({ syncFocus: true })` 才会把 `focusTarget` 的 DOM focus/blur 转成
`view.focus()/blur()`（并在 pointerdown 里替你 `focusTarget.focus()`）。实测：

- 开着 syncFocus 时，DOM 焦点一挪到宿主按钮，唤醒后 `startRecognition` 就不来了；
  点回画布立刻恢复。
- 而 **Chrome 在标签页切后台时会给当前聚焦元素发 blur**：实测事件序列
  `canvas focus → canvas blur → window blur`，`document.hidden=true`。

两条合起来就是先前观察到的那套现象：窗口一切走 InkView 就 blurred，点一下画布就好。
**所以 InkLab 明确不开 syncFocus**，也不在 pointerdown 里补 `view.focus()`——那条 workaround
治的是一个由 syncFocus 自己造出来的病。要故意测 blurred，用能力控制台的 focus()/blur() 两个钮。

### 3. 「dispatchInput 不推进应用」与焦点无关，真凶是**帧停摆**

- 引擎的帧调度是 `requestAnimationFrame`（glue 的调度器只有在没有 rAF 时才退回 setTimeout）。
  `view.render()` 是**公开且同步**的方法，wasm 侧的 tick 就发生在它里面；`startRendering()`
  的循环无非是把它排在 rAF 上。
- 实测（后台标签页，`document.hidden=true`，宿主没有 pump）：连按 5 次
  （Enter/Enter/Enter/ArrowDown/Enter），画面指纹**一次都没变**，`caps.speech.calls` 全空；
  切回前台后画面停在第 2 步。即**只有第一次输入生效**——它的状态变更在 wasm 调用里同步发生了，
  但新一步的布局与焦点要等下一帧才落地，后面的按键全打在陈旧的焦点树上。
- 实测（同样后台标签页，但每次 `dispatchInput` 之后同步 `view.render()` 摇到不再有内容）：
  一路走到目标步，唤醒后 `startRecognition` 正常，全程 `document.hidden===true`。

**排查时最容易上当的一点**：窗口被别的窗口完全遮住时 Chrome 同样把页面判为 hidden。
「我明明开着窗口」不构成反证——要看 `document.hidden`。

宿主据此改了三处接线（`host/inklab/input.js`、`keyboard.js`、`stage.js`，原因见 `host/inklab.js` 头注）：

1. 所有程序化输入收敛到 `sendInput`/`wake` 一个出口，dispatch 完立刻 pump 帧；
2. 键盘不再交给 `bindDomEvents`（它的 keydown 直接进 wasm，插不进 pump，也没法镜像到第二块画布），
   改由宿主监听 window 后走同一个出口，键名口径对齐引擎的 `event.code || event.key`；
3. `bindDomEvents` 只留指针/滚轮：`keyboardTarget` 传一个游离元素（永远收不到键盘事件）把它的键盘绑定关掉。

### 自证配方

```js
// 后台标签页里也应当一路推进到「练什么目标」，并且 startRecognition 出现
await window.__inklab.runScenario('onboarding-goal');
window.__inklab.lastScenario.summary        // "10 步全部通过"
window.__inklab.caps.speech.calls.map(c => c.method)  // [..., "startRecognition"]

// 想看「不 pump 会怎样」：直接打引擎，不走宿主出口
const v = window.__inklab.view;
v.dispatchInput('keydown', 'Enter', Date.now()); // 后台标签页里连按几次，只有第一次生效
```

## e2e 场景批次落地时的新实测（2026-08-26 下午，某真实应用）

- **`Page "…" method "onLoad/onShow" took …` 是采样式性能日志**：方法跑得快就不打。
  曾把「日志缺席」误判成「导航丢了」，截图证明页面好好的（rAF 保活让引擎更快后，
  这行日志反而更少见）。页面**首次到达**的可靠标记是
  `eval_module namespace success module='…/pages/x/index.js'`（模块求值，同步必打；
  有模块缓存，同一实例内只出现一次）。宿主 `lab.pagesLoaded()` 已按双源解析。
- **无头 Chrome 会把窗口判成被遮挡而长时间不发 rAF**（实测 >8s），引擎 glue 的调度器
  （页面挂载续段、渲染循环）全排在 rAF 上——症状是页面模块 eval 了但挂载停在半路。
  反遮挡的 Chrome 旗子治不住；宿主现内建 rAF 保活（每个回调加 32ms 计时器保底，
  谁先到谁执行，前台行为不变）。能力事件注入后宿主也会立刻 pump（与输入路径同纪律）。
- **被测应用的「欢迎屏」是 home 的首跑门面**：按「开始」才 navigate 到 onboarding 页。
  完整首跑 = 开始 → 手势 → 权限 → 校准(可跳过) → 目标 → **绑定手机(可跳过)** → home。
  目标确认并不直接落地——漏掉绑定步会卡在 6 位码画面。
- **应用存档不跨引擎实例**：重载（重建 InkView）后恒回欢迎屏。e2e 场景因此各自全新开局，
  不依赖上一个场景留下的状态。
- **应用闲置一阵后，待机前置层会吞掉第一个手势**（用来唤出注意力浮层）。浏览器里手动
  实验时要先重载再驱动，否则键序错位极具迷惑性。
- **确认卡后的自动重听（relisten）在 InkLab 里不触发**：应用侧要经页面 realm 的
  `startPreparedSpeechRecognition` 桥真正 start，注入环境里这一步没发生（真机行为待查）。
  语音「确认」因此暂不可测，e2e 走同一确认闸的硬件 Enter（`handlePrimary`）。待排查。

## LLM 接真模型时的实测（2026-08-26 晚，本机 CLI Proxy API + dashscope/qwen3.7-plus）

- **引擎不向与页面同源的 endpoint 发请求**：getConfig 正常返回同源 URL（如页面在
  127.0.0.1:8788，endpoint 也是它）后，POST 无影无踪——globalThis.fetch 层零记录、
  无报错。换成 `http://localhost:8788/...`（同一服务、不同 host 字符串）立即恢复。
  serve 的 /llm 转发路由因此刻意用 localhost 下发（页面在 127.0.0.1 上跨域，路由带 CORS）。
- **思考型模型赶不上应用的生成闸**：qwen3.7-plus 思考模式下正文首 token 实测 17.7s，
  该应用的 GENERATE_TIMEOUT_MS=8s，恒转离线兜底；`enable_thinking:false` 后 1.3s。
  引擎发的请求体没法带厂商参数，所以 serve 提供 /llm 转发路由按 `llm.local.json` 的
  `requestDefaults` **补缺失字段**（引擎显式写的字段绝不覆盖）。
- 全链路验证过：引擎 getConfig → POST（net 层 continue/pass）→ serve 补参转发 →
  CLI Proxy → qwen 流式回 → 应用 8s 闸内收齐 → TTS 播出真答案（llm.exchanges live:200）。

### 引擎的请求恒 `stream:true`（2026-08-27 实测，录像带逐条可查）

**`session.prompt()` 与 `session.promptStreaming()` 在 HTTP 层是同一形请求**：请求体里
`stream` 恒为 `true`，响应恒是 `text/event-stream`。三盘录像各自佐证——意图分类那一发用的是
`prompt()`（`request.stream === true`、正文分成 7 段 chunk 带 `tool_calls` 增量），
两站对比总结那一发也是 `prompt()`（同样 stream:true），问答那一发才是 `promptStreaming()`。
差别只在**应用怎么消费**这条流：`prompt()` 等收完再拿整段，`promptStreaming()` 边收边回调。

两条后果，写 e2e 断言前必须知道：

1. **「走的是流式还是非流式」在能力面 / 录像键上分辨不出来**——两者的归一化请求体一模一样，
   键也一样。想证明「应用真的走了流式消费」只能靠应用侧单测（router 的分流 + travel-agent 的
   `promptStreaming` 契约）。e2e 层能证的是「分段正文被完整拼接」（用横跨 chunk 边界的针）
   和「往返次数对不对」（流式起来了又中途死会回落非流式**再打一发**，次数当场变 3）。
2. **工具调用是分段流下来的**：`tool_calls[].function.arguments` 会被拆成好几段 delta
   （`{"intent": ` / `"query_status` / `"` / `, "queryKey": "clues` …），由引擎负责拼回完整 JSON
   再 dispatch `toolcall` 事件。手写 FC 录像带时要么照这个形态写，要么一段给全——
   两种引擎都吃得下，但**别写成非流式的单个 JSON 响应**（`stream` 进键，格式不对会解析出垃圾）。

## 拆实例时引擎恒 panic（2026-08-27 实测，写「没崩」断言前必读）

通用手动 `reload()` 仍受下面问题影响。自动 E2E runner 现在为每条场景执行完整
`Page.navigate`，用新 document 同时隔离 Ink Web glue、Web Bluetooth 包装器与能力层；因此不要
再把这里的“只重建 InkView”当作自动场景切换机制。

每次 `reload()` 都会先拆掉旧 InkView（`disposeStage` → `view.destroy()`）。当前引擎在这一步**恒 panic**：

```
INFO  packages/ink/src/instance.rs:325              Dropping Ink instance <uuid>
DEBUG packages/ink-scripting/src/js_runtime.rs:74   JsRuntime drop start: safe persistent count = 189
panicked at library/std/src/sys/sync/mutex/no_threads.rs:19:9:
  assertion `left == right` failed: cannot recursively acquire mutex
```

三条实证它与被测应用无关：换任意前置场景（`voice-nav` / `ui-boards`）照样出现；只跑一个场景
（没有前一轮可拆）一次都不出现；出现之后同一轮里后面的每一步照常通过。**它不影响新实例**。

**坑在于它是懒执行的**：`Dropping Ink instance` 常常在下一轮装载**跑到一半**才真正完成，
于是那条 panic 落进**下一个场景**的日志窗口里。宿主已把 `state.bootLogFrom` 挪到 `disposeStage`
之后（拆旧实例是上一轮的收尾），但那只挡住同步那半截，懒执行那半截挡不住。

→ **场景里写「本场引擎没崩」这类断言时，必须按上下文把这一路排除掉**：只有当
`cannot recursively acquire mutex` 的前几行出现过 `Dropping Ink instance` / `JsRuntime drop`
才豁免；同一句话出现在别处（应用真把引擎搞成重入了）照样算数。InkLab 不内置这条断言，
需要的应用场景自己按此口径实现。
排除口径**必须窄**——放宽一点，真正的崩溃就跟着被吞掉了。

## 已解：传感器能力其实一直在被调用（2026-08-26 复核）

先前记的「挂上回声探针走到校准步，`probe.calls` 一条都没有」**复现不出来**。今天的实测：

- 驱动到校准步按「开始校准」（`?probe=1`）：`probe.calls` 里出现 `accelerometer.start`；
- 换成真能力集：`caps.sensors.activeSessions()` 里有一路 accelerometer，60Hz，
  几秒内 readings 涨到两百多条，`running=true`；
- 从能力控制台注入 `NotReadableError` 之后再按「开始校准」，应用立刻降级并播报
  「传感器暂不可用,先用语音记录模式」——**故障注入这条链路整条是通的**。

先前那三条猜想（Generic Sensor API 不存在 / 能力要在 openBundle 前设 / 应用 realm 没有该全局）
**都不成立**：引擎确实把传感器转给了宿主能力。最可能的解释是当时「界面进了采集中」与
「probe 无记录」这两条证据并非来自同一次运行（探针没真装上，或读的是另一个实例），
在没有新证据之前不再往下猜。

顺带两条对写场景有用的实测：

- 静置基线（`DEFAULT_BASELINES`）**跑不完校准**：应用要 3 个深蹲周期，静置数据一个都出不来，
  界面会一直停在 `0 / 3`。要走完真校准得 `caps.sensors.loadTrace()` 喂一段真实深蹲 IMU。
  样例场景因此走的是「先跳过校准」。
- onboarding 是**单页多步**，步进不产生 `eval_module` 日志。用页面模块日志判断「有没有前进」
  会得出错误结论——要么看画面，要么看应用调了哪些宿主能力（样例场景用的就是后者）。

## 已解：trace 定时器迟到污染样本时间轴（2026-09-03）

某真实应用的 `glasses-imu-workout` 场景里，同一条 18 秒/1080 帧 trace 在浏览器负载下曾出现两类表象：

- 25 秒等待上限时只收到 1067 帧，差 13 帧；
- 完整收到后业务仍是 7 次、画面一致，但组间点评请求里的组时长从录像里的 30 秒漂到 35 秒，
  键对不上，产生 `replay-miss`。

根因在宿主模拟器：排程间隔来自 trace 的 `t`，派给应用的 reading `timestamp` 却取回调真正
执行时的 `Date.now()`。后台或高负载让 `setTimeout` 迟到后，同一录制轨迹的样本周期也被错误
拉长。现在 trace reading 的时间戳固定为「激活时刻 + 样本相对 t / speed」，循环时叠加原始
末段间隔；墙钟只用于断流/首帧延迟。单测让每个回调故意晚 200ms，仍逐位得到
`0/7/23/24/61ms` 原始时间轴。导入时也拒绝负数或倒退的 `t`。

应用的组时长仍按真实墙钟计算，这是产品口径，不由模拟器改写。因此该场景保留 30 秒主录像
并显式登记已观察到的 35 秒 alias；其他时长不模糊命中。场景完整复验为 37/37、三张基线
一致、`replay-hit×1`。实时大号数字另有 8 像素/最大通道差 1 的 Skia 抗锯齿抖动，只给该
截图设置 `tolerance:1`，没有扩大忽略区域。
