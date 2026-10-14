# InkLab 使用指南

安装、首次运行和引擎下载见 [README](../README.zh-CN.md)。本文讲工作台里有什么、各项宿主能力怎么控制、怎么写场景和跑测。
USB 连真机见 [device.md](device.md)；实测出来的引擎行为与时序规律见 [runtime-notes.md](runtime-notes.md)，给应用写脚本之前先读。

在本地跑 AIUI 工程或发布包：**源码目录与 `.aix` 都是一等输入，不上传，启动后不依赖外网**。

```bash
npm run engine                               # 首次：去站点找引擎、生成 runtimes.lock.json 并下载（之后也可只点名一条 lane）
npm start -- <app>                           # 源码目录
npm start -- <app>.aix                       # 发布包
npm start -- <app> --compare-with <app>.aix  # 源码对照发布包
# 打开 http://127.0.0.1:8788/ ，改完源码自动热重载（服务端 fs.watch → SSE）
```

## 这是什么

Craft 的渲染引擎不是服务端渲染，而是把眼镜上的 Ink 容器（QuickJS 跑逻辑层 + Skia 画视图层）
整个编译成 WebAssembly 搬进浏览器。那个 wasm 是自洽的：给它一张 canvas 和一组宿主能力回调，
它自己解析 `.ink` / `.js` / `app.json`、自己排版、自己处理焦点与事件。

InkLab 把同一个引擎接到我们自己的宿主上，并且**把宿主能力换成我们能控制的假体**——
这才是它相对 Craft 的价值所在：Craft 是给人看的，InkLab 是给测试用的。

```
你的工程源码 ──normalizeBundleFiles──▶ ink_web(wasm) ──bindCanvas──▶ <canvas>
   或 .aix 包                              ▲
                        宿主能力(ASR/TTS/相机/LLM/传感器/网络) ── 我们自己写
                        navigator.bluetooth(BLE 模拟/电脑蓝牙) ── 独立浏览器桥
```

源码目录会按 InkLab/.aixignore 口径形成 bundle 快照；`.aix` 已经是发布事实源，装载时不再二次
过滤，启动页会展示 `VERSION`、MD5、SHA-256、包体积与完整 manifest。`--compare-with` 可把另一个
源码目录或 `.aix` 作为只读对照，工程页按 `+ / - / ~ / =` 展示文件内容差分。

## 目录

| 路径 | 作用 |
| --- | --- |
| `bin/` | 命令行入口（薄壳）：`inklab`、`inklab-e2e`、`inklab-matrix`、`inklab-engine`、`inklab-device` |
| `host/` | 宿主页面，在浏览器里跑：入口 `host/inklab.js`，按职责拆在 `host/inklab/*.js`；`host/device*` 是 USB 真机页 |
| `lib/` | 浏览器与 Node 共用的纯逻辑和能力层，**不许 import `node:`**（`__tests__/boundaries.test.mjs` 守着） |
| `lib/caps/` | **宿主能力层**——见下 |
| `lib/bundle.mjs` | 源码目录 → bundle 文件表 + 工程预检 |
| `lib/aix.mjs` | 直接读 `.aix` 包（对照线上、回归旧版用） |
| `lib/runtime-lock.mjs` | 运行时 registry 的校验与多选 URL 解析 |
| `lib/driver.mjs` | 场景驱动：声明式脚本 + 时序配方 |
| `lib/recording.mjs` | 主舞台画面录屏：canvas stream、MP4/WebM 择优、成片生命周期 |
| `lib/shots.mjs` | 截图基线与像素 diff |
| `lib/stamp.mjs` | 源码指纹（截图 stale 检测的依据） |
| `lib/node/` | 只给 Node 用：`serve.mjs`（本地宿主）、`e2e.mjs` + `e2e-browser.mjs`（e2e 跑测：内嵌服务 + 无头 Chrome + CDP，见下「e2e 跑测」）、`matrix.mjs`（一条命令执行 runtime × lighting 矩阵并汇总 conformance/PNG 差异）、`fetch-engine.mjs` + `download.mjs`（引擎拉取与校验，另有 `cache-path.mjs`、`runtime-lock-file.mjs`、`engine-version.mjs`）、`project-source.mjs`（源码/发布包统一快照、内容身份与文件差分）、`device-*.mjs`（USB 真机） |
| `runtimes.lock.json` | **不入库**（每个人不一样）。本机的 lane 清单：一个数组，每条记来源、版本、glue/wasm sha256；顺序即优先级，第一条是默认 lane。由 `npm run engine` 生成 |
| `.engine/` | **不入库**。引擎缓存目录（`INKLAB_ENGINE_DIR` 可换位置）；各 lane 的二进制在 `.engine/runtimes/<lane id>/`（条目的 `cacheDir` 可指到别处） |
| `scenarios/` | **内置通用**场景（目前只有冒烟）。应用专属场景是工程资产，放各工程 `e2e/scenarios/` |
| `fixtures/cap-probe-app/` | AIUI 0.17 API/组件 conformance fixture（不是产品代码） |
| `docs/runtime-notes.md` | **实测的引擎坑与时序规律，动手前必读** |

## 宿主页面

- **工作台布局**：预览、runtime/场景任务带、能力控制与 Inspector 分层排列。能力控制按
  「交互 / 设备 / 传感 / 全部」分页，说明默认收起，Inspector 可单独折叠；常见桌面尺寸下
  页面本身不滚动，仅对当前控制分页或 Inspector 内容做局部滚动。
- **浅色 / 暗色**：顶栏一键切换并写入本机 `localStorage`；首次打开跟随系统配色。主题只影响
  InkLab 工具外壳，不改写 InkView canvas 像素，所以不污染截图基线。
