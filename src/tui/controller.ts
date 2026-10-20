// src/tui/controller.ts - Commands and agent lifecycle for the terminal
import { createAgent, MOCK_MODEL } from '../cli/agent.js';
import type { AgentLoop } from '../core/agent-loop.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { redact } from '../core/secrets.js';
import type { AxiomConfig } from '../core/types.js';
import { defaultCommandRouter } from '../commands/index.js';
import { parseCommand, unknownCommandMessage } from '../commands/router.js';
import { readAuth, readAxiomEnv } from '../llm/auth/store.js';
import { loadCatalog, readUserProviders, type Catalog, type ModelInfo } from '../llm/catalog/index.js';
import { resolveModel } from '../llm/model-resolver.js';
import { TuiStore } from './store.js';
import type { GitStatusCache } from './git-status.js';

/** Preferred default model when a provider's catalog default has zero free-tier quota. */
const PREFERRED_PROVIDER_MODEL: Partial<Record<string, string>> = {
  google: 'gemini-3.1-flash-lite',
};

function hasExplicitCredential(providerId: string, catalog: Catalog): boolean {
  const entry = catalog.providers().find((p) => p.id === providerId);
  if (!entry || entry.available === false) return false;
  const auth = readAuth();
  if (providerId in auth) return true;
  const user = readUserProviders();
  if (user[providerId]?.apiKey) return true;
  const dotenv = readAxiomEnv();
  return entry.env.some((name) => Boolean(process.env[name] || dotenv[name]));
}

function pickProviderModel(providerId: string, catalog: Catalog, config: AxiomConfig): ModelInfo | null {
  const entry = catalog.providers().find((p) => p.id === providerId);
  if (!entry || entry.available === false) return null;
  const preferredId = PREFERRED_PROVIDER_MODEL[providerId];
  const models = catalog.models(providerId);
  const chosenId =
    (preferredId && models.some((m) => m.id === preferredId) ? preferredId : undefined) ?? entry.defaultModel;
  try {
    return resolveModel(`${providerId}/${chosenId}`, catalog, config);
  } catch {
    return models[0] ?? null;
  }
}

/**
 * Resolves the active session model without falling back to an unconfigured local server (`litellm`, `ollama`)
 * unless the user explicitly selected it in `config.json`.
 */
export function resolveActiveModel(
  catalog: Catalog = loadCatalog(),
  config: AxiomConfig = loadConfig(),
): ModelInfo | null {
  const explicitSelector = config.modelRoles?.default ?? config.defaultModel;
  if (explicitSelector) {
    const slash = explicitSelector.indexOf('/');
    const explicitProvider = slash > 0 ? explicitSelector.slice(0, slash) : undefined;
    const knownEntry = explicitProvider ? catalog.providers().find((p) => p.id === explicitProvider) : undefined;
    const providerAllowed = !knownEntry || knownEntry.auth === 'none' || hasExplicitCredential(knownEntry.id, catalog);
    if (providerAllowed) {
      try {
        const info = resolveModel(explicitSelector, catalog, config);
        if (!knownEntry || info.provider === knownEntry.id) {
          const entry = catalog.providers().find((p) => p.id === info.provider);
          if (entry?.auth === 'none' || hasExplicitCredential(info.provider, catalog)) {
            return info;
          }
        }
      } catch {
        // Fall through to connected providers below.
      }
    }
  }
  const connected = catalog
    .providers()
    .find((p) => p.available !== false && hasExplicitCredential(p.id, catalog) && catalog.isAvailable(p.id));
  if (!connected) return null;
  return pickProviderModel(connected.id, catalog, config);
}

