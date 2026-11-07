// src/tui/controller.ts - Commands and agent lifecycle for the terminal
import { createAgent, MOCK_MODEL } from '../cli/agent.js';
import type { AgentLoop } from '../core/agent-loop.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { redact } from '../core/secrets.js';
import type { AxiomConfig } from '../core/types.js';
import { defaultCommandRouter } from '../commands/index.js';
import { permissionSession } from '../commands/permission-session.js';
import { parseCommand, unknownCommandMessage } from '../commands/router.js';
import type { ModelRow } from '../commands/models.js';
import type { Command, CommandContext } from '../commands/types.js';
import { createExecutionContext, type ExecutionContext } from '../core/execution-context.js';
import { readAuth, readAxiomEnv } from '../llm/auth/store.js';
import { loadCatalog, readUserProviders, type Catalog, type ModelInfo } from '../llm/catalog/index.js';
import { resolveModel } from '../llm/model-resolver.js';
import { formatTokens } from './layout.js';
import type { TuiMenuItem } from './select-menu.js';
import { TuiStore } from './store.js';
import type { GitStatusCache } from './git-status.js';

/** Preferred default models when a provider's catalog default has zero free-tier quota. */
const PREFERRED_PROVIDER_MODELS: Partial<Record<string, readonly string[]>> = {
  google: ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'],
};

const RETIRED_GOOGLE_MODELS = new Set(['gemini-1.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);

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
  const preferredIds = PREFERRED_PROVIDER_MODELS[providerId] ?? [];
  const models = catalog.models(providerId);
  const chosenId = preferredIds.find((id) => models.some((m) => m.id === id)) ?? entry.defaultModel;
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

function buildModelMenuItems(rows: ModelRow[], catalog: Catalog, currentSelector?: string): TuiMenuItem[] {
  const scored = rows.map((row, idx) => {
    const hasCred = hasExplicitCredential(row.provider, catalog);
    const isPreferred = (PREFERRED_PROVIDER_MODELS[row.provider] ?? []).includes(row.id);
    const isRetired = row.provider === 'google' && RETIRED_GOOGLE_MODELS.has(row.id);
    const rank = hasCred ? (isPreferred ? 0 : isRetired ? 2 : 1) : 3;
    return { row, idx, hasCred, isPreferred, isRetired, rank };
  });
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);

  return scored.map(({ row, hasCred, isPreferred, isRetired }) => {
    const isCurrent = row.selector === currentSelector;
    const ctxText = formatTokens(row.contextWindow);
    const costText = row.cost ? `$${row.cost.input}/$${row.cost.output}` : 'free/local';
    const note = isPreferred ? ' · khuyên dùng' : isRetired ? ' · ngừng hỗ trợ key mới' : '';
    return {
      value: row.selector,
      label: row.selector,
      description: `${row.name} · ${ctxText} · ${costText}${note}`,
      badge: isCurrent ? 'đang dùng' : hasCred ? 'connected' : 'local',
      active: isCurrent,
    };
  });
}

interface LoginListRow {
  id: string;
  name: string;
  connection: string;
  status: string;
}

function buildLoginMenuItems(rows: LoginListRow[]): TuiMenuItem[] {
  const scored = rows.map((row, idx) => {
    const unsupported = row.status.startsWith('unsupported:');
    const loggedIn = row.status === 'logged in';
    const rank = unsupported ? 2 : loggedIn ? 0 : 1;
    return { row, idx, unsupported, loggedIn, rank };
  });
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);

  return scored.map(({ row, unsupported, loggedIn }) => ({
    value: row.id,
    label: `${row.id} (${row.name})`,
    description: `${row.connection} · ${row.status}`,
    badge: loggedIn ? 'đã kết nối' : row.status === 'available' ? 'sẵn sàng' : undefined,
    active: loggedIn,
    disabled: unsupported,
  }));
}

export class TuiController {
  private agent?: AgentLoop;
  private controller?: AbortController;
  private running = false;
  private lastInterrupt = -Infinity;
  private execution?: ExecutionContext;
  public lastPrompt = '';

