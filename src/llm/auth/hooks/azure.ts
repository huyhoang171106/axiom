// src/llm/auth/hooks/azure.ts - Azure OpenAI: the base URL comes from the resource name or an explicit URL

import type { CloudHook } from '../engines/cloud-fields.js';

export const prepare: CloudHook['prepare'] = (values, info) => {
  const explicit = values.AZURE_OPENAI_BASE_URL;
  const resource = values.AZURE_OPENAI_RESOURCE_NAME;
  // The key is sent to this host, so only an HTTPS URL or a plain resource name is accepted.
  if (explicit && !explicit.startsWith('https://')) throw new Error('AZURE_OPENAI_BASE_URL must start with https://');
  if (!explicit && !/^[a-z0-9-]+$/i.test(resource ?? '')) throw new Error('Set AZURE_OPENAI_RESOURCE_NAME (letters, digits, -) or AZURE_OPENAI_BASE_URL. Run /login azure.');
  const baseUrl = explicit ? explicit.replace(/\/+$/, '') : `https://${resource}.openai.azure.com/openai/v1`;
  return { info: { ...info, baseUrl }, credential: values.AZURE_OPENAI_API_KEY };
};
