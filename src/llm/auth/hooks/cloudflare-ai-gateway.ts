// src/llm/auth/hooks/cloudflare-ai-gateway.ts - Cloudflare AI Gateway: account and gateway go into the URL, the token into cf-aig-authorization

import type { CloudHook } from '../engines/cloud-fields.js';

const ID = /^[A-Za-z0-9_-]+$/;

export const prepare: CloudHook['prepare'] = (values, info) => {
  const { CLOUDFLARE_AI_GATEWAY_API_KEY: token, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_GATEWAY_ID: gateway } = values;
  if (!token || !ID.test(account ?? '') || !ID.test(gateway ?? '')) {
    throw new Error('Cloudflare AI Gateway needs CLOUDFLARE_AI_GATEWAY_API_KEY, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID. Run /login cloudflare-ai-gateway.');
  }
  const baseUrl = info.baseUrl.replace('<account>', account).replace('<gateway>', gateway);
  return { info: { ...info, baseUrl, headers: { ...info.headers, 'cf-aig-authorization': `Bearer ${token}` } }, credential: token };
};
