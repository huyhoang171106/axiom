// src/tools/text-lines.ts - Line boundaries shared by the file tools.
//
// `content.split(/\r?\n/)` has two traps this module exists to avoid: it yields a phantom empty last element
// for the file that ends in a newline (so "lines 1-3 of 3" for a two-line file, and a line number that can be
// targeted but does not exist), and it throws away the line ending, so anything that re-joins the lines
// silently converts a CRLF file to LF.

/** Logical lines: no phantom trailing element for content ending in a newline. */
export function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The ending the file mostly uses, used when lines have to be re-joined after a partial edit. */
export function lineEndingOf(content: string): '\n' | '\r\n' {
  const crlf = content.split('\r\n').length - 1;
  const lf = content.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}
