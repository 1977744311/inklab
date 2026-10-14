# InkLab 使用指南

安装、首次运行和引擎下载见 [README](../README.zh-CN.md)。本文介绍工作台的各项功能、硬件模拟器怎么控制、以及怎么编写和运行自动化测试场景。
USB 连接真实眼镜见 [device.md](device.md)；实测总结的引擎底层机制与时序规律见 [runtime-notes.md](runtime-notes.md)（写自动化脚本前必读）。

章节：[工作原理](#工作原理) · [仓库结构](#仓库结构) · [工作台界面与自动化接口](#工作台界面与自动化接口) · [硬件与系统能力模拟](#硬件与系统能力模拟) · [编写测试场景](#编写测试场景) · [运行 e2e 测试](#运行-e2e-测试) · [LLM 怎么接](#llm-怎么接) · [截图基线](#截图基线) · [引擎版本会漂](#引擎版本会漂) · [测试边界](#测试边界)

在本地直接运行 AIUI 源码目录或 `.aix` 发布包：**代码不会上传，启动后无需依赖外网**。

```bash
npm run engine                               # 首次运行：去官方站点获取引擎、生成 runtimes.lock.json 并下载到本地
npm start -- <app>                           # 直接运行应用源码目录
npm start -- <app>.aix                       # 直接运行打包好的 .aix 发布包
npm start -- <app> --compare-with <app>.aix  # 运行源码，并对照 .aix 包的文件差异
# 打开 http://127.0.0.1:8788/ ，修改源码后页面会自动热重载（服务端 fs.watch → SSE 推送）
```

## 工作原理

官方 Craft 网页并不是服务端渲染，而是把眼镜上的 Ink 运行容器（QuickJS 跑 JS 逻辑 + Skia 绘制界面）编译成 WebAssembly（`ink_web`）放进浏览器运行。只要给这个 WASM 引擎提供一块 `<canvas>` 画布和一组硬件能力回调函数，它就能自己在浏览器里解析 `.ink` / `.js` / `app.json`、计算排版并处理按键事件。

InkLab 加载的是同一个 `ink_web` 引擎，但**把底层的硬件与系统能力替换成了可控的模拟器**——Craft 只能给人手动点着看，而 InkLab 可以用脚本注入语音、传感器、蓝牙、网络故障，从而实现自动化测试。

```
应用源码目录 ──打包快照──▶ ink_web (WASM) ──渲染──▶ <canvas>
 或 .aix 包                     ▲
              硬件与系统能力 (语音/相机/LLM/传感器/网络) ── InkLab 模拟器提供
              navigator.bluetooth (BLE 模拟 / 电脑蓝牙)  ── 独立浏览器桥接
```

传入源码目录时，InkLab 会按 `.aixignore` 规则生成内存快照；传入 `.aix` 包时则直接读取包内文件，并在「工程」页展示 `VERSION`、MD5、SHA-256、体积与完整 manifest。加上 `--compare-with` 参数时，「工程」页会按 `+ / - / ~ / =` 列出两份代码的文件差异。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `bin/` | 命令行入口：`inklab`、`inklab-e2e`、`inklab-matrix`、`inklab-engine`、`inklab-device` |
| `host/` | 浏览器端工作台页面：入口为 `host/inklab.js`，子模块位于 `host/inklab/*.js`；`host/device*` 为 USB 真机测试页面 |
| `lib/` | 浏览器与 Node 共用的纯逻辑模块，**严禁依赖 Node 内置模块**（由 `__tests__/boundaries.test.mjs` 自动检查）：含 `caps/`（硬件能力模拟器）、`bundle.mjs`（源码快照与预检）、`aix.mjs`（`.aix` 解析）、`runtime-lock.mjs`（引擎清单校验）、`driver.mjs`（场景驱动与按键时序）、`recording.mjs`（画布录屏）、`shots.mjs`（像素比对）、`stamp.mjs`（源码与引擎指纹） |
| `lib/node/` | 仅在 Node 端运行：`serve.mjs`（本地 Web 服务）、`e2e*.mjs`（无头 Chrome 测试执行器）、`matrix.mjs`（多引擎版本 × 环境光矩阵对比）、`fetch-engine.mjs` 等（引擎发现、下载与锁文件读写）、`project-source.mjs`（工程快照与文件对比）、`device-*.mjs`（USB 真机服务与执行器） |
| `runtimes.lock.json` | **不入库**（本机状态）。记录本机发现的引擎版本列表、来源 URL 与 SHA-256 哈希；列表第一项为默认版本，由 `npm run engine` 自动生成和维护 |
| `.engine/` | **不入库**。引擎二进制缓存目录（可通过 `INKLAB_ENGINE_DIR` 修改位置），按 `.engine/runtimes/<lane id>/` 存放 |
| `scenarios/` | **内置通用**测试场景（`smoke` 冒烟测试）。应用专属的测试场景放在应用自己的 `<app>/e2e/scenarios/` 目录下 |
| `fixtures/cap-probe-app/` | 内置的引擎能力探针应用（用于测试引擎 API 支持度，非业务代码） |
| `docs/runtime-notes.md` | **实测总结的引擎底层机制与时序规律，写自动化脚本前必读** |

## 工作台界面与自动化接口

- **界面布局**：包含主预览舞台、引擎版本/场景选择栏、硬件能力控制面板与右侧 Inspector。能力控制面板按「交互 / 设备 / 传感 / 全部」分页；支持浅色/暗色主题切换（仅改变工具外壳颜色，不影响应用画布像素和截图基线）。
- **多引擎并排运行（运行时矩阵）**：可同时勾选 `runtimes.lock.json` 中的多个引擎版本并排启动。每个版本拥有独立的 WASM 实例、画布和能力模拟器；键盘按键、语音唤醒和场景脚本会同步镜像到所有画布。
- **键盘操作**：画布逻辑尺寸为 `480×352`，直接用电脑键盘控制（`↑`/`↓` 切换焦点、`Enter` 确认、`Backspace` 返回）。当鼠标焦点在控制台输入框内时，按键不会传给应用，避免打字时误触。
- **两种预览画面模式**：
  - **效果预览 · 黑底（默认）**：`480×352` 纯黑底画布。
  - **真机模拟 · 竖屏**：对齐 AIUI Studio 的 `480×640` 竖屏尺寸，将 `480×352` 画布居中（上下各留 144px），把黑色背景转为透明后叠加在环境背景图上，可选「绝对黑暗 / 室内明亮 / 夜晚弱光」三种环境光。预览模式与环境光会记入截图指纹，不同模式下的截图基线互不混用。
- **热重载**：服务端监听源码目录变更并通过 SSE 通知页面自动重载（含防抖合并）；正在跑自动化场景时不会打断。
- **场景运行与主舞台录屏**：下拉框会自动列出应用自带场景（`<app>/e2e/scenarios/`）和内置 `smoke` 场景，右侧实时展示每一步的执行耗时、失败原因和截图。点击「开始录制」或勾选「同步录屏」可将主舞台画面直接导出为无声 MP4 视频（可直接放进 PPT；若浏览器不支持 MP4 则降级为 WebM 并提示需转码），不录制鼠标和浏览器边框，也无需系统录屏权限。
- **右侧 Inspector 与启动预检**：分标签页查看启动状态、引擎日志、网络请求（含脱敏后的请求/响应头与正文）、能力调用记录、工程文件与 `run.json` 导出。若应用缺少 `app.json` / `app.js` 或注册了不存在的页面，启动前会直接报错提示。

工作台在页面全局暴露了 `window.__inklab` 自动化接口（可在浏览器 DevTools 控制台或通过 CDP 调用）：

```js
__inklab.view                      // 主舞台的 InkView 实例
__inklab.caps.speech.calls         // 语音能力的调用记录（用于检查应用是否真正发起了识别或播报）
__inklab.bluetooth.calls           // 蓝牙扫描、连接、订阅、读写的调用记录
__inklab.press('Enter')            // 发送按键：含参数校验 + 手动触发渲染帧 + 同步到并排画布
__inklab.wake('inklab')            // 触发语音唤醒
await __inklab.runScenario('onboarding-goal')  // 运行指定场景，返回结构化结果
await __inklab.runScenario('onboarding-goal', { record: true }) // 运行场景并自动下载录屏
__inklab.snapshot('name')          // 截取当前主舞台画面（返回含 dataUrl 的对象）
__inklab.snapshotMatrix('name')    // 为当前勾选的所有引擎版本分别截图
__inklab.setPreviewMode('optical') // 切换到 480×640 真机模拟竖屏模式
__inklab.setLighting('night-low-light') // 切换环境光背景
__inklab.exportRun()               // 导出完整测试证据（源码哈希、引擎锁、时间线、网络日志、截图）
__inklab.conformanceReport()       // 导出探针应用（cap-probe-app）的能力支持度报告
__inklab.startRecording({ name: 'free-demo' }) // 手动开始主舞台录屏（30fps）
await __inklab.stopRecording()     // 结束录屏并下载视频文件
```

> ⚠️ **不要绕过 `__inklab.press()` 直接调用 `view.dispatchInput(...)`**：当浏览器标签页处于后台或窗口被遮挡时，浏览器的 `requestAnimationFrame` 会暂停，直接调用 `dispatchInput` 只有第一次按键会生效。`__inklab.press()` 会在每次按键后主动调用 `view.render()` 推进画面（原理详见 [runtime-notes.md](runtime-notes.md)《焦点与帧》）。

## 硬件与系统能力模拟

接口定义见 `lib/caps/contract.mjs`（从引擎胶水代码逆向整理并实测验证）。

| 模块 | 模拟能力 | 主要控制功能 |
| --- | --- | --- |
| `caps/sensors.mjs` | 加速度计 / 陀螺仪 / 磁力计 / 姿态 | **传感器轨迹（IMU trace）回放**、静置数据、故障注入；支持一键加载内置深蹲轨迹或导入 JSON |
| `caps/battery.mjs` | 电池（BatteryManager） | 修改电量、充电状态、剩余时间，并向应用推送 `statuschange` 事件 |
| `caps/speech.mjs` | 语音识别（ASR）+ 语音合成（TTS） | **注入识别文本**（实时中间结果 `interim` / 最终结果 `final`）、**结束单轮识别**（`endTurn`）、模拟中途异常中断（`abort`）、无匹配（`nomatch`），以及通过 `spokenTexts` 检查应用的播报内容 |
| `caps/media.mjs` | 相机与媒体 | 默认按队列返回预设图片；手动调试可切换为电脑真实摄像头；支持注入拍照延迟及权限拒绝/设备不存在/超时三种故障 |
| `caps/bluetooth.mjs` | 蓝牙（Web Bluetooth / BLE） | 模拟设备扫描、GATT 连接、Service/Characteristic 读写、特征值通知推送、断连与高频数据流回放；手动调试可切换为电脑真实蓝牙 |
| `caps/llm.mjs` | 大模型（LanguageModel） | 在线（`live`）/ 录制（`record`）/ **离线回放（`replay`）** 三种模式，支持注入超时与格式错误响应 |
| `caps/net.mjs` | 网络请求 | **默认拦截外部域名请求**（见下）、模拟断网、按 URL 拦截/加延迟/改状态码、记录脱敏后的请求与响应日志 |
| `caps/probe.mjs` | 调用探针 | 排查未知能力时，原样记录引擎传入的所有调用参数 |
| `caps/index.mjs` | 能力组装与事件桥 | 将模拟器组装注入引擎，并在事件派发参数不合法时立即抛出明确错误 |

**模拟器设计原则：刻意复现真机的异常行为，而不是只模拟理想状态**。真机上常见的坑如果被模拟器掩盖，测试就会失去意义：

- **语音识别（ASR）**：支持模拟中途自行 `abort`。调用 `say()` 注入最终文本后**不会**自动关闭识别会话（在 `continuous: true` 持续识别模式下，何时关闭会话由应用自己决定）；对于 `continuous: false` 的单轮识别应用，脚本需显式调用 `endTurn()` 触发收尾。
- **语音合成（TTS）**：真机上 TTS 的播放结束回调（`onend`）并不稳定，因此模拟器默认**不**自动派发 `synthesisEnd`。
- **传感器故障不会自愈**：注入传感器权限拒绝或读取故障后，故障状态会一直保持，直到显式调用 `clear`（真机上权限被拒后重试同样会继续失败）。
- **拍照延迟**：模拟拍照默认带有 1.5 秒延迟，还原真机快门与图像处理耗时。
- **蓝牙通知强校验**：应用必须先完成 GATT 连接并调用 `startNotifications()` 订阅特征，之后注入通知才会生效；未订阅直接注入会立即报错，不会替应用掩盖遗漏的协议步骤。

### 传感器（IMU）轨迹回放

在工作台「传感器 / IMU」面板选择传感器后，可加载内置的合成深蹲轨迹，或导入以下任一格式的 JSON（将在应用下次调用传感器 `start` 时生效，采样时间戳严格按轨迹内的相对毫秒数 `t` 递增，不受浏览器定时器延迟影响）：

```json
[{ "t": 0, "x": 0, "y": 9.81, "z": 0 }]
```

```json
{ "sensor": "accelerometer", "speed": 1, "samples": [{ "t": 0, "x": 0, "y": 9.81, "z": 0 }] }
```

> 注：这张卡片模拟的是**眼镜自身**的传感器。如果是外接蓝牙设备（如运动手环/腕表）通过 BLE 发来的六轴数据，请使用下方「蓝牙」面板里的「导入通知 trace」或脚本中的 `playNotificationTrace(...)`。

### 相机：自动化用模拟图片，手动调试可用电脑摄像头

- **模拟图片（默认，`camera=mock`）**：自动化测试（`npm run e2e`）强制使用此模式。脚本通过 `caps.media.loadPhoto('assets/example.png')`（从被测应用的静态目录读取，文件不存在立即报错）或 `queuePhotos()` 指定下次 `takePhoto()` 返回的图片，也可直接传入 `Uint8Array` 字节。
- **电脑摄像头（手动，`?camera=computer`）**：在工作台下拉框切换到「电脑摄像头」时，浏览器会弹窗请求摄像头权限。当你在画面中按键触发应用调用 `takePhoto()` 时，会通过电脑摄像头抓拍一帧并返回 `{data, mimeType}`，拍完立即关闭摄像头指示灯。

### 蓝牙：自动化用模拟设备，手动调试可用电脑蓝牙

`ink_web` 引擎直接读取浏览器的 `navigator.bluetooth` 对象（底层原理见 [runtime-notes.md](runtime-notes.md)）：

- **模拟蓝牙（默认，`bluetooth=mock`）**：自动化测试强制使用此模式。默认内置一个 `InkLab Heart Rate` 心率设备；脚本可通过 `caps.bluetooth.replaceDevices([...])` 自定义设备与服务树、用 `failNext('gatt.connect', ...)` 模拟连接失败、用 `playNotificationTrace(...)` 高频回放通知数据流。
- **电脑蓝牙（手动，`?bluetooth=computer`）**：恢复使用浏览器原生的 Web Bluetooth 连接真实外设。如果因跨引擎桥接丢失了浏览器的用户点击手势导致无法弹出设备选择框，点击控制台上的「选择真实设备」按钮即可继续配对。页面热重载时会自动断开已有蓝牙连接。

```js
// 应用连接并订阅后，推送一帧心率通知（88 BPM）
__inklab.bluetooth.emitNotification({
  serviceUuid: 'heart_rate',
  characteristicUuid: 'heart_rate_measurement',
}, [0x00, 88]);

// 按固定间隔（如 20ms / 50Hz）或按样本时间戳 { t, value } 连续回放蓝牙通知
const trace = __inklab.bluetooth.playNotificationTrace({
  serviceUuid: '6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001',
  characteristicUuid: '6f1d0001-8f5b-4c7e-9a21-4a19f2b4c001',
  frames: [[1, 2, 3], [4, 5, 6]],
  intervalMs: 20,
});
trace.stats(); // 查看状态：running/completed/failed、已发帧数 emittedFrames、循环次数 loops
trace.stop();
```

在工作台导入蓝牙通知 JSON 时，可以传十六进制字符串数组，或带设备与时间轴的对象（所有帧要么统一使用 `intervalMs`，要么全部提供递增的相对毫秒 `t`）：

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

### 眼镜画面与环境光模拟：哪些是真的，哪些是模拟

- **真实执行的部分**：应用的 `.ink` 界面解析、JS 逻辑（QuickJS）和画布绘制（Skia/WASM）全部由真实的 `ink_web` 引擎执行。
- **软件模拟的部分**：由于真实 AR 眼镜的光学镜片上**黑色像素不发光（即呈透明状态）**，人眼会透过黑色区域看到现实环境。切换到「真机模拟 · 竖屏」并选择环境光（绝对黑暗 / 室内明亮 / 夜晚弱光）后，InkLab 会通过算法把画布上的黑色背景抠成透明，叠加在模拟的环境背景图上（具体算法见 [runtime-notes.md](runtime-notes.md)）。
- **用途与局限**：它能帮你在电脑上提前发现「文字颜色太暗，在白天亮背景下看不清」等界面对比度问题；但软件合成无法还原真实眼镜光机的物理亮度、镜片色偏与人眼适应效果，最终视觉效果仍需戴上真机确认。

### 自带的引擎能力探针应用（`fixtures/cap-probe-app`）

仓库内置的 `fixtures/cap-probe-app` 是一个用来给不同版本引擎做“API 能力体检”的探针应用。它会逐项调用 AIUI 0.17 的接口并给出明确结论（`supported` 完全支持 / `partial` 部分支持 / `unsupported` 不支持 / `contract-drift` 行为与约定不符），涵盖：

- 电池状态（`BatteryManager`）初始读取与变更事件；
- 本地文件系统（OPFS）创建、写入、读取与删除；
- 空间感知（World Awareness）、姿态传感器（`AbsoluteOrientationSensor`）与合成点头手势（`nod`）；
- 媒体采集接口（`mediaDevices` / `MediaRecorder` / `ImageCapture`）；
- 语音合成 `speechSynthesis.speak()` 与独立 `synthesize()` 任务；
- `table`、`timed-text`、`streamdown` 流式渲染与空源 `video` 组件生命周期。

检查单个引擎版本可运行：`npm run e2e -- fixtures/cap-probe-app --scenario aiui-017-conformance --runtime <id> --no-video`；对比多个引擎版本的支持差异可运行 `npm run matrix`。

### 默认拦截外部网络请求（`caps/net.mjs` 的 `guardExternal`）

本地工作台运行的是应用的真实源码，而许多应用在启动阶段就会自动请求线上生产域名（例如拉取天气或上报埋点），此时测试脚本甚至还没开始执行。为了**防止本地测试意外请求或污染线上生产服务器**，InkLab 默认开启了外部请求防火墙：

- **默认拦截行为**：凡是目标地址与本地工作台（`127.0.0.1`）不同源的外部请求，默认**一律拦截，不发往外网，直接向应用返回 HTTP 503**，并在网络日志中标记为 `decision: 'external-stub'`。你可以在测试中检查 `caps.net.requests`，确保没有任何标记为 `decision: 'pass'` 的外部请求。
- **规则优先级**：全局断网 > 按 URL 拦截（`block`）> 场景脚本显式配置的 Mock 响应（`status()`）> **外部请求拦截** > 真实发出请求。也就是说，你在测试脚本里专门写过 Mock 的接口会正常返回 Mock 数据，未 Mock 的外部接口才会被拦截返回 503。
- **白名单放行**：调用 `caps.net.allowExternal('域名或子串')` 可放行指定域名。此外，开启大模型在线或录制模式（LLM `live` / `record`）时，所配置的 LLM 接口地址会自动放行。
- **关闭拦截**：URL 加上 `?netguard=0`、取消勾选控制台「网络」面板中的**挡外域**，或调用 `caps.net.guardExternal(false)`。
- **排障查询**：如果发现某个请求意外返回 503，可调用 `caps.net.wouldStubExternal(url)` 检查它是否命中了外部请求拦截。

## 编写测试场景

```js
const driver = createDriver({ view, screenshot });
const result = await driver.runScenario([
  { activate: true },                       // 按 Enter 确认，并等待页面切换冷却结束
  { pressMany: ['ArrowDown', 5] },
  { shot: 'settings' },
  { expect: (ctx) => ctx.someCheck() || '焦点未落到设备连接项' },
]);
```

驱动层内置了实测得出的按键时序规则（详见 [runtime-notes.md](runtime-notes.md)）：**连续按方向键时自动推进事件虚拟时间戳**（跨过应用约 700ms 的同向按键防抖），**按确认键切换页面后真实等待 ≥1.3s**（跨过应用约 1.2s 的新页面激活冷却期）。

应用自己的测试场景放在应用仓库的 `<app>/e2e/scenarios/*.mjs` 下（工作台下拉框与 `npm run e2e` 会自动扫描加载）；与特定应用无关的通用场景放在 InkLab 的 `scenarios/` 下：

```js
export default {
  id: 'onboarding-goal', title: '走完新手引导到目标页', summary: '……',
  build({ caps }) { return [ /* 步骤列表 */ ]; },   // 通过 caps 检查应用实际调用了哪些硬件能力
};
```

编写断言时，应优先检查**应用实际调用了哪些宿主能力**（`caps.*.calls`）或比对画面截图，不要依赖引擎控制台里的 `onLoad` 耗时日志（该日志为随机采样打印，不可靠，详见 [runtime-notes.md](runtime-notes.md)）。

## 运行 e2e 测试

**InkLab 作为通用测试运行器，测试场景、录制数据和截图基线均保存在被测应用自己的仓库中**：

```
<app>/e2e/
  scenarios/*.mjs      # 测试场景脚本
  cassettes/*.json     # 大模型（LLM）响应录制文件（不含请求头与 API Key，可安全提交进 git）
  baselines/           # 参考截图基线：<场景id>/<截图名>.png 及同名 .json 指纹信息
  report/              # 本次测试运行报告与录屏产物（不入库）
```

```bash
npm run e2e -- <app>                                 # 在无头 Chrome 中运行该应用的全部场景
npm run e2e -- <app> --accept                        # 将本次运行的截图保存为新的参考基线
npm run e2e -- <app> --scenario onboarding-goal      # 只运行指定场景
npm run e2e -- <app> --no-video                      # 关闭场景自动录屏（默认开启）
npm run e2e -- <app> --headed                        # 打开可见浏览器窗口运行，方便排障
npm run e2e -- <app> --runtime <lane>                # 指定使用某一个引擎版本运行
npm run e2e -- <app> --preview optical \
  --lighting indoor-bright                           # 在真机模拟竖屏 + 室内明亮背景模式下运行
npm run e2e -- dist/pkg.aix --scenario smoke \
  --runtime <lane> --report-dir /tmp/pkg-smoke       # 直接对打包好的 .aix 文件跑冒烟测试

# 跨多个引擎版本（及三种环境光背景）运行同一场景并汇总差异报告
npm run matrix -- fixtures/cap-probe-app \
  --scenario aiui-017-conformance \
  --runtime <lane>,<lane> --all-lighting
```

**运行流程**：自动在随机端口启动本地服务 → 强制将相机与蓝牙设为模拟模式（`camera=mock`、`bluetooth=mock`）→ 启动系统 Chrome（`--headless=new`，固定 `--force-device-scale-factor=2` 保证不同机器截图分辨率一致）→ 每个场景前执行一次完整的页面跳转（`Page.navigate`，彻底隔离上一个场景的 WASM 与蓝牙状态）→ 执行步骤并比对截图基线 → 生成 `<app>/e2e/report/last-run.json`。只要任一步骤失败、截图差异超标、或参考截图指纹过期（`stale`），命令即以非零退出码结束。

### 按场景配置 LLM 模式：一次测试同时覆盖联网与离线场景

不同的测试场景可能需要不同的 LLM 模式（例如有的测大模型正常回复，有的测未配模型时的离线降级）。每个场景可以在脚本中单独声明所需的 `llm` 配置，测试运行器会在进入该场景前自动切换：

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
| `mode` | `off`（无模型）/ `live`（请求真实模型）/ `record`（请求真实模型并录制）/ `replay`（离线回放录制文件）。不填则使用全局默认模式（存在 `e2e/cassettes/default.json` 时默认 `replay`，否则为 `off`） |
| `cassette` | `replay` 或 `record` 模式下读写的录制文件路径（相对于被测应用根目录） |
| `model` | **固定录制匹配用的模型名**（推荐统一填 `'inklab-cassette'`）。匹配录制文件时会计算请求体哈希（内含 `model` 字段）；固定此名称后，其他开发者或 CI 机器无需配置相同的模型环境变量也能正常命中回放 |

**优先级**：命令行传入的 `--llm` 参数最高 > 场景脚本内的 `llm` 声明 > 全局默认模式。录制与回放只需三步：

```bash
# ① 录制：连接真实大模型跑一次，自动将响应写入场景指定的 cassette 文件（并自动把模型名替换为场景声明的 model）
npm run e2e -- <app> --scenario llm-fc-intent --llm record
# ② 验证回放：直接重跑（自动使用离线 replay，不联网、无需 API Key）
npm run e2e -- <app> --scenario llm-fc-intent
# ③ 将生成的 cassette JSON 提交到 git 仓库，后续 CI 即可离线稳定运行
```

- **测试报告统计**：`e2e/report/last-run.json` 中的 `llm.online` / `llm.offline` 会分别列出在线与离线场景，`llm.outcomes` 汇总所有请求的结果计数（`replay-hit` 命中回放 / `replay-miss` 未命中 / `fault:*` 注入故障 / `live:2xx` 真实请求成功）。
- **请求哈希别名（`aliases`）**：如果同一个场景因机器性能差异导致请求内容出现微小但合理的波动（例如计时器显示 30 秒 vs 35 秒，导致算出的 16 位请求哈希不同），可在录制条目中添加 `aliases: ["另一个16位哈希"]`，让它们共用同一条录制响应。InkLab 不做模糊匹配，未登记的哈希一律视为 `replay-miss`。
- **`--llm live` 真模型抽检**：传入 `--llm live` 可将所有场景强制切换为调用真实大模型（会发起真实网络请求，且模型回复措辞不固定，请勿放入常规 CI）。场景脚本中可通过 `caps.llm.mode` 判断当前是否为 `replay`，在 `live` 模式下只检查接口是否正常往返，不检查具体字面文案。

## LLM 怎么接

**大模型请求由浏览器内的 `ink_web` 引擎自己发起**（标准 OpenAI `chat/completions` 格式；InkLab 宿主只负责向引擎提供接口地址、请求头和默认模型名，详见 `lib/caps/llm.mjs`）：

- **配置方式**（环境变量优先）：设置环境变量 `INKLAB_LLM_ENDPOINT`（完整的 `chat/completions` URL）、`INKLAB_LLM_API_KEY`（或指向密钥文件的 `INKLAB_LLM_API_KEY_FILE`）、`INKLAB_LLM_MODEL`；或者在仓库根目录创建本地文件 `llm.local.json`（已被 git 忽略，包含 `endpoint`、`model`、`apiKeyFile`）。
- **补充默认请求参数（`requestDefaults`）**：部分思考型大模型默认开启长思考，首字耗时超过 15 秒，会导致应用 8 秒超时失败。可在 `llm.local.json` 中配置 `requestDefaults: {"enable_thinking": false}`：配置后，工作台会将引擎请求转发到本地服务的 `http://localhost:<port>/llm/chat/completions` 路由，自动补上引擎未传的默认字段（之所以用 `localhost` 而不是 `127.0.0.1`，是因为引擎内部屏蔽了与页面完全同源的请求地址，详见 [runtime-notes.md](runtime-notes.md)）。
- **四种运行模式**（URL 参数 `?llm=off|live|record|replay`）：未配置接口地址时默认为 `off`（引擎判定大模型不可用，触发应用的离线降级提示）；已配置时默认为 `live`。`record` 模式会将真实响应录制到 `e2e/cassettes/`；`replay` 模式直接读取录制文件离线回放。
- **故障注入**：调用 `caps.llm.failNext({ kind: 'timeout' | 'http' | 'malformed', ... })` 可让下一次大模型请求发生指定故障（优先级高于录制回放），专门用于测试「大模型已配置，但本次请求超时或报错」的异常处理路径。

## 截图基线

`lib/shots.mjs` 负责像素级截图比对，`lib/stamp.mjs` 负责计算基线指纹（包含源码内容哈希、引擎版本、WASM 哈希、画布尺寸、预览与环境光模式、场景 id、能力夹具 id；不包含 git commit、时间和分支名）。当应用源码或引擎版本发生变化而参考截图未更新时，比对结果会标记为 `stale`（过期）并报错，防止拿旧截图冒充新代码的测试通过证据。

默认对整张截图进行严格的全像素比对。如果页面上有倒计时、实时波形等必然变化的动态区域，可以在该步截图上单独配置容差（`tolerance`）或忽略区域（`ignoreRegions`，忽略区域不计入差异像素分母）：

```js
{
  shot: {
    name: 'set-live',
    diffOptions: {
      tolerance: 1,
      ignoreRegions: [{ x: 20, y: 490, w: 920, h: 145 }],
    },
  },
  label: '实时计次页面截图',
}
```

## 引擎版本会漂

Rokid 官方站点上同时挂着多个引擎版本（如正式版与每日构建 daily 版），且会随站点发版而更新。为了保证测试结果可复现，`runtimes.lock.json` 中的每一条版本记录（lane）都是**只读锁定的**：一旦记下 id、来源、版本号和 SHA-256 哈希，就绝不覆盖修改；列表顺序代表优先级，**第一条即为默认引擎版本**。

```bash
npm run engine                    # 检查官方站点、将新版本追加到清单（首次运行会创建清单），并下载本地缺失的引擎文件
npm run engine -- <lane>          # 同样先检查站点，但只下载指定的引擎版本（可写多个）
npm run engine -- --check         # 仅离线校验本地已下载文件与清单哈希是否一致（不联网）
npm run engine -- --discover      # 只读预览：查看线上有哪些新版本可追加，不写任何文件（无新版本返回 0，发现新版本返回 2，检查失败返回 1）
```

1. **自动发现新版本**：默认检查 Craft（`https://js.rokid.com/craft`）和 AIUI Studio（`https://aiui.rokid.com/`）两个站点（也可通过 `--site=[<名字>=]<url>` 指定自定义站点）。脚本通过比对胶水 JS 文件的 SHA-256 判断该构建是否已收录；若没有新构建，只会拉取轻量的入口 JS 文件对比，不会重复下载体积庞大的 WASM。
2. **只追加、不覆盖**：发现未收录的新构建时，脚本会下载 WASM 计算哈希并提取版本号，按 `<平台>-<版本>` 命名（如 `craft-0.19.0-daily.202609230326`；同名但文件内容不同时自动附上哈希前 8 位），追加到 `runtimes.lock.json` 末尾并缓存在 `.engine/`。首次在空目录下生成清单时，正式版会自动排在 daily 版前面作为默认版本。你可以随时修改条目的 `id` 或 `label` 别名，不影响缓存识别与截图基线指纹。
3. **容错与格式校验**：某个站点无法访问时仅打印警告，继续检查另一个站点并按现有清单下载。手写修改 `runtimes.lock.json` 时如果出现 JSON 语法错误，会直接报错并指出文件位置。

自动发现仅支持带有独立胶水 JS 文件的引擎构建。如果遇到站点改版或其他来源的构建，可以**手动添加一条引擎记录**：

1. 在浏览器打开目标站点，通过开发者工具 Network 面板找到 `ink_web_bg-*.wasm` 以及加载它的胶水 JS 文件（内含 `createInkView` 和 `initInk`），记下两者的完整 URL。
2. 下载这两个文件，用 `shasum -a 256` 计算各自的 SHA-256 哈希。
3. 从 WASM 文件中提取引擎版本号（输出的 `version` 和 `build` 分别填入清单的 `engineVersion` 和 `engineBuild`，非 daily 版本 `build` 为 `null`）：

   ```bash
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { extractEngineVersion } from './lib/node/engine-version.mjs'; console.log(extractEngineVersion(readFileSync(process.argv[1])))" engine.wasm
   ```

4. 在 `runtimes.lock.json` 数组中新增一条记录，字段顺序为 `id`、`label`、`channel`、`cacheDir`、`source`、`fetchedAt`、`engineVersion`、`engineBuild`、`glueUrl`、`glueSha256`、`wasmUrl`、`wasmSha256`（其中 `id`、`engineVersion` 或 `engineBuild`、`glueSha256`、`wasmSha256` 为必填；需要自动下载时填 `glueUrl`、`wasmUrl`；如果源站链接已失效、仅使用本机已有缓存文件，可加上 `cacheOnly: true`）。保存后运行 `npm run engine -- <新 lane id>` 验证即可。

## 测试边界

InkLab 使用与 Craft 相同的渲染引擎，**它能替代在 Craft 网页里手动点测，但不能替代戴上真机测试**。光学显示效果、整机功耗、真实传感器物理精度、真实麦克风收音与 TTS 播报、真实蓝牙射频与固件稳定性，仍需在真实眼镜上验收。

此外，当前浏览器宿主全局不提供 `BarcodeDetector`（`typeof` 为 `undefined`），但引擎向静态 `barcode` 模块注入了构造器；因此在模拟器中只能测到“取帧扫码但未识别出有效内容”的分支，二维码成功识别的完整链路仍需在 Craft 或真机上验证。
