#!/usr/bin/env node
import { handleMeta } from '../lib/node/cli-meta.mjs';
import { main } from '../lib/node/e2e.mjs';

const argv = process.argv.slice(2);
if (!handleMeta('inklab-e2e', argv)) await main(argv);