- **运行时矩阵**：`runtimes.lock.json` 里的 lane 可多选，同页同时启动。每条 lane 都有独立
  glue module、WASM、InkView、宿主能力实例和 appId；默认把键盘、唤醒和脚本输入镜像到全部 lane。
  清单是你自己的：`npm run engine` 会把 Craft 与 AIUI Studio 两个站点上挂着的构建都记成 lane，
  别的来源可以手动加（见下「引擎版本会漂」）。第一条 lane 是默认 lane；
  本机没有它的缓存时改用别的已缓存 lane，并在启动日志里说明。
- **每条 AIUI 画布 480×352**：键盘直接驱动（`↑`/`↓` 切焦点、`Enter` 执行、`Backspace` 返回）。
  焦点在控制台输入框里时键盘不生效——否则打字会把应用推着走。
- **两种 Studio 口径**：默认「效果预览 · 黑底」为 480×352 normal blend；
  「真机模拟 · 竖屏」对齐 Studio `device-screen=480×640`，把 480×352 AIUI 画布放在
  `top=144`，上下各留 144px 环境，对黑底画面去底后覆盖到环境上，保留鲜绿色与柔和边缘。
- **三种光照**：绝对黑暗、室内明亮、夜晚弱光，仅在「真机模拟 · 竖屏」里生效。
  DOM 预览与 PNG/录屏使用同一套合成；preview/profile 会写进 source stamp 和 `run.json`，
  不同口径的基线不能互相顶替。
- **热重载**：服务端 `fs.watch` 盯着被调工程目录，变化经 SSE 推给页面，宿主自动重跑装载。
  一次保存只重载一次（服务端去抖，实测连改 6 次 → 1 次重载）。场景跑测期间不打断。
- **场景跑测**：下拉框 = 工程自带场景（`<app>/e2e/scenarios/`，装载时动态 import）+ 内置通用场景。
  右侧「场景结果」页签**实时**展示进度（自动切过去）：整份步骤先列成待执行，跑到哪步
  高亮到哪步，完成的带耗时、失败的带原因、截图即拍即贴；失败后未执行的步骤标灰保留。
- **主舞台录屏**：工具栏「开始录制」覆盖自由操作；场景旁勾「同步录屏」会从第一步前录到收尾，
  自动下载并在「场景结果」里留下可回放/再次下载的成片。只录 canvas，不含控制台、鼠标或浏览器边框。
- **能力控制台**：手动触发关键注入——ASR（final / interim 转写、未识别、`no-speech`、中途 abort）、
  网络（断网 / 恢复 / 请求日志）、传感器（四选一注入故障，可选「先发 20 条读数再报错」）、
  相机来源（模拟图片 / 电脑摄像头）、蓝牙来源（模拟 GATT / 电脑蓝牙、断连、单帧通知、
  JSON 通知 trace 导入、运行统计与停止）、
  InkView 焦点（`focus()` / `blur()`，用来**故意**制造 blurred）、播报回看。
- 右侧 Inspector：启动 / 引擎日志 / 网络 / 能力调用 / 场景 / 工程 / 证据。网络详情保留脱敏后的
  request/response headers、body、preview、状态和截断标记；证据页可导出统一 `run.json`。
- 启动前预检：缺 `app.json` / `app.js`、`app.json` 里注册了但盘上没有的页面，都在跑之前说人话。

自动化入口 `window.__inklab`（DevTools 或 CDP 都能用）：

```js
__inklab.view                      // 主舞台的 InkView 实例
__inklab.caps.speech.calls         // 引擎到底调了哪些能力——判「应用有没有真做那件事」看这个
__inklab.bluetooth.calls           // BLE 扫描 / 连接 / 订阅 / 读写的调用账
__inklab.press('Enter')            // 走宿主出口的按键：校验 + 摇帧 + 镜像到副画布
__inklab.wake('inklab')            // 语音唤醒
await __inklab.runScenario('onboarding-goal')  // 跑场景，返回结构化结果
await __inklab.runScenario('onboarding-goal', { record: true }) // 跑场景并下载主舞台录屏
__inklab.snapshot('name')          // 截一张（含 dataUrl；场景的 shot 步骤用的同一条）
__inklab.snapshotMatrix('name')    // 所有选中 runtime，按当前预览口径分别截图
__inklab.setPreviewMode('optical') // 切到 480×640 真机模拟竖帧（兼容 id 仍叫 optical）
__inklab.setLighting('night-low-light')
__inklab.exportRun()               // source/AIX + locks + fixtures + timeline + net + artifacts
__inklab.conformanceReport()       // 当前 conformance fixture 的结构化 supported/partial/... 结果
__inklab.startRecording({ name: 'free-demo' }) // 手动开始（主舞台、30fps）
await __inklab.stopRecording()     // 封口、预览并下载
```

> ⚠️ 绕过宿主出口直接调 `view.dispatchInput(...)`，在**页面不可见**（后台标签页 / 窗口被完全遮挡）
> 时**只有第一次生效**——引擎的帧调度是 rAF，页面一 hidden 就停摆。用 `__inklab.press` 没这问题。
> 机理与自证配方见 [runtime-notes.md](runtime-notes.md)《焦点与帧》。

### 主舞台录屏：给演示/PPT，不替代截图基线

- 采集源是当前预览口径的合成 canvas `captureStream(30)`：效果预览录黑底横幅，
  真机模拟录“环境底图 + 居中 AIUI 画布”的 3:4 竖帧。它不是屏幕录制，所以无需系统录屏权限。
  `480×352 @2` 在效果预览输出 `960×704`，在真机模拟输出 `960×1280`；AIUI 内容位于 `y=288..992`。
