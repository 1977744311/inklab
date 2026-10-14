#!/usr/bin/env node
import { main } from '../lib/node/device-e2e.mjs';

main(process.argv.slice(2)).then((code) => { process.exitCode = code; })
  .catch((err) => { console.error(`[device] ${err.message}`); process.exitCode = 1; });
