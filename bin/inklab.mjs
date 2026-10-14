#!/usr/bin/env node
import { main } from '../lib/node/serve.mjs';

await main(process.argv.slice(2));
