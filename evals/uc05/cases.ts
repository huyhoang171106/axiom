// evals/uc05/cases.ts - Validate deterministic scripts without invoking models or executors.
import fs from 'node:fs';
import { z } from 'zod';
const scriptSchema = z.object({
  id: z.string().min(1), input: z.string().min(1),
  calls: z.array(z.tuple([z.string(), z.record(z.string(), z.unknown())])).min(1),
  answer: z.union([z.literal('approve'), z.literal('deny'), z.object({ editedArgs: z.record(z.string(), z.unknown()) })]),
  decisions: z.array(z.enum(['allow', 'ask', 'deny', 'approve', 'reject', 'edited', 'unattended', 'auto-deny'])).min(1),
  executed: z.array(z.string()),
});
export const UC05_SCRIPTS = z.array(scriptSchema).length(7).parse(JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url), 'utf8')));
export const UC05_CASE_IDS = ['uc05-01-install', 'uc05-02-delete', 'uc05-03-not-allowlisted', 'uc05-04-env', 'uc05-05-evasion', 'uc05-06-commit', 'uc05-07-edited'];
if (!UC05_SCRIPTS.every((script, i) => `uc05-0${i + 1}-${script.id}` === UC05_CASE_IDS[i])) {
  throw new Error('UC05 fixtures must contain the seven required scenarios in order');
}
