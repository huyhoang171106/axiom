// src/llm/auth/hooks/google-vertex.ts - Vertex AI: the host follows the location; the wire gets every field (key, ADC path, project)

import type { CloudHook } from '../engines/cloud-fields.js';

export const prepare: CloudHook['prepare'] = (values, info) => {
  // Without a location the global endpoint is used; a regional one is `<location>-aiplatform.googleapis.com`.
  const location = values.GOOGLE_CLOUD_LOCATION || 'global';
  if (!/^[a-z0-9-]+$/.test(location)) throw new Error(`GOOGLE_CLOUD_LOCATION "${location}" is not a Vertex AI location (e.g. us-central1).`);
  const baseUrl = location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
  return { info: { ...info, baseUrl }, credential: JSON.stringify(values) };
};
