// src/tui/index.tsx - Interactive Ink entrypoint with terminal cleanup
import { render, type RenderOptions } from 'ink';
import { App } from './app.js';
import { TuiStore } from './store.js';
import { TuiController } from './controller.js';
import { GitStatusCache } from './git-status.js';
import { parseCliArgs } from '../cli/index.js';

export async function startTui(argv: string[], renderOptions?: Partial<RenderOptions>): Promise<void> {
  const { model, mock, words } = parseCliArgs(argv);
  const store = new TuiStore();
  const workspace = process.cwd();
  const git = new GitStatusCache(workspace, status => store.update({ git: status }));
  void git.refresh();
  let quit = () => {};
  const controller = new TuiController(store, { workspaceRoot: workspace, mock, model, exit: () => quit(), git });
  const initial = words.join(' ').trim();
  const targetStdout = renderOptions?.stdout ?? process.stdout;
  if (targetStdout && typeof (targetStdout as any).write === 'function') {
    (targetStdout as any).write('\x1b[?1049h\x1b[H');
  }
  const app = render(<App store={store} controller={controller} workspace={workspace} initial={initial} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
    ...renderOptions,
  });
  quit = () => app.unmount();
  try { await app.waitUntilExit(); }
  finally { controller.abort(); store.dispose(); app.cleanup(); }
}