- 优先选择 `H.264 MP4`，页面 pill 显示 `MP4 · PPT` 时可直接插入 PowerPoint。浏览器没有 MP4
  MediaRecorder 时才降级为 WebM，页面会显示「需转码」，不会把它误报成 PPT-ready。
- 当前只录**无声画面**。InkLab 的 ASR/TTS 是能力模拟，不等于一条可混入视频的真实音轨；讲解音频可在
  PPT/剪辑阶段另配。浏览器控制台、讲解麦克风可用系统录屏；真实眼镜画面用上面的 USB 真机投屏录制入口。
- 场景里的 `shot` 仍照常执行，截图基线、像素 diff 与 stale/sourceStamp 纪律完全不变。录屏是演示产物，
  不是新的视觉回归判定依据；命令行 `npm run e2e` 也不会默认批量生成视频。
- 工程重载会在销毁主舞台前自动结束并下载当前录屏，避免产出一条后半段空白的伪成片。

## 宿主能力层

契约见 `lib/caps/contract.mjs`，全部从引擎 glue 反解（官方无文档），并经四个模块的实现反向校正过。

| 模块 | 能力 | 关键控制面 |
| --- | --- | --- |
| `caps/sensors.mjs` | 加速度计 / 陀螺仪 / 磁力计 / 姿态 | **IMU trace 回放**（按样本自己的时间戳走）、静置基线、故障注入；控制台可直接装合成深蹲或导入 JSON |
| `caps/battery.mjs` | BatteryManager | 完整初态、可变电量/充电/预计时长、按 targetId 回灌 `statuschange` |
| `caps/speech.mjs` | ASR + TTS | **脚本注入转写**（interim/final）、**本轮收尾**（`endTurn`）、中途 abort、nomatch、`spokenTexts` 断言应用说了什么 |
| `caps/media.mjs` | 相机 / 媒体 | 默认/E2E **按队列喂照片**；手动可切电脑摄像头；拍照延迟、denied/notfound/timeout 三种故障 |
| `caps/bluetooth.mjs` | Web Bluetooth / BLE | 设备发现、GATT 连接、Service/Characteristic/Descriptor、读写、通知、断连、一次性故障与高频 trace；JSON 导入、活动账本和统一停止；手动可切电脑蓝牙 |
| `caps/llm.mjs` | LanguageModel | live / record / **replay** 三模式、超时与畸形响应注入 |
| `caps/net.mjs` | 网络 | **外域出网默认挡下**（见下）、整体断网、按 URL 断/延迟/改状态码、脱敏 request/response 取证 |
| `caps/probe.mjs` | 回声探针 | 排查新能力时把引擎真实调用参数录下来 |
| `caps/index.mjs` | 组装 | 事件桥（把沉默失败变成响亮失败）+ 能力集组装 |

手动测眼镜 IMU 时，在「传感器 / IMU」卡片里先选传感器，再装内置的合成深蹲 trace，
或导入下面任一 JSON 形状；可选循环，点「回到静置」卸载。trace 在应用下一次调用
传感器 `start` 时生效，已经在跑的会话不会被中途换带。回放事件的 `timestamp` 由 trace
自己的相对时间轴派生；浏览器计时器即使迟到也不会把动作周期拉长。实际墙钟仍单独用于
首次回调延迟与断流健康判断。

```json
[{ "t": 0, "x": 0, "y": 9.81, "z": 0 }]
```

```json
{ "sensor": "accelerometer", "speed": 1, "samples": [{ "t": 0, "x": 0, "y": 9.81, "z": 0 }] }
```

内置深蹲只用于流程和算法调试，不作为真实传感器质量证据。外接设备（如腕表）的六轴数据不走这张卡，使用上方
「蓝牙来源」里的「导入通知 trace」回放固件协议包；脚本入口仍是
`playNotificationTrace(...)`。真实芯片、时序和断连行为继续由真机验收。

**能力实现刻意照抄真机的坏行为，不照理想契约写**——这是本层最重要的纪律。例如：

- ASR 会中途自行 abort；`say()` 的 final **不**结束 session（`continuous:true` 下收口是应用自己的活）。
  `continuous:false` 的应用要靠这一轮真的结束才落定转写，脚本用 `endTurn()` 显式收尾——
  给它一个单独的出口，是为了不让假体替应用做收口决定（真实应用的 e2e 踩过这条）
- TTS 的 `onend` 不可靠，所以默认**不**自动发 `synthesisEnd`
- 传感器故障是**粘的**，要显式 clear——真机的权限拒绝不会自愈
- 拍照默认有 1.5s 延迟——真机没有「瞬间返回」这回事
- BLE 通知必须先连接并 `startNotifications()`——没订阅就注入会响亮失败，不替应用补协议步骤

理想化的假数据会掩盖要测的问题。宿主比 Craft 更容易骗自己，这几条就是防线。

### 相机：E2E 模拟，手动交互可用电脑摄像头

- 默认 `camera=mock`：宿主注入 `caps/media.mjs`，场景通过 `caps.media.loadPhoto()` / `queuePhotos()`
  精确控制下一次 `takePhoto()` 返回哪张图；无权限框、可重复，适合 E2E 和截图基线。
  `loadPhoto('assets/example.png')` 默认从当前被测工程的 `/app/` 静态根读取；路径不存在会立即失败，
  不会把 404 响应伪装成照片。也可以直接传 `Uint8Array` 字节。
- 宿主页面把「相机来源」切到**电脑摄像头（手动）**（或打开 `?camera=computer`）后，InkLab
  会在这次明确的用户操作里申请浏览器相机权限，成功后立即停轨，不读取或保存照片；拒绝或直接以
  URL 打开时，可点「授权 / 重试」。InkLab 只把 `media.takePhoto` 换成电脑浏览器适配器，录音等
  其余媒体方法仍保持模拟。真正拍照时，只有应用在用户的按键/点击交互中调用
  `wx.media.createCameraContext().takePhoto()` 才会通过 `navigator.mediaDevices.getUserMedia()` 采一帧并
  立即停轨。返回值仍是 Craft/AIUI 使用的 `{data, mimeType}` 契约。
