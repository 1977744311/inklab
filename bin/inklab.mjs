#!/usr/bin/env node
import { handleMeta } from '../lib/node/cli-meta.mjs';
import { main } from '../lib/node/serve.mjs';

const argv = process.argv.slice(2);
if (!handleMeta('inklab', argv)) await main(argv);
