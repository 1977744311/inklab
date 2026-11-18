# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `npm run install-cli` symlinks `inklab`, `inklab-e2e`, `inklab-engine`, `inklab-matrix` and `inklab-device` into
  `~/.local/bin` (`--bin-dir` picks another directory, `--uninstall` removes them). The links point at the clone, so they
  survive fnm/nvm Node switches and follow `git pull`. Every command answers `--help` and `--version`.
- The USB glasses workbench works without `--device`: switching to **USB 真机** turns device control on (a plain start
  still never calls ADB), and the glasses are picked automatically when only one pair is connected, preferring Wi-Fi when the
  same pair is on USB and Wi-Fi, and reconnecting a remembered wireless address. `--device` still turns it on from the start.
- `inklab-device wifi` turns on wireless debugging (adb over TCP) while the glasses are plugged in, connects over Wi-Fi
  and checks the link, so recording and gestures keep working after the cable comes out; `--off` turns it back off.
  When one pair of glasses shows up twice (USB and Wi-Fi), commands pick the Wi-Fi connection. The address is kept in
  `~/.cache/inklab/wifi-adb.json`, and commands reconnect to it after the adb server restarts.
- The device log stream reconnects when logcat drops (every 2 s) and resumes from the last line's time without
  duplicates. Saved IMU traces report gaps over 250 ms inside a segment.
- `lab.imu.play(ref, { from, to, rebase })` cuts a trace by time, and `rebase: true` replays orientation relative to the
  slice's first reading. Recorded orientation is in Android's world frame, while the simulator's resting pose is the identity
  quaternion, so an app that already took its reference pose needs `rebase` to see the recorded head motion.
- `inklab-engine` checks npm (`@yodaos-pkg/ink`, tags `latest` and `daily`) before the AIUI Studio and Craft sites.
  New versions become `npm-ink-<version>` lanes; the package tarball is verified against its `integrity` and
  extracted whole, and can be downloaded again if the cache is lost.
