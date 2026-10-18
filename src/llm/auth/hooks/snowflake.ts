// src/llm/auth/hooks/snowflake.ts - Snowflake Cortex: the account picks the host, the PAT is a bearer token

import type { CloudHook } from '../engines/cloud-fields.js';

/** Catalog base URLs use this origin until the account is known; it cannot resolve, so an unprepared request fails. */
const PLACEHOLDER_ORIGIN = 'https://snowflake-account.invalid';
const SUFFIX = '.snowflakecomputing.com';

/** `orgname-accountname`, a full host or an https URL to `https://<host>`; any other host is refused because it receives the PAT. */
export function accountOrigin(input: string): string {
  let host = input.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '').replaceAll('_', '-');
  if (!host.endsWith(SUFFIX)) host += SUFFIX;
  if (!host.split('.').every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error(`"${input}" is not a Snowflake account (orgname-accountname or https://<account>${SUFFIX}).`);
  }
  return `https://${host}`;
}

export const prepare: CloudHook['prepare'] = (values, info) => {
  const { SNOWFLAKE_PAT: pat, SNOWFLAKE_ACCOUNT: account } = values;
  if (!pat || !account) throw new Error('Snowflake needs SNOWFLAKE_PAT and SNOWFLAKE_ACCOUNT. Run /login snowflake.');
  const baseUrl = info.baseUrl.startsWith(PLACEHOLDER_ORIGIN) ? accountOrigin(account) + info.baseUrl.slice(PLACEHOLDER_ORIGIN.length) : info.baseUrl;
  const headers = { ...info.headers, authorization: `Bearer ${pat}`, 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' };
  return { info: { ...info, baseUrl, headers }, credential: pat };
};
