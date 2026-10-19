// src/tui/components/header.tsx - One-time terminal welcome
import { Box, Text } from 'ink';
import { createTheme } from '../theme.js';

export function Header({ workspace, model }: { workspace: string; model: string }) {
  const theme = createTheme();
  return <Box borderStyle="round" flexDirection="column" paddingX={1}>
    <Text>{theme.accent('Axiom · Coding agent')}</Text>
    <Text>{model}</Text>
    <Text>{workspace}</Text>
    <Text>{theme.muted('/help  /login  /model  /triage  /exit')}</Text>
  </Box>;
}