- `lib/node/e2e.mjs` 会强制把页面 URL 写成 `camera=mock`；即使传入的基础 URL 带
  `camera=computer` 也会覆盖，防止无头 Chrome / CI 意外点亮真实摄像头。
- 电脑摄像头验证的是浏览器宿主链路，不替代眼镜真机的镜头方向、权限、画质与时延验收。

### 蓝牙：E2E 模拟，手动交互可用电脑蓝牙

蓝牙与上面的宿主能力表有一处重要差异：`ink_web 0.17.0` 不把它交给
`setHostCapabilities()`，而是由独立的 Web Bluetooth bridge 直接读取 `navigator.bluetooth`。
InkLab 因此模拟的是浏览器对象树，不是一个虚构的 `hostCapabilities.bluetooth`。实测 AIUI 的
`scanDevices()` 在 Web 宿主里会落到 `requestDevice()`，随后走完整的
`device.gatt.connect()` → Service → Characteristic → `startNotifications()` 链路。

- 默认 `bluetooth=mock`，内置一个 `InkLab Heart Rate` 设备；过滤、授权后设备、连接/断连、
  Characteristic 读写、通知与调用账都可重复控制。控制台可直接切适配器不可用、断开连接、
  向已订阅的特征发十六进制通知，或导入一整条通知 trace。状态徽标显示运行状态、已发送帧数
  和循环次数；「停止 trace」同时管理控制台与场景脚本启动的所有活动回放。
- 业务协议可通过 `__inklab.bluetooth.replaceDevices([...])` 配设备树；场景里同一入口是
  `caps.bluetooth`。`failNext('gatt.connect', ...)` 可造下一次连接失败，
  `playNotificationTrace({ frames, intervalMs: 20, ... })` 可按 50Hz 回放 IMU/BLE 数据流；返回
  handle 的 `stats()` 给出状态、总帧、已发送帧、循环和错误，
  `activeNotificationTraces()` / `stopNotificationTraces()` 提供统一运行账本与清场。
- 切到**电脑蓝牙（手动）**（或 `?bluetooth=computer`）只会恢复浏览器原生
  `navigator.bluetooth`，不会在切换时预先申请权限。应用在你的真实按键/点击交互中发起扫描时，
  浏览器才显示设备选择框。若 QuickJS → Web bridge 跨越后丢失了 Chromium 的瞬时用户手势，
  控制台会进入“等待选择”，点一次“选择真实设备”会沿用应用给出的 service filters 打开 chooser，
  选中后原扫描继续。工程热重载会断开真实 GATT、保留本页授权，避免旧通知继续投递给已销毁实例。
  宿主适配器只包装 `requestDevice` 的授权时序，不实现自己的 `scanDevices`：真实
  `BluetoothDevice` 必须由 ink_web 代理进 WASM/QuickJS，普通 JS scan handle 会丢失设备回调。
  是否可用取决于当前浏览器、系统蓝牙和安全上下文。
- `lib/node/e2e.mjs` 会强制覆盖为 `bluetooth=mock`，并核对 `navigator.bluetooth` 的实际对象
  就是模拟器，避免 CI 意外触碰电脑蓝牙。

```js
// 应用连接并订阅后，注入一帧心率 88 BPM
__inklab.bluetooth.emitNotification({
  serviceUuid: 'heart_rate',
  characteristicUuid: 'heart_rate_measurement',
}, [0x00, 88]);

// 高频业务数据：frames 也可以写成 { t, value }，按样本时间戳回放
const trace = __inklab.bluetooth.playNotificationTrace({
  serviceUuid: '6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001',
  characteristicUuid: '6f1d0001-8f5b-4c7e-9a21-4a19f2b4c001',
  frames: [[1, 2, 3], [4, 5, 6]],
  intervalMs: 20,
});
trace.stats(); // running/completed/failed、emittedFrames、loops
trace.stop();
```

控制台导入的 JSON 可以直接是十六进制帧数组，也可以带设备、特征和时间轴。每帧要么全部
省略 `t` 并使用 `intervalMs`，要么全部携带非递减的相对毫秒 `t`；两种时间轴不能混用。

```json
{
  "deviceId": "inklab-wrist-1",
  "serviceUuid": "6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001",
  "characteristicUuid": "6f1d0001-8f5b-4c7e-9a21-4a19f2b4c001",
  "frames": [
    { "t": 0, "value": "01 00 00 00 00 00 00 00 00 00 e8 03 00 00 00 00 00 00 00 00" },
    { "t": 20, "value": "01 00 01 00 14 00 00 00 00 00 e8 03 00 00 00 00 00 00 00 00" }
  ]
}
```

模拟证据能证明应用的扫描、连接状态机、协议解析、断连恢复和通知消费；不能证明真实射频、
系统配对/权限、目标固件 GATT、吞吐、丢包、50Hz 持续稳定性。这些仍须目标硬件验收。

### 眼镜画面与光照：哪部分是真的，哪部分是模拟

