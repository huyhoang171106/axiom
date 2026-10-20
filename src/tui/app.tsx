// src/tui/app.tsx - Ink composition and global terminal shortcuts
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { defaultCommandRouter } from '../commands/index.js';
import { Header } from './components/header.js';
import { Transcript } from './components/transcript.js';
import { ApprovalDialog } from './components/approval-dialog.js';
import { Editor } from './components/editor.js';
import { SelectMenu } from './components/select-menu.js';
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
  const matches =
    !state.menu && !state.question && /^\/\S*$/.test(state.editor.text)
      ? defaultCommandRouter.complete(state.editor.text)
      : [];
  const [slashIndex, setSlashIndex] = useState(0);
  const clampedSlashIdx = matches.length > 0 ? Math.min(slashIndex, matches.length - 1) : 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [state.editor.text]);

  useEffect(() => {
    if (initial) void controller.submit(initial);
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      controller.interrupt();
      return;
    }
    if (state.pendingApproval) {
      if (key.escape || input.toLowerCase() === 'n' || key.return) store.resolveApproval('deny');
      else if (input.toLowerCase() === 'y') store.resolveApproval('approve');
      return;
    }
    if (state.menu) {
      // SelectMenu owns keyboard navigation, search typing, Enter and Esc while active.
      return;
    }
    if (key.escape) {
      controller.abort();
      return;
    }
    if (key.ctrl && input === 'o') store.update({ expanded: !state.expanded });
    if (state.busy && !state.question) return;
    if (matches.length > 1 && (key.upArrow || key.downArrow)) {
      const delta = key.downArrow ? 1 : -1;
      setSlashIndex((clampedSlashIdx + delta + matches.length) % matches.length);
      return;
    }
    if (key.tab && matches[clampedSlashIdx]) {
      const text = `/${matches[clampedSlashIdx].name} `;
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
          : `${matches
              .map((command, idx) =>
                idx === clampedSlashIdx ? theme.accent(theme.bold(`/${command.name}`)) : theme.muted(`/${command.name}`),
              )
              .join(' ')} ${theme.muted('· ↑↓ Tab để điền')}`,
        columns,
      )
    : '';
  const noticeLine = state.notice
    ? truncate(
        /aborted|Ctrl\+C|Không kết nối|không còn khả dụng|vượt hạn mức|rejected|not saved|failed|Unknown/i.test(
          state.notice,
        )
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
      {state.menu ? (
        <SelectMenu
          menu={state.menu}
          getMenu={store.getMenu}
          width={columns}
          disabled={!!state.pendingApproval}
          onChange={(patch) => store.updateMenu(patch)}
          onSelect={(value) => store.resolveMenu(value)}
          onCancel={() => store.resolveMenu(null)}
        />
      ) : (
        <>
          {state.question?.hint &&
            state.question.hint.split(/\r?\n/).map((line, idx) => (
              <Text key={`qhint-${idx}`}>{truncate(theme.muted(`  ${line}`), columns)}</Text>
            ))}
          {state.question && (
            <Text>{truncate(theme.accent(`${theme.icons.prompt} ${state.question.text}`), columns)}</Text>
          )}
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
        </>
      )}
      {noticeLine && <Text>{noticeLine}</Text>}
      <Footer state={state} workspace={workspace} width={columns} />
    </Box>
  );
}
