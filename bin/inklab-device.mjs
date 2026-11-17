#!/usr/bin/env node
import { handleMeta } from '../lib/node/cli-meta.mjs';
import { main } from '../lib/node/device-e2e.mjs';

const argv = process.argv.slice(2);
if (!handleMeta('inklab-device', argv)) {
  main(argv).then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`[device] ${err.message}`); process.exitCode = 1; });
}
