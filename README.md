# InkLab

A standalone local workbench for AIUI source directories and AIX packages. It provides source hot reload, runtime comparison, controllable host capabilities, scenario execution, screenshots, recordings and optional device adapters.

## Quick start

Node.js 22 or later is required. Browser scenarios also use a local Chrome installation.

```bash
gh repo clone 1977744311/inklab
cd inklab
npm ci
npm test
npm run engine -- --matrix
npm start -- fixtures/cap-probe-app
```

To load your application, pass its source directory or `.aix` path. `npm run e2e -- /path/to/app --scenario smoke --llm off --no-video` runs a startup check. `npm run matrix -- ...` compares named runtimes.

## Repository boundaries

- `host/` and `lib/`: the workbench and host capabilities.
- `fixtures/` and `scenarios/`: self-contained probes and generic scenarios.
- `__tests__/`: standalone tests; no sibling product repository is required.
- Runtime lockfiles: versions, sources and hashes of separately obtained engine artifacts.
- [Detailed guide](docs/guide.md) and [runtime field notes](RUNTIME-NOTES.md): behavior and evidence conventions.

Runtime binaries are stored outside the repository under `$XDG_CACHE_HOME/inklab/engines` or `~/.cache/inklab/engines`. `INKLAB_ENGINE_DIR` overrides that location. `npm run engine -- --matrix --check` verifies cached bytes against the lockfiles. Engine binaries are not included with this source package.

`llm.local.json` is optional and ignored by Git; environment variables described in the guide are also supported. No product account configuration or private workspace data is required by the test suite.

## Product-owned device adapters

An application can provide `inklab.device.json` in its source root:

```json
{
  "profile": "my-app",
  "asrText": true,
  "controlScript": "scripts/glasses-control.mjs"
}
```

The control script path is resolved against the selected application. It implements the existing `key`, `say`, `capture` and `wake-assistant` command contract and returns a JSON dispatch receipt. Device access remains opt-in through `--device`; an application without an ASR adapter leaves `asrText` false. Real hardware validation remains separate from host simulation.

## Source status

This repository was extracted from [aiui-test](https://github.com/1977744311/aiui-test), with product dependencies removed. It is currently private; public release and an open-source license remain separate decisions. Runtime binaries retain their separate upstream distribution status. Source provenance is recorded in [MIGRATION.json](MIGRATION.json).