export function enrichErrorMessage(raw: string, model: ModelInfo | null): string {
  const clean = redact(raw);
  if (/Key not saved \(HTTP 400\)/i.test(clean)) {
    return `${clean} — API key không hợp lệ hoặc sai định dạng cho provider này. Hãy kiểm tra lại key từ trang tạo key và thử lại /login.`;
  }
  if (!model) return clean;
  const label = `${model.provider}/${model.id}`;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(clean)) {
    return `${clean}\n→ Không kết nối được tới ${label} (${model.baseUrl}). Nếu bạn chưa bật local server, hãy đăng nhập provider bằng /login <provider> rồi chọn model bằng /model.`;
  }
  if (/404 Not Found|no longer available/i.test(clean)) {
    const hint = model.provider === 'google' ? ' (ví dụ: /model google/gemini-3.1-flash-lite)' : '';
    return `${clean}\n→ Model ${label} không còn khả dụng trên endpoint này. Hãy đổi model bằng /model${hint}.`;
  }
  if (/429|quota|rate[_ -]?limit/i.test(clean)) {
    const hint = model.provider === 'google' ? ' (ví dụ: /model google/gemini-3.1-flash-lite)' : '';
    return `${clean}\n→ Model ${label} vượt hạn mức (quota/rate limit). Hãy đổi sang model khác bằng /model${hint}.`;
  }
  return clean;
}

export class TuiController {
  private agent?: AgentLoop;
  private controller?: AbortController;
  private running = false;
  private lastInterrupt = -Infinity;
  private detachGit?: () => void;
  public lastPrompt = '';

  constructor(
    public readonly store: TuiStore,
    private readonly opts: { workspaceRoot: string; mock?: boolean; exit?: () => void; git?: GitStatusCache },
  ) {
    if (this.opts.mock) {
      this.store.update({ model: MOCK_MODEL });
      this.store.flush();
    } else {
      const config = loadConfig();
      const initialModel = resolveActiveModel(loadCatalog(), config);
      if (initialModel) {
        if (!config.modelRoles?.default && config.defaultModel !== `${initialModel.provider}/${initialModel.id}`) {
          saveConfig({ defaultModel: `${initialModel.provider}/${initialModel.id}` });
        }
        this.store.update({ model: initialModel });
        this.store.flush();
      }
    }
  }

