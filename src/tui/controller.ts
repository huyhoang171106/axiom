// src/tui/controller.ts - Commands and agent lifecycle for the terminal
import { createAgent, MOCK_MODEL } from '../cli/agent.js';
import type { AgentLoop } from '../core/agent-loop.js';
import { loadConfig } from '../core/config.js';
import { redact } from '../core/secrets.js';
import { defaultCommandRouter } from '../commands/index.js';
import { parseCommand, unknownCommandMessage } from '../commands/router.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { resolveModel } from '../llm/model-resolver.js';
import { TuiStore } from './store.js';

export class TuiController {
  private agent?: AgentLoop;
  private controller?: AbortController;
  private running = false;
  private lastInterrupt = -Infinity;
  public lastPrompt = '';
  constructor(public readonly store: TuiStore, private readonly opts: { workspaceRoot: string; mock: boolean; exit(): void }) {}
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
          config, workspaceRoot: this.opts.workspaceRoot, signal: controller.signal,
          ui: { print: text => store.print(redact(text)), ask: (question, options) => store.ask(question, options?.secret),
            confirm: async question => /^y$/i.test(await store.ask(`${question} [y/N]`)) },
          session: { get model() { return mock ? MOCK_MODEL : resolveModel('@default', loadCatalog(), config); },
            setModel: info => store.update({ model: info }) },
        });
        if (controller.signal.aborted) return;
        if (result?.kind === 'exit') this.opts.exit();
        else if (result?.kind === 'clear') this.store.clear();
        else if (result) this.store.print(redact(result.text), input);
        if (['model', 'login', 'logout'].includes(parsed.name)) this.agent = undefined;
      } else {
        if (!this.agent) {
          const agent = await createAgent({ workspaceRoot: this.opts.workspaceRoot, mock: this.opts.mock });
          if (controller.signal.aborted) return;
          this.agent = agent;
          this.store.attach(agent.eventBus);
        }
        this.agent.toolRegistry.approver = request => new Promise(resolve => {
          if (controller.signal.aborted) resolve('deny');
          else this.store.requestApproval(request, resolve);
        });
        this.store.update({ model: this.opts.mock ? MOCK_MODEL : resolveModel('@default', loadCatalog(), loadConfig()) });
        this.store.prepareTurn(input);
        const result = await this.agent.runTask(input, controller.signal);
        this.store.update({ notice: result.status });
      }
    } catch (error) {
      this.store.print(redact(error instanceof Error ? error.message : String(error)));
      if (!this.agent && !this.opts.mock) this.store.update({ notice: 'Dùng /login rồi /model role default <provider/model>.' });
    } finally {
      this.running = false;
      this.controller = undefined;
      this.store.update({ busy: false });
    }
  }
  public abort(): void {
    this.controller?.abort();
    this.store.cancelInteraction();
    this.store.update({ notice: 'aborted' });
  }
  public interrupt(now = Date.now()): void {
    if (now - this.lastInterrupt <= 2000) { this.abort(); this.opts.exit(); return; }
    this.lastInterrupt = now;
    if (this.running) this.abort();
    else this.store.update({ editor: { text: '', cursor: 0 } });
    this.store.update({ notice: 'Bấm Ctrl+C lần nữa để thoát' });
  }
}
