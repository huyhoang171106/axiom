// src/tools/test-guard.ts - Refuse patches that weaken existing tests (UC-03 criterion 3)

import type { FilePatch } from './apply-patch.js';

/** null = allowed; otherwise the reason the patch tampers with a test. */
export function findTestTampering(patches: readonly FilePatch[], workspaceRoot: string): string | null {
  // TODO(C2)
  return null;
}
