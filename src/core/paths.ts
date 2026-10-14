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
