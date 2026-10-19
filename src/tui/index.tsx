// src/tui/index.tsx - Interactive Ink entrypoint with terminal cleanup
import { render } from 'ink';
import { App } from './app.js';
import { TuiStore } from './store.js';
import { TuiController } from './controller.js';

export async function startTui(argv: string[]): Promise<void> {
  const store = new TuiStore();
  const workspace = process.cwd();
  let quit = () => {};
  const controller = new TuiController(store, { workspaceRoot: workspace, mock: argv.includes('--mock'), exit: () => quit() });
  const initial = argv.filter(arg => !['--mock', '--yes', '--json'].includes(arg)).join(' ').trim();
  const app = render(<App store={store} controller={controller} workspace={workspace} initial={initial} />, { exitOnCtrlC: false });
  quit = () => app.unmount();
  try { await app.waitUntilExit(); }
  finally { controller.abort(); store.dispose(); app.cleanup(); }
}