  constructor(
    public readonly store: TuiStore,
    private readonly opts: { workspaceRoot: string; mock?: boolean; model?: string; exit?: () => void; git?: GitStatusCache },
  ) {
    if (this.opts.mock) {
      this.store.update({ model: MOCK_MODEL });
      this.store.flush();
    } else {
      const config = loadConfig();
      const catalog = loadCatalog();
      let initialModel: ModelInfo | null = null;
      if (this.opts.model) {
        try {
          initialModel = resolveModel(this.opts.model, catalog, config);
        } catch {
          initialModel = null;
        }
      }
      if (!initialModel) {
        initialModel = resolveActiveModel(catalog, config);
      }
      if (initialModel) {
        if (!config.modelRoles?.default && config.defaultModel !== `${initialModel.provider}/${initialModel.id}`) {
          saveConfig({ defaultModel: `${initialModel.provider}/${initialModel.id}` });
        }
        this.store.update({ model: initialModel });
        this.store.flush();
      }
    }
  }

  /** The session chat and slash commands share; made on the first input so the first command already has it. */
  private get exec(): ExecutionContext {
    if (!this.execution) {
      this.execution = createExecutionContext();
      this.store.attach(this.execution.bus);
      this.opts.git?.attach(this.execution.bus);
    }
    return this.execution;
  }

