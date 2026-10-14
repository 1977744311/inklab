# InkLab agent guide

## Boundaries and invariants

1. **Standalone repository**: InkLab must install and test without any sibling product repository. Keep generic capability probes and fixtures here (`fixtures/cap-probe-app`); product assertions, scenarios, cassettes, baselines, and device control scripts belong to their owning applications.
2. **Browser / Node layering** (`__tests__/boundaries.test.mjs`): Code loaded by the browser (`lib/` except `lib/node/`, `host/`, `scenarios/`) must use web-standard APIs only — never import `node:*` or `lib/node/*`, and never reference `Buffer` or `process`.
3. **Local state and packaging** (`__tests__/local-state.test.mjs`, `__tests__/package.test.mjs`): Engine binaries (`.engine/`), the runtime list (`runtimes.lock.json`), local LLM credentials (`llm.local.json`), and run reports (`**/e2e/report/`, `.runs/`) are git-ignored local state and must never enter git or `npm pack`.
4. **Compatibility surface**: Changing baseline stamp inputs (`lib/stamp.mjs`) or LLM cassette key normalization (`lib/caps/llm.mjs`, `CASSETTE_VERSION`) invalidates existing user baselines or cassettes. Keep `README.md` and `README.zh-CN.md` in sync when user-visible behavior or flags change.

## Context pointers

- [`docs/runtime-notes.md`](docs/runtime-notes.md) — **Read before** editing `host/`, `lib/driver.mjs`, `lib/caps/`, or scenario scripts: documents rAF frame pumping in hidden/headless tabs, why `syncFocus` stays off, `dispatchInput` WASM memory safety, 700 ms key dedup vs 1.2 s page-show cooldown, sampling-only `onLoad` logs, lazy `Dropping Ink instance` mutex panics, and `stream: true` LLM requests.
- [`docs/guide.md`](docs/guide.md) — **Read when** changing workbench UI controls, the `window.__inklab` automation surface, capability fakes, LLM modes (`off`/`live`/`record`/`replay`), screenshot diffing, or `npm run engine` discovery and lock rules.
- [`docs/device.md`](docs/device.md) — **Read when** working on `--device`, `bin/inklab-device.mjs`, `lib/node/device-*.mjs`, ADB H.264 mirror streaming, or the `inklab.device.json` control-script contract.

## Verification

- Run `npm test` and `npm run lint` after code changes (requires no engine binary, browser, or external network).
- For runtime integration changes (`host/`, `lib/caps/`, `lib/driver.mjs`, `lib/node/serve.mjs`, `lib/node/e2e*.mjs`), also run a browser scenario such as `npm run e2e -- fixtures/cap-probe-app --scenario smoke` when `.engine/` is populated.