InkLab/Studio 里的“眼镜界面”是**混合模拟**：应用源码真的由 `ink_web` 的 QuickJS + Skia/WASM
执行和绘制，页面解析、布局、焦点、宿主 API 调用因此有很高参考价值；但眼镜外壳、镜腿输入、
相机/电池/IMU 数据和周围环境由浏览器宿主模拟。「效果预览」保持 480×352 黑底；
切到「真机模拟 · 竖屏」后，三种光照会在 480×640 环境帧中把黑色像素视作透视区域，
按最大 RGB 通道估算覆盖度、反除黑底污染后覆盖到原创环境底图上。亮色主体保留，暗色边缘转成同色系半透明像素（不使用 screen）。
这种约定重新叠到黑底可还原原图明暗，不能恢复已经丢失的原始透明度；也不能证明真实光机亮度、透过率、色偏、视场或人眼适应。
因此矩阵可用于提前发现“亮背景下信息层级不够”等问题，最终可读性仍必须上真机收口。

### AIUI 0.17 conformance pack

`fixtures/cap-probe-app` 会把每项标成 `supported / partial / unsupported / contract-drift / not-observed`，
而不是拿“页面没崩”冒充能力成功。当前探针覆盖：

- BatteryManager 初态与 change 事件；
- OPFS 创建、写入 `close()` 提交、读回与删除；
- page-level World Awareness、AbsoluteOrientationSensor 和合成 nod 手势；
- `navigator.mediaDevices` / `MediaRecorder` / `ImageCapture`；
- `speechSynthesis.speak()` 与独立 `synthesize()` task；
- `table` / `timed-text` / `streamdown` 增量更新 / 空源 `video` 生命周期。

单版本证据用 `npm run e2e -- fixtures/cap-probe-app --scenario aiui-017-conformance
--runtime <id> --no-video`；版本差异用 `npm run matrix`。头部动作 trace 只证明运行时检测状态机
与宿主接线，不是对真实头动幅度/阈值的校准。

### 外域出网默认挡下（`caps/net.mjs` 的 `guardExternal`）

本地宿主跑的是**真源码**，所以应用里任何一条硬编码的线上域名都会真的打到别人的生产后端。
更麻烦的是它多半在**启动链路**里就发生了（有的应用在启动入口里就会 fire-and-forget
预取天气），那时候场景脚本一行都还没跑——**这道闸只能在能力层，场景层拦不住**；应用自己的
实例级节流也拦不住，因为 e2e 每个场景都重建 InkView，每次都是「第一次」。

所以：**跟宿主页面不同源的请求一律回 503 且不真的出去**，请求日志里记 `decision:'external-stub'`。
「本轮零真实外呼」因此是可断言的——`caps.net.requests` 里不该有 `decision:'pass'` 的外域条目。

- 优先级：断网 > 按 URL 的 block > 场景显式 `status()` 桩 > **外域闸** > 真出网。
  也就是说场景显式桩过的 URL（如分享场景的 `/api/share`）照常走它自己那一支，不受影响。
- 放行走显式清单：`caps.net.allowExternal('域名或子串')`。LLM `live`/`record` 的上游端点由宿主自动放行
  ——那次出网是有意的。
- 整道闸的开关：`?netguard=0`、控制台「网络」卡片的**挡外域**勾选框、或 `caps.net.guardExternal(false)`。
- **拿不到 origin 时（`node --test` 这类非浏览器环境）整道闸天然 no-op**：不知道自己是谁就没法判外人，
  反过来做（什么都算外域）会把所有非浏览器调用方的请求凭空变成 503。
- `caps.net.wouldStubExternal(url)` 回答「这条会不会被挡」——排查「我的请求怎么回了 503」用。

## 场景脚本

```js
const driver = createDriver({ view, screenshot });
const result = await driver.runScenario([
  { activate: true },                       // Enter + 真实等换页冷却
  { pressMany: ['ArrowDown', 5] },
  { shot: 'settings' },
  { expect: (ctx) => ctx.someCheck() || '焦点没落到设备连接' },
]);
```

时序配方来自实测（细节见 [runtime-notes.md](runtime-notes.md)）：**事件时间戳按虚拟时钟推进**跨过应用约 700ms 的
同向去重闸，**换页后真实等待 ≥1.3s** 跨过约 1.2s 的激活冷却——后者跨不过去，只能等。

应用专属的脚本放**工程自己的** `e2e/scenarios/*.mjs`（宿主页面下拉框与 e2e runner 自动加载，
不用注册）；只有与具体应用无关的通用场景才进内置 `scenarios/` 并在 `scenarios/index.mjs` 挂上：

```js
export default {
  id: 'onboarding-goal', title: '走完引导到目标步', summary: '……',
  build({ caps }) { return [ /* 步骤 */ ]; },   // caps = 主舞台能力集，断言就靠它
};
```

断言口径挑「应用真调了哪些宿主能力」而不是日志：引导是单页多步，步进**不产生**页面模块日志，
拿日志判断有没有前进会得出错误结论（[runtime-notes.md](runtime-notes.md) 有记）。场景模块本身零浏览器 API，
`__tests__/inklab-host.test.mjs` 用一个假被测应用把键序与失败点都钉住了。

## e2e 跑测

分工和 Playwright 一个道理：**InkLab 是测试框架（仓库级复用），测试内容是工程资产**：

```
<app>/e2e/
  scenarios/*.mjs      # 场景脚本（与内置场景同一约定；宿主下拉框的「工程场景」）
  cassettes/*.json     # LLM 录像（replay 喂；record 录；不含请求头，密钥不入库）
  baselines/           # 截图基线：<场景id>/<屏名>.png + 同名 .json（capturedAt/sourceStamp）
  report/              # 本次跑测产物（不入库；含逐场景舞台录屏 <场景id>/<场景id>.mp4|webm）
```

