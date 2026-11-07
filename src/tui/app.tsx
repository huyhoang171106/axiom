// src/tui/app.tsx - Ink composition and global terminal shortcuts
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { defaultCommandRouter } from '../commands/index.js';
import { parseCommand } from '../commands/router.js';
import { Header } from './components/header.js';
import { Transcript } from './components/transcript.js';
import { ApprovalDialog } from './components/approval-dialog.js';
import { Editor } from './components/editor.js';
import { MENU_PAGE_SIZE, SelectMenu } from './components/select-menu.js';
import { Footer } from './components/footer.js';
import { SlashCompletion } from './components/slash-completion.js';
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
  const { columns, rows } = useWindowSize();
  const safeColumns = Math.max(20, columns || 80);
  const safeRows = Math.max(12, rows || 24);
  const maxLiveLines = Math.max(4, safeRows - 10);
  const menuPageSize = Math.max(2, Math.min(MENU_PAGE_SIZE, safeRows - 9));
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
      if (key.ctrl && input === 'o') { store.toggleApprovalExpanded(); return; }
      if (state.approvalEdit) {
        if (key.escape) store.cancelApprovalEdit();
        return;
      }
      if (input.toLowerCase() === 'e') { store.beginApprovalEdit(); return; }
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
    if (key.shift && key.tab && !state.question) {
      void controller.submit(`/mode ${state.mode === 'edit' ? 'read-only' : 'edit'}`);
      return;
    }
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
  const noticeLine = state.notice
    ? truncate(
        /aborted|Ctrl\+C|Không kết nối|không còn khả dụng|vượt hạn mức|rejected|not saved|failed|Unknown/i.test(
          state.notice,
        )
          ? theme.warning(state.notice)
          : theme.muted(state.notice),
        safeColumns,
      )
    : '';

  return (
    <Box flexDirection="column" width={safeColumns}>
      <Transcript
        workspaceRoot={workspace}
        state={state}
        expanded={state.expanded}
        width={safeColumns}
        header={<Header workspace={workspace} model={modelLabel} mode={state.mode} width={safeColumns} />}
      />
      {noticeLine && <Text>{noticeLine}</Text>}
      {state.pendingApproval && <ApprovalDialog approval={state.pendingApproval} width={safeColumns} expanded={state.approvalExpanded} draft={state.approvalEdit?.text} />}
      {state.approvalEdit && <>
        {state.approvalEditError && <Text>{state.approvalEditError}</Text>}
        <Editor value={state.approvalEdit} getValue={store.getApprovalEdit} width={safeColumns}
          onChange={(value) => store.updateApprovalEdit(value)}
          onSubmit={(text) => store.submitApprovalEdit(text)} />
      </>}
      {state.menu ? (
        <SelectMenu
          menu={state.menu}
          getMenu={store.getMenu}
          width={safeColumns}
          pageSize={menuPageSize}
          disabled={!!state.pendingApproval}
          onChange={(patch) => store.updateMenu(patch)}
          onSelect={(value) => store.resolveMenu(value)}
          onCancel={() => store.resolveMenu(null)}
        />
      ) : (
        <>
          {state.question?.hint &&
            state.question.hint.split(/\r?\n/).map((line, idx) => (
              <Text key={`qhint-${idx}`}>{truncate(theme.muted(`  ${line}`), safeColumns)}</Text>
            ))}
          {state.question && (
            <Text>{truncate(theme.accent(`${theme.icons.prompt} ${state.question.text}`), safeColumns)}</Text>
          )}
          <Editor
            value={state.editor}
            getValue={store.getEditor}
            width={safeColumns}
            disabled={!!state.pendingApproval || (state.busy && !state.question)}
            secret={state.question?.secret}
            allowEmptySubmit={!!state.question}
            onChange={(editor) => store.update({ editor })}
            onSubmit={(text) => {
              if (state.question) {
                store.answer(text);
                return;
              }
              let submitText = text;
              if (matches.length > 0) {
                const selected = matches[clampedSlashIdx] ?? matches[0];
                if (selected) {
                  const parsed = parseCommand(text);
                  if (!parsed && text.trim() === '/') {
                    submitText = `/${selected.name}`;
                  } else if (parsed && !defaultCommandRouter.get(parsed.name)) {
                    submitText = `/${selected.name}${parsed.args ? ' ' + parsed.args : ''}`;
                  }
                }
              }
              void controller.submit(submitText);
            }}
          />
          <SlashCompletion matches={matches} selectedIndex={clampedSlashIdx} width={safeColumns} />
        </>
      )}
      <Footer state={state} workspace={workspace} width={safeColumns} />
    </Box>
  );
}
