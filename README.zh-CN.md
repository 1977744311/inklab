# InkLab

[English](README.md)

**AIUI 应用的本地调试与测试工作台**——AIUI 是 Rokid AR 眼镜的应用格式。在浏览器里直接打开应用源码目录（或打包好的 `.aix`），用真实的 Ink 渲染引擎跑起来，支持同时并排运行多个引擎版本；语音、相机、运动传感器、电池、蓝牙、网络、大模型（LLM）等硬件能力均由可控的模拟器提供，让你不用戴上眼镜，就能在电脑上用脚本和截图基线完成自动化测试。

![InkLab 工作台：同一个应用在两个引擎版本上并排运行，下方是跑完 9 步全部通过的场景结果和硬件模拟控件](docs/assets/workbench.png)

> **非官方项目。** InkLab 与 Rokid 没有隶属关系，也未获得其认可或支持。“Rokid”“AIUI”归各自权利人所有。InkLab 不包含也不分发 Rokid 的引擎，详见[运行时引擎](#运行时引擎)。

## 它能做什么

- **热重载**——修改源码后页面自动刷新（服务端监听文件变更并实时推送）。
- **多引擎版本并排对比**——同一个应用同时跑在多个版本的引擎上，直观对比画面差异；键盘操作和测试脚本会同步发给每个版本。
- **贴近真机的硬件模拟**——手动或用脚本注入语音（ASR/TTS）、相机照片、传感器轨迹（IMU）、电量、蓝牙（BLE）设备、网络故障和大模型回复（在线请求、录制、离线回放）。模拟器刻意复现了真机上的常见异常（如语音识别中途意外中断、拍照存在延迟、传感器权限报错后不会自动恢复），而不是只模拟理想情况。
- **自动化场景与截图比对**——用简单的 JS 脚本编排按键、等待、截图和断言，可在浏览器里交互运行，也可在无头浏览器（Headless Chrome）中跑 CI。参考截图带有源码和引擎版本的指纹，一旦代码或引擎更新而截图未更新，会自动标记为过期（`stale`）。
- **测试报告与录屏**——一键导出 `run.json`（包含源码版本、引擎哈希、执行时间线、网络日志、截图产物），或将应用画面直接录制成 MP4/WebM 视频。
- **可选：USB 连接真机测试**——通过 `adb` 在真实眼镜上截图、实时投屏、运行只读测试场景，见 [docs/device.md](docs/device.md)。

InkLab 和官方 Craft 网页使用的是同一个渲染引擎，因此**它能替代在 Craft 里手动点测，但不能替代最终的真机验收**：光学显示、功耗、真实传感器精度、麦克风收音和蓝牙信号仍需在真实眼镜上验证。

## 快速开始

需要 Node.js 22 或更高版本，以及 Chrome 浏览器。无需 `npm install` 安装任何运行时依赖。

```bash
git clone https://github.com/1977744311/inklab.git
cd inklab
npm run engine                              # 首次运行：从 Craft 和 AIUI Studio 站点获取引擎并缓存到本地
npm start -- fixtures/cap-probe-app --open
```

浏览器会自动打开 <http://127.0.0.1:8788/>。`fixtures/cap-probe-app` 是仓库自带的示例探针应用，方便你直接体验所有功能；调试自己的应用时，把路径换成你的源码目录或 `.aix` 文件即可。想并排对比两个引擎版本，只需在页面顶部勾选两个版本，或在 URL 后加上 `?runtimes=<id>,<id>`（版本 id 见本机的 `runtimes.lock.json`）。

## 核心概念

| 名词 | 含义 |
| --- | --- |
| **AIUI 应用** | 包含 `app.json`、`app.js` 和 `pages/**/*.ink` 的源码目录；打包后为 `.aix`（zip 格式）文件。 |
| **运行时（lane）** | Rokid `ink_web` 引擎的一个特定版本构建（由一个 JS 胶水文件和一个 WebAssembly 文件组成）。每个版本在 `runtimes.lock.json` 中有一条记录（称为一条 lane，如 `craft-0.18.0`），并锁定文件的 SHA-256 哈希。 |
| **宿主能力** | 应用向眼镜系统调用的硬件与系统接口：语音、相机、传感器、电池、蓝牙、网络、LLM。InkLab 在浏览器中提供这些接口的模拟实现。 |
| **场景（Scenario）** | 定义操作步骤与检查条件的小型 JS 模块。InkLab 内置了通用的 `smoke`（冒烟测试）场景；应用专属的场景放在应用自己的 `<app>/e2e/scenarios/` 目录下。 |
| **截图基线（Baseline）** | 保存在 `<app>/e2e/baselines/` 下的参考截图，附带源码与引擎指纹，用于像素级视觉回归比对。 |
| **录制文件（Cassette）** | 保存在 `<app>/e2e/cassettes/` 下的大模型历史响应记录，回放时无需联网、无需 API Key，且每次返回结果固定。 |

应用自己的测试文件保存在应用自己的仓库中；InkLab 只作为运行和测试工具。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start -- <应用目录\|包.aix> [--port 8788] [--open] [--compare-with <目录\|包.aix>]` | 启动本地工作台。`--compare-with` 可对比另一份源码或 `.aix` 包的文件差异。 |
| `npm run e2e -- <应用目录\|包.aix> [--scenario id] [--runtime id] [--accept] [--headed]` | 在无头 Chrome 中运行场景并比对截图基线，结果写入 `<app>/e2e/report/last-run.json`。加上 `--accept` 会将本次截图保存为新基线。 |
| `npm run matrix -- <应用目录\|包.aix> [--scenario id] [--runtime a,b] [--all-lighting]` | 将同一场景跨多个引擎版本（及不同环境光背景）运行一遍，生成差异对比报告。 |
| `npm run engine [-- <lane>…] [--check\|--discover]` | 检查 Craft 和 AIUI Studio 站点上的引擎版本，把新版本记入 `runtimes.lock.json`，并下载 `.engine/` 中缺失的文件。`--check` 仅在本地校验文件完整性；`--discover` 仅预览线上是否有新版本（有新版本时退出码为 2）。 |
| `npm run e2e:device -- <应用目录> --serial SN --scenario ID` | 通过 USB 在真实眼镜上运行测试场景（可选）。 |
| `npm test` · `npm run lint` | 运行单元测试（无需联网和浏览器）· 运行 ESLint 代码检查（需先执行 `npm ci`）。 |

大模型（LLM）配置是可选的：可通过环境变量 `INKLAB_LLM_ENDPOINT`、`INKLAB_LLM_API_KEY`、`INKLAB_LLM_MODEL` 配置，或在项目根目录创建本地文件 `llm.local.json`。未配置时，应用会收到“模型不可用”提示并走离线逻辑。详见[使用指南](docs/guide.md#llm-怎么接)。

## 运行时引擎

`ink_web` 是 Rokid 的闭源渲染引擎（即 Craft 和 AIUI Studio 网页所使用的引擎）。它**不包含**在本仓库及 npm 包中，InkLab 也不授予任何引擎使用权。执行 `npm run engine` 时，脚本会从 Rokid 官方服务器（`js.rokid.com`、`aiui.rokid.com`、`static.rokidcdn.com`）下载浏览器打开这些网页时加载的同名 JS 和 WASM 文件，校验 SHA-256 哈希后缓存在本地。

引擎清单与二进制文件均属于本机状态，已被 `.gitignore` 忽略且不会打入 npm 包：

- `runtimes.lock.json`：首次运行 `npm run engine` 时自动生成的版本清单，记录每个引擎版本的来源、版本号和 SHA-256 哈希（首次下载时记录哈希，后续下载必须完全一致）。列表第一项为默认版本；若本地尚未缓存该版本，启动时会自动切换到其他已缓存版本并打印提示。
- `.engine/`：存放下载好的引擎文件，每个版本一个子目录（可通过环境变量 `INKLAB_ENGINE_DIR` 修改存放位置）。下载过程会显示速度与剩余时间，单文件超过 30 秒无响应会自动重试（最多 3 次）。

版本发现机制与手动添加引擎版本的方法见[使用指南](docs/guide.md#引擎版本会漂)。请确保在符合 Rokid 服务条款的前提下使用引擎。

## 环境要求

- Node.js 22 或更高版本（CI 在 macOS 和 Ubuntu 上使用 Node 22 和 24 测试）。
- Chrome 浏览器（用于打开工作台；其他浏览器未做兼容测试）。
- 运行自动化测试（`npm run e2e`、`npm run matrix`）需要本机安装 Chrome 或 Chromium（macOS 和 Linux 下自动查找，macOS 也支持 Edge；找不到时可通过 `INKLAB_CHROME` 或 `--chrome` 指定路径）。
- 连接真机测试还需安装 `adb` 和 `ffmpeg`；截图文字自动识别（OCR）依赖 macOS 的系统 Vision 接口。
- Windows 系统暂未测试。

## 常见问题

| 现象 | 解决办法 |
| --- | --- |
| `runtimes.lock.json 里还没有运行时…` 或 `还没取任何运行时…` | 本地还没有下载引擎。联网运行 `npm run engine` 即可自动获取并下载。 |
| 引擎下载很慢或卡住 | 超过 30 秒无数据会自动重试。你也可以直接从其他电脑拷贝 `runtimes.lock.json` 和 `.engine/` 目录，再运行 `npm run engine -- --check` 校验。 |
| 页面显示 `forbidden: host` | 请使用 `http://127.0.0.1:<端口>/` 或 `http://localhost:<端口>/` 访问。出于安全考虑，服务会拒绝局域网 IP 或反向代理域名访问。 |
| `EADDRINUSE` | 默认端口被占用，加上 `--port <新端口>` 启动即可。 |
| `找不到 Chrome`（e2e） | 安装 Chrome/Chromium，或设置环境变量 `INKLAB_CHROME=/path/to/chrome`。 |
| 启动时提示 `默认运行时 … 本机没有缓存` | 普通提示：`runtimes.lock.json` 里的第一个版本还没下载到本地，已自动切换为另一个已下载的版本。 |

## 文档导航

- [使用指南](docs/guide.md)——工作台功能、硬件模拟控制、编写测试场景、e2e 运行、LLM 录制回放、截图基线。
- [USB 连真机](docs/device.md)——真机实时投屏、真机测试场景、应用端控制脚本约定。
- [运行时实测笔记](docs/runtime-notes.md)——实测总结的引擎底层机制与时序规律，写自动化脚本前必读。

工作台界面与详细文档目前为中文；欢迎使用中文或英文提交 Issue 和 PR。

## 安全说明

InkLab 是纯本地开发工具，仅监听 `127.0.0.1` 回环地址，并拒绝非本机 `Host` 的请求。请勿将端口暴露到公网或局域网。由于浏览器内的引擎需要直接发起大模型请求，你配置的 LLM API Key 会下发给本地工作台页面。详见 [SECURITY.md](SECURITY.md)。

## 参与贡献与许可证

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。InkLab 自身的源码采用 [MIT 许可证](LICENSE)开源；该许可证仅覆盖 InkLab 自身代码，不包含 Rokid 的引擎（见 [NOTICE](NOTICE) 和[运行时引擎](#运行时引擎)）。
