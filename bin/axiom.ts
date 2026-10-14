#!/usr/bin/env tsx
// bin/axiom.ts - Direct tsx execution entrypoint

import { runCli } from '../src/cli/index.js';

runCli().catch((err) => {
  console.error(process.env.AXIOM_DEBUG ? err : `axiom: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
