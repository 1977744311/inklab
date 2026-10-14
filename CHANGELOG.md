# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/1977744311/inklab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/1977744311/inklab/releases/tag/v0.1.0
