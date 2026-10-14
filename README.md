# InkLab

[简体中文](README.zh-CN.md)

**A local debugging and testing workbench for AIUI apps** — the app format of Rokid AR glasses. Open an app's source folder (or a packaged `.aix`) in your browser, run it on one or more versions of the real Ink rendering engine side by side, and drive it with simulated hardware — speech, camera, motion sensors, battery, Bluetooth, network, LLM — so you can test with scripts and screenshot baselines on your computer before testing on physical glasses.

![InkLab workbench: the same app on two engine versions side by side, a scenario run with nine passing steps, and the simulated-hardware controls below](docs/assets/workbench.png)

> **Unofficial project.** InkLab is not affiliated with, endorsed by or supported by Rokid. "Rokid" and "AIUI" belong to their respective owners. InkLab does not contain or redistribute Rokid's engine; see [The runtime engine](#the-runtime-engine).

## What it does

- **Hot reload** — edit the source and the page reloads automatically via a file watcher.
- **Runtime lanes side by side** — run the same app on several pinned engine builds at once to compare renders; keyboard and scripted input are mirrored to every lane.
- **Realistic hardware simulation** — inject speech (ASR/TTS), camera photos, IMU sensor traces, battery levels, BLE devices, network failures and LLM responses (live, recorded or replayed). The simulators intentionally reproduce real-device edge cases (ASR aborting mid-turn, camera shutter delay, sticky sensor permission faults) rather than an idealised contract.
- **Automated scenarios and screenshot baselines** — declarative JS scripts (key presses, waits, screenshots, assertions) run interactively in the browser or headless in CI. Baselines carry a fingerprint of the source and engine, so outdated baselines are flagged as `stale` instead of silently passing.
- **Test reports and stage recording** — export `run.json` (source identity, engine hashes, timeline, network log, artifacts) and record the stage canvas as MP4/WebM.
- **Optional: real glasses over USB** — capture screenshots, stream a live mirror and run read-only scenarios through `adb`. See [docs/device.md](docs/device.md) (Chinese).

InkLab runs the same rendering engine as Rokid's web preview (Craft), so **it replaces manual clicking in Craft, not final testing on physical glasses**: optics, power draw, real sensor accuracy, microphone acoustics and Bluetooth radio still require real hardware verification.

## Quick start

You need Node.js 22 or later and Chrome. There are no npm runtime dependencies to install.

```bash
git clone https://github.com/1977744311/inklab.git
cd inklab
npm run engine                              # first run: discovers engines on Craft and AIUI Studio and downloads them
npm start -- fixtures/cap-probe-app --open
```

The workbench opens at <http://127.0.0.1:8788/>. `fixtures/cap-probe-app` is a built-in probe app so you can try every feature right away; when you have your own app, pass its source directory or `.aix` file instead. To compare two engine versions side by side, tick two lanes in the workbench or open `?runtimes=<id>,<id>` (lane ids are stored in `runtimes.lock.json`).

> The workbench UI is in Chinese for now.

## Core concepts

| Term | Meaning |
| --- | --- |
| **AIUI app** | A source directory with `app.json`, `app.js` and `pages/**/*.ink`. Its packaged form is a `.aix` (zip) archive. |
| **Runtime (lane)** | One pinned build of Rokid's `ink_web` engine: a JS glue file plus a WebAssembly binary. Each build is recorded as a lane (e.g. `craft-0.18.0`) and locked by SHA-256 in your local `runtimes.lock.json`. |
| **Host capabilities** | Device APIs requested by an app: speech, camera, sensors, battery, Bluetooth, network, LLM. InkLab provides controllable simulators in the browser. |
| **Scenario** | A small JS module defining steps and assertions. The built-in `smoke` scenario works for any app; app-specific scenarios live in `<app>/e2e/scenarios/`. |
| **Baseline** | Reference screenshots stored in `<app>/e2e/baselines/`, stamped with a fingerprint of the source and engine for pixel-level regression checks. |
| **Cassette** | Recorded LLM responses stored in `<app>/e2e/cassettes/`, replayed deterministically offline without an API key. |

Your app's tests live in your app's repository; InkLab only provides the host runner.

## Commands

