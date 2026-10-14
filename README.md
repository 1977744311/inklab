# InkLab

[简体中文](README.zh-CN.md)

**A local workbench for AIUI apps** — the app format of Rokid AR glasses. Open an app's source folder (or a packaged `.aix`) in your browser, run it on one or more versions of the real Ink rendering engine side by side, and drive it with simulated hardware — speech, camera, motion sensors, battery, Bluetooth, network, LLM — so you can test with scripts and screenshot baselines what normally needs glasses on your face.

![InkLab workbench: the same app on two engine versions side by side, a scenario run with nine passing steps, and the simulated-hardware controls below](docs/assets/workbench.png)

> **Unofficial project.** InkLab is not affiliated with, endorsed by or supported by Rokid. "Rokid" and "AIUI" belong to their respective owners. InkLab does not contain or redistribute Rokid's engine; see [The runtime engine](#the-runtime-engine).

## What it does

- **Hot reload** — edit the source and the page reloads; a file watcher pushes the change.
- **Runtime lanes side by side** — run the same app on several pinned engine builds at once and compare the renders. Keyboard and scripted input are mirrored to every lane.
- **Controllable fake hardware** — inject speech (ASR/TTS), camera frames, IMU traces, battery levels, BLE devices, network failures and LLM answers (live, recorded or replayed). The fakes deliberately reproduce real devices' bad behaviour (ASR that aborts mid-turn, a slow camera, sticky sensor faults) instead of an idealised contract.
- **Scenarios and screenshot baselines** — declarative scripts (key presses, waits, screenshots, assertions) run in the browser or headless for CI. Baselines carry a fingerprint of the source and engine, so a stale baseline is flagged instead of silently trusted.
- **Evidence** — export a `run.json` (source identity, engine locks, timeline, network log, artifacts) and record the stage as MP4/WebM.
- **Optional: real glasses over USB** — screenshots, a live mirror and read-only scenarios through `adb`. See [docs/device.md](docs/device.md) (Chinese).

InkLab runs the same engine as Craft, so it replaces the *Craft* step of your evidence ladder, **not** the real-device step: hardware, power draw, real sensors, real ASR/TTS completion and the Bluetooth radio are all simulated.

## Quick start

You need Node.js 22 or later and a browser. There are no npm packages to install.

```bash
git clone https://github.com/1977744311/inklab.git
cd inklab
npm run engine                              # first run: finds the engines on Craft and AIUI Studio and downloads them
npm start -- fixtures/cap-probe-app --open
```

The workbench opens at <http://127.0.0.1:8788/>. `fixtures/cap-probe-app` is a probe app that ships with InkLab, so you can try everything without an app of your own; when you have one, pass its source directory or `.aix` file instead.

The first `npm run engine` fetches every engine build the two sites serve; the wasm files are large, so expect it to take a while. `npm run engine -- --discover` shows what the sites serve right now and writes nothing. To see two engine versions side by side, tick two lanes in the workbench, or open it with `?runtimes=<id>,<id>` (the lane ids are in `runtimes.lock.json`).

> The workbench UI is in Chinese for now.

## Concepts

| Term | Meaning |
| --- | --- |
| **AIUI app** | A folder with `app.json`, `app.js` and `pages/**/*.ink`. Its packaged form is a `.aix` (zip) file. |
| **Runtime (lane)** | One pinned build of Rokid's `ink_web` engine: a JS glue file plus a WebAssembly binary. Every lane has an id such as `craft-0.18.0` and is locked by SHA-256 in your local `runtimes.lock.json`. |
| **Host capabilities** | What an app asks of the device: speech, camera, sensors, battery, Bluetooth, network, LLM. InkLab supplies controllable fakes. |
| **Scenario** | A small JS module that lists steps and assertions. The built-in `smoke` scenario works for any app; your own go in `<app>/e2e/scenarios/`. |
| **Baseline** | Accepted reference screenshots in `<app>/e2e/baselines/`, stamped with a fingerprint of the source and engine. |
| **Cassette** | Recorded LLM responses in `<app>/e2e/cassettes/`, replayed without network access or an API key. |

Your app's tests live in your app's repository; InkLab only provides the host.

## Commands

| Command | What it does |
| --- | --- |
| `npm start -- <app-dir\|pkg.aix> [--port 8788] [--open] [--compare-with <dir\|pkg.aix>]` | Start the workbench. `--compare-with` shows a file-level diff against a second source. |
| `npm run e2e -- <app-dir\|pkg.aix> [--scenario id] [--runtime id] [--accept] [--headed]` | Run scenarios in headless Chrome, compare screenshot baselines, write the report to the app's `e2e/report/last-run.json`. `--accept` adopts this run's screenshots as baselines. |
| `npm run matrix -- <app-dir\|pkg.aix> [--scenario id] [--runtime a,b] [--all-lighting]` | Run one scenario across runtime lanes (and lighting profiles) and summarise the differences. |
| `npm run engine [-- <lane>…] [--check\|--discover]` | Look for engine builds on the Craft and AIUI Studio sites and record the ones your `runtimes.lock.json` does not know as new lanes (the first run creates the file), then download whatever `.engine/` lacks. `--check` only verifies the local files (no network). `--discover` shows what would be recorded and writes nothing (exits with 2 if there is anything). |
| `npm run e2e:device -- <app-dir> --serial SN --scenario ID` | Run a scenario on real glasses over USB (optional). |
| `npm test` · `npm run lint` | Test suite (needs no external network and no browser) · ESLint (`npm ci` first, it is the only thing that needs dev dependencies). |