```bash
npm run e2e -- <app>                                 # 跑工程全部场景（无头 Chrome）
npm run e2e -- <app> --accept                        # 把本次截图收为基线
npm run e2e -- <app> --scenario onboarding-goal      # 点名跑（内置场景也可点名）
npm run e2e -- <app> --no-video                      # 关掉逐场景舞台录屏（默认开）
npm run e2e -- <app> --headed                        # 开窗跑，排障看画面
npm run e2e -- <app> --runtime <lane>                # 单条运行时（清单里的 lane id），报告锁定版本/哈希
npm run e2e -- <app> --preview optical \
  --lighting indoor-bright                           # 显式跑光照可读性假体
npm run e2e -- dist/pkg.aix --scenario smoke \
  --runtime <lane> --report-dir /tmp/pkg-smoke       # 发布包直接跑；包本身只读

# 同一场景比较多个版本；加 --all-lighting 即跑版本 × 三种光照
npm run matrix -- fixtures/cap-probe-app \
  --scenario aiui-017-conformance \
  --runtime <lane>,<lane> --all-lighting
```

### 场景级 LLM 声明：on 与 off 一条命令一起跑

LLM 模式**不是整轮一个**。场景可以自己声明要什么模式，runner 在跑它之前把宿主切好：

```js
// <app>/e2e/scenarios/21-llm-fc-intent.mjs
export default {
  id: 'llm-fc-intent',
  llm: { mode: 'replay', cassette: 'e2e/cassettes/llm-fc-intent.json', model: 'inklab-cassette' },
  build(ctx) { /* … */ },
};
```

| 字段 | 含义 |
| --- | --- |
| `mode` | `off` / `live` / `record` / `replay`。不声明 → 吃整轮缺省 |
| `cassette` | `replay` 用哪盘录像（工程相对路径） |
| `model` | **回放时钉死录像键里的 model**。录像键含 `model` 字段，不钉就只在录它那台机器上命中 |

为什么这样做：LLM 模式是**装载期**决定的（能力层在 bootStage 里一次性建好），一页只能有一个
模式。而「在线路径必须进默认闸」要求同一条命令里 on 与 off 都跑到。runner 会把场景声明写进
URL，并在**每条场景前做一次完整 `Page.navigate`**。这里故意不用只重建 InkView 的 `reload()`：
当前 Ink Web glue 会跨实例缓存 Web Bluetooth 包装器，完整的新 document 才能隔离前一场的
设备、特征与延迟 teardown。首场若初始 URL 已完全匹配，才复用那一个 document。

优先级：**命令行 `--llm` 恒赢** > 场景声明 > 整轮缺省（有 `e2e/cassettes/default.json` 就 replay，
否则 off）。所以 `--llm live` 能一把切成真模型抽检、`--llm record` 能一把重录，不必逐个改场景。

**录一遍就能提交**：`--llm record` 落盘前会自动把键钉到场景声明的 `model` 上（`pinCassetteModel`），
并落回场景自己声明的那盘录像。闭环是：

```bash
# ① 录（打真上游，用本机 llm.local.json 里的真模型）
npm run e2e -- <app> --scenario llm-fc-intent --llm record
# ② 直接回放验证（键已钉好，不用挂 INKLAB_LLM_MODEL）
npm run e2e -- <app> --scenario llm-fc-intent
# ③ 提交录像带 → 以后默认全量跑就带着它
```

跑完的账在 `e2e/report/last-run.json`：`llm.online` / `llm.offline` 是两张场景名单，
`llm.outcomes` 是本轮所有往返的结局计数（`replay-hit` / `replay-miss` / `fault:*` / `live:2xx`），
每个场景自己那份在 `scenarios[].llm`。

录像条目可选 `aliases: ["另一条16位键"]`，只用于同一确定性场景已经实际观察并审过的等价
请求桶，例如相同完整 IMU trace 因宿主节流产生的 30/35 秒墙钟组时长。alias 必须由对应
canonical 请求算出并由工程测试锁定；InkLab 不做相似 prompt 模糊匹配，未显式登记的键仍然
`replay-miss`。

**`--llm live` 冒烟（不进默认闸）**：`npm run e2e -- <app> --llm live` 把整轮切成真模型。
内容不确定，所以场景里的逐字断言必须自己让路——约定是场景读 `caps.llm.mode`（工程侧一般封成
`llmMarker(caps).isReplay()`），`replay` 才比内容，`live` 只比能力面（有没有真的发生模型往返、
有没有退回降级文案、有没有意外导航）。live 会**真的出网**，别进 CI。

流程：内嵌 `createInkLabServer`（随机端口）→ 页面 URL 强制 `camera=mock`、`bluetooth=mock` → 拉起系统 Chrome（`--headless=new`，CDP 用
Node ≥22 自带 WebSocket，零新依赖）→ 每条场景用独立 document 经 `window.__inklab` 执行 → 步骤结论 + 截图基线
比对（像素 diff 在页面里做，`lib/shots.mjs`）→ 报告落 `e2e/report/last-run.json`，
失败退出码非零。判据口径：步骤失败恒 fail；截图基线只在工程已有基线时强制
（`--accept` 收编本轮）；源码/引擎/采集口径变了而基线没重采 → `stale`，fail。
DPR 用 `--force-device-scale-factor=2` 钉死——截图是证据，不随跑测机器的屏漂。

## LLM 怎么接

**宿主不发 LLM 请求，引擎自己发**（标准 OpenAI chat-completions；宿主只回答
endpoint / headers / defaultModel，见 `lib/caps/llm.mjs` 头注）。InkLab 的接线：

- 配置两个来源，环境变量优先：`INKLAB_LLM_ENDPOINT`（完整 chat-completions URL，引擎不拼
  路径）、`INKLAB_LLM_API_KEY`（或 `INKLAB_LLM_API_KEY_FILE` 指向密钥文件）、`INKLAB_LLM_MODEL`；
  或常驻的本地档 `llm.local.json`（**不入库**，写 endpoint/model/apiKeyFile 三样，
  密钥本体留在仓库外的文件里，serve 启动时现读）。serve 经 `/api/manifest` 透传给页面。
