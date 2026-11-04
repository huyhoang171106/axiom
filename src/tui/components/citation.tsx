// src/tui/components/citation.tsx - `ask-answer` result: answer text with clickable `path:Lx-Ly` citations
import { Box, Text } from 'ink';
import type { AskAnswer } from '../../agents/ask.js';
import { CITATION_RE, citationKey, fileLink, parseCitations } from '../../core/rag/citations.js';
import type { Citation } from '../../core/rag/types.js';
import { createTheme } from '../theme.js';

/** Only validated citations become links; anything else stays plain text so a link never points at an unchecked range. */
export function linkCitations(text: string, root: string, citations: readonly Citation[]): string {
  const valid = new Set(citations.map(citationKey));
  return text.replace(CITATION_RE, (match) => {
    const [c] = parseCitations(match);
    return valid.has(citationKey(c)) ? fileLink(root, c) : match;
  });
}

export function AskAnswerView(props: { answer: AskAnswer; root: string; width: number }) {
  const theme = createTheme();
  const { answer, root, width } = props;
  if (!answer.found) return <Text>{theme.muted(answer.text)}</Text>;
  return (
    <Box flexDirection="column" width={width}>
      <Text wrap="wrap">{linkCitations(answer.text, root, answer.citations)}</Text>
      <Text>{theme.muted(`${theme.icons.success} ${answer.citations.length} trích dẫn đã kiểm tra`)}</Text>
    </Box>
  );
}
