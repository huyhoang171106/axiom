// src/tui/app.tsx - Ink composition and global terminal shortcuts
import { useEffect, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { defaultCommandRouter } from '../commands/index.js';
import { Header } from './components/header.js';
import { Transcript } from './components/transcript.js';
import { ApprovalDialog } from './components/approval-dialog.js';
import { Editor } from './components/editor.js';
import { Footer } from './components/footer.js';
import { truncate } from './layout.js';
import { createTheme } from './theme.js';
import type { TuiStore } from './store.js';
import type { TuiController } from './controller.js';

export function App({
  store,
  controller,
  workspace,
  initial,
}: {
  store: TuiStore;
  controller: TuiController;
  workspace: string;
  initial: string;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { columns } = useWindowSize();
  const theme = createTheme();
  const matches = !state.question && /^\/\S*$/.test(state.editor.text) ? defaultCommandRouter.complete(state.editor.text) : [];

  useEffect(() => {
    if (initial) void controller.submit(initial);
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.interrupt();
      return;
    }
    if (key.escape) {
      controller.abort();
      return;
    }
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

  const modelLabel = state.model ? `${state.model.provider}/${state.model.id}` : 'Dùng /login để kết nối';
  const completionLine = matches.length
    ? truncate(
        matches.length === 1
          ? `${theme.accent(matches[0].usage)} ${theme.muted(`— ${matches[0].summary} · Tab để điền`)}`
          : `${matches.map((command) => theme.accent(`/${command.name}`)).join(' ')} ${theme.muted('· Tab để điền')}`,
        columns,
      )
    : '';
  const noticeLine = state.notice
    ? truncate(
        /aborted|Ctrl\+C|Không kết nối|không còn khả dụng|vượt hạn mức/i.test(state.notice)
          ? theme.warning(state.notice)
          : theme.muted(state.notice),
        columns,
      )
    : '';

  return (
    <Box flexDirection="column">
      <Transcript
        key={state.revision}
        state={state}
        expanded={state.expanded}
        width={columns}
        header={<Header workspace={workspace} model={modelLabel} mode={state.mode} width={columns} />}
      />
      {state.pendingApproval && <ApprovalDialog approval={state.pendingApproval} width={columns} />}
      {state.question && <Text>{truncate(theme.accent(`${theme.icons.prompt} ${state.question.text}`), columns)}</Text>}
      <Editor
        value={state.editor}
        getValue={store.getEditor}
        width={columns}
        disabled={!!state.pendingApproval || (state.busy && !state.question)}
        secret={state.question?.secret}
        allowEmptySubmit={!!state.question}
        onChange={(editor) => store.update({ editor })}
        onSubmit={(text) => (state.question ? store.answer(text) : void controller.submit(text))}
      />
      {completionLine && <Text>{completionLine}</Text>}
      {noticeLine && <Text>{noticeLine}</Text>}
      <Footer state={state} workspace={workspace} width={columns} />
    </Box>
  );
}