LLM access is optional: set `INKLAB_LLM_ENDPOINT`, `INKLAB_LLM_API_KEY` and `INKLAB_LLM_MODEL`, or create an untracked `llm.local.json`. Without it, apps see "model unavailable" and take their offline path. Details are in the [guide](docs/guide.md#llm-怎么接).

## The runtime engine

`ink_web` is Rokid's closed-source rendering engine, the same one used by Craft and AIUI Studio. It is **not** included in this repository or its npm package, and InkLab grants no rights to it. `npm run engine` downloads the two files a browser downloads when it opens those products — from Rokid's own servers (`js.rokid.com`, `aiui.rokid.com`, `static.rokidcdn.com`) — checks them against the SHA-256 hashes it records in `runtimes.lock.json`, and stores them in `.engine/` in the project directory.

What you fetch and which build you use differs from person to person, so both are local state: `runtimes.lock.json` and `.engine/` are git-ignored and are not in the npm package.

- `runtimes.lock.json` is a JSON array of lanes, created by your first `npm run engine`. Each lane records where a build came from, its version and its hashes. The order is the priority: the first lane is the default.
- `.engine/` holds the downloaded files, one directory per lane. `INKLAB_ENGINE_DIR` puts it somewhere else.

Every `npm run engine` first looks at the Craft and AIUI Studio sites. If either serves an engine build that your list does not record, InkLab appends it as a new lane (named after the platform and the version, such as `craft-0.19.0-daily.202609230326` or `studio-0.19.0-daily.202610080438`) and keeps the files it already downloaded; on a fresh clone this is how the list comes into being. Existing lanes are never edited. A new build is trusted the first time it is seen: its hashes are recorded as they arrive, and every later download must match them. If a site cannot be reached, InkLab warns, still checks the other one, and carries on with the list as it is. [The guide](docs/guide.md#引擎版本会漂) has the details, including how to add a lane by hand for a source the check does not understand.

When the first lane is not in `.engine/`, InkLab starts on another lane that is, and says so in the startup log.

Downloads show speed and time remaining, abort a file that stops receiving data for 30 seconds, and retry up to three times. A lane already in your list is downloaded only when `.engine/` lacks it or its hashes do not match; lanes you do not name are skipped, except a build the site check has just found (it has to be fetched to be hashed anyway). You are responsible for using the engine in line with Rokid's terms.

## Requirements

- Node.js 22 or later. CI runs the test suite on macOS and Ubuntu with Node 22 and 24.
- A browser for the workbench. It is developed and tested with Chrome; other browsers are untested.
- Headless runs (`npm run e2e`, `npm run matrix`) need Chrome or Chromium, auto-detected on macOS and Linux (Edge as well on macOS). Otherwise set `INKLAB_CHROME` or pass `--chrome`.
- Real glasses additionally need `adb` and `ffmpeg`; automatic text assertions use macOS Vision OCR.
- Windows is untested.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `runtimes.lock.json 里还没有运行时…` or `还没取任何运行时…` | The list or `.engine/` is empty. Run `npm run engine` while online: it creates the list from the Craft and AIUI Studio sites and downloads the engines. |
| The download is slow or looks stuck | The progress line shows speed and time remaining; a file that receives nothing for 30 seconds is retried automatically. Instead of downloading again you can copy `runtimes.lock.json` and `.engine/` from another machine; `npm run engine -- --check` verifies the copy. |
| The page shows `forbidden: host` | Open the workbench through `http://127.0.0.1:<port>/` or `http://localhost:<port>/`. Other host names (a LAN address, a reverse proxy) are refused on purpose. |
| `EADDRINUSE` | The port is taken. Pick another with `--port`. |
| `找不到 Chrome` (e2e) | Install Chrome or Chromium, or set `INKLAB_CHROME=/path/to/chrome`. |
| `默认运行时 … 本机没有缓存` at startup | Informational. The first lane in `runtimes.lock.json` is not in `.engine/`, so another lane is used. |

## Documentation

The long-form documents are in Chinese for now; issues and pull requests in English or Chinese are both welcome.

- [Guide](docs/guide.md) — workbench, host capabilities, scenarios, e2e, LLM modes, screenshot baselines.
- [Real glasses over USB](docs/device.md) — live mirror, device scenarios, app-provided control scripts.
- [Runtime field notes](docs/runtime-notes.md) — measured engine behaviour and timing rules; read before scripting an app.

## Security

InkLab is a local development tool. It listens on `127.0.0.1` only and rejects requests whose `Host` is not loopback. Do not expose its port to a network. The LLM key you configure is handed to the page, because the in-browser engine makes the request itself. See [SECURITY.md](SECURITY.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). InkLab's own source code is released under the [MIT License](LICENSE). The license covers InkLab's code only, not Rokid's engine; see [The runtime engine](#the-runtime-engine).
