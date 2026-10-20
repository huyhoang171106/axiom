// src/tui/components/select-menu.tsx - Transient Pi-style interactive selector
import { Box, Text, useInput } from 'ink';
import {
  editMenuInput,
  filterMenuItems,
  windowMenuItems,
  type TuiMenuState,
} from '../select-menu.js';
import { truncate } from '../layout.js';
import { createTheme } from '../theme.js';

export const MENU_PAGE_SIZE = 8;

export function SelectMenu(props: {
  menu: TuiMenuState;
  width?: number;
  disabled?: boolean;
  getMenu?(): Readonly<TuiMenuState> | null;
  onChange(patch: { query?: string; selectedIndex?: number }): void;
  onSelect(value: string): void;
  onCancel(): void;
}) {
  useInput(
    (input, key) => {
      const current = props.getMenu?.() ?? props.menu;
      const result = editMenuInput(current, input, key, MENU_PAGE_SIZE);
      if (result.cancel) {
        props.onCancel();
        return;
      }
      if (result.select !== undefined) {
        props.onSelect(result.select);
        return;
      }
      if (
        result.state.query !== current.query ||
        result.state.selectedIndex !== current.selectedIndex
      ) {
        props.onChange({
          query: result.state.query,
          selectedIndex: result.state.selectedIndex,
        });
      }
    },
    { isActive: !props.disabled },
  );

  const theme = createTheme();
  const cols = props.width ? Math.max(20, Math.floor(props.width)) : undefined;
  const innerWidth = cols ? Math.max(8, cols - 4) : 100;
  const filtered = filterMenuItems(props.menu.items, props.menu.query);
  const win = windowMenuItems(filtered, props.menu.selectedIndex, MENU_PAGE_SIZE);
  const cursorGlyph = theme.accent(theme.icons.cursor);
  const searchLine = props.menu.query
    ? `${theme.accent(theme.icons.prompt)} ${props.menu.query}${cursorGlyph}`
    : `${theme.accent(theme.icons.prompt)} ${cursorGlyph} ${theme.muted(props.menu.placeholder ?? 'Gõ để tìm kiếm...')}`;

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column" {...(cols ? { width: cols } : {})}>
      <Text>
        {truncate(
          `${theme.accent(theme.bold(props.menu.title))} ${theme.muted(`(${filtered.length}/${props.menu.items.length})`)}`,
          innerWidth,
        )}
      </Text>
      <Text>{truncate(searchLine, innerWidth)}</Text>
      {win.slice.length === 0 ? (
        <Text>{truncate(theme.warning('  Không có mục nào khớp từ khóa.'), innerWidth)}</Text>
      ) : (
        win.slice.map((item, idx) => {
          const absIdx = win.start + idx;
          const isSelected = absIdx === win.selectedIndex;
          const pointer = isSelected ? theme.accent(theme.icons.prompt) : ' ';
          const activeMark = item.active ? `${theme.success(theme.icons.success)} ` : '';
          const badge = item.badge ? ` [${item.badge}]` : '';
          const desc = item.description ? ` — ${item.description}` : '';
          const plainLine = `${pointer} ${activeMark}${item.label}${badge}${desc}`;
          if (item.disabled) {
            return <Text key={item.value}>{truncate(theme.muted(plainLine), innerWidth)}</Text>;
          }
          if (isSelected) {
            return (
              <Text key={item.value}>
                {truncate(
                  `${pointer} ${activeMark}${theme.accent(theme.bold(item.label))}${badge ? theme.success(badge) : ''}${desc ? theme.muted(desc) : ''}`,
                  innerWidth,
                )}
              </Text>
            );
          }
          return (
            <Text key={item.value}>
              {truncate(
                `  ${activeMark}${item.label}${badge ? theme.muted(badge) : ''}${desc ? theme.muted(desc) : ''}`,
                innerWidth,
              )}
            </Text>
          );
        })
      )}
      <Text>
        {truncate(
          theme.muted(
            win.total > MENU_PAGE_SIZE
              ? `↑↓ (${win.start + 1}–${win.end}/${win.total}) · Enter chọn · Esc hủy`
              : '↑↓ di chuyển · Enter chọn · Esc hủy',
          ),
          innerWidth,
        )}
      </Text>
    </Box>
  );
}