- 本地档还可配 `requestDefaults`（如思考型模型必配的 `{"enable_thinking": false}`——
  不关的话正文首 token 十几秒，赶不上应用自己的 8s 生成闸）：配了它页面会改走 serve 的
  `/llm/chat/completions` 转发路由，只**补引擎没写的字段**，显式字段绝不覆盖。
  路由按 localhost 下发——引擎不向与页面同源的 endpoint 发请求（[runtime-notes.md](runtime-notes.md) 有记）。
- 模式走 URL 参数 `?llm=off|live|record|replay`（e2e runner 用 `--llm` 传；e2e 里还可以**按场景**
  声明，见上面「场景级 LLM 声明」）。自动 runner 用 URL + 完整 `Page.navigate` 隔离场景；
  `__inklab.setLlm()` + `reload()` 只保留给手动调试。缺省：
  配了 endpoint 就 live，否则 off——off 不装配置，引擎自判模型不可用，应用走自己的
  离线路径（诚实答复；假装成功测出来的降级全是错的）。
- `record` 跑一遍把真实响应录进 `e2e/cassettes/`（runner `--llm record` 自动落盘、自动按场景
  声明钉死录像键里的 model）；`replay` 吃录像回放：不出网、不用密钥、答案确定——
  在线路径进默认闸靠的就是它。
- **录像键含 `model` 字段**（换个模型换的是整个应答，见 `lib/caps/llm.mjs` 的归一化注释）。
  所以提交进仓库的录像带必须钉一个**固定的假模型名**（约定 `inklab-cassette`）：
  replay 一个字节都不出网，model 只进哈希、不进任何真实请求。record 落盘时 runner 自动钉，
  手写录像带则自己保证键是在那个名字下算的。
- **故障注入**：`caps.llm.failNext({kind:'timeout'|'http'|'malformed', …})` 一次性生效，
  排在录像查找**之前**。这是测「模型在线但这一发挂了」的唯一入口——它与 `llm=off`
  是两条不同的代码路径（off 是「一开始就知道没模型」，应用连请求都不发）。

## 截图基线

`lib/shots.mjs` 做像素 diff（支持容差、忽略区、单绿屏只比绿通道），`lib/stamp.mjs` 算源码指纹。
**基线带指纹**：源码或引擎变了而图没重采，`compare` 会标 `stale` ——
把「旧图冒充新证据」这件事在工具层暴露，而不是靠人记得。

默认每张图都全像素严格比较。只有倒计时、实时波形等明确动态区域可在**该截图**上声明口径：

```js
{
  shot: {
    name: 'set-live',
    diffOptions: {
      tolerance: 1,
      ignoreRegions: [{ x: 20, y: 490, w: 920, h: 145 }],
    },
  },
  label: '实时计次截图',
}
```

场景顶层 `shotOptions` 仍用于全场共同口径；只有一张图动态时必须用上面的单图写法，避免同场其他页面也被遮掉。忽略区不进入 diff 分母，最终报告会留下 `ignoredPixels`、`tolerance` 和实际比较像素数。

指纹的组成：bundle 内容哈希 + 引擎构建 + wasm 哈希 + 画布尺寸 + 场景 id + 能力夹具 id。
刻意**不含** git sha、时间、分支名（细节与理由见 `lib/stamp.mjs` 头注）。

## 引擎从哪来，以及为什么不入库

`ink_web` 是 Rokid 的私有产物：**没有开源许可声明，也没有发布到 npm**（npm 上的 `ink-web`
是无关的 CLI 库），只作为 Rokid 站点（`js.rokid.com`、`aiui.rokid.com`、`static.rokidcdn.com`）上的资源存在。

我们做的事是：把浏览器打开 Craft / AIUI Studio 时**本来就会下载的同一份文件**放到本地，用来调试**自己的应用**。因此：

- **二进制绝不入库、绝不随工具分发。** 它们只存在于本机的 `.engine/`（已被 git 忽略），不在仓库里，也不在 npm 包里。
- 每个人取到哪些引擎、用哪一条都不一样，所以记录它们的 `runtimes.lock.json`（每条 lane 的来源、版本和 glue/wasm 的 SHA-256）
  也是本机文件，不入库。`npm run engine` 生成并维护它；取回的字节必须与清单逐字节一致，否则报错、不落盘。
- 要把 InkLab 分享出去，也只能分享代码，不能附带 wasm。

```bash
npm run engine                    # 先查站点、追加新构建（没有清单就从这一步生成），再拉取清单里的全部 lane；本地文件与清单一致的直接跳过
npm run engine -- <lane>          # 同样先查站点，只拉指定的 lane（可写多个）
npm run engine -- --check         # 只校验盘上文件与清单是否一致（不发网络请求，也不查站点）
npm run engine -- --discover      # 只读：看会追加什么，不写任何文件
```

下载某个文件 30 秒收不到数据会中止并重试（最多三次），并显示速度与剩余时间。

## 引擎版本会漂

Rokid 的站点同时挂着不止一个构建（实测过 `0.16.1` 正式版与 `0.17.0-daily` 并存），内容也会随站点发版而换。
所以每条 lane 都是**不可变的**：id、来源、版本和哈希一起锁定，覆盖升级会让旧截图和旧行为失去复现条件。
InkLab 不会悄悄换引擎：取回的字节与清单不一致就停下，并指出是 glue 还是 wasm 不符。

`runtimes.lock.json` 就是一个 lane 数组，顺序即优先级，**第一条是默认 lane**（想换默认，把它挪到最前面）。
站点上新出现的构建，`npm run engine` 每次运行都会发现，并追加成新 lane：

