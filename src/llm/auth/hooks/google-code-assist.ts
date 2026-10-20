// src/llm/auth/hooks/google-code-assist.ts - Gemini CLI and Antigravity: after sign-in, find or provision the account's Cloud Code Assist project
//
// The credential schema has no project field, so the project goes in the credential's `headers` as
// `x-goog-user-project`: that field survives other logins and refresh, is never sent as a request header,
// and the google-gemini-cli wire reads the project from it. A new personal account is onboarded (free
// tier); an account that cannot use Code Assist fails here with Google's own reason.

import { z } from 'zod';
import type { AfterExchangeHook } from '../engines/device-code.js';
import { withTimeout } from '../refresh.js';
import type { Credential } from '../engines/index.js';

const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 60;

/** What each client says it is; Antigravity's endpoint expects its own IDE type. */
const METADATA: Record<string, Record<string, string>> = {
  'google-gemini-cli': { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  'google-antigravity': { ideType: 'ANTIGRAVITY' },
};

const loadSchema = z.looseObject({
  currentTier: z.looseObject({ id: z.string().optional() }).nullish(),
  allowedTiers: z.array(z.looseObject({ id: z.string().optional(), isDefault: z.boolean().optional() })).optional(),
  cloudaicompanionProject: z.string().optional(),
  /** Why the account cannot get a tier (region, age, account validation); Gemini CLI shows these too. */
  ineligibleTiers: z.array(z.looseObject({ reasonMessage: z.string().optional(), validationUrl: z.string().optional() })).optional(),
});
type Load = z.infer<typeof loadSchema>;
const operationSchema = z.looseObject({
  name: z.string().optional(),
  done: z.boolean().optional(),
  error: z.looseObject({ message: z.string().optional() }).nullish(),
  // Gemini CLI answers `{ id }`, Antigravity a bare string.
  response: z.looseObject({ cloudaicompanionProject: z.union([z.string(), z.looseObject({ id: z.string() })]).optional() }).nullish(),
});

async function call<T>(step: string, schema: z.ZodType<T>, url: string, access: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${access}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: withTimeout(undefined, 30_000),
  });
  const reply: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // Google explains refusals (region, age, Workspace policy) in `error.message`; it holds no secret.
    const reason = z.object({ error: z.object({ message: z.string() }) }).safeParse(reply).data?.error.message;
    throw new Error(`Google Code Assist ${step} failed with HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
  }
  const parsed = schema.safeParse(reply);
  if (!parsed.success) throw new Error(`Google Code Assist ${step} returned an unexpected reply; the login flow may have changed.`);
  return parsed.data;
}

const NEEDS_PROJECT = 'This Google account needs a Cloud project: set GOOGLE_CLOUD_PROJECT and run /login again (https://goo.gle/gemini-cli-auth-docs#workspace-gca).';

/** Google's own reasons when it gave any, otherwise the project hint. */
function noProject(load?: Load): Error {
  const reasons = (load?.ineligibleTiers ?? []).map((t) => [t.reasonMessage, t.validationUrl].filter(Boolean).join(' ')).filter(Boolean);
  return new Error(reasons.length > 0 ? `Google Code Assist refused this account: ${reasons.join('; ')}` : NEEDS_PROJECT);
}

export const afterExchange: AfterExchangeHook['afterExchange'] = async (credential, _raw, provider) => {
  const api = `${provider.baseUrl}/v1internal`;
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
  const metadata = METADATA[provider.id] ?? METADATA['google-gemini-cli'];

  const load = await call('lookup', loadSchema, `${api}:loadCodeAssist`, credential.access, {
    cloudaicompanionProject: envProject,
    metadata: { ...metadata, duetProject: envProject },
  });
  const withProject = (project: string): Credential => ({ ...credential, headers: { ...credential.headers, 'x-goog-user-project': project } });
  if (load.currentTier) {
    const project = load.cloudaicompanionProject || envProject;
    if (!project) throw noProject(load);
    return withProject(project);
  }

  // Not onboarded yet: a personal account gets the free tier and a project made for it.
  const tierId = load.allowedTiers?.find((t) => t.isDefault)?.id ?? 'free-tier';
  if (tierId !== 'free-tier' && !envProject) throw noProject(load);
  let operation = await call('onboarding', operationSchema, `${api}:onboardUser`, credential.access, {
    tierId,
    metadata,
    ...(tierId !== 'free-tier' && { cloudaicompanionProject: envProject }),
  });
  for (let attempt = 0; !operation.done && operation.name && attempt < POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    operation = await call('onboarding', operationSchema, `${api}/${operation.name}`, credential.access);
  }
  if (operation.error?.message) throw new Error(`Google Code Assist onboarding failed: ${operation.error.message}`);
  if (!operation.done) throw new Error('Google Code Assist onboarding did not finish in time. Run /login again.');
  const made = operation.response?.cloudaicompanionProject;
  const project = (typeof made === 'string' ? made : made?.id) || envProject;
  if (!project) throw noProject();
  return withProject(project);
};