| Command | What it does |
| --- | --- |
| `npm start -- <app-dir\|pkg.aix> [--port 8788] [--open] [--compare-with <dir\|pkg.aix>]` | Start the workbench. `--compare-with` shows a file-level diff against a second source or `.aix`. |
| `npm run e2e -- <app-dir\|pkg.aix> [--scenario id] [--runtime id] [--accept] [--headed]` | Run scenarios in headless Chrome, compare screenshot baselines, and write the report to `<app>/e2e/report/last-run.json`. `--accept` saves this run's screenshots as new baselines. |
| `npm run matrix -- <app-dir\|pkg.aix> [--scenario id] [--runtime a,b] [--all-lighting]` | Run one scenario across multiple runtime lanes (and ambient lighting backgrounds) and summarise differences. |
| `npm run engine [-- <lane>…] [--check\|--discover]` | Discover engine builds on Craft and AIUI Studio, append new lanes to `runtimes.lock.json`, and download missing files into `.engine/`. `--check` verifies local files offline; `--discover` previews new builds without writing (exits with 2 if found). |
| `npm run e2e:device -- <app-dir> --serial SN --scenario ID` | Run a scenario on real glasses over USB (optional). |
| `npm test` · `npm run lint` | Unit test suite (needs no external network or browser) · ESLint (`npm ci` first; devDependencies are for linting only). |

LLM access is optional: set `INKLAB_LLM_ENDPOINT`, `INKLAB_LLM_API_KEY` and `INKLAB_LLM_MODEL`, or create an untracked `llm.local.json`. Without it, apps receive "model unavailable" and take their offline path. Details are in the [guide](docs/guide.md#llm-怎么接).

## The runtime engine

`ink_web` is Rokid's closed-source rendering engine, the same one used by Craft and AIUI Studio. It is **not** included in this repository or its npm package, and InkLab grants no rights to it. `npm run engine` downloads the glue JS and WebAssembly binary from Rokid's servers (`js.rokid.com`, `aiui.rokid.com`, `static.rokidcdn.com`), verifies their SHA-256 hashes against `runtimes.lock.json`, and caches them in `.engine/`.

Both paths are local, git-ignored state and excluded from the npm package:

- `runtimes.lock.json` is an append-only JSON array of lanes created on your first `npm run engine`. Each lane pins its source URL, version and SHA-256 hashes (recorded on first download; every later download must match). The first lane is the default; if it is not cached locally, InkLab falls back to another cached lane and logs a notice.
- `.engine/` holds the downloaded binaries, one directory per lane (`INKLAB_ENGINE_DIR` overrides the path). Downloads show speed and ETA, abort after 30 s without data, and retry up to three times.

See [the guide](docs/guide.md#引擎版本会漂) for discovery rules and how to register a lane by hand. You are responsible for using the engine in line with Rokid's terms.

## Requirements

- Node.js 22 or later. CI runs the test suite on macOS and Ubuntu with Node 22 and 24.
- Chrome for the workbench (other browsers are untested).
- Headless runs (`npm run e2e`, `npm run matrix`) need Chrome or Chromium, auto-detected on macOS and Linux (Edge as well on macOS). Otherwise set `INKLAB_CHROME` or pass `--chrome`.
- Real glasses additionally need `adb` and `ffmpeg`; automatic text assertions use macOS Vision OCR.
- Windows is untested.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `runtimes.lock.json 里还没有运行时…` or `还没取任何运行时…` ("no runtimes yet") | The list or `.engine/` is empty. Run `npm run engine` while online to discover and download the engines. |
| The download is slow or looks stuck | Stalled files (30 s without data) retry automatically. You can also copy `runtimes.lock.json` and `.engine/` from another machine and verify with `npm run engine -- --check`. |
| The page shows `forbidden: host` | Open the workbench through `http://127.0.0.1:<port>/` or `http://localhost:<port>/`. Other host names (a LAN address, a reverse proxy) are refused on purpose. |
| `EADDRINUSE` | The port is taken. Pick another with `--port`. |
| `找不到 Chrome` ("Chrome not found", e2e) | Install Chrome or Chromium, or set `INKLAB_CHROME=/path/to/chrome`. |
| `默认运行时 … 本机没有缓存` ("default runtime not cached") at startup | Informational. The first lane in `runtimes.lock.json` is not in `.engine/`, so another cached lane is used. |

## Documentation

The long-form documents are in Chinese for now; issues and pull requests in English or Chinese are both welcome.

- [Guide](docs/guide.md) — workbench, host capabilities, scenarios, e2e, LLM modes, screenshot baselines.
- [Real glasses over USB](docs/device.md) — live mirror, device scenarios, app-provided control scripts.
- [Runtime field notes](docs/runtime-notes.md) — measured engine behaviour and timing rules; read before scripting an app.

## Security

InkLab is a local development tool. It listens on `127.0.0.1` only and rejects requests whose `Host` is not loopback. Do not expose its port to a network. The LLM key you configure is handed to the page, because the in-browser engine makes the request itself. See [SECURITY.md](SECURITY.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). InkLab's own source code is released under the [MIT License](LICENSE). The license covers InkLab's code only, not Rokid's engine; see [The runtime engine](#the-runtime-engine).
