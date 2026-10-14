# Contributing to InkLab

Thanks for helping. This page covers the development setup, the rules the code base relies on,
and what a pull request needs. Issues and pull requests in English or Chinese are both welcome.

## Development setup

```bash
git clone https://github.com/1977744311/inklab.git
cd inklab
npm ci
npm test       # unit tests: no engine, no browser, no external network
npm run lint   # ESLint
```

Node.js 22 or later is required. Running anything in a browser also needs Chrome and a runtime
engine; the engine binaries go to `.engine/`, which git ignores, never into the repository:

```bash
npm run engine
npm run e2e -- fixtures/cap-probe-app --scenario smoke
```

`npm run engine` finds the engines on the Craft and AIUI Studio sites, records them in `runtimes.lock.json` (your
own list, also git-ignored, so nothing it writes can end up in a commit) and downloads them.
`npm run engine -- --check` never touches the network or the list.

## Repository layout

| Path | Contents |
| --- | --- |
| `bin/` | Command entry points (thin wrappers): `inklab`, `inklab-e2e`, `inklab-matrix`, `inklab-engine`, `inklab-device` |
| `host/` | The browser workbench: `inklab.js` is the entry, `host/inklab/*.js` split by responsibility, `device*` is the USB page |
| `lib/` | Pure modules shared by the workbench and Node; `lib/caps/` holds the capability fakes |
| `lib/node/` | Node-only code: the server, the e2e runner, the engine fetcher, the device runner |
| `scenarios/` | Built-in scenarios (just `smoke`) |
| `fixtures/` | The capability probe app and `minimal.aix` |
| `__tests__/` | `node:test` suites |
| `docs/` | Documentation (Chinese for now) |

## Rules the code base relies on

- **No engine binaries in the repository.** Engines live in `.engine/`, and the list that records
  their URLs, versions and SHA-256 hashes is the local `runtimes.lock.json`; both are git-ignored.
  `npm test` fails if a binary, the list or a local config would end up in the package.
- **Layering.** Code under `lib/` (except `lib/node/`), `host/` and `scenarios/` is loaded by the
  browser and must not depend on Node: no `node:` modules, no `Buffer` or `process`, nothing from
  `lib/node/`. `__tests__/boundaries.test.mjs` enforces it.
- **No product or private data.** InkLab must install and test without any sibling product
  repository. Fixtures, tests and docs use neutral sample content; product assertions and device
  control scripts belong to the application that owns them (see [docs/device.md](docs/device.md)).
- **Baseline stamps and cassettes are compatibility surface.** Changing what goes into a baseline
  stamp (`lib/stamp.mjs`) or a cassette key (`lib/caps/llm.mjs`) invalidates users' existing
  baselines or cassettes. Call it out in the changelog; a cassette format change also bumps
  `CASSETTE_VERSION`.
- **Fakes copy real-device behavior on purpose.** If a fake does something surprising, read
  [docs/runtime-notes.md](docs/runtime-notes.md) before "fixing" it, and add the evidence (engine
  version and date) when you change documented behavior.
- **Validate input before it reaches WASM.** A wrong-typed key or event can corrupt engine memory
  instead of throwing; the driver validates every input (`assertInput` in `lib/driver.mjs`).
- **Language.** The workbench UI and the long documents are in Chinese for now and there is no
  message catalog yet, so match the surrounding text. `README.md` and `README.zh-CN.md` change
  together.

## Style

ESLint (`npm run lint`) and `.editorconfig`. Plain ES modules, no build step, no runtime
dependencies (the three devDependencies are for linting only). Keep modules small and pure where
possible so they can be tested without a browser; browser-only code stays in `host/`.

## Tests

- Unit tests: `npm test`, or `node --test __tests__/<file>.test.mjs` for one file.
- Changes to runtime integration (`host/`, `lib/caps/`, `lib/driver.mjs`, the server or the e2e
  runner) also need a relevant browser scenario, for example
  `npm run e2e -- fixtures/cap-probe-app`.
- Changes that may behave differently between engines: run
  `npm run matrix -- fixtures/cap-probe-app --runtime <lane>,<lane>` and include the output in the
  pull request.

## Pull requests

1. Open an issue first for anything larger than a bug fix, so the approach can be agreed.
2. Keep one change per pull request, with tests.
3. `npm run lint` and `npm test` must pass; CI runs both on Ubuntu and macOS with Node.js 22 and 24.
4. Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
5. Describe how you verified the change (commands and results).

Commit messages use the imperative mood ("Add lane selection", "Fix stale baseline check") and
explain why in the body when the reason is not obvious.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
