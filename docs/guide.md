# InkLab 使用指南

这份指南讲模拟器工作台怎么用，以及怎么写、怎么跑自动化测试。安装和第一次下载引擎见 [README](../README.zh-CN.md)，连真眼镜见 [USB 连真机](device.md)。脚本的表现和预期对不上时，查 [运行时实测笔记](runtime-notes.md)。

| 我想… | 看这一节 |
| --- | --- |
| 先跑起来看看 | [五分钟上手](#五分钟上手) |
| 弄清工作台上每一块是干什么的 | [工作台一览](#工作台一览) |
| 模拟语音、传感器、相机、蓝牙、网络、大模型 | [模拟硬件](#模拟硬件) |
| 写一个自动化测试 | [写场景](#写场景) |
| 在命令行或 CI 里跑测试、比对截图 | [跑自动化测试](#跑自动化测试) |
| 换引擎、并排对比几个引擎版本 | [引擎版本](#引擎版本) |
| 测多人联机 | [多玩家](#多玩家) |
| 在 DevTools 或 CDP 里直接控制工作台 | [自动化接口](#自动化接口) |
| 分清哪些能在电脑上测、哪些必须上真机 | [原理与边界](#原理与边界) |

## 五分钟上手

```bash
inklab fixtures/cap-probe-app --open     # 没装命令时：npm start -- fixtures/cap-probe-app --open
```

`fixtures/cap-probe-app` 是仓库自带的探针应用。浏览器打开 <http://127.0.0.1:8788/> 后：

1. **操作应用**：点一下画面，用键盘 `↑` `↓` 移动焦点，`Enter` 确认，`Backspace` 返回。
2. **改代码**：修改应用源码并保存，画面会自动重载。
3. **跑一个测试**：在预览下方的场景条里选「冒烟：应用能跑起来」，点「运行」。右侧「场景」页会列出每一步的结果和截图。
4. **模拟一句语音**：在下方「语音识别」卡片里输入一句话，点「说完一句」，应用就会收到这句识别结果。
5. **在命令行跑同一个测试**：

   ```bash
   inklab-e2e fixtures/cap-probe-app --scenario smoke
   ```

调试自己的应用时，把路径换成应用的源码目录（目录里有 `app.json`）或打包好的 `.aix`：

```bash
inklab <应用目录>                            # 运行源码，保存即重载
inklab <应用>.aix                            # 运行发布包
inklab <应用目录> --compare-with <应用>.aix  # 运行源码，同时在「工程」页对比两份文件
inklab <应用目录> --port 8790                # 默认端口 8788 被占用时换一个
```

代码不会上传。引擎下载好以后，运行时也不需要外网。

## 工作台一览

| 区域 | 位置 | 用途 |
| --- | --- | --- |
| 顶栏 | 最上方 | 在「模拟器」「USB 真机」「真机 + 模拟器」三种模式之间切换。还有「热重载」开关和源码监听状态、浅色 / 深色切换、右侧 Inspector 的收起按钮。 |
| 预览 | 左上 | 左上角的「引擎」菜单选择引擎，可以多选并排。右上角是「重载」「唤醒」「截图」「开始录制」。画面下方切换「视图」和「环境」，勾选「镜像输入」，并显示工程身份（源码或 AIX、体积、SHA-256）。 |
| 场景条 | 预览下方 | 选择场景，点「运行」，勾选「录屏」，或「清空」结果。下面一行是场景说明，悬停可看全文。 |
| 能力控制 | 场景条下方 | 模拟硬件的卡片，按「交互 / 设备 / 传感 / 全部」分页。打开右侧「说明」开关，每张卡会显示一句说明；悬停在按钮上能看到更细的解释。 |
| Inspector | 右侧 | 共七页，顶部输入框可以筛选当前页内容，见下表。 |

| Inspector 页 | 看什么 |
| --- | --- |
| 启动 | 启动过程和预检报错。缺少 `app.json` / `app.js`、注册了不存在的页面，启动前就会在这里报出来。 |
| 日志 | 引擎日志 |
| 网络 | 每个请求的判定、请求头、响应和正文（密钥已脱敏） |
| 能力 | 应用调用了哪些硬件接口、传了什么参数 |
| 场景 | 场景每一步的耗时、失败原因和截图 |
| 工程 | 文件清单。`.aix` 会显示 `VERSION`、MD5、SHA-256、体积和完整 manifest；加 `--compare-with` 时用 `+ / - / ~ / =` 列出两份代码的差异 |
| 证据 | 导出 `run.json`：源码哈希、引擎锁、时间线、网络日志和截图 |

几个容易忽略的地方：

- **按键只发给画面**：光标在输入框里时按键不会传给应用，打字不会误触。画布的逻辑尺寸是 `480×352`。
- **两种视图**：「效果预览 · 黑底」就是 `480×352` 的原始画布。「真机模拟 · 竖屏」按 AIUI Studio 的 `480×640` 排版，把黑色当成透明叠在环境背景上，环境可选「绝对黑暗 / 室内明亮 / 夜晚弱光」，用来检查文字在亮环境下是否看得清（见[原理与边界](#原理与边界)）。视图和环境会记进截图指纹，不同视图的截图基线互不混用。
- **热重载不打断测试**：场景还在跑时改了源码，会等场景跑完再重载。连续保存会合并成一次。
- **录屏**：点「开始录制」或勾选场景条上的「录屏」，会把画面录成无声 MP4，浏览器不支持时退成 WebM。不录鼠标和浏览器边框，也不需要系统录屏权限，可以直接放进 PPT。
- **窄屏**：窗口宽度不超过 1260px 时 Inspector 默认收起，点顶栏右侧的按钮展开。
- **主题只改工作台外观**：浅色 / 深色不影响应用画布的像素，也不影响截图基线。

源码目录会按 `.aixignore` 规则打成内存快照再交给引擎；`.aix` 则直接读包里的文件。

## 模拟硬件

应用在眼镜上调用的硬件，在 InkLab 里都换成了可控的模拟器。每一样都能在「能力控制」卡片里手动操作；在场景脚本里则通过 `caps.<名字>` 控制，并用 `caps.<名字>.calls` 检查应用调用了什么。

| 能力 | 工作台卡片 | 脚本里常用 |
| --- | --- | --- |
| 语音识别与播报 | 语音识别、焦点 · 播报 | `caps.speech.say(text)`、`endTurn()`、`nomatch()`、`abortMidway()`；`spokenTexts` 是应用播报过的文字 |
| 传感器 / IMU | 传感器 / IMU | `caps.sensors.playTrace(name, samples)`、`injectError(name, …)`；`lab.imu.play('轨迹#段落')` |
| 相机 | 相机 | `caps.media.loadPhoto(path)`、`failNext({ kind })`、`setTakePhotoDelayMs(ms)` |
| 蓝牙 | 蓝牙 | `caps.bluetooth.emitNotification(…)`、`playNotificationTrace(…)`、`failNext(op)` |
| 网络 | 网络 | `caps.net.offline()` / `online()`、`block()`、`delay()`、`status()`、`allowExternal()` |
| 大模型 | 没有卡片：用配置和 URL 参数 `?llm=` | `caps.llm.failNext({ kind })`；场景里声明 `llm` 模式 |
| 电池 | 电池 | `caps.battery.setStatus({ level, charging })` |

接口定义在 `lib/caps/contract.mjs`，是从引擎胶水代码逆向整理、再逐项实测出来的。

**模拟器故意保留真机的毛病。** 真机上会出的问题，模拟器不会替应用兜住，否则测试就测不出来：

- 语音识别可能中途被掐断（`abortMidway()`）。`say()` 注入最终结果后**不会**自动结束会话：`continuous: true` 的应用自己决定什么时候关，`continuous: false` 的单轮识别要由脚本调用 `endTurn()` 收尾。
- 真机上 TTS 的播放结束回调不可靠，所以模拟器默认**不**自动通知「播报结束」。
- 传感器权限被拒或读取出错后，故障一直保持，直到显式清除。真机上被拒后重试也一样失败。
- 拍照默认延迟 1.5 秒，接近真机快门加处理的耗时。
- 蓝牙必须先完成 GATT 连接并调用 `startNotifications()` 订阅，注入的通知才会生效；没订阅就注入会直接报错。

### 语音

「语音识别」卡片里的按钮对应识别过程中的各种情况：「说完一句」（最终结果）、「说到一半」（中间结果）、「本轮收尾」、「没听清」、「没人说话」、「被掐断」。脚本里：

```js
caps.speech.say('我想增肌');                    // 最终结果
caps.speech.say('我想', { interim: true });     // 中间结果，通常只上屏，不该触发执行
caps.speech.endTurn();                          // 单轮识别（continuous: false）要显式收尾
caps.speech.spokenTexts;                        // 应用播报过的文字
```

旧版识别接口和 0.18 以后的流式接口都支持。纯音频采集用本地空音轨和模拟 PCM 帧，不申请麦克风权限。识别结果靠注入文字，所以这里验证的是应用行为，不能证明真实声音的识别质量。

### 传感器与 IMU 轨迹

「传感器 / IMU」卡片模拟的是**眼镜自身**的传感器：加速度计、陀螺仪、磁力计、姿态。可以：

- 点「深蹲 ×6」加载内置的合成深蹲轨迹；
- 导入一段 JSON 轨迹；
- 在「工程轨迹」一行选工程里存的轨迹（可以只选其中一段），点「播放」；
- 注入权限被拒、读取故障。

轨迹 JSON 可以是样本数组，也可以带传感器名和速度：

```json
[{ "t": 0, "x": 0, "y": 9.81, "z": 0 }]
```

```json
{ "sensor": "accelerometer", "speed": 1, "samples": [{ "t": 0, "x": 0, "y": 9.81, "z": 0 }] }
```

`t` 是相对毫秒。回放按每个样本自己的时间排在绝对时刻上（起点 + `t / speed`），浏览器计时器晚到不会累积，60Hz 的轨迹放出来就是 60Hz。导入的轨迹在应用下次 `start` 传感器时生效。

**工程轨迹**放在被测工程的 `e2e/traces/<名字>.json`，包含多个传感器、带段落和标记，格式见 `lib/imu-trace.mjs`。在真机上用「模拟 IMU · 录制」或 `inklab-device imu-guide` 录下来的就存在这里（见 [USB 连真机 · 模拟 IMU](device.md#模拟-imu)）。在场景里放一段：

```js
{ do: () => lab.imu.play('guided-20261117-1030#nod-normal'), label: '放真机录的正常点头' },
{ wait: 16000 },
{ expect: async () => countNods() === (await lab.imu.segment('guided-20261117-1030#nod-normal')).expect.nod },
```

`lab.imu.play(ref, options)` 的选项：

| 选项 | 作用 |
| --- | --- |
| `mode: 'load'` | 不切正在跑的传感器，只给之后新开的会话 |
| `loop`、`speed` | 循环、倍速 |
| `sensors` | 只放其中几个传感器 |
| `from`、`to` | 按轨迹时间（毫秒）截一段 |
| `rebase: true` | 把姿态改成相对这一段第一条读数的转动 |

什么时候要 `rebase`：真机录的姿态在 Android 世界坐标里（Z 朝上），而模拟器的静置姿态是单位四元数。应用已经用静置姿态定好「正前方」、再切到真机轨迹时，不加 `rebase` 算出来的转头角度是乱的。

另外还有 `lab.imu.list()`（列出工程轨迹）、`lab.imu.load(id)`（读整条）、`lab.imu.segment('名字#段落')`（读一段及其标注）、`lab.imu.summary(id)`（各传感器的样本数和实际频率）。

**传感器档案**：在应用的 `inklab.config.json` 里写 `"sensorProfile": "rokid-rg1"`，模拟器就按 RG1 实测的样子提供传感器：没有磁力计（`start` 返回 `OperationError`）；加速度计、陀螺仪请求 60Hz 时给约 101Hz；姿态请求 10 或 30Hz 时给约 50Hz。默认是 `generic`：四个传感器都有，按请求的频率给。

> 外接蓝牙设备（手环、腕表等）发来的六轴数据不归这张卡管，用「蓝牙」卡片的「导入 trace」或脚本里的 `playNotificationTrace(...)`。

### 相机

- **模拟图片**（默认，`camera=mock`）：自动化测试一律用这个模式。`caps.media.loadPhoto('assets/example.png')` 从被测应用目录读图（文件不存在立即报错），也可以传 `Uint8Array`。装进来的图会排队，之后每次 `takePhoto()` 依次取一张；队列空了就一直返回最后一张。`enqueuePhoto(name)` 把已装过的图再排一次，`usePhoto(name)` 从现在起固定返回这一张。`failNext({ kind: 'denied' | 'notfound' | 'timeout' })` 让下一次拍照失败。
- **电脑摄像头**（手动，`?camera=computer`）：在「相机」卡片里切到「电脑摄像头」，浏览器会请求摄像头权限。应用调用 `takePhoto()` 时抓一帧返回，拍完立刻关掉摄像头。

### 蓝牙

引擎直接读浏览器的 `navigator.bluetooth`，InkLab 在这一层换成模拟设备（原理见 [runtime-notes.md](runtime-notes.md)）。

- **模拟蓝牙**（默认，`bluetooth=mock`）：自动化测试一律用这个模式。默认有一台 `InkLab Heart Rate` 心率设备。`caps.bluetooth.replaceDevices([...])` 换成自己的设备和服务树，`failNext('gatt.connect', ...)` 让下一次连接失败，`playNotificationTrace(...)` 高频回放通知数据。
- **电脑蓝牙**（手动，`?bluetooth=computer`）：用浏览器原生 Web Bluetooth 连真实外设。如果设备选择框没弹出来（跨引擎调用时丢了用户点击手势），点「蓝牙」卡片里的「选择真实设备」继续配对。页面热重载时会断开已有连接。

```js
// 应用连接并订阅后，推一帧心率通知（88 BPM）
__inklab.bluetooth.emitNotification({
  serviceUuid: 'heart_rate',
  characteristicUuid: 'heart_rate_measurement',
}, [0x00, 88]);

// 按固定间隔（20ms，即 50Hz）连续回放；也可以每帧写 { t, value } 按时间戳回放
const trace = __inklab.bluetooth.playNotificationTrace({
  serviceUuid: '6f1d0000-8f5b-4c7e-9a21-4a19f2b4c001',
  characteristicUuid: '6f1d0001-8f5b-4c7e-9a21-4a19f2b4c001',
  frames: [[1, 2, 3], [4, 5, 6]],
  intervalMs: 20,
});
trace.stats();   // running / completed / failed、已发帧数 emittedFrames、循环次数 loops
trace.stop();
```

在工作台「导入 trace」时，可以给十六进制字符串数组，或者带设备和时间轴的对象。所有帧要么统一用 `intervalMs`，要么都写递增的相对毫秒 `t`：

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

### 网络与外部请求

**外部请求默认挡下。** 本地跑的是应用的真实源码，很多应用一启动就会请求线上域名（拉天气、上报埋点），这时测试还没开始。为了不误碰线上服务，所有跟工作台不同源的请求默认不发出去，直接给应用返回 HTTP 503，网络日志里标成 `decision: 'external-stub'`。

需要放行时：

- 命令行加 `--allow-external <规则>`，可以重复写；
- 或者在应用目录的 `inklab.config.json` 里写 `{"allowExternal": ["https://tonedom.com/*", "wss://tonedom.com/*"]}`；
- 或者在工作台「网络」卡片里添加放行项（只在这个窗口会话里有效）；
- 脚本里用 `caps.net.allowExternal('域名或子串')`。

命令行和配置文件的规则会合并，启动应用前就生效，e2e 也读同一份。规则是普通字符串时按 URL 子串匹配；含 `*` 时按整条 URL 通配。大模型在 `live` / `record` 模式下，配置的接口地址自动放行。

要整个关掉拦截：URL 加 `?netguard=0`、取消「网络」卡片里的「挡外域」，或者调用 `caps.net.guardExternal(false)`。某个请求莫名返回 503 时，用 `caps.net.wouldStubExternal(url)` 查它是不是被拦了。

**模拟网络故障**（脚本里）：

```js
caps.net.offline();                               // 整体断网：关掉已有 WebSocket，中止进行中的下载
caps.net.online();                                // 恢复：只放开新连接，重连由应用负责
caps.net.block('/api/weather');                   // 按 URL 拦截
caps.net.delay('/api/', 3000);                    // 加延迟
caps.net.status('/api/score', 500, { body: '' }); // 返回指定状态码
caps.net.requests;                                // 请求日志（已脱敏）
```

规则优先级：整体断网 > `block` > `status` > 外部请求拦截 > 真实发出。也就是说，脚本里专门写过 `status` 的接口照常拿到模拟响应，没写过的外部接口才被拦成 503。

WebSocket 和 `fetch` 共用放行和拦截规则，但不模拟 HTTP 状态码、`rewrite` 和延迟。WS 日志记录连接、打开、关闭、关闭码和收发消息数，不记消息正文。`caps.net.networkState()` 返回当前的 WS 连接和下载进度。工作台自己拉源码的请求和热重载推送不受断网影响。

**清下载缓存**：「网络」卡片里的「清下载缓存并重载」会在重新装载引擎前清掉这个玩家的浏览器 OPFS，并重建引擎内存里的文件系统。应用存在 OPFS 里的其他文件（比如进度）也会一起清掉；localStorage 里的设备身份保留。浏览器 OPFS 和 Ink 自己的文件系统是两层，不要用浏览器 OPFS 的文件列表判断 Ink 里下载完没有，要看应用画面和网络日志里的完成记录。

### 大模型（LLM）

大模型请求是浏览器里的引擎自己发的，格式是标准 OpenAI `chat/completions`。InkLab 只告诉引擎接口地址、请求头和默认模型名（见 `lib/caps/llm.mjs`）。

**配置**（环境变量优先）：

- 环境变量 `INKLAB_LLM_ENDPOINT`（完整的 `chat/completions` 地址）、`INKLAB_LLM_API_KEY`（或用 `INKLAB_LLM_API_KEY_FILE` 指向密钥文件）、`INKLAB_LLM_MODEL`；
- 或者在 InkLab 仓库根目录建 `llm.local.json`（已被 git 忽略），写 `endpoint`、`model`、`apiKeyFile`。

不配置也能用：应用会收到「模型不可用」，走自己的离线逻辑。

**四种模式**（URL 参数 `?llm=off|live|record|replay`）：

| 模式 | 行为 |
| --- | --- |
| `off` | 没有模型，应用走离线降级。未配置接口时的默认值。 |
| `live` | 请求真实模型。已配置接口时的默认值。 |
| `record` | 请求真实模型，并把响应录进 `e2e/cassettes/` |
| `replay` | 离线回放录好的响应，不联网，不需要 API Key |

**故障注入**：`caps.llm.failNext({ kind: 'timeout' | 'http' | 'malformed', ... })` 让下一次请求超时、报错或返回格式错误的内容（优先于回放），用来测「模型配了，但这次请求出问题」的处理。

**思考型模型太慢**：有些模型默认开长思考，首字要 15 秒以上，会让应用 8 秒超时。在 `llm.local.json` 里加 `"requestDefaults": {"enable_thinking": false}`，工作台会把引擎的请求转到本地 `http://localhost:<端口>/llm/chat/completions`，补上引擎没传的默认字段。这里用 `localhost` 而不是 `127.0.0.1`，是因为引擎会挡掉和页面完全同源的请求地址（见 [runtime-notes.md](runtime-notes.md)）。

**按场景切换模式**：不同场景可以要不同的模式，比如一个测模型正常回复，一个测没配模型时的降级。在场景里声明 `llm`，跑到这个场景前自动切换：

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
| `mode` | `off` / `live` / `record` / `replay`。不写就用全局默认：存在 `e2e/cassettes/default.json` 时是 `replay`，否则是 `off` |
| `cassette` | `record` / `replay` 读写的录制文件，相对于被测应用根目录 |
| `model` | 固定写一个模型名，推荐 `'inklab-cassette'`。匹配录制时会对请求体（含 `model` 字段）算哈希；写死名字后，别的开发者和 CI 不用配同样的模型也能命中回放 |

优先级：命令行 `--llm` > 场景里的 `llm` > 全局默认。录制和回放三步：

```bash
# ① 录制：连真实模型跑一次，响应写进场景指定的 cassette（模型名会换成场景声明的 model）
inklab-e2e <app> --scenario llm-fc-intent --llm record
# ② 验证回放：直接再跑一次，自动用 replay，不联网
inklab-e2e <app> --scenario llm-fc-intent
# ③ 把生成的 cassette JSON 提交进 git，CI 就能离线稳定地跑
```

- 录制文件不含请求头和 API Key，可以放心提交。
- 报告 `e2e/report/last-run.json` 里，`llm.online` / `llm.offline` 分别列出联网和离线的场景，`llm.outcomes` 统计每种结果（`replay-hit` 命中、`replay-miss` 没命中、`fault:*` 注入的故障、`live:2xx` 真实请求成功）。
- 同一个场景在不同机器上请求内容有合理的小波动（比如计时器显示 30 秒和 35 秒，16 位请求哈希就不同）时，在录制条目里加 `aliases: ["另一个16位哈希"]` 共用一条响应。InkLab 不做模糊匹配，没登记的哈希一律算 `replay-miss`。
- `--llm live` 把所有场景强制切到真实模型。模型措辞每次不同，不要放进常规 CI；场景里可以看 `caps.llm.mode`，在 `live` 时只检查请求有没有正常往返，不比对具体文案。

### 电池

「电池」卡片可以改电量、充电状态和剩余时间，并向应用推送 `statuschange` 事件（AIUI 0.17 起支持）。脚本里用 `caps.battery.setStatus({ level: 0.15, charging: false })`，`level` 取 0 到 1。

### 能力探针应用

`fixtures/cap-probe-app` 用来给不同版本的引擎做「API 体检」。它逐项调用 AIUI 0.17 的接口，给出结论：`supported`（支持）、`partial`（部分支持）、`unsupported`（不支持）、`contract-drift`（行为和约定不符）。覆盖电池、本地文件系统（OPFS）、空间感知与姿态传感器和点头手势、媒体采集、语音合成、`table` / `timed-text` / `streamdown` 流式渲染、空源 `video` 组件的生命周期。

```bash
inklab-e2e fixtures/cap-probe-app --scenario aiui-017-conformance --runtime <lane> --no-video   # 检查一个引擎
inklab-matrix fixtures/cap-probe-app --scenario aiui-017-conformance --runtime <lane>,<lane>    # 对比几个引擎
```

## 写场景

场景是一个小 JS 模块，描述「按什么键、等多久、截什么图、检查什么」。应用自己的场景放在应用仓库的 `<app>/e2e/scenarios/*.mjs`，工作台的场景下拉框和 `inklab-e2e` 都会自动加载。跟具体应用无关的通用场景放在 InkLab 的 `scenarios/`（目前只有 `smoke`）。

最小的例子：

```js
// <app>/e2e/scenarios/open-settings.mjs
export default {
  id: 'open-settings',
  title: '打开设置页',
  summary: '从首页往下移 5 次，进入设置，截图。',
  build({ caps, lab }) {
    return [
      { wait: 800, label: '等首屏' },
      { pressMany: ['ArrowDown', 5] },
      { activate: true, label: '进入设置' },
      { shot: 'settings' },
      { expect: () => lab.pagesLoaded().includes('pages/settings/index') || '没有进入设置页' },
    ];
  },
};
```

每一步写一种动作，可以加 `label` 让报告更好读：

| 步骤 | 作用 |
| --- | --- |
| `{ press: 'ArrowDown' }` | 按一次键：`ArrowUp` / `ArrowDown` / `ArrowLeft` / `ArrowRight` / `Enter` / `Backspace` 等 |
| `{ pressMany: ['ArrowDown', 5] }` | 同一个键连按几次 |
| `{ activate: true }` | 按 `Enter` 确认，并等新页面的冷却期过去 |
| `{ back: true }` | 返回 |
| `{ wait: 1000 }` | 等待毫秒数 |
| `{ wake: true }` | 语音唤醒；也可以写唤醒词 `{ wake: '你好' }` |
| `{ shot: 'name' }` | 截图，并和基线比对；动态区域的写法见[截图基线](#截图基线) |
| `{ expect: () => … }` | 检查：返回 `true` 算通过，返回字符串就是失败原因 |
| `{ do: async () => … }` | 执行任意代码，比如注入语音、放轨迹、切断网络 |

`build()` 拿到的参数：

| 参数 | 内容 |
| --- | --- |
| `caps` | 各硬件模拟器，见[模拟硬件](#模拟硬件) |
| `lab` | 观测工具：`pagesLoaded()` 到过的页面、`frameHash()` 当前画面指纹、`framePixels()` / `compareFrame()` 取像素和比对、`logTail(n)` 最近的引擎日志（排障用）、`imu` 工程轨迹 |
| `view` | 引擎实例 |
| `players` | 多玩家时的每个玩家，见[多玩家](#多玩家) |

几条经验：

- **断言优先看应用实际调用了什么**（`caps.*.calls`）或比截图。不要依赖引擎日志里的 `onLoad` 耗时：那是采样打印的，方法跑得快就不打（见 [runtime-notes.md](runtime-notes.md)）。
- **按键时序已经处理好**：应用对同方向的连续按键有约 700ms 防抖，脚本连按方向键时驱动层会自动推进事件时间戳；确认进新页面后，应用有约 1.2 秒冷却期，`activate` 会真实等待 1.3 秒以上。脚本里不用自己加等待。
- 场景模块还可以写 `llm` 字段，按场景切换大模型模式，见[大模型（LLM）](#大模型llm)。

## 跑自动化测试

InkLab 只是测试运行器，测试资产都放在被测应用自己的仓库里：

```text
<app>/e2e/
  scenarios/*.mjs      # 场景
  cassettes/*.json     # 大模型录制（不含请求头和 API Key，可以提交）
  baselines/           # 截图基线：<场景id>/<截图名>.png，以及同名 .json 指纹
  traces/*.json        # IMU 轨迹（可选）
  report/              # 每次运行的报告和录屏（不要提交）
```

```bash
inklab-e2e <app>                                   # 在无头 Chrome 里跑全部场景
inklab-e2e <app> --scenario open-settings          # 只跑一个场景
inklab-e2e <app> --accept                          # 把这次的截图存成新基线
inklab-e2e <app> --no-video                        # 不录屏（默认录）
inklab-e2e <app> --headed                          # 打开可见的浏览器窗口，方便排障
inklab-e2e <app> --runtime daily                   # 指定引擎：latest / daily / studio 或具体 lane id
inklab-e2e <app> --preview optical --lighting indoor-bright   # 真机竖屏视图 + 室内明亮环境
inklab-e2e dist/pkg.aix --scenario smoke --report-dir /tmp/pkg-smoke   # 直接测发布包
```

（在 InkLab 仓库里也可以写成 `npm run e2e -- <app> …`。）

跑一次大致是：在随机端口起本地服务 → 相机和蓝牙强制用模拟模式 → 启动系统 Chrome（`--headless=new`，固定 2 倍像素，保证不同机器截图一致）→ 每个场景前重新加载页面，隔离上一个场景的引擎和蓝牙状态 → 执行步骤、比对截图 → 写出 `<app>/e2e/report/last-run.json`。

任一步失败、截图差异超标，或者基线指纹过期（`stale`），命令都以非零退出码结束，可以直接接 CI。

### 截图基线

`--accept` 存下的基线带一个指纹：源码内容哈希、引擎版本、WASM 哈希、画布尺寸、视图和环境、场景 id、能力夹具 id（不含 git commit、时间和分支名）。源码或引擎变了而基线没更新时，比对结果标成 `stale` 并报错，防止拿旧截图冒充新代码的通过证据。换了引擎后看到 `stale` 是提醒你在新引擎上重录，不是故障。

默认整张图逐像素严格比对。页面上有倒计时、实时波形这类必然变化的区域时，给这一张截图单独设容差（`tolerance`）或忽略区域（`ignoreRegions`，忽略的像素不计入差异比例）：

```js
{
  shot: {
    name: 'set-live',
    diffOptions: {
      tolerance: 1,
      ignoreRegions: [{ x: 20, y: 490, w: 920, h: 145 }],
    },
  },
  label: '实时计次页截图',
}
```

### 多个引擎 × 多种环境一起跑

```bash
inklab-matrix fixtures/cap-probe-app --scenario aiui-017-conformance --runtime <lane>,<lane> --all-lighting
```

同一个场景在几个引擎版本（以及三种环境光）上各跑一遍，汇总出差异报告。

## 引擎版本

引擎会不断发新版：npm 上的 `@yodaos-pkg/ink` 用 `latest` 标签发正式版、`daily` 标签发每日构建；AIUI Studio 和 Craft 网页里嵌的构建更旧，随网站更新。

- **lane**：本机记下的一个引擎构建，比如 `npm-ink-0.21.0`。记在 `runtimes.lock.json` 里，带来源、版本号和 SHA-256。lane 一旦记下就**不再修改**，保证结果可以复现。
- **通道**：指向「最新的那条 lane」的名字，每次按本机已缓存的 lane 现算：`latest`（版本最高的正式版）、`daily`（版本最高的任意构建）、`studio`（Studio 网页来源里版本最高的）。同号版本优先用 npm 官方包。

**默认用 `latest`。** 项目要跟真机对齐（比如真机已经是每日构建）时，在应用目录的 `inklab.config.json` 里写 `"runtime": "daily"`，工作台和 e2e 都会以它为默认。优先级从高到低：`--runtime` / `?runtimes=`、环境变量 `INKLAB_RUNTIME`、`inklab.config.json` 的 `runtime`、`latest`。

项目脚本里写通道名，引擎更新后不用改项目；要复现某次旧结果时才写具体的 lane id。

**并排对比**：在预览左上角「引擎」菜单里勾选几个引擎，或者打开 `?runtimes=<id>,<id>`，画面上用「主」「2」……标出各条 lane。每条 lane 有独立的引擎、画布和能力模拟器；勾选「镜像输入」后，按键、语音唤醒和场景脚本会同步发给所有画布。

**自动更新**：`inklab`、`inklab-e2e`、`inklab-matrix` 启动时会查一次 npm（一天最多一次，记在 `.engine/update-check.json`），`latest` 或 `daily` 有新版本就自动下载并记成新 lane。查不了只打一行警告，照常用本机已有的引擎。`INKLAB_NO_UPDATE=1` 关掉检查（CI 想完全离线时用），`INKLAB_UPDATE=force` 立即检查，`INKLAB_NPM_REGISTRY` 换镜像。

```bash
inklab-engine                  # 检查 npm 和官方站点，新版本记进清单（第一次会创建清单），并下载缺的文件
inklab-engine <lane>           # 同样先检查，但只下载指定的 lane（可以写多个）
inklab-engine --list           # 不联网：列出本机的 lane、哪些已缓存，以及三个通道各指向哪条
inklab-engine --check          # 不联网：校验本地文件和清单里的哈希是否一致
inklab-engine --discover       # 只看线上有没有新版本，不写文件（没有返回 0，有返回 2，检查失败返回 1）
```

<details>
<summary>新版本是怎么发现和记录的</summary>

1. **发现**：先查 npm（`@yodaos-pkg/ink` 的 `latest`、`daily` 标签）。版本还没有 lane 时下载 tarball，按 `integrity` 校验后整包解到 `.engine/runtimes/npm-ink-<版本>/`，lane 里记下 `tarballUrl` 和 `tarballIntegrity`，缓存丢了可以重新下载。再查 Craft（`https://js.rokid.com/craft`）和 AIUI Studio（`https://aiui.rokid.com/`）两个站点；用 `--site=[<名字>=]<url>` 可以只查指定站点，这时不查 npm。站点构建靠比对胶水 JS 的 SHA-256 判断是否已经记过，没有新构建时只拉轻量的入口 JS，不会重复下载很大的 WASM。
2. **只追加，不覆盖**：发现新构建时下载 WASM、算哈希、提取版本号，按 `<来源>-<版本>` 命名（比如 `npm-ink-0.20.0`、`craft-0.19.0-daily.202609230326`；站点构建同名但内容不同时自动加上哈希前 8 位），追加到 `runtimes.lock.json` 末尾，文件缓存在 `.engine/`。条目的 `label` 可以随便改，不影响缓存识别和截图指纹；改 `id` 会让项目里写死的这个 id 失效，所以项目里尽量写通道名。
3. **容错**：某个来源访问不了只打警告，继续检查其他来源，并按现有清单下载。手改 `runtimes.lock.json` 出现 JSON 语法错误时，会直接报错并指出位置。

</details>

<details>
<summary>手动添加一个引擎版本</summary>

自动发现只认带独立胶水 JS 的构建。遇到站点改版或其他来源的构建，可以手动加一条：

1. 在浏览器打开目标站点，用开发者工具的 Network 面板找到 `ink_web_bg-*.wasm`，以及加载它的胶水 JS（里面有 `createInkView` 和 `initInk`），记下两者的完整 URL。
2. 下载这两个文件，用 `shasum -a 256` 分别算出 SHA-256。
3. 从 WASM 里提取引擎版本号（输出的 `version`、`build` 分别填进清单的 `engineVersion`、`engineBuild`；非 daily 版本 `build` 是 `null`）：

   ```bash
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { extractEngineVersion } from './lib/node/engine-version.mjs'; console.log(extractEngineVersion(readFileSync(process.argv[1])))" engine.wasm
   ```

4. 在 `runtimes.lock.json` 数组里加一条，字段顺序为 `id`、`label`、`channel`、`cacheDir`、`source`、`fetchedAt`、`engineVersion`、`engineBuild`、`glueUrl`、`glueSha256`、`wasmUrl`、`wasmSha256`。其中 `id`、`engineVersion` 或 `engineBuild`、`glueSha256`、`wasmSha256` 必填；需要自动下载时填 `glueUrl`、`wasmUrl`；源站链接已失效、只用本机已有缓存时加 `cacheOnly: true`。npm 包的版本不用手写，`inklab-engine` 会自动收录，它的条目用 `tarballUrl`、`tarballIntegrity` 代替 `glueUrl`、`wasmUrl`。保存后运行 `inklab-engine <新 lane id>` 验证。

</details>

## 多玩家

测多人联机时，一个工作台里可以开 1 到 6 个互相独立的玩家：

```bash
inklab <app> --players 2 --allow-external tonedom.com --open
inklab-e2e <app> --players 4 --allow-external tonedom.com --scenario multiplayer
inklab-e2e fixtures/cap-probe-app --players 6 --scenario multiplayer --no-video   # 通用隔离探针，不需要公网
```

也可以在 URL 加 `?players=2`。

- **相互隔离**：每个玩家是独立的 iframe、引擎、能力模拟器和设备身份；浏览器 localStorage、sessionStorage、OPFS 按应用路径和玩家编号隔离。同一个玩家在独立窗口里打开，沿用原来的身份。
- **只选一个引擎**：多玩家和多引擎并排二选一。多条 lane 是给同步输入做版本对比用的，不负责多人联机。
- **切换当前玩家**：点玩家画面、按 `Alt+1`…`Alt+6`，或在玩家画面有焦点时按 `Tab`（`Shift+Tab` 往回）。按键、点头、摇头，以及展开的控制面板，都只作用于当前玩家。
- **单独窗口**：把当前玩家移到新窗口，避免两个活实例共用同一个设备身份；关掉窗口后回到原来的格子。
- **性能**：多玩家用 1 倍画布、约 20fps。每格显示 WebSocket 状态和下载进度。六个人同时跑时，还要看应用本身的 CPU 和内存开销。

场景照样放在 `<app>/e2e/scenarios/`，用 `players` 分别驱动：

```js
export default {
  id: 'two-player', title: '双人', summary: '分别驱动两个玩家',
  build({ players }) {
    return [
      { label: '两位玩家分别确认', do: async () => {
        await players[0].press('Enter');
        await players[1].press('Enter');
      } },
      { label: '分别截图', do: () => {
        players[0].shot('host'); players[1].shot('guest');
      } },
    ];
  },
};
```

`players[i]` 从 0 编号，有 `press`、`sendInput`、`shot`、`caps`、`view`、`driver`、`lab`、`window`、`clearCache`。用 `players[i].caps.sensors` 控制这个玩家的姿态，`players[i].caps.net.offline()` / `online()` 控制它的网络。`shot` 会自动加上 `player-N--` 前缀，进入同一份截图报告；源码指纹里带上玩家数，不会和单人基线混用。主玩家仍然负责场景报告、录屏和基线；e2e 的网络汇总覆盖所有玩家。

## 自动化接口

工作台在页面上暴露了 `window.__inklab`，可以在浏览器 DevTools 控制台里用，也可以通过 CDP 调用（`inklab-e2e` 就是这么驱动的）：

```js
__inklab.press('Enter')                          // 按键：校验参数、手动推进一帧、同步到并排画布
__inklab.wake('inklab')                          // 语音唤醒
await __inklab.runScenario('open-settings')      // 跑一个场景，返回结构化结果
await __inklab.runScenario('open-settings', { record: true })  // 跑场景并下载录屏
__inklab.snapshot('name')                        // 截取当前画面（返回带 dataUrl 的对象）
__inklab.snapshotMatrix('name')                  // 给勾选的每个引擎各截一张
__inklab.setPreviewMode('optical')               // 切到 480×640 真机竖屏视图
__inklab.setLighting('night-low-light')          // 切换环境光
__inklab.startRecording({ name: 'free-demo' })   // 开始录屏（30fps）
await __inklab.stopRecording()                   // 结束录屏并下载
__inklab.exportRun()                             // 导出完整证据：源码哈希、引擎锁、时间线、网络日志、截图
__inklab.conformanceReport()                     // 导出探针应用的能力支持度报告
__inklab.view                                    // 主画面的引擎实例
__inklab.caps.speech.calls                       // 语音能力的调用记录
__inklab.bluetooth.calls                         // 蓝牙扫描、连接、订阅、读写记录
__inklab.players                                 // 多玩家时的玩家列表；selectPlayer(i) 切换当前玩家
```

> ⚠️ **不要绕过 `__inklab.press()` 直接调 `view.dispatchInput(...)`**。标签页在后台或窗口被挡住时，浏览器会暂停渲染帧，直接调 `dispatchInput` 只有第一次按键生效。`__inklab.press()` 每次按键后会主动推进一帧（原理见 [runtime-notes.md](runtime-notes.md)《焦点与帧》）。

## 原理与边界

### InkLab 是怎么跑起来的

Rokid 的 Craft 网页并不是服务端渲染：它把眼镜上的 Ink 运行环境（QuickJS 跑逻辑，Skia 画界面）编译成 WebAssembly（`ink_web`），放在浏览器里跑。只要给它一块 `<canvas>` 和一组硬件能力回调，它就能自己解析 `.ink` / `.js` / `app.json`、排版、处理按键。

InkLab 加载的是同一个 `ink_web` 引擎，只是**把硬件和系统能力换成了可控的模拟器**。Craft 只能手动点着看，InkLab 可以用脚本注入语音、传感器、蓝牙和网络故障，所以能做自动化测试。

```text
应用源码目录 ──打包快照──▶ ink_web (WASM) ──渲染──▶ <canvas>
 或 .aix 包                    ▲
            硬件与系统能力（语音 / 相机 / LLM / 传感器 / 网络）── InkLab 模拟器提供
            navigator.bluetooth（模拟设备 / 电脑蓝牙）     ── 独立的浏览器桥接
```

### 哪些是真的，哪些是模拟的

- **真的**：应用的 `.ink` 界面解析、JS 逻辑（QuickJS）和画布绘制（Skia / WASM），都由真实的 `ink_web` 引擎执行。
- **模拟的**：AR 眼镜的镜片上，黑色像素不发光，等于透明，人眼会透过它看到现实环境。「真机模拟 · 竖屏」视图把画布上的黑色抠成透明，叠在环境背景图上（算法见 [runtime-notes.md](runtime-notes.md)）。它能帮你提前发现「文字太暗，白天看不清」这类对比度问题，但还原不了光机的真实亮度、镜片色偏和人眼适应，最终效果仍然要戴上真机看。

### 测试边界

InkLab 用的是 Rokid 发布的同一个渲染引擎，**它能替代在 AIUI Studio / Craft 网页里手动点测，但不能替代戴上真机测试**。光学显示、整机功耗、传感器的真实精度、麦克风收音和 TTS 播报、蓝牙射频和固件稳定性，仍需要在真实眼镜上验收（见 [USB 连真机](device.md)）。

另外，浏览器里没有全局的 `BarcodeDetector`，引擎只给静态 `barcode` 模块注入了构造器。所以模拟器里只能测到「取帧扫码但没识别出内容」这条分支，扫码成功的完整流程要在 Craft 或真机上验证。
