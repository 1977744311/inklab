#!/usr/bin/env node
import { main } from '../lib/node/e2e.mjs';

await main(process.argv.slice(2));
