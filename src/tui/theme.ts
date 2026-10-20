// src/tui/theme.ts - Semantic colors and portable terminal status symbols
import pc from 'picocolors';

export type IconMode = 'auto' | 'nerd' | 'unicode' | 'ascii';

export function createTheme(opts: { env?: NodeJS.ProcessEnv; isTTY?: boolean; icons?: IconMode } = {}) {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  const colors = pc.createColors(isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb');
  const mode = opts.icons ?? 'auto';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  const unicode = mode !== 'ascii' && (mode !== 'auto' ||
    (isTTY && env.TERM !== 'dumb' && (process.platform === 'win32' || /utf-?8/i.test(locale))));
  return {
    accent: colors.cyan,
    muted: colors.dim,
    success: colors.green,
    warning: colors.yellow,
    error: colors.red,
    userBg: colors.bgBlue,
    bold: colors.bold,
    icons: unicode
      ? {
          running: '●',
          success: '✓',
          error: '✗',
          denied: '⊘',
          warning: '!',
          prompt: '❯',
          cursor: '█',
          userLeft: '▌',
          userRight: '▐',
          bar: '│',
          thinking: '⠋',
          bullet: '·',
          logo: '◆',
        }
      : {
          running: '*',
          success: '+',
          error: 'x',
          denied: '-',
          warning: '!',
          prompt: '>',
          cursor: '_',
          userLeft: '|',
          userRight: '|',
          bar: '|',
          thinking: '~',
          bullet: '-',
          logo: '*',
        },
  };
}
