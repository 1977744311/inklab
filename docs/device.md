# USB 连真机

InkLab 可以在已连接的真实眼镜上执行场景。这是**可选**能力：默认启动不会探测或控制 ADB，必须显式加 `--device`。

## 前置条件

- 本机有 `adb`（`ADB` 环境变量可指定路径）和 `ffmpeg`（实时投屏解码用，`FFMPEG` 环境变量可指定路径）。
- 自动文字断言依赖 macOS 的 Vision OCR；其他系统仍能取图，但自动文字断言会标 unsupported。
- 接好已授权的 USB，保持手机 Rokid App 连接，在眼镜里手动打开一次 AIUI 沉浸应用。
- 应用提供设备适配器，见[应用提供的设备适配器](#应用提供的设备适配器)。

## 启动

```bash
npm start -- <app> --device --serial <serial>
# 打开 http://127.0.0.1:8788/device ，或点模拟器右上角「USB 真机」
```

工作台直接显示 ADB 返回的完整 PNG，可从电脑移焦、确认、返回、重放已校准镜腿长按，
也可向实现了文字输入适配器的应用发送 ASR 识别文字。运行中的步骤、真实截图、OCR 原文
和最终报告会同步展示。源码修改不会更新眼镜已安装的包；新版本仍须在新版 Studio 打包并安装。

点「开始实时投屏」可持续看真实眼镜画面：眼镜 `screenrecord` 连续输出 H.264，本机
`ffmpeg` 解码，经本地事件流送到浏览器。不是每次操作后才截图，也没有循环启动
`adb screencap`。当前目标实测支持 `480×640`；原生画面静止时会少出帧，工作台显示实际
接收 FPS、最近绘制年龄和本机解码完成到浏览器绘制的延迟。这个延迟不包含设备编码，
不能冒充端到端测量。

投屏与场景输入可以同时运行，原始 PNG/OCR 证据继续独立保存；「实时视频 / 原图证据」
切换只影响当前查看的内容。投屏画面经 JPEG 压缩用于预览，不能替代原始 PNG。
「录制视频」复用同一浏览器视频画布，不再占用眼镜编码器；结束后可下载无声 MP4
（浏览器不支持时降级 WebM），适合演示取材，不当作传感器或语音识别准确性的证明。
结束录制后会自动写入本机 `device-output/recordings`，下载链接指向同一份已保存文件，
避免内嵌浏览器无法下载 Blob 时丢失素材。保存失败会保留当前页面的原始 Blob；不要立即刷新。
本地保存只接受 MP4/WebM，单份上限 64 MiB，并保留字节数和 SHA256 校验值。

停止投屏、最后一个页面退出、视频断线或服务关闭会清理本机进程和本次眼镜编码进程；
不会杀掉其他 `screenrecord`。Android 单次录制有时长上限，服务每 165 秒重新连接编码器，
期间显示续接状态。投屏期间只在输入空闲时临时发唤醒事件，不修改持久常亮设置。

## 命令行执行器

不依赖浏览器的同一真机执行器：

```bash
npm run e2e:device -- <app> --list
npm run e2e:device -- <app> \
  --serial <serial> \
  --scenario device-greeting-readonly --scenario device-settings-readonly \
  --out /tmp/inklab-device-runs
```

多设备必须选择序列号。默认原图与 `run.json` 保存在系统临时目录 `inklab-device-runs/`；可用
`--device-output DIR` 指定长期证据目录。真实设备内容可能含个人数据，应存到本地
排除 Git 的目录。服务仅监听 `127.0.0.1`，控制请求要求同源与本次服务的 session token。

## 应用提供的设备适配器

InkLab 自己**不带** ADB 控制脚本：按键、文字输入和截图都经由应用自己提供的脚本执行——
怎么在这台眼镜上给这个应用送文字，是应用的事。在应用源码根目录放 `inklab.device.json`：

```json
{
  "profile": "my-app",
  "asrText": true,
  "controlScript": "scripts/glasses-control.mjs"
}
```

| 字段 | 含义 |
| --- | --- |
| `profile` | 写进真机报告的名字，缺省 `generic`。 |
| `asrText` | 必须严格等于 `true` 才允许 `say`；缺省为 false，此时用到 `say` 或 `asr-text` 的场景预检为 unsupported。 |
| `controlScript` | 控制脚本路径，相对该应用根目录解析；缺省 `scripts/glasses-control.mjs`。 |

InkLab 这样调用脚本，单次超时 120 秒：

```bash
node <controlScript> <command> [value] --serial <序列号> --wait-ms <毫秒> [--capture <PNG 路径>]
```

| command | value | 脚本要做的事 |
| --- | --- | --- |
| `key` | `left` `right` `up` `down` `enter` `back` `wake` | 向眼镜发这个按键 |
| `say` | 1–180 UTF-8 字节的文字 | 把文字当作 ASR 识别结果送进应用（只有 `asrText: true` 才会调用） |
| `capture` | 无 | 把当前屏幕的完整 PNG 写到 `--capture` 给的路径 |
| `wake-assistant` | 无 | 重放镜腿触控板长按来唤醒助手 |

脚本必须在 stdout 输出 JSON 回执，`dispatched: true` 表示命令已发出，否则本次命令按失败处理；
可以带 `note`。回执只证明“发出去了”，所以 InkLab 始终把 `resultVerified` 记为 `false`——
结果对不对，要靠截图和 OCR 断言来判。

没有适配器的应用也可以先用按键和截图；文字输入需要该应用明确实现适配器，
不能把普通按键发送当作语音注入成功。

## 真机场景

工程真机场景放在 `e2e/device-scenarios/*.json`，复用原场景的声明式步骤：

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

| 步骤 / 能力 | 真机口径 |
| --- | --- |
| `press` / `pressMany` / `activate` / `back` | 实际 ADB 按键和墙钟等待，不使用模拟器虚拟时间戳 |
| `wait` | 最多 60 秒，停止请求每 250ms 检查一次 |
| `say` | 1–180 UTF-8 字节；要求应用声明 `asrText: true` 并在控制脚本里实现 `say` |
| `wake` | 重放已实测的 Rokid 触控板长按；可先验证聆听画面，再串行执行 `say` |
| `shot` | 完整 ADB PNG，不裁切、不拼接环境、不重画文字；包含尺寸和 SHA-256 |
| `expectText` | 本机 macOS Vision 从本次真实截图识别；`all` / `none` 字面匹配，`anyOf` 支持多个合法回复 |
| 旧场景 `do` / `expect`、mock caps、seed、LLM cassette、传感器注入 | 预检为 unsupported，必须明确改写成可观察的真机步骤 |
| 模型请求与 TTS 完播、麦克风识音质量 | 不能由按键发送和 OCR 证明；报告保留未验证边界 |

报告分 `passed`、`failed`、`unsupported`、`pending-review`、`cancelled`。只有至少一条真实
截图文字断言成立且其余步骤没有失败，才标 `passed`；纯按键/截图场景只记 `pending-review`。
`passed` 仅覆盖场景声明的文案条件，不凭固定数据声称内容永远正确。
OCR 原文与置信度一起留在报告里，关键截图仍需人工复核。
CLI 对通过返回 0，失败/中止返回 1，不支持或待复核返回 2。

`say` 后立即进入截图观测，不固定等六秒：短回复可能已经收起。`expectText` 默认最多等
10 秒、最多 12 次实际取图，每次间隔至少 500ms；所有尝试原图均保留，可用 `timeoutMs`
调整到 0–60000ms。初始未命中不提前猜成功，超过观察窗口才给失败。
