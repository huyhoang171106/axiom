// src/core/secrets.ts - Keep secret values out of child processes, tool output, logs and traces

export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE/i;

/** Child processes break without these, so they survive even if a future SECRET_NAME would match them. */
const ALWAYS_KEPT = new Set(['PATH', 'HOME', 'LANG', 'TERM']);
/** Shorter env values are too likely to be ordinary words ("true", "1") to blank out everywhere. */
const MIN_ENV_SECRET_LENGTH = 8;
const REDACTED = '‹redacted›';

const registered = new Set<string>();

/** A copy of `env` without variables whose name looks like a credential. Windows names are case-insensitive (`Path`). */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => ALWAYS_KEPT.has(name.toUpperCase()) || !SECRET_NAME.test(name)));
}

/** Remembers a credential value so redact() hides it from then on. */
export function registerSecret(value: string): void {
  if (value) registered.add(value);
}

/** Replaces every known secret value: registered ones, and env values whose name matches SECRET_NAME. */
export function redact(text: string): string {
  const secrets = new Set(registered);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= MIN_ENV_SECRET_LENGTH && SECRET_NAME.test(name) && !ALWAYS_KEPT.has(name.toUpperCase())) secrets.add(value);
  }
  // Longest first, so a secret that contains another is replaced whole rather than leaving a fragment.
  return [...secrets].sort((a, b) => b.length - a.length).reduce((out, secret) => out.split(secret).join(REDACTED), text);
}
