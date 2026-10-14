#!/usr/bin/env node
import { main } from '../lib/node/matrix.mjs';

main(process.argv.slice(2)).catch((error) => { console.error(`[matrix] ${error.message}`); process.exitCode = 1; });
