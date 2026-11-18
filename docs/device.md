# USB 连真机

InkLab 支持通过 USB 在已连接的真实眼镜上执行测试场景。这是**可选功能**：普通启动不会调用 ADB，必须显式加上 `--device` 参数才会启用。

## 前置条件

- 电脑已安装 `adb`（可通过 `ADB` 环境变量指定路径）和 `ffmpeg`（用于实时投屏视频解码，可通过 `FFMPEG` 环境变量指定路径）。
- 「推到真机」要打包，需要本机装好 `aiui` 命令（aiui-toolkit 里 `npm run install-cli`）；没装时也可以直接给打好的 `.aix`。
- 截图文字自动识别（OCR）依赖 macOS 系统自带的 Vision 接口；在其他操作系统上仍能正常操作和截图，但包含文字识别断言（`expectText`）的场景会标记为 `unsupported`。
- 用 USB 连接已授权调试的眼镜（眼镜里打开 adb 调试；没打开时 `dumpsys`、`input` 等命令会被直接断开）。
  也可以无线调试：见下面「无线调试（不插线）」。
- 如需向应用直接发送语音识别文本，应用需配置设备控制脚本，见[应用提供的设备适配器](#应用提供的设备适配器)。

## 启动真机工作台

```bash
inklab <app> --device --serial <serial> [--device-output DIR]
# 浏览器打开 http://127.0.0.1:8788/device ，或点击顶部模式栏的「USB 真机」
```

- **设备识别**：选中眼镜后，顶部显示型号、Android 版本、眼镜上的 Ink 版本（`debug.rokid.ink.version`）、对应的模拟器引擎和触控板档案，并逐条提示会让测试失真的状态：
  - 佩戴检测判定没戴：触控板进入低功耗，真手势不上报（InkLab 回放的手势不受影响）；
  - 有无障碍服务在接管按键（例如 Quick Menu 会拦长按镜腿）；
  - AIUI 开发者模式没开（推送、打开时会临时打开，用完恢复原值）。
- **真机 + 模拟器并排**：从任一工作台顶部点「真机 + 模拟器」，或打开 `/device?simulator=1`。模拟器的引擎自动对齐眼镜上的 Ink 版本：构建号一致的优先，其次同一版本号（优先正式版）、同一版本线（major.minor）。勾选「真机手势同时发给模拟器」后，手势按钮会同时在模拟器上按下触控板真实会发的那几个键（前后滑各带两个方向）。
- **推到真机**：点「推到真机」依次完成打包（`aiui build`）→ 安装调试包 → 打开选中的页面（前台有全屏应用挡着时让它退下，见下）→ 等第一帧 → 截图（画面还是黑的就等一会儿重拍）。安装走固件开发者接口 `content://com.rokid.aiui.develop`，和官方 `aix install` 同一套协议（`prepare` 拿到收件目录 → 推 `package.aix` 与 `agent.json` → `apply` → `status`），装好后再核对 `developer_manifest.json` 里的 MD5；打开走 `content://com.rokid.aiui.develop` 的 `open`，并从 AIUI 运行时日志确认它真的显示到了全屏（只看这次操作之后的日志：眼镜的日志缓冲只有 1 MiB，很快被冲掉，不能靠更早的记录推断前台）。这是本机调试安装，与 Studio 发布分开，不能当作已发布的证据。
- **保存即推送**：默认开启。被测工程是源码目录且选了设备时，保存源码会自动推一次；推送进行中又保存的，结束后合成一次再推。可在推送面板取消勾选，或在 `inklab.config.json` 写 `"device": { "autoPush": false }`。
- **推送前先关掉助手**：推送和「只打开」在打开之前，先连续真双击把 AI 助手整个关掉（每一下都等日志确认走完这一步：退回卡片 → 结束这一轮 → 关掉），助手里之前推送留下的旧实例这时一起销毁，结果写在推送状态的 `reclaimed` 里（`dropped` 是销毁的实例数）。助手本来没开就不双击。实测连推三次整活，每次都销毁上一个实例；前台是旧实例时一次推送约 17–20 秒。
- **前台被挡着**：AIUI 同一时间只显示一个全屏应用，新打开的实例**不会顶掉**已在前台的实例——自己的旧实例也一样。上面关掉助手这一步没关成时（比如应用弹了退出确认），还按原来的办法兜底：打开后等不到显示，就做一次真双击（应用收到返回）；看到前台开始退回就等它退完（约 2 秒），排着的新实例会自动显示，等不到就重新打开一次；应用把返回当成「上一层」时再双击，最多 4 次。退回过程中不连续双击（会把助手整个关掉，排着的实例也丢了），也不替应用去点「退出吗？」的确认。实测整活、出招吧在各自菜单、别的应用在前台、自己的旧实例在前台三种情况下都能显示出新包。
- **触控板手势**：手势按钮（向前滑、向后滑、单击、双击、长按）直接往触控板设备写原始按键，系统收到的和手指操作完全一样（扫描码、来源设备都一致）。时序取自实测：每次接触先发 `KEY_DASHBOARD`（系统里是 `KEYCODE_NOTIFICATION`）；单击约 0.5 秒后发 `ENTER`；双击发 `BACK`；长按发 `PROG1`（`KEYCODE_PROG_BLUE`）；前滑同时发 `RIGHT` 和 `DOWN`，后滑同时发 `LEFT` 和 `UP`。眼镜 10 秒熄屏，熄屏时的第一个键只会唤醒屏幕，所以每个手势前先确认屏幕亮着。没有触控板档案的设备退回 `input keyevent`（双击、长按做不了）。
- **真机日志**：工作台实时显示眼镜上与 AIUI 有关的日志，分三类：应用自己的 `console`（`ink_script::console`）、AIUI 运行时事件（打开、全屏、退回卡片等，压成一行）、Ink 引擎日志（默认收起）。推送结果和场景报告里会附上这段时间的应用日志与告警、错误。
- **眼镜上的调试包**：推送面板里可以展开开发者通道的调试包列表，点「打开」直接打开（别的调试包从它 `app.json` 的第一页打开）。手机同步装的智能体在系统私有目录，adb 读不到名字，不在列表里。
- **远程操作与截图取证**：网页直接展示 ADB 从眼镜端截取的完整原始 PNG（`480×640`），右侧同步展示执行步骤、真实截图、OCR 识别出的文字和最终测试报告。
- **实时投屏**：点击「开始实时投屏」后，眼镜端通过 `screenrecord` 连续输出 `480×640` 的 H.264 视频流，由本机 `ffmpeg` 实时解码后推送到浏览器显示（无需循环调用慢速的 `adb screencap`）。界面会显示实时帧率（FPS）、画面刷新间隔以及本机解码到浏览器渲染的耗时（注：该耗时不包含眼镜端编码与 USB 传输时间）。投屏画面经 JPEG 压缩仅用于流畅预览，测试报告中的截图证据始终使用独立的无损 PNG。由于 Android 系统限制单次录屏时长，服务每 165 秒会自动无缝重连一次视频流。
- **录制演示视频**：点击「录制视频」可直接将浏览器中的投屏画面录制为无声 MP4（不支持 MP4 的浏览器自动降级为 WebM），不会额外增加眼镜端的编码负担。结束录制后视频自动保存到 `<输出目录>/recordings`（单文件上限 64 MiB，自动记录文件大小与 SHA-256；默认位于系统临时目录 `inklab-device-runs/` 下，可通过 `--device-output DIR` 自定义保存目录）。
- **进程清理与安全限制**：停止投屏、关闭网页、连接断开或退出服务时，InkLab 会自动清理本次启动的眼镜端 `screenrecord`、`logcat` 和本机解码进程；投屏期间仅在无操作时发送临时唤醒信号防息屏，不会修改眼镜系统的常亮设置。本地服务仅监听 `127.0.0.1`，所有设备控制请求均校验同源 Origin 与当次会话 Token。

### 调试包的身份

调试包的 agentId 必须是 `develop.rokid.<业务>.<id>`（官方 aix 的格式要求）。官方 `aix install` 装 `.aix` 时会改用包里写死的 ID（`aiui build` 每次打包都不同），所以 InkLab 直接用同一套协议、但保持固定 ID。默认按项目名生成 `develop.rokid.inklab.<项目>`（应用目录叫 `app` 时取上一级目录名，去掉 `aiui-` 前缀），名字取 `app/AGENTS.md` 的 Name 加「（调试）」，权限按 `app.json` 补齐 Studio 的写法。可以在应用目录的 `inklab.config.json` 里覆盖：

```json
{
  "device": {
    "agentId": "develop.rokid.inklab.zhenghuo",
    "agentName": "整活派对（调试）",
    "page": "pages/index/index",
    "autoPush": true
  }
}
```

可写的字段：`agentId`、`agentName`、`agentPrompt`、`page`（默认打开哪页）、`autoPush`、`permissions`、`inkVersion`、`nativeVersion`。同一个 agentId 重推时系统回执 `UPDATED`，不需要改版本号。

## 命令行无头运行

不开浏览器也能操作眼镜（连着一台设备时可省略 `--serial`）：

```bash
inklab-device info                               # 型号、Ink 版本、对应的模拟器引擎、触控板档案和警告（有警告时退出码 2）
inklab-device push <app> [--page pages/x/index]  # 打包 → 安装调试包 → 打开 → 截图（没显示到前台时退出码 2）
inklab-device open <app> [--page pages/x/index]  # 只打开本工程的调试包
inklab-device open --agent <agentId> --page <页面>  # 按 ID 打开任意已装的智能体
inklab-device exit                               # 连续真双击把助手整个关掉（回收所有实例），并核对
inklab-device gesture <tap|double-tap|long-press|forward|backward|wake> [--hold-ms 1000]
inklab-device agents                             # 列出开发者通道的调试包
inklab-device push <app> --imu replay --trace <轨迹名[#段落]> [--loop]   # 推模拟 IMU 回放包（见下）
inklab-device imu-record <app> --name <轨迹名> [--seconds 30] [--push]  # 录制模式：收真机读数存成轨迹
inklab-device imu-guide [<app>] [--name <轨迹名>]                       # 引导录制：眼镜上逐段提示动作
inklab-device wifi [--off]                                            # 无线调试：插着线时打开，之后可以拔线
```

### 无线调试（不插线）

戴着眼镜录 IMU、走动测试时，线很碍事。眼镜和电脑连同一个 Wi-Fi 后，插着线跑一次：

```bash
inklab-device wifi
```

它把眼镜的 adb 切到 TCP 模式（`adb tcpip 5555`），再经 Wi-Fi `adb connect <眼镜 IP>:5555` 并核对，之后就可以拔线。

- 插着线时 `adb devices` 里同一台眼镜有两行。只连着这一台时，所有 `inklab-device` 命令会按 `ro.serialno` 认出是同一台，
  自动用 Wi-Fi 那个，所以录到一半拔线也不断；工作台里手动选 `IP:5555` 那一项。
- 日志流断了会每 2 秒重连一次，从断开前最后一行的时刻接着读，不重复也不漏。眼镜的日志缓冲区只有约 1 MiB，
  录 IMU 时大约能保住最近一分钟：断得更久，中间的读数就没了。存轨迹时会报出哪个传感器有断档、最长多久，断档落在要用的段落里就重录那段。
- 不替你开 Wi-Fi，也不替你连网络（要输密码）：眼镜没连上 Wi-Fi 时照实说。
- TCP 模式不持久，眼镜重启后回到只走 USB，要插线再跑一次。`inklab-device wifi --off` 关掉无线调试。
- 地址记在 `~/.cache/inklab/wifi-adb.json`。adb 服务一重启（别的工具重启它，或你手动 `adb kill-server`）就会忘掉无线连接：
  之后命令发现一台设备都没有、或只插着这副眼镜的 USB 时，会按记下的地址自动连回去。
- 一直开着的 adb 服务可能卡住：USB 和 Wi-Fi 都列不出来，`adb connect` 报 `No route to host`，可 ping 和端口探测都通。
  这时运行 `adb kill-server` 再试（2026-11-18 在跑了 11 天的 adb 服务上遇到过）。
- RG1（Android 12 user 版）实测（2026-11-18）：`adb tcpip` 可用，电脑原来的调试授权直接有效，眼镜上不用再确认；
  Wi-Fi 下推送、手势、关助手都正常，截一张图约 0.6 秒。录制中途断开 adb 连接，重连后数据完整（33 秒加速度计 3339 条，101 Hz，无断档）。

运行真机场景：

```bash
inklab-device <app> --list
inklab-device <app> \
  --serial <serial> \
  --scenario device-greeting-readonly --scenario menus \
  --out /tmp/inklab-device-runs
```

连接多台设备时必须通过 `--serial` 指定设备序列号。原始截图与测试报告 `run.json` 默认保存在系统临时目录 `inklab-device-runs/` 下，可通过 `--out DIR` 指定输出目录。由于真机截图可能包含个人隐私数据，建议保存在未被 Git 跟踪的本地目录中。

## 模拟 IMU

眼镜是 user 版系统，adb 往 Android 传感器里注入数据做不到，AIUI 宿主也没有替换传感器的入口。所以 InkLab
在**调试包里**换掉传感器：推送时把应用复制到临时目录，给用到 `AbsoluteOrientationSensor`、`Accelerometer`、
`Gyroscope`、`Magnetometer` 的脚本开头加一行 `import`（同名导入在模块里遮住引擎原生类；直接给 `globalThis`
赋值改不到页面里写的类名，模拟器 0.20/0.21 与 RG1 实测），再从临时目录打包。你的源码不动，包装完就删；
调试包名字带上模式（如「整活（调试·IMU 回放）」）。`aiui build` 遇到这种带 `__inklab__/` 的包会拒绝，防止当发布包打。

| 模式 | 眼镜上的传感器 | 用途 |
|---|---|---|
| 真实（缺省） | 真传感器 | 正常调试 |
| 回放 | 选中的轨迹（或其中一段）打进包里，传感器每次 `start` 都从头放；轨迹里没有的传感器照常用真数据 | 不戴眼镜也能复现「那一次」点头、深蹲 |
| 实时 | 经 `adb reverse` 用 WebSocket 连回工作台，随时下发轨迹、注入故障、回到真传感器 | 边看画面边换动作；要工作台在跑 |
| 录制 | 真传感器照常给应用，读数分批写进日志，InkLab 收下来存成轨迹 | 录真机数据给模拟器和回放用 |

工作台真机页的「模拟 IMU」面板：选模式（回放 / 实时选轨迹和段落）→「切换并推送」。录制模式下可以「存成轨迹」
（全部或最近 N 秒）、「打标记」；实时模式下可以「下发播放」「回到真传感器」「注入故障」。

轨迹存在工程的 `e2e/traces/<名字>.json`（格式见 `lib/imu-trace.mjs`：多传感器、按真机时间戳存、带段落与标记），
模拟器里用 `await lab.imu.play('名字#段落')` 或传感器面板的「工程轨迹」放同一批文件。

**引导录制**：`inklab-device imu-guide <app>` 把 InkLab 自带的「IMU 引导录制」推到眼镜上，逐段提示动作
（静止 30 秒、方向核对、正常 / 轻微 / 快速点头、低头看东西、摇头、左右看、歪头、说话、走动，最后 2 分钟静止可跳过）。
单击开始一段，向前滑跳过，向后滑重录上一段，双击退出。每段先倒数 3 秒（也录，算动作前的静止引子），
段落带「这段应该识别出几次」的标注（如 `{ "nod": 5 }`）。录完存成 `<app>/e2e/traces/guided-<时间>.json`。
读数是实时经日志传回电脑的，所以全程要连着：插线，或者先 `inklab-device wifi` 再拔线（见「无线调试（不插线）」）。

真机实测（RG1，Ink 0.20）：

- 加速度计、陀螺仪请求 60Hz 实际给约 101Hz；姿态（Game Rotation Vector）请求 60Hz 给 60Hz，请求 10 或 30Hz 却给约 50Hz；
  偶尔有时间戳相同的重复读数。录制按真机时间戳原样存，不重采样。
- 没有磁力计：`Magnetometer` 的 `start` 回 `OperationError`。
- `sensor.timestamp` 是开机时钟毫秒，不是 `performance.now()`；姿态是相对的，静止时也不是单位四元数。
- 全屏应用在前台时屏幕不会熄（不碰触控板 160 秒以上也亮着），录长静止段不用改熄屏时间。

限制：

- 只换得掉应用自己 `new` 出来的传感器。World Awareness（`enableWorldAwareness` / `onHeadGesture`）用引擎内部的传感器，
  调试包里换不掉；它的识别逻辑在引擎里，模拟器和眼镜是同一份，用录下来的轨迹在模拟器里测。
- **旧实例要等助手完全关掉才销毁**：每推一次新包都会新建一个实例，旧实例退回卡片后照样在跑（定时器、传感器、日志都在）；
  再打开同一个或别的应用、卸载调试包都不回收。从全屏连续双击三次才会回收：第一次退回卡片，第二次结束这一轮对话
  （`userExit`），第三次关掉助手（`dismiss clearModeData=true`），这时助手里的所有实例一起 `Dropping Ink instance`。
  所以 InkLab 推送、打开、退出时都先这样关掉助手（见上面「推送前先关掉助手」）。模拟 IMU 包每一版都带编号：录制时只收当前这一版的读数；
  实时模式下 InkLab 会让旧版本的实例调用 `wx.exitMiniProgram()` 退出（退回卡片的实例这样能真正销毁）。

## 应用提供的设备适配器

InkLab 仓库自身**不内置**特定产品的 ADB 控制脚本：如何在真机上给特定应用注入语音文字或触发按键，由应用自己的脚本决定。在被测应用根目录下创建 `inklab.device.json`：

```json
{
  "profile": "my-app",
  "asrText": true,
  "controlScript": "scripts/glasses-control.mjs"
}
```

| 字段 | 含义 |
| --- | --- |
| `profile` | 写入真机测试报告的配置名称，默认为 `generic`。 |
| `asrText` | 是否支持直接注入语音识别文字。必须显式设为 `true` 才允许执行 `say` 步骤；默认为 `false`（此时包含 `say` 的真机场景在运行前会被标为 `unsupported`）。 |
| `controlScript` | 控制脚本路径（相对于被测应用根目录），默认为 `scripts/glasses-control.mjs`。 |

有触控板档案的眼镜上，按键与长按唤醒由 InkLab 直接用真触控板手势完成，不再调用适配器；适配器只负责 `say` 文字注入，以及没有触控板档案时的按键与唤醒。

InkLab 会按以下命令行格式调用该脚本（单次调用超时时间为 120 秒）：

```bash
node <controlScript> <command> [value] --serial <序列号> --wait-ms <毫秒> [--capture <PNG 保存路径>]
```

| command | value | 脚本需要完成的操作 |
| --- | --- | --- |
| `key` | `left` `right` `up` `down` `enter` `back` `wake` | 通过 ADB 向眼镜发送对应按键 |
| `say` | 1–180 UTF-8 字节的文本 | 将文本作为语音识别（ASR）结果发给应用（仅当 `asrText: true` 时调用） |
| `capture` | 无 | 截取眼镜当前屏幕的完整 PNG 并写入 `--capture` 指定的路径 |
| `wake-assistant` | 无 | 模拟镜腿触控板长按以唤醒语音助手 |

控制脚本执行完毕后，必须在标准输出（stdout）打印一行 JSON 回执：包含 `"dispatched": true` 表示指令已成功发出（可选附带 `"note"` 说明），否则视为执行失败。由于脚本回执只能证明“指令发给了设备”，不能证明界面已经正确响应，InkLab 在报告中会将单步的 `resultVerified` 记为 `false`，最终是否通过完全取决于后续的真实截图与 OCR 文字检查。

未配置适配器的应用仍可使用 ADB 基础按键与截图。长按唤醒和语音文字注入由应用适配器提供。

## 编写与运行真机场景

真机场景有两个来源：

- **模拟器的 `.mjs` 场景**（`<app>/e2e/scenarios/*.mjs`）会自动列出来。InkLab 在 Node 里调用它的 `build()` 拿到步骤（场景里写的 `/app/…` 引入会映射回应用目录）。只用按键、等待、截图、长按唤醒的场景可以直接在真机上跑；方向键按触控板手势执行（前滑同时发右和下，和真机一致）。跑完在报告目录生成 `compare.html`：同名截图左边是模拟器（先找 `e2e/baselines/<场景>/`，再找 `e2e/report/<场景>/`），右边是真机原图。用到 `do` / `expect` 函数或需要模拟器上下文（`build({ caps })` 等）的场景标为不支持，并写明原因。
- **专门写的真机场景**（`<app>/e2e/device-scenarios/*.json`），同 id 时优先于模拟器场景：

```json
{
  "id": "device-greeting-readonly",
  "title": "真实眼镜问候回复",
  "device": {
    "readOnly": true,
    "requires": ["asr-text", "screenshot", "ocr"],
    "steps": [
      { "shot": "before" },
      { "say": "你好" },
      { "expectText": {
        "anyOf": [
          { "all": ["你好"] },
          { "all": ["请问", "帮"] }
        ],
        "none": ["出错了"]
      } }
    ]
  }
}
```

| 步骤 / 能力 | 在真机上的执行方式 |
| --- | --- |
| `press` / `pressMany` / `activate` / `back` | 发送真实 ADB 按键并按真实时间等待；可用 `waitMs` 指定每次输入后的等待，`pressMany` 对每一击生效，不使用模拟器的虚拟时间戳加速。 |
| `wait` | 真实等待指定毫秒数（上限 60 秒） |
| `say` | 发送 1–180 字节的 UTF-8 文本；要求应用在 `inklab.device.json` 中开启 `asrText: true` |
| `wake` | 由应用适配器模拟镜腿触控板长按唤醒；支持先截图确认进入聆听状态，再接着执行 `say` |
| `shot` | 保存 ADB 返回的原始完整 PNG（不做任何裁剪或背景合成），记录宽高与 SHA-256 |
| `expectText` | 调用 macOS Vision OCR 识别当前真实截图中的文字：`all` 表示必须包含全部词条，`none` 表示不能出现该词条，`anyOf` 表示满足任一组即可 |
| 模拟器专用的 `do` / `expect` 函数、模拟硬件开关、LLM 录制文件 | 在真机模式下不支持，运行前检查会直接标记为 `unsupported` |

- **报告结果与命令行退出码**：
  - `passed`（退出码 `0`）：所有步骤执行成功，且至少有一条 `expectText` 真实截图文字检查通过。
  - `pending-review`（退出码 `2`）：纯按键与截图场景（未配置 `expectText` 文字检查），需人工查看截图确认。
  - `unsupported`（退出码 `2`）：缺少当前系统或应用适配器支持的能力（如非 macOS 跑 OCR、或未开启 `asrText`）。
  - `failed` / `cancelled`（退出码 `1`）：步骤执行报错、文字检查超时未命中或被手动中止。
- **截图轮询机制**：真机上的对话气泡可能在几秒后自动消失，因此执行 `say` 后不会固定死等 6 秒，而是立即开始轮询截图。`expectText` 默认在 10 秒内最多截图 12 次（每次间隔至少 500ms，可通过 `timeoutMs` 在 `0–60000ms` 间调整）：一旦某次截图识别出目标文字即刻通过，保留每一次尝试的原始截图，超过时间仍未识别到才判定失败。