1. 查站点。默认查官方的两个平台，Craft（`https://js.rokid.com/craft`）和 AIUI Studio（`https://aiui.rokid.com/`），
   各自顺着找出站点上挂着的全部引擎构建，用 glue 的 SHA-256 与清单里已有的 lane 比对。
   `--site=[<名字>=]<url>` 可以换站点，写几个查几个（给了就不再查默认的两个）；名字是新 lane `id` 的前缀，不写就是 `craft`。
   每次运行要取两个站点的首页、主 bundle 和几个候选 chunk 来对比（都是 JS，不含体积大的 wasm），没有新构建时不会下载 wasm。
2. 没被收录的构建：取回 wasm 算哈希、读版本，在数组**末尾追加**一条，并把已经取回的文件放进 `.engine/`（不会再下一遍）。
   `id` 是平台名加版本，如 `craft-0.19.0-daily.202609230326`、`studio-0.19.0-daily.202610080438`；同版本不同字节时接上 glue 哈希的前 8 位。
   已收录与否按 glue 的哈希认，所以两个平台发布的 glue 只要字节不同，同一个引擎版本在两边都发布的话也会各记一条。
   全新 clone 没有清单，是从空清单起步的：这时正式版排在 daily 前面，所以第一条（默认）是正式版。
3. 然后照常按清单装配 `.engine/`。

只追加，不改已有条目；追加前先校验整份清单仍然合法，写入也是先写临时文件再改名。
每个新 daily 都会多一条 lane，`npm run engine` 和 `matrix` 默认处理全部 lane（`matrix` 可以用 `--runtime` 点名）。
站点上还挂着的构建，删掉它的条目后下次运行会被重新追加。

想用自己的名字，改新条目的 `id` / `label` 就行，`cacheDir` 保持原样、缓存不用动：已收录与否按 glue 的哈希认，
不按名字；基线指纹也只取决于引擎构建，改名不会让基线失效。

有一点要清楚：**新构建是“首次所见即信任”**。它的哈希是取回那一刻记下的，此后每次下载都必须与之一致；
但如果站点第一次给的就是被换过的东西，InkLab 看不出来。清单里原有的 lane 不受影响。

两个站点各查各的：某个站点查不了（断网、站点结构变了）只警告，另一个照常查，然后照常按现有的清单装配；
没有清单又一个站点都查不了时没有东西可装配，命令报错并提示联网重试，不会创建任何文件。想先看看会追加什么、又不写任何文件，用 `--discover`：
退出码全部已收录为 `0`，发现未收录的构建为 `2`，没能查完（某个候选 chunk 取不到，或某个站点没查成）为 `1`。

清单是 JSON，**手写时漏一个逗号**会得到“不是合法的 JSON”并指出文件，不会被当成“没有运行时”；
还是旧格式的 `{ "runtimes": [...] }` 对象也会被明确拒绝，改成直接的数组即可。

自动检查认的是 Craft 和 AIUI Studio 两个站点的页面结构，而且只收有独立 glue 文件的构建：引擎内联在主 bundle 里的发布方式没有 glue 文件可记，
InkLab 看不到它，也没法把它记成 lane。自动认不出、但有独立 glue 和 wasm 的**其他来源**（别的站点、站点改版之后）就手工来：

1. 在浏览器里打开 Craft 或 AIUI Studio，用开发者工具的 Network 面板找到 `ink_web_bg-*.wasm`，记下完整 URL。
   glue 是引用了这个 wasm 的 JS 文件（里面同时有 `ink_web_bg-….wasm`、`createInkView` 和 `initInk`，文件名通常是 `index-*.js`），同样记下 URL。
2. 下载这两个文件，用 `shasum -a 256` 算出哈希。
3. 版本从 wasm 里读（锚点法，见 `lib/node/engine-version.mjs`），输出的 `version` / `build` 分别对应 lock 里的 `engineVersion` / `engineBuild`（没有 daily 构建戳时 `build` 为 `null`）：

   ```bash
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { extractEngineVersion } from './lib/node/engine-version.mjs'; console.log(extractEngineVersion(readFileSync(process.argv[1])))" engine.wasm
   ```

4. 在 `runtimes.lock.json` 这个数组里加一条（加在末尾；想让它当默认 lane 就放最前面），字段有 `id`、`label`、`channel`、`cacheDir`、`source`、`fetchedAt`、
   `engineVersion`、`engineBuild`、`glueUrl`、`glueSha256`、`wasmUrl`、`wasmSha256`。
   必填的是 `id`、`engineVersion`（或 `engineBuild`）、`glueSha256`、`wasmSha256`；要能下载还得有 `glueUrl`、`wasmUrl`；其余可省。
   源站已经下线、只认本机已有文件的 lane 加 `cacheOnly: true`：它不会被下载，本机缺文件时只跳过，`matrix` 默认也不跑它。
   然后跑 `npm run engine -- <新 lane id>`，它会按这份清单下载并核对哈希与版本。

## 边界

InkLab 用的是和 Craft 同一个引擎，所以**它替代的是证据阶梯里 Craft 那一格，不是真机那一格**。
硬件、功耗、真实传感器、真实 ASR/TTS 完播、真实蓝牙射频/GATT/固件通知都不在里面；
InkLab 的 BLE 模拟只覆盖应用状态机与协议处理。

已知引擎 Web 全局**不提供** `BarcodeDetector`（实测 `typeof` 为 `undefined`），但当前引擎仍向
静态 `barcode` 宿主模块提供构造器。所以模拟环境里能验证的是“取帧、检码但无有效 payload”这条分支；
二维码成功识别与能力完全缺失分支仍需 Craft / 真机或后续专用宿主夹具取证。
