# USB 连真机

InkLab 支持通过 USB 在已连接的真实眼镜上执行测试场景。这是**可选功能**：普通启动不会调用 ADB，必须显式加上 `--device` 参数才会启用。

## 前置条件

- 电脑已安装 `adb`（可通过 `ADB` 环境变量指定路径）和 `ffmpeg`（用于实时投屏视频解码，可通过 `FFMPEG` 环境变量指定路径）。
- 截图文字自动识别（OCR）依赖 macOS 系统自带的 Vision 接口；在其他操作系统上仍能正常按键和截图，但包含文字识别断言（`expectText`）的场景会标记为 `unsupported`。
- 用 USB 连接已授权调试的眼镜，保持手机端 Rokid App 连接，并在眼镜里手动打开一次待测的 AIUI 应用。
- 如需向应用直接发送语音识别文本，应用需配置设备控制脚本，见[应用提供的设备适配器](#应用提供的设备适配器)。

## 启动真机工作台

```bash
npm start -- <app> --device --serial <serial> [--device-output DIR]
# 浏览器打开 http://127.0.0.1:8788/device ，或点击工作台右上角的「USB 真机」
```

- **远程操作与截图取证**：网页直接展示 ADB 从眼镜端截取的完整原始 PNG（`480×640`）。你可以在网页上点击方向键、确认、返回、触发镜腿长按唤醒，或向支持适配器的应用直接发送语音文字；右侧同步展示执行步骤、真实截图、OCR 识别出的文字和最终测试报告。注意：修改本地源码不会自动更新眼镜里已安装的应用包，更新真机应用仍需通过 Studio 重新打包安装。
- **实时投屏**：点击「开始实时投屏」后，眼镜端通过 `screenrecord` 连续输出 `480×640` 的 H.264 视频流，由本机 `ffmpeg` 实时解码后推送到浏览器显示（无需循环调用慢速的 `adb screencap`）。界面会显示实时帧率（FPS）、画面刷新间隔以及本机解码到浏览器渲染的耗时（注：该耗时不包含眼镜端编码与 USB 传输时间）。投屏画面经 JPEG 压缩仅用于流畅预览，测试报告中的截图证据始终使用独立的无损 PNG。由于 Android 系统限制单次录屏时长，服务每 165 秒会自动无缝重连一次视频流。
- **录制演示视频**：点击「录制视频」可直接将浏览器中的投屏画面录制为无声 MP4（不支持 MP4 的浏览器自动降级为 WebM），不会额外增加眼镜端的编码负担。结束录制后视频自动保存到 `<输出目录>/recordings`（单文件上限 64 MiB，自动记录文件大小与 SHA-256；默认位于系统临时目录 `inklab-device-runs/` 下，可通过 `--device-output DIR` 自定义保存目录）。
- **进程清理与安全限制**：停止投屏、关闭网页、连接断开或退出服务时，InkLab 会自动清理本次启动的眼镜端 `screenrecord` 和本机解码进程；投屏期间仅在无操作时发送临时唤醒信号防息屏，不会修改眼镜系统的常亮设置。本地服务仅监听 `127.0.0.1`，所有设备控制请求均校验同源 Origin 与当次会话 Token。

## 命令行无头运行

无需打开浏览器，直接在命令行运行真机测试场景：

```bash
npm run e2e:device -- <app> --list
npm run e2e:device -- <app> \
  --serial <serial> \
  --scenario device-greeting-readonly --scenario device-settings-readonly \
  --out /tmp/inklab-device-runs
```

连接多台设备时必须通过 `--serial` 指定设备序列号。原始截图与测试报告 `run.json` 默认保存在系统临时目录 `inklab-device-runs/` 下，可通过 `--out DIR` 指定输出目录。由于真机截图可能包含个人隐私数据，建议保存在未被 Git 跟踪的本地目录中。

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

未配置适配器的应用仍可使用基础按键与截图功能；语音文字注入则必须由应用实现上述适配器脚本。

## 编写与运行真机场景

真机测试场景保存在被测应用的 `<app>/e2e/device-scenarios/*.json` 目录下：

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
| `press` / `pressMany` / `activate` / `back` | 发送真实 ADB 按键并按真实时间等待（不使用模拟器的虚拟时间戳加速） |
| `wait` | 真实等待指定毫秒数（上限 60 秒） |
| `say` | 发送 1–180 字节的 UTF-8 文本；要求应用在 `inklab.device.json` 中开启 `asrText: true` |
| `wake` | 模拟镜腿触控板长按唤醒；支持先截图确认进入聆听状态，再接着执行 `say` |
| `shot` | 保存 ADB 返回的原始完整 PNG（不做任何裁剪或背景合成），记录宽高与 SHA-256 |
| `expectText` | 调用 macOS Vision OCR 识别当前真实截图中的文字：`all` 表示必须包含全部词条，`none` 表示不能出现该词条，`anyOf` 表示满足任一组即可 |
| 模拟器专用的 `do` / `expect` 函数、模拟硬件开关、LLM 录制文件 | 在真机模式下不支持，运行前检查会直接标记为 `unsupported` |

- **报告结果与命令行退出码**：
  - `passed`（退出码 `0`）：所有步骤执行成功，且至少有一条 `expectText` 真实截图文字检查通过。
  - `pending-review`（退出码 `2`）：纯按键与截图场景（未配置 `expectText` 文字检查），需人工查看截图确认。
  - `unsupported`（退出码 `2`）：缺少当前系统或应用适配器支持的能力（如非 macOS 跑 OCR、或未开启 `asrText`）。
  - `failed` / `cancelled`（退出码 `1`）：步骤执行报错、文字检查超时未命中或被手动中止。
- **截图轮询机制**：真机上的对话气泡可能在几秒后自动消失，因此执行 `say` 后不会固定死等 6 秒，而是立即开始轮询截图。`expectText` 默认在 10 秒内最多截图 12 次（每次间隔至少 500ms，可通过 `timeoutMs` 在 `0–60000ms` 间调整）：一旦某次截图识别出目标文字即刻通过，保留每一次尝试的原始截图，超过时间仍未识别到才判定失败。