  public async submit(input: string): Promise<void> {
    if (this.running || !input.trim()) return;
    this.running = true;
    this.lastPrompt = input;
    const controller = new AbortController();
    this.controller = controller;
    this.store.update({ busy: true, notice: '' });
    try {
      const parsed = parseCommand(input);
      if (parsed) {
        const command = defaultCommandRouter.get(parsed.name);
        if (!command) throw new Error(unknownCommandMessage(defaultCommandRouter, parsed.name));
        const config = loadConfig();
        const mock = this.opts.mock;
        const store = this.store;
        const result = await command.run(parsed.args, {
          config,
          workspaceRoot: this.opts.workspaceRoot,
          signal: controller.signal,
          ui: {
            print: (text) => store.print(redact(text)),
            ask: async (question, options) => {
              const answer = await store.ask(question, options?.secret);
              return options?.secret ? answer.trim().replace(/^(['"])(.*)\1$/, '$2').trim() : answer;
            },
            confirm: async (question) => /^(y|yes)$/i.test((await store.ask(`${question} [y/N]`)).trim()),
          },
          session: {
            get model() {
              if (mock) return MOCK_MODEL;
              return store.getSnapshot().model ?? resolveActiveModel(loadCatalog(), config) ?? resolveModel('@default', loadCatalog(), config);
            },
            setModel: (info) => {
              store.update({ model: info });
              store.flush();
            },
          },
        });
        if (controller.signal.aborted) return;
        if (result?.kind === 'exit') this.opts.exit?.();
        else if (result?.kind === 'clear') this.store.clear();
        else if (result) this.store.print(redact(result.text), input);

        if (['model', 'login', 'logout'].includes(parsed.name)) {
          this.agent = undefined;
          this.syncModelAfterCommand(parsed.name, parsed.args, result?.data);
          this.store.flush();
        }
      } else {
        const activeModel = this.opts.mock ? MOCK_MODEL : this.ensureConnectedModel();
        this.store.update({ model: activeModel });
        if (!this.agent) {
          const agent = await createAgent({ workspaceRoot: this.opts.workspaceRoot, mock: this.opts.mock });
          if (controller.signal.aborted) return;
          this.agent = agent;
          this.store.attach(agent.eventBus);
          this.detachGit?.();
          this.detachGit = this.opts.git?.attach(agent.eventBus);
        }
        this.agent.toolRegistry.approver = (request) =>
          new Promise((resolve) => {
            if (controller.signal.aborted) resolve('deny');
            else this.store.requestApproval(request, resolve);
          });
        this.store.prepareTurn(input);
        const result = await this.agent.runTask(input, controller.signal);
        if (result.status === 'failed' && result.error) {
          const hint = enrichErrorMessage(result.error, activeModel);
          if (hint !== redact(result.error)) {
            const extra = hint.slice(redact(result.error).length).trim();
            if (extra) this.store.update({ notice: extra });
          } else {
            this.store.update({ notice: result.status });
          }
        } else {
          this.store.update({ notice: result.status });
        }
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const currentModel = this.store.getSnapshot().model;
      this.store.print(enrichErrorMessage(raw, currentModel), input);
      if (!this.agent && !this.opts.mock && !this.store.getSnapshot().model) {
        this.store.update({ notice: 'Dùng /login <provider> rồi /model <provider/model> để bắt đầu.' });
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.store.update({ busy: false });
    }
  }

  private ensureConnectedModel(): ModelInfo {
    const catalog = loadCatalog();
    const config = loadConfig();
    const active = this.store.getSnapshot().model ?? resolveActiveModel(catalog, config);
    if (!active) {
      throw new Error(
        'Chưa kết nối provider nào. Gõ /login <provider> (ví dụ: /login google, /login openrouter) hoặc chọn local model bằng /model.',
      );
    }
    // Persist defaultModel when it was inferred from a logged-in provider so createAgent() resolves the exact same provider.
    if (!config.modelRoles?.default && config.defaultModel !== `${active.provider}/${active.id}`) {
      saveConfig({ defaultModel: `${active.provider}/${active.id}` });
    }
    return active;
  }

  private syncModelAfterCommand(commandName: string, args: string, data: unknown): void {
    if (this.opts.mock) return;
    const catalog = loadCatalog();
    const config = loadConfig();
    if (commandName === 'login') {
      const loginData = data as { provider?: string; stored?: boolean } | undefined;
      const providerId = loginData?.provider ?? args.trim().split(/\s+/)[0];
      if (loginData?.stored && providerId) {
        const entry = catalog.providers().find((p) => p.id === providerId);
        const storeAs = typeof entry?.login?.storeAs === 'string' ? entry.login.storeAs : providerId;
        const picked = pickProviderModel(storeAs, catalog, config);
        if (picked) {
          saveConfig({ defaultModel: `${picked.provider}/${picked.id}` });
          this.store.update({
            model: picked,
            notice: `Đã kết nối ${picked.provider}. Đang dùng model: ${picked.provider}/${picked.id}`,
          });
          return;
        }
      }
    }
    const resolved = resolveActiveModel(catalog, loadConfig());
    this.store.update({ model: resolved });
  }

  public abort(): void {
    this.controller?.abort();
    this.store.cancelInteraction();
    this.store.update({ notice: 'aborted' });
  }

  public interrupt(now = Date.now()): void {
    if (now - this.lastInterrupt <= 2000) {
      this.abort();
      this.opts.exit?.();
      return;
    }
    this.lastInterrupt = now;
    if (this.running) this.abort();
    else this.store.update({ editor: { text: '', cursor: 0 } });
    this.store.update({ notice: 'Bấm Ctrl+C lần nữa để thoát' });
  }
}