  private createCommandContext(
    config: AxiomConfig,
    signal: AbortSignal,
    transientHints?: string[],
  ): CommandContext {
    const mock = this.opts.mock;
    const store = this.store;
    return {
      ...this.exec,
      config,
      workspaceRoot: this.opts.workspaceRoot,
      signal,
      ui: {
        print: (text) => {
          const clean = redact(text);
          if (transientHints) {
            transientHints.push(clean);
            store.setQuestionHint(transientHints.join('\n'));
            store.update({ notice: clean });
            store.flush();
          } else {
            store.print(clean);
          }
        },
        ask: async (question, options) => {
          // Lệnh có thể vừa hoàn tất await sau abort; không mở lại tương tác đã huỷ.
          if (signal.aborted) throw new Error('Cancelled');
          const hint = transientHints && transientHints.length > 0 ? transientHints.join('\n') : undefined;
          const answer = await store.ask(question, options?.secret, hint);
          return options?.secret ? answer.trim().replace(/^(['"])(.*)\1$/, '$2').trim() : answer;
        },
        confirm: async (question) => {
          if (signal.aborted) throw new Error('Cancelled');
          // Dùng cùng hộp duyệt; xác nhận giữa node không phải một tool call.
          return new Promise<boolean>((resolve) => store.requestApproval(
            { name: 'confirm', args: { question }, reason: question },
            (decision) => {
              this.exec.bus.emit('approval', { tool: 'confirm', reason: question,
                decision: decision === 'approve' ? 'approve' : 'deny', approver: 'user' });
              resolve(decision === 'approve');
            },
          ));
        },
      },
      session: {
        get model() {
          if (mock) return MOCK_MODEL;
          return (
            store.getSnapshot().model ??
            resolveActiveModel(loadCatalog(), config) ??
            resolveModel('@default', loadCatalog(), config)
          );
        },
        setModel: (info) => {
          store.update({ model: info });
          store.flush();
        },
      },
    };
  }

  private async handleModelCommand(command: Command, args: string, config: AxiomConfig, signal: AbortSignal): Promise<void> {
    const transientHints: string[] = [];
    const ctx = this.createCommandContext(config, signal, transientHints);
    const result = await command.run(args, ctx);
    if (signal.aborted) return;

    if (result?.kind === 'model-list') {
      const rows = (result.data as ModelRow[]) ?? [];
      const catalog = loadCatalog();
      const current = this.store.getSnapshot().model;
      const currentSelector = current ? `${current.provider}/${current.id}` : undefined;
      const items = buildModelMenuItems(rows, catalog, currentSelector);
      if (items.length === 0) {
        this.store.update({ notice: 'Chưa có provider nào kết nối. Gõ /login để kết nối.' });
        this.store.flush();
        return;
      }
      const picked = await this.store.openMenu({
        kind: 'model',
        title: 'Chọn model cho phiên làm việc',
        placeholder: 'Gõ để lọc model hoặc provider...',
        items,
        initialValue: currentSelector ?? items[0]?.value,
      });
      this.store.flush();
      if (!picked || signal.aborted) {
        this.store.update({ notice: 'Đã hủy chọn model.' });
        this.store.flush();
        return;
      }
      const switchResult = await command.run(picked, ctx);
      if (signal.aborted) return;
      this.agent = undefined;
      this.syncModelAfterCommand('model', picked, switchResult?.data);
      const updated = this.store.getSnapshot().model;
      this.store.update({
        notice: updated ? `Đã chọn model: ${updated.provider}/${updated.id}` : redact(switchResult?.text ?? ''),
      });
      this.store.flush();
      return;
    }

    this.agent = undefined;
    this.syncModelAfterCommand('model', args, result?.data);
    if (result?.text) {
      this.store.update({ notice: redact(result.text) });
    }
    this.store.flush();
  }

  private async handleLoginCommand(command: Command, args: string, config: AxiomConfig, signal: AbortSignal): Promise<void> {
    let targetProvider = args.trim();
    if (!targetProvider) {
      const listCtx = this.createCommandContext(config, signal, []);
      const listResult = await command.run('', listCtx);
      if (signal.aborted) return;
      const rows = (listResult?.data as LoginListRow[]) ?? [];
      const current = this.store.getSnapshot().model;
      const items = buildLoginMenuItems(rows);
      const picked = await this.store.openMenu({
        kind: 'login',
        title: 'Chọn provider để đăng nhập',
        placeholder: 'Gõ tên provider (vd: google, openrouter, anthropic, openai)...',
        items,
        initialValue: current?.provider,
      });
      this.store.flush();
      if (!picked || signal.aborted) {
        this.store.update({ notice: 'Đã hủy đăng nhập.' });
        this.store.flush();
        return;
      }
      targetProvider = picked;
    }

    const loginHints: string[] = [];
    const loginCtx = this.createCommandContext(config, signal, loginHints);
    const loginResult = await command.run(targetProvider, loginCtx);
    if (signal.aborted) return;
    this.agent = undefined;
    this.syncModelAfterCommand('login', targetProvider, loginResult?.data);
    const loginData = loginResult?.data as { stored?: boolean } | undefined;
    if (loginResult && !loginData?.stored) {
      this.store.update({ notice: redact(loginResult.text) });
    }
    this.store.flush();
  }

  private async handleLogoutCommand(command: Command, args: string, config: AxiomConfig, signal: AbortSignal): Promise<void> {
    let targetProvider = args.trim();
    const ctx = this.createCommandContext(config, signal, []);
    if (!targetProvider) {
      const listResult = await command.run('', ctx);
      if (signal.aborted) return;
      const stored = (listResult?.data as { stored?: string[] } | undefined)?.stored ?? [];
      if (stored.length === 0) {
        this.store.update({ notice: 'Chưa có thông tin đăng nhập nào được lưu.' });
        this.store.flush();
        return;
      }
      const catalog = loadCatalog();
      const items: TuiMenuItem[] = stored.map((id) => {
        const entry = catalog.providers().find((p) => p.id === id);
        return {
          value: id,
          label: entry ? `${id} (${entry.name})` : id,
          description: 'Xoá thông tin xác thực đã lưu',
          badge: 'đã kết nối',
          active: true,
        };
      });
      const picked = await this.store.openMenu({
        kind: 'logout',
        title: 'Chọn provider để đăng xuất',
        placeholder: 'Gõ tên provider...',
        items,
      });
      this.store.flush();
      if (!picked || signal.aborted) {
        this.store.update({ notice: 'Đã hủy đăng xuất.' });
        this.store.flush();
        return;
      }
      targetProvider = picked;
    }

    const result = await command.run(targetProvider, ctx);
    if (signal.aborted) return;
    this.agent = undefined;
    this.syncModelAfterCommand('logout', targetProvider, result?.data);
    if (result?.text) {
      this.store.update({ notice: redact(result.text) });
    }
    this.store.flush();
  }

  public async submit(input: string): Promise<void> {
    if (this.running || !input.trim()) return;
    this.running = true;
    this.lastPrompt = input;
    const controller = new AbortController();
    this.controller = controller;
    this.store.update({ busy: true, notice: '' });
    const parsed = parseCommand(input);
    // Every tool call of this input, chat or workflow node, asks through the approval dialog.
    this.exec.tools.approver = (request) =>
      new Promise((resolve) => {
        if (controller.signal.aborted) resolve('deny');
        else this.store.requestApproval(request, resolve);
      });
    try {
      if (parsed) {
        let command = defaultCommandRouter.get(parsed.name);
        if (!command) {
          const completions = defaultCommandRouter.complete(`/${parsed.name}`);
          if (completions.length > 0) {
            command = defaultCommandRouter.get(completions[0].name);
            if (command) {
              parsed.name = command.name;
            }
          }
        }
        if (!command) throw new Error(unknownCommandMessage(defaultCommandRouter, parsed.name));
        // Resume có thể phục hồi snapshot trước node step; chặn workflow ghi trước dispatch.
        if (this.exec.tools.permissionMode === 'read-only' && ['fix', 'feature', 'resume'].includes(parsed.name)) {
          throw new Error(`/${parsed.name} requires edit mode. Use /mode edit first.`);
        }
        const config = loadConfig();

        if (parsed.name === 'model') {
          await this.handleModelCommand(command, parsed.args, config, controller.signal);
          return;
        }
        if (parsed.name === 'login') {
          await this.handleLoginCommand(command, parsed.args, config, controller.signal);
          return;
        }
        if (parsed.name === 'logout') {
          await this.handleLogoutCommand(command, parsed.args, config, controller.signal);
          return;
        }

        const result = await command.run(parsed.args, this.createCommandContext(config, controller.signal));
        if (parsed.name === 'mode' || parsed.name === 'plan') {
          const permissions = permissionSession({ tools: this.exec.tools, workspaceRoot: this.opts.workspaceRoot });
          this.store.update({ mode: permissions.mode, planMode: permissions.planning });
        }
        if (controller.signal.aborted) return;
        if (result?.kind === 'exit') this.opts.exit?.();
        else if (result?.kind === 'clear') this.store.clear();
        else if (result) {
          // Ticket đã được in trước confirm; sau route chỉ in kết quả workflow để tránh lặp bảng.
          const data = result.data;
          const route = result.kind === 'issue-ticket' && data && typeof data === 'object' && 'result' in data
            ? data.result : undefined;
          const text = route && typeof route === 'object' && 'text' in route && typeof route.text === 'string'
            ? route.text : result.text;
          this.store.print(redact(text), input, result);
        }
      } else {
        const activeModel = this.opts.mock ? MOCK_MODEL : this.ensureConnectedModel();
        this.store.update({ model: activeModel });
        if (!this.agent) {
          const agent = await createAgent({ workspaceRoot: this.opts.workspaceRoot, mock: !!this.opts.mock, exec: this.exec });
          if (controller.signal.aborted) return;
          this.agent = agent;
          permissionSession({ tools: this.exec.tools, workspaceRoot: this.opts.workspaceRoot }).bind(agent);
        }
        if (this.agent.stateMachine.getState() === 'completed') {
          this.agent.stateMachine.reset();
        }
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
      if (raw === 'Cancelled' || controller.signal.aborted) {
        this.store.update({ notice: parsed ? 'Đã hủy thao tác.' : 'aborted' });
        this.store.flush();
        return;
      }
      const currentModel = this.store.getSnapshot().model;
      const enriched = enrichErrorMessage(raw, currentModel);
      if (parsed && ['model', 'login', 'logout'].includes(parsed.name)) {
        this.store.update({ notice: enriched.replace(/\r?\n/g, ' ') });
        this.store.flush();
        return;
      }
      this.store.print(enriched, input);
      if (!this.agent && !this.opts.mock && !this.store.getSnapshot().model) {
        this.store.update({ notice: 'Dùng /login <provider> rồi /model <provider/model> để bắt đầu.' });
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.store.update({ busy: false });
      this.store.flush();
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
          const selector = `${picked.provider}/${picked.id}`;
          saveConfig({
            defaultModel: selector,
            ...(config.modelRoles?.default ? { modelRoles: { ...config.modelRoles, default: selector } } : {}),
          });
          this.store.update({
            model: picked,
            notice: `Đã kết nối ${picked.provider}. Đang dùng model: ${selector}`,
          });
          return;
        }
      }
    }
    if (commandName === 'model' && data && typeof data === 'object' && 'provider' in data && 'id' in data) {
      const info = data as ModelInfo;
      const selector = `${info.provider}/${info.id}`;
      if (config.modelRoles?.default && config.modelRoles.default !== selector) {
        saveConfig({ defaultModel: selector, modelRoles: { ...config.modelRoles, default: selector } });
      }
      this.store.update({ model: info });
      return;
    }
    const resolved = resolveActiveModel(catalog, loadConfig());
    this.store.update({ model: resolved });
  }

  public abort(): void {
    this.controller?.abort();
    this.store.cancelInteraction();
    this.store.update({ notice: 'aborted' });
    this.store.flush();
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
    this.store.flush();
  }
}