- Channel names `latest` (newest release), `daily` (newest build) and `studio` (AIUI Studio's web preview) work
  wherever a lane id does: `--runtime`, `?runtimes=` and `INKLAB_RUNTIME`.
- `inklab`, `inklab-e2e` and `inklab-matrix` check npm for new engines at most once a day on start.
  `INKLAB_NO_UPDATE=1` skips the check, `INKLAB_UPDATE=force` forces it, `INKLAB_NPM_REGISTRY` sets a mirror.
- `inklab-engine --list` shows the local lanes and where each channel points.
- An app's `inklab.config.json` may set `runtime` (a channel or lane id) as the project's default engine.
- Real glasses: push a debug build and open it in one step (`inklab-device push`, the workbench's 推到真机, and push on save, on by default).
  Installs use the firmware developer interface with the same protocol as `aix install` (prepare, apply, status) under a fixed `develop.rokid.<business>.<id>`, open goes through
  `content://com.rokid.aiui.develop`, and both are verified from the device: manifest MD5 and the AIUI runtime log.
- Real touchpad gestures (tap, double tap, long press, forward and back swipes) replayed on the touchpad's input device
  with the measured timing; the old arrow, confirm and back buttons map to them.
- Device facts and warnings: model, Ink version, matching simulator lane, touchpad profile, wear detection, accessibility
  services that intercept keys, developer mode. The side-by-side view runs the simulator on the matching lane and can
  mirror gestures to it.
- Live device logs (app console, AIUI runtime events, Ink engine) in the workbench and attached to push results and run reports.
- Simulator `.mjs` scenarios that only press keys, wait and take screenshots run on the glasses, with a `compare.html`
  pairing simulator and device screenshots by name.
- `inklab-device info | push | open | exit | gesture | agents`.
- Mock IMU on real glasses: `--imu replay | live | record` (and the workbench's 模拟 IMU panel) push a debug build with the
  sensor classes replaced through an injected `import` in a temporary copy of the app. Replay bakes a trace (or one segment)
  into the build; live connects back over `adb reverse` + WebSocket so the workbench can play traces, inject faults or
  return to the real sensors; record writes real readings to the log and saves them as `e2e/traces/<name>.json`.
- `inklab-device imu-guide` pushes a guided recorder that walks through still, axis, nod, shake, look-around, talk and walk
  segments and saves one labelled trace; `inklab-device imu-record` saves what a record-mode build sends.
- Project IMU traces (`e2e/traces/*.json`, multi-sensor, with segments and marks) in the simulator: `lab.imu.play()`
  in scenarios and a 工程轨迹 picker in the sensors panel.
- `sensorProfile: "rokid-rg1"` in `inklab.config.json`: no magnetometer, accelerometer and gyroscope at about 101 Hz
  for a 60 Hz request, orientation at about 50 Hz for 10 or 30 Hz requests (measured on RG1).
- Live mode asks instances left over from earlier builds to exit (`wx.exitMiniProgram`); new builds do not replace them.

### Changed

- Real glasses: push, open and `inklab-device exit` first close the AI assistant with real double taps, one confirmed
  step at a time (card, end of the round, dialog closed). Old instances left by earlier pushes keep running in the
  assistant until it closes, so each push now destroys them; the push result reports `reclaimed.dropped`.
  The workbench's 退出应用 button is now 关掉助手.
- Sensor trace playback and the still baseline are scheduled on absolute times: late timers no longer accumulate,
  so a 60 Hz trace plays at 60 Hz instead of about 52 Hz in the browser.
- The workbench UI was redesigned for everyday use. The simulator, USB glasses and side-by-side pages share one stylesheet
  (`host/theme.css`) with a light/dark theme and no horizontal overflow on narrow screens. Engines are picked from an
  **引擎** menu above the preview, the scenario bar sits under the preview, and long help text moved into one-line hints
  and tooltips. The USB glasses page keeps evidence under the preview, scrolls as one page with the preview pinned, and
  folds the sidebar into collapsible sections that remember their state. Element ids and `window.__inklab` are unchanged.
- The default lane is the `latest` channel among cached lanes instead of the first entry in `runtimes.lock.json`.
- An unknown `--runtime` now lists the available lanes and the channel names.
- `docs/guide.md` and `docs/device.md` were rewritten around tasks: each opens with a "where to look" table and a
  five-minute walkthrough, explains the workbench by area, and moves implementation details to a closing section.
  The READMEs fold the networking and multiplayer notes into the feature list and command table.

## [0.2.0] - 2026-11-09

### Added

- Side-by-side USB glasses and simulator workbench with isolated simulator storage, source reload,
  and simulator-only network controls. Both previews fit the same frame on desktop, with USB setup
  and evidence in a scrollable side panel.
- Shared header navigation across simulator, USB glasses, and side-by-side workbenches. Switching
  modes preserves the simulator's selected runtime and other URL settings.
- Basic ADB keys and original PNG capture for apps without a device adapter.

### Changed

- Manual key presses in the live video view send input immediately. The original-image view
  refreshes its PNG after each key press.

### Fixed

- USB scenarios that require an unavailable assistant-wake adapter report unsupported before
  sending any device input.
- The side-by-side simulator can reload source after a startup failure.

## [0.1.1] - 2026-11-06

### Added

- Independent multiplayer workbench for 1–6 players, with per-player engines, capabilities,
  device identities, browser storage, keyboard routing, pop-out windows and scenario controls.
- Repeatable `--allow-external` patterns and optional application `inklab.config.json`, shared
  by the workbench and headless runner; network controls show and edit the active allowlist.
- WebSocket policy enforcement alongside fetch, connection/message-count diagnostics and
  per-player download progress and OPFS cache clearing.
- Streaming speech recognition support for newer AIUI engines, simulated audio capture without
  microphone access, and a two-turn ASR compatibility probe.

### Changed

- Offline injection closes active WebSockets and aborts in-flight downloads; applications
  remain responsible for reconnecting after the network is restored.
- Multiplayer defaults to 1× canvases and a 20 fps frame pump to limit rendering overhead.

### Fixed

- The USB device driver honors scenario-declared input cooldowns.

## [0.1.0] - 2026-10-14

### Added

- Initial standalone release of the AIUI workbench, with source-directory and `.aix` loading,
  hot reload and runtime lanes side by side.
- Controllable speech, camera, motion sensors, battery, Bluetooth, network and LLM capabilities,
  including LLM `off`, `live`, `record` and `replay` modes.
- Declarative browser and headless scenarios, source- and engine-stamped screenshot baselines,
  evidence export and MP4/WebM stage recording.
- Optional USB glasses screenshots, H.264 mirroring and read-only device scenarios through `adb`.
- `README.md` and `README.zh-CN.md` with a quick start, a concept table, troubleshooting and the
  engine download notes; `docs/device.md` for the USB device runner and the contract of the
  device adapter an application provides.
- `npm run engine -- <lane>…` fetches only the named runtime lanes.
- `npm run engine` looks at both official platforms, the Craft and AIUI Studio sites, on every
  run. An engine build that your `runtimes.lock.json` does not record is appended as a new lane
  named after the platform and its version (`craft-…`, `studio-…`), and the files already
  downloaded for it are kept; on a fresh clone the first run creates the list this way. Existing
  lanes are never edited, the list is validated before it is written and replaced atomically, and
  a build is trusted the first time it is seen. If a site cannot be reached the run only warns,
  still checks the other one and installs from the list as it is. `--check` makes no network
  request at all. `--site=[<name>=]<url>`, repeatable, checks only the sites you give.
- `npm run engine -- --discover` shows what would be appended and writes nothing. It exits with 2
  when there is something to append, and with 1 when the check could not be completed.
- Engine downloads give up after 30 s without data, retry up to three times with back-off, and
  show progress with speed and remaining time.
- A startup notice when the default runtime lane is not in the local cache: it names the lane
  used instead and how to fetch the missing one.
- CI on Ubuntu and macOS with Node.js 22 and 24 (`npm ci`, `npm run lint`, `npm test`), ESLint
  and `.editorconfig`.
- Service-level tests for the local server's `Host`, cross-site and CORS handling, a layering test
  (browser-loaded code must not depend on Node) and a packaging test.
- The standard MIT `LICENSE` and a separate third-party runtime `NOTICE`. The license covers
  InkLab's own code only, not the Ink engine.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and issue and pull request templates.

### Changed

- Repository layout: command entry points live in `bin/`, Node-only modules in `lib/node/`,
  `host/inklab.js` is split into `host/inklab/*.js`, and the e2e runner into `lib/node/e2e.mjs`
  and `lib/node/e2e-browser.mjs`. `RUNTIME-NOTES.md` is now `docs/runtime-notes.md`;
  `docs/guide.md` is reorganized and its USB section moved to `docs/device.md`.
- `runtimes.lock.json` is now local and git-ignored, and it is a plain JSON array of lanes instead
  of a tracked object with `schemaVersion`, `default` and `discoverUrl`. The order is the
  priority: the first lane is the default (on a fresh clone, the Craft stable build) instead of
  the cache-only `inklab-legacy`. Baselines recorded on a different default carry a different
  engine fingerprint, so the next run reports them stale and fails: re-record them with `--accept`,
  or pin `--runtime` to the lane they were recorded on. A missing file is a normal state and
  `npm run engine` creates it; invalid JSON and the old object format are rejected with a message
  that names the file.
- The engine cache is `.engine/` in the project directory (git-ignored; `INKLAB_ENGINE_DIR` still
  overrides it) instead of `~/.cache/inklab/engines` or `$XDG_CACHE_HOME/inklab/engines`. To keep
  engines you already have, copy them into `.engine/` with the same layout.
- `npm pack` carries only the host, fixtures and the documents above. The runtime list, the engine
  cache and e2e reports are excluded.
- Product names, device serial numbers and local paths were removed from sources, tests and docs.

### Removed

- The single-engine mode: `engine.lock.json` and `npm run engine -- --update`. Runtimes are
  fetched per lane from your `runtimes.lock.json`. Finding new Craft builds is now part of
  `npm run engine` itself (see Added): it appends lanes instead of rewriting a lock.
- The Studio and `inklab-legacy` lanes that used to ship in the tracked `runtimes.lock.json`.
  Studio builds are now discovered the same way as Craft builds (see Added), the cache-only
  `inklab-legacy` lane is gone, and other sources can be added by hand (see `docs/guide.md`).
- `MIGRATION.json` and `docs/migration-validation.json`.
- The cassette key rounding written for one product's coach prompts (`restRemainingSec`,
  `lastSummary.durationSec`, and the per-set amplitude fields were bucketed when building keys).
  Keys of every other request are unchanged, so existing cassettes keep working. A recorded request
  that carried those fields with values off the 5-second grid now fails with `replay-miss`:
  re-record it, or list the observed key under `aliases`.

### Security

- The local server validates the `Host` header on every route (a DNS-rebinding defence), rejects
  cross-site subresource requests, and answers CORS on the LLM forwarding route only for the
  workbench page's own origin.
- A malformed percent-encoded URL no longer crashes the server, a failing request no longer takes
  it down, and a busy port ends with an error message and exit code 1 instead of an unhandled
  exception.

[Unreleased]: https://github.com/1977744311/inklab/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/1977744311/inklab/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/1977744311/inklab/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/1977744311/inklab/releases/tag/v0.1.0
