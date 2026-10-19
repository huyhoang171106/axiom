// src/tui/app.tsx - Ink composition and global terminal shortcuts
import { useEffect, useSyncExternalStore } from 'react';
import { Box, Static, Text, useInput, useWindowSize } from 'ink';
import { defaultCommandRouter } from '../commands/index.js';
import { Header } from './components/header.js';
import { Transcript } from './components/transcript.js';
import { Editor } from './components/editor.js';
import { Footer } from './components/footer.js';
import type { TuiStore } from './store.js';
import type { TuiController } from './controller.js';

export function App({ store, controller, workspace, initial }: { store: TuiStore; controller: TuiController; workspace: string; initial: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { columns } = useWindowSize();
  const matches = /^\/\S*$/.test(state.editor.text) ? defaultCommandRouter.complete(state.editor.text) : [];
  useEffect(() => { if (initial) void controller.submit(initial); }, []);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { controller.interrupt(); return; }
    if (key.escape) { controller.abort(); return; }
    if (state.pendingApproval) {
      if (input.toLowerCase() === 'y') store.resolveApproval('approve');
      else if (input.toLowerCase() === 'n' || key.return) store.resolveApproval('deny');
      return;
    }
    if (key.ctrl && input === 'o') store.update({ expanded: !state.expanded });
    if (state.busy && !state.question) return;
    if (key.tab && matches[0]) {
      const text = `/${matches[0].name} `;
      store.update({ editor: { text, cursor: text.length } });
    } else if (key.upArrow && !state.editor.text && !state.question) {
      store.update({ editor: { text: controller.lastPrompt, cursor: controller.lastPrompt.length } });
    }
  });
  return <Box flexDirection="column">
    <Static items={['header']}>{item => <Header key={item} workspace={workspace} model={state.model ? `${state.model.provider}/${state.model.id}` : 'Dùng /login để kết nối'} />}</Static>
    <Transcript key={state.revision} state={state} expanded={state.expanded} width={columns} />
    {state.pendingApproval && <Box borderStyle="round" flexDirection="column">
      <Text>Cần duyệt: {state.pendingApproval.name}</Text><Text>{JSON.stringify(state.pendingApproval.args)}</Text>
      <Text>{state.pendingApproval.reason}</Text><Text>[y] Duyệt   [n / Enter] Từ chối</Text>
    </Box>}
    {state.question && <Text>{state.question.text}</Text>}
    <Editor value={state.editor} getValue={store.getEditor} disabled={!!state.pendingApproval || state.busy && !state.question} secret={state.question?.secret}
      onChange={editor => store.update({ editor })} onSubmit={text => state.question ? store.answer(text) : void controller.submit(text)} />
    {!!matches.length && <Text>{matches.map(command => `/${command.name}`).join('  ')} · Tab để điền</Text>}
    <Text>{state.notice}</Text>
    <Footer state={state} workspace={workspace} width={columns} />
  </Box>;
}
