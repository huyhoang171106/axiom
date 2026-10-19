// src/tui/index.tsx - Interactive Ink entrypoint with terminal cleanup
import { render } from 'ink';
import { App } from './app.js';
import { TuiStore } from './store.js';
import { TuiController } from './controller.js';
import { GitStatusCache } from './git-status.js';

export async function startTui(argv: string[]): Promise<void> {
  const store = new TuiStore();
  const workspace = process.cwd();
  const git = new GitStatusCache(workspace, status => store.update({ git: status }));
  void git.refresh();
  let quit = () => {};
  const controller = new TuiController(store, { workspaceRoot: workspace, mock: argv.includes('--mock'), exit: () => quit(), git });
  const initial = argv.filter(arg => !['--mock', '--yes', '--json'].includes(arg)).join(' ').trim();
  const app = render(<App store={store} controller={controller} workspace={workspace} initial={initial} />, { exitOnCtrlC: false });
  quit = () => app.unmount();
  try { await app.waitUntilExit(); }
  finally { controller.abort(); store.dispose(); app.cleanup(); }
}
