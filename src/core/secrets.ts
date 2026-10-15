// src/core/secrets.ts - Keep secret values out of child processes, tool output, logs and traces; stubs until C3

export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE/i;

// TODO(C3): drop variables whose name matches SECRET_NAME, keep PATH, HOME, LANG, TERM.
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env;
}

// TODO(C3): remember the value so redact() can replace it.
export function registerSecret(value: string): void {}

// TODO(C3): replace every known secret value with ‹redacted›.
export function redact(text: string): string {
  return text;
}
