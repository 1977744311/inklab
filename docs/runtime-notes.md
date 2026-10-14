# InkLab 运行时实测笔记

本文记录在接入和实测 `ink_web` 引擎（`0.16.1`、`0.17.0-daily` 等版本）过程中验证过的底层行为与避坑规则。官方未文档化的细节均以实测结果为准；编写场景脚本或修改宿主代码前请先阅读本文。

章节：[焦点与帧](#焦点与帧两个程序化输入推不动的真凶2026-08-26-实测) · [驱动时序规律](#驱动应用时的时序规律这条最影响脚本化) · [引擎 API 与实例销毁坑](#引擎-api-的坑) · [宿主能力与蓝牙底层](#宿主能力层) · [LLM 接入实测](#llm-接真模型时的实测2026-08-26-晚本机-cli-proxy-api--dashscopeqwen37-plus) · [本地存储](#存储) · [预览合成、录屏与真机投屏](#aiui-studio-110-预览几何与合成口径2026-09-03-实测)

---

## 焦点与帧：两个「程序化输入推不动」的真凶（2026-08-26 实测）

用脚本驱动应用时，曾遇到“切到后台标签页后按键失效”和“点击工作台按钮后语音唤醒失效”两个问题，实测排查出的真正原因如下：

### 1. InkView 焦点是引擎内部状态，新建实例默认就是 `focused`

引擎通过 `view.focus()` / `view.blur()` 切换内部焦点状态：

- 新创建的 `InkView` 默认就是 `focused` 状态，初始化时无需额外调用 `view.focus()`。
- 一旦处于 `blurred` 状态，调用语音唤醒将不再触发 `speech.startRecognition`，且**控制台没有任何报错**——因为引擎抛出的 `InvalidStateError: ... is unavailable while InkView is blurred` 在应用内部被捕获吞掉了。
- 浏览器 DOM 焦点本身不影响引擎：只要不调 `view.blur()`，哪怕把页面焦点移到控制台按钮上，语音识别依然正常工作。

### 2. 导致引擎意外失焦的罪魁祸首是 `syncFocus: true`

如果调用 `bindDomEvents({ syncFocus: true })`，引擎胶水代码会把画布的 DOM `focus/blur` 事件同步转发给 `view.focus()/blur()`。而 **Chrome 在切换后台标签页或点击画布外的按钮时，会自动触发当前元素的 DOM `blur` 事件**，导致引擎瞬间进入 `blurred` 状态。

**结论**：InkLab 宿主**明确不开启 `syncFocus`**。如果需要专门测试应用在失焦状态下的行为，请使用工作台控制面板上的 `focus()` / `blur()` 按钮手动触发。

### 3. 后台与无头浏览器里「按键只有第一次生效」的原因是渲染帧停摆

- 引擎的画面更新与内部状态推进依赖浏览器的 `requestAnimationFrame`（rAF），而实际的帧计算发生在公开且同步的 `view.render()` 方法中。
- 当浏览器标签页切到后台、窗口被其他窗口完全遮挡（`document.hidden === true`），或者运行在**无头 Chrome（Headless）**中时，浏览器会暂停或大幅延迟触发 rAF。
- 此时如果连续调用 `view.dispatchInput` 发送 5 次按键，**只有第 1 次按键会生效**：因为第 1 次按键触发的界面布局与焦点树更新必须等下一帧 `view.render()` 才会生效，rAF 停摆导致后续 4 次按键全部打在了未更新的旧焦点树上。

**结论**：InkLab 在宿主层（`host/inklab/input.js`、`keyboard.js`、`stage.js`）做了三项固定处理：

1. 所有脚本按键与硬件能力事件统一走宿主的 `sendInput` / `wake` 出口，每次派发后**立即同步调用 `view.render()` 手动推进帧（pump）**，并内置 32ms 保底定时器防 rAF 停摆；
2. 键盘事件由宿主监听 `window` 后统一走 `sendInput`（既保证每次按键后渲染帧推进，也能将按键同步发给并排运行的多个引擎画布）；
3. 调用 `bindDomEvents` 时传入一个未挂载的空 DOM 元素作为 `keyboardTarget`，禁用引擎自带的直接键盘监听。

```js
// 验证方法：即使把浏览器标签页切到后台，通过 __inklab 运行场景也能全部通过
await window.__inklab.runScenario('onboarding-goal');
// 反例：若绕过宿主直接调用 view.dispatchInput，在后台标签页里连续按键只有第一次会生效
window.__inklab.view.dispatchInput('keydown', 'Enter', Date.now());
```

## 驱动应用时的时序规律（这条最影响脚本化）

AIUI 应用通常包含两道按键防抖限制，但**两道限制读取的时钟来源不同**：

| 防抖限制 | 应用读取的时钟 | 能否用虚拟时间戳跳过 |
| --- | --- | --- |
| 连续按同一方向键的防抖间隔（约 700ms） | 按键事件自带的 `timeStamp` 参数 | **能**——调用 `dispatchInput` 时把第 3 个时间戳参数往后加即可立即生效 |
| 页面切换后的确认键（Enter）冷却期（约 1.2s） | 系统真实时间 `Date.now()` | **不能**——脚本必须真实等待 ≥1.3s |

- **驱动脚本标准做法**：**方向键递增虚拟时间戳（瞬间跳过 700ms 防抖）+ 确认键换页后真实等待 ≥1.3s（跨过 1.2s 页面冷却）**。如果换页后只递增虚拟时间戳而不做真实等待，后续按键会被直接忽略。
- **冷启动第一次按确认键**：宿主显示“装载完成”的时间点比首页真正执行完 `onShow` 早几百毫秒。如果一启动立刻发送 `Enter`，极易撞上首页 `onShow` 的 1.2s 冷却期而被吞掉，导致后续所有按键错位。因此场景脚本的第一个 `activate` 前需真实等待 ≥2.5s（且不要用连按两次 `Enter` 来撞运气）。
- **长时间闲置遮罩**：部分应用闲置一段时间后会进入待机层，第一次按键只会唤醒待机层而不会触发页面按钮；在浏览器里手动调试前建议先刷新重载。

## 引擎 API 的坑

### `dispatchInput(type, key, timestamp?)` 参数类型必须严格校验

- `type` 只接受 `'keydown'` 或 `'keyup'`（传 `'key'` 或 `'keypress'` 会报错 `Unsupported input event type`）。
- `key` 必须是字符串键名（如 `'Enter'`、`'ArrowDown'`、`'Backspace'`），第 3 个参数为毫秒时间戳（默认 `Date.now()`）。
- **传入非字符串类型（如误把对象当成 `key` 传入）会直接导致 WASM 内存越界崩溃（`memory access out of bounds`）**。一旦发生，引擎实例内部状态即损坏，必须重建 `InkView`。因此 `lib/driver.mjs` 在调用引擎前会通过 `assertInput` 强制校验参数类型。

### 初始化后必须调用 `startRendering()`

`requestRender()` 只会渲染单帧。装载应用后如果不调用 `startRendering()` 启动渲染循环，会出现**内部状态已改变但画布不重绘**的现象，看起来就像按键完全没反应。

### 引擎日志输出在 `console.*`，且 `onLoad` 耗时日志是随机采样的

引擎内部日志直接打印在浏览器的 `console` 中（宿主已拦截并收集到 `window.__inklab_engineLog`）；而 `onMessage` / `setOnMessage` 是应用代码调用的 `postMessage` 通信通道，不是引擎日志。

> ⚠️ **千万不要用 `Page "…" method "onLoad|onShow" took …` 日志来判断页面是否加载成功。**
> 这条日志是引擎的性能采样日志（`ink-runtime/src/page/mod.rs:247`），页面方法执行很快时往往不会打印。
> **判断页面是否到达的可靠依据只有两个**：
> 1. 引擎日志中出现 `eval_module namespace success module='…/pages/x/index.js'`（模块首次加载时必定同步打印；注意同一个页面内的多步切换不会再次触发模块加载）；
> 2. **画面截图或宿主能力调用记录**（检查 `caps.*.calls` 确认应用是否调用了预期的接口）。

### 鼠标点击画布不会触发按钮点击（2026-08-26 实测）

无论是通过 `bindDomEvents` 还是直接调用 `view.dispatchPointer('pointerdown'/'pointerup', x, y, ...)`，在画布上点击按钮都不会触发激活（因为真实眼镜没有触摸屏，镜腿触控板在系统层也是映射为方向键与确认键）。**因此 InkLab 的自动化操作全部通过键盘按键和语音唤醒完成。**

### `dispatchVoiceWakeup(keyword, ts?)` 与 `openBundle`

- `dispatchVoiceWakeup`：`keyword` 必须为非空字符串，否则抛出 `TypeError`。
- `view.openBundle({ appId: <非空字符串>, files, initialPage?, query?, hostOptions? })`：`appId` 为空会报错；`hostOptions.initialTarget` 可选值为 `_current` / `_blank` / `_widget`。

### 销毁旧实例时引擎必现的 Mutex Panic（2026-08-27 实测，写崩溃断言必读）

在页面内调用 `reload()` 销毁旧 `InkView`（`disposeStage` → `view.destroy()`）时，引擎在异步垃圾回收阶段**必定会打印一条 Rust Panic**（注：自动化 `npm run e2e` 现已改为每个场景前整页跳转 `Page.navigate`，不会触发此问题）：

```
INFO  packages/ink/src/instance.rs:325              Dropping Ink instance <uuid>
DEBUG packages/ink-scripting/src/js_runtime.rs:74   JsRuntime drop start: safe persistent count = 189
panicked at library/std/src/sys/sync/mutex/no_threads.rs:19:9:
  assertion `left == right` failed: cannot recursively acquire mutex
```

实测确认该报错发生在旧实例销毁阶段，与被测应用代码无关，也**不影响新创建的实例正常运行**。但由于它是异步延迟触发的，往往会打印在下一个场景启动后的日志里。如果在测试脚本中编写“检查引擎日志无 Panic”的断言，**请仅将紧跟在 `Dropping Ink instance` / `JsRuntime drop` 之后的这一条 `cannot recursively acquire mutex` 排除**，其他位置的 Panic 仍应正常报错。

## 宿主能力层

接口规范见 `lib/caps/contract.mjs`。核心对接规则：

- **方法注册**：`hostCapabilities` 的结构为 `{ 命名空间: { 方法名: async (args) => result } }`。若应用调用了宿主未配置的方法，引擎会抛出 `Host capability {ns}.{method} is not configured on Web host`。调试新接口时可挂载 `lib/caps/probe.mjs`，把引擎传过来的真实参数记录到 `window.__inklab.probe.calls`。
- **向引擎推送事件**：必须通过 `view.getHostCapabilitiesTarget().dispatchEvent(new CustomEvent(name, { detail }))` 派发（见 `lib/caps/index.mjs` 的 `createEventBridge`），且 `detail` 中**必须原样带回引擎启动该会话时传入的 `targetId` 和 `sessionId`**。注意：`InkView` 实例上同名的 `dispatchHostCapabilityEvent` 是给 WASM 内部用的私有方法，宿主不要直接调用。
- **相机（`media`）**：引擎胶水代码自带的浏览器降级实现只支持麦克风录音和枚举设备，**没有实现 `takePhoto`**。因此 InkLab 默认注入模拟 `media` 模块；手动切换到“电脑摄像头”模式时，仅将 `takePhoto` 替换为 `lib/browser-camera.mjs` 的摄像头抓拍实现。
- **传感器（`sensors`）**：引擎会将标准 Generic Sensor API 调用转发给宿主的 `sensors` 能力（如 `accelerometer.start`）。回放传感器轨迹（trace）时，模拟器发送给应用的采样 `timestamp` 固定按「启动时刻 + 样本相对时间 `t / speed`」计算，避免浏览器后台定时器延迟导致动作周期变形。默认静置数据不包含运动波形，测试计次或动作校准功能时需调用 `caps.sensors.loadTrace()` 注入真实轨迹数据。

### 蓝牙（Bluetooth）不走 `hostCapabilities`（2026-08-27 实测）

引擎的 `setHostCapabilities()` 不接收 `bluetooth` 命名空间，而是由 `web_bluetooth.rs` 直接调用浏览器的 `window.navigator.bluetooth`（完整调用链：`getAvailability()` → `requestDevice()` → `device.gatt.connect()` → `getPrimaryService()` → `getCharacteristic()` → `startNotifications()` → 监听 `characteristicvaluechanged` 事件）。

因此 InkLab 的蓝牙模拟器直接挂载在 `navigator.bluetooth` 上，并且完整模拟了浏览器原生的蓝牙对象层级（例如 `characteristic.properties` 必须存在，否则引擎在 Rust/JS 边界会报 `Reflect.get called on non-object`）。

### 电脑真实蓝牙（Web Bluetooth）连接外设的注意事项（2026-09-02）

- **用户点击手势丢失问题**：应用在 QuickJS 引擎内调用 `scanDevices()` 再桥接到浏览器的 `navigator.bluetooth.requestDevice()` 时，常会因为异步跨桥而丢失浏览器的瞬时用户点击状态（transient user activation），导致 Chrome 报错 `SecurityError: Must be handling a user gesture...`。为此，InkLab 的电脑蓝牙适配器会先挂起该请求，等你点击工作台上的「选择真实设备」按钮时，在原生 DOM 点击事件中带着相同的过滤条件弹出系统配对框。
- **连接就绪时机**：`device.gatt.connected === true` 仅代表底层物理连接建立，此时服务发现、特征订阅和应用层握手尚未完成，脚本或操作不能看到 `connected` 就立刻切换页面。
- **蓝牙断线检测**：`ink_web 0.17` 不会向应用转发浏览器的 `gattserverdisconnected` 事件，`server.connected` 属性也可能停留在旧状态。应用需要通过写入特征值时返回的 `NetworkError: GATT Server is disconnected` 来感知断线；而 InkLab 在热重载应用前也会主动断开已连接的真实 GATT 设备。

## LLM 接真模型时的实测（2026-08-26 晚，本机 CLI Proxy API + dashscope/qwen3.7-plus）

- **引擎不会向与页面同源的接口地址发请求**：当工作台运行在 `http://127.0.0.1:8788` 时，如果 `getConfig` 返回的 LLM 接口地址也是 `http://127.0.0.1:8788/...`，引擎内部会直接静默丢弃该请求（`fetch` 层没有任何调用记录）。将接口地址改为 `http://localhost:8788/...`（指向同一个本地服务，但主机名字符串不同）即可正常发出请求。因此 InkLab 服务端的 `/llm` 转发路由专门使用 `localhost` 地址下发并配置了 CORS。
- **思考型模型的超时问题**：像 `qwen3.7-plus` 这类模型在默认开启思考模式时，首字输出耗时常超过 15 秒，而应用端通常设有 8 秒超时限制。通过在 `llm.local.json` 中设置 `requestDefaults: {"enable_thinking": false}`，由本地 `/llm` 转发路由自动补上该参数后，首字响应可缩短至约 1.3 秒。

### 引擎发出的 LLM 请求固定带有 `stream: true`（2026-08-27 实测）

**无论应用调用的是非流式 `session.prompt()` 还是流式 `session.promptStreaming()`，引擎在 HTTP 层发出的请求体中 `stream` 固定为 `true`，且响应格式固定为 `text/event-stream`（SSE 流）**。两者的区别仅在于：调用 `prompt()` 时引擎会等整条流接收完毕再一次性返回给应用；调用 `promptStreaming()` 时则是边收边回调。

编写测试与构造录制文件（cassette）时需注意两点：

1. **在网络层无法区分应用调的是 `prompt()` 还是 `promptStreaming()`**：因为请求体完全相同。E2E 测试中验证流式处理，应检查「跨多个数据块（chunk）的文本是否被完整拼接」以及「请求次数是否符合预期」。
2. **工具调用（Function Calling）也是分段流式返回的**：`tool_calls[].function.arguments` 会被拆成多个增量片段下发，由引擎拼成完整 JSON 后再触发 `toolcall` 事件。如果手动编写录制文件，响应内容必须写成 SSE 流格式，不能写成普通的单条 JSON 响应。

## 存储

- 引擎自身的设备标识保存在浏览器的 `localStorage` 中（`ink.host.identity.device_seed.v1` 和 `local_salt.v1`）；但应用自己调用的 `wx.*StorageSync` 数据**不在** `localStorage` 里。在同一个 `InkView` 实例生命周期内存储读写正常，若测试场景需要干净的初始状态，应重建 `InkView` 或重新导航页面，单靠清空 `localStorage` 没有效果。
- `0.17` 引擎已支持浏览器的 OPFS 本地文件系统（`navigator.storage.getDirectory()`，`0.16.1` 不支持）。注意：当前引擎实现的 `removeEntry(name, { recursive: false })` **必须传入第二个配置对象参数**，只传文件名会抛出参数数量错误的 `TypeError`。

---

## AIUI Studio 1.1.0 预览几何与合成口径（2026-09-03 实测）

- **效果预览模式**：逻辑尺寸为 `480×352`（2 倍屏实际像素 `960×704`），纯黑背景。
- **真机模拟（竖屏）模式**：对齐 AIUI Studio 的 `.device-screen` 尺寸 `480×640`（2 倍屏实际像素 `960×1280`），将 `480×352` 的应用画布放在居中位置（`top: 144px`，上下各留 144px 环境背景），提供「绝对黑暗 / 室内明亮 / 夜晚弱光」三种背景。
- **黑底转透明合成算法（2026-09-08 修正）**：真实的 AR 眼镜镜片上黑色不发光（即透明）。如果在网页上简单用 CSS `screen` 滤镜混合，会导致绿色文字发白；如果只把纯黑像素（`#000000`）硬抠成透明，抗锯齿边缘的深色半透明像素会残留成难看的黑边。因此 InkLab 采用通道还原算法：取每个像素的最大 RGB 通道值作为不透明度（alpha），反除去除黑色背景混色后还原出前景色，再按标准 `source-over` 叠加到环境背景图上。工作台实时预览、截图和录屏统一使用这套 `paintPreviewFrame` 合成逻辑。

## 主舞台画布录屏（2026-08-28 实测）

直接对合成画布调用 `canvas.captureStream(30)` 并传给浏览器的 `MediaRecorder` 进行录制（无需申请操作系统的屏幕录制权限，也不会把工作台按钮或鼠标录进去）。录制时优先使用 `video/mp4;codecs=avc1.42E01E`（生成 H.264 编码的无声 MP4，效果预览分辨率为 `960×704`，真机模拟竖屏为 `960×1280`）；若当前浏览器不支持直接录制 MP4，则自动降级为 WebM 并在界面提示插入 PPT 前需转码。

## 多引擎版本并行对比（2026-09-03 实测）

同一个浏览器页面内可同时加载并运行多个不同版本的 `ink_web` 胶水模块与 WASM 实例。实测对比 `0.16.1` 与 `0.17` daily 版本的能力差异：

- `0.16.1`：不支持 Battery、OPFS 和 Media Capture 接口；TTS 仅支持 `speak()`（不支持独立 `synthesize` 任务）；注入合成点头轨迹不会触发 `head-gesture` 回调。
- `0.17` daily：Battery、OPFS 文件读写删、Media Capture、独立 TTS `synthesize` 任务、空间感知（World Awareness）与合成点头手势全部支持。
- 原生 `table` 等组件在两个版本间的渲染像素存在细微差异，`npm run matrix` 会将其标记为 `visual-changed`，供开发者人工比对是否符合预期。

## USB 真机驱动与取证（2026-09-09 实测）

- **发送语音文字后需立即轮询截图**：实测发现，真机上的离线问答回复气泡会在几秒后自动消失；如果发送 `say` 指令后固定等待 6 秒再截图，截到的往往是已经恢复原状的首页。改为发送 `say` 后 250ms 立即开始轮询截图（每次截取完整 `480×640` PNG 并调用 macOS Apple Vision OCR 识别文字），即可稳定捕获回复内容，并支持 `wake（唤醒）→ say（提问）` 连续执行。
- **持续 H.264 投屏流**：眼镜端的 `screenrecord v1.3` 支持 `--output-format=h264 --size 480x640 --bit-rate 2000000 -` 参数，可直接向标准输出持续吐出无 B 帧的 H.264 视频流。InkLab 通过一个常驻 ADB 进程加一个本机 `ffmpeg` 解码进程将画面实时推给浏览器：首帧耗时约 1.5 秒，本机解码到浏览器绘制耗时约 2–8ms。停止投屏或刷新网页时，实测均可干净回收眼镜端的 `screenrecord` 进程与本机解码进程。
