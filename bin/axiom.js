#!/usr/bin/env node
// bin/axiom.js - Universal Node.js execution wrapper for Axiom CLI

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
const tsCli = path.join(__dirname, 'axiom.ts');

if (fs.existsSync(distCli)) {
  import(distCli).then(({ runCli }) => {
    runCli().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });
} else {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(npx, ['tsx', tsCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
