// src/core/paths.ts - Where harness state (memory, skills, harness store) lives.
import os from 'node:os';
import path from 'node:path';

/**
 * Root of the user's global harness state. Tests can point AXIOM_HARNESS_HOME at a temp dir so
 * baseline/candidate runs cannot read or write each other's memory. Credentials and sessions are
 * deliberately NOT under this override.
 */
export function harnessHome(): string {
  return process.env.AXIOM_HARNESS_HOME || path.join(os.homedir(), '.axiom');
}

/** `~/.axiom`, or AXIOM_HOME so tests never touch the real one (providers.md section 8). */
export function axiomHome(): string {
  return process.env.AXIOM_HOME || path.join(os.homedir(), '.axiom');
}

/** Python for pytest and the ast chunker: AXIOM_PYTHON, else `python3` (`python` on Windows, where `python3` is often the Store stub). */
export function pythonBin(): string {
  return process.env.AXIOM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}
