#!/usr/bin/env node
import { handleMeta } from '../lib/node/cli-meta.mjs';
import { main } from '../lib/node/matrix.mjs';

const argv = process.argv.slice(2);
if (!handleMeta('inklab-matrix', argv)) main(argv).catch((error) => { console.error(`[matrix] ${error.message}`); process.exitCode = 1; });
