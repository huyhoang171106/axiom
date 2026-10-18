// src/llm/auth/engines/hook.ts - engine login `hook`, nạp luồng riêng theo tên trong auth JSON

import type { CommandUI } from '../../../commands/types.js';
import type { ProviderEntry } from '../../catalog/index.js';
import type { Credential, LoginEngine } from './index.js';

/** Cùng shape với credential đã lưu; hook trả về đúng một bản ghi. */
export type StoredCredential = Credential;

export interface LoginContext {
  provider: ProviderEntry;
  ui: CommandUI;
  /** Test seam: vòng poll chờ hàm này thay vì hẹn giờ thật. */
  sleep?: (ms: number) => Promise<void>;
}

/** Hook refresh cần provider để lấy endpoint/clientId từ auth JSON, không hardcode trong TS. */
export type HookRefresh = (cred: StoredCredential, provider: ProviderEntry) => Promise<StoredCredential>;

export interface LoginHook {
  login(ctx: LoginContext): Promise<StoredCredential>;
  refresh?: HookRefresh;
}

const HOOK_NAME = /^[a-z0-9-]+$/;

export function hookSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nạp lười một file trong `../hooks/`; tên chỉ cho chữ thường, số và dấu gạch ngang. */
export async function loadHook(name: string): Promise<LoginHook> {
  if (!HOOK_NAME.test(name)) throw new Error(`Invalid login hook name: ${name}`);
  const module = (await import(`../hooks/${name}.js`)) as Partial<LoginHook>;
  if (typeof module.login !== 'function') {
    throw new Error(`Login hook "${name}" has no login(); update the auth file`);
  }
  return module as LoginHook;
}

export const hookEngine: LoginEngine = async (provider, ui) => {
  const name = provider.login?.hook;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${provider.id}: login type hook has no hook name; update the auth file`);
  }
  let hook: LoginHook;
  try {
    hook = await loadHook(name);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${provider.id}: login hook "${name}" failed to load (${reason}); use an API key or update the auth file`);
  }
  return hook.login({ provider, ui });
};
