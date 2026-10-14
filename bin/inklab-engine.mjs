#!/usr/bin/env node
import { main } from '../lib/node/fetch-engine.mjs';

main(process.argv.slice(2)).catch((err) => { console.error('[inklab]', err.message); process.exit(1); });
