#!/usr/bin/env node
import { handleMeta } from '../lib/node/cli-meta.mjs';
import { main } from '../lib/node/fetch-engine.mjs';

const argv = process.argv.slice(2);
if (!handleMeta('inklab-engine', argv)) main(argv).catch((err) => { console.error('[inklab]', err.message); process.exit(1); });
