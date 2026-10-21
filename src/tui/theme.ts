// src/tui/theme.ts - Semantic colors and portable terminal status symbols
import pc from 'picocolors';

export type IconMode = 'auto' | 'nerd' | 'unicode' | 'ascii';

export function createTheme(opts: { env?: NodeJS.ProcessEnv; isTTY?: boolean; icons?: IconMode } = {}) {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  const isColor = isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  const colors = pc.createColors(isColor);
  const mode = opts.icons ?? 'auto';
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  const isUtf8 = isTTY && env.TERM !== 'dumb' && (process.platform === 'win32' || /utf-?8/i.test(locale));
  const isSsh = Boolean(env.SSH_TTY || env.SSH_CONNECTION);
  const isNerd = mode === 'nerd' || (mode === 'auto' && isUtf8 && !isSsh);
  const isUnicode = mode === 'unicode' || (mode === 'auto' && isUtf8 && isSsh);

  const nerdIcons = {
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
    cwd: '\uF07C',       // 
    git: '\uF418',       // 
    context: '\uF0C9',   // 
    model: '\uF121',     // 
    effort: '\uF0EB',    // 
    speed: '\uF04C5',    // 󰓅
    cost: '$',
    done: '',
    input: '↑',
    output: '↓',
    runtime: '\uE718',   // 󰎙
  };

  const unicodeIcons = {
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
    cwd: '📁',
    git: '🌿',
    context: '≡',
    model: '💻',
    effort: '💡',
    speed: '⚡',
    cost: '$',
    done: '✓',
    input: '↑',
    output: '↓',
    runtime: '⚡',
  };

  const asciiIcons = {
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
    cwd: '@',
    git: '*',
    context: '#',
    model: 'M',
    effort: '~',
    speed: '>',
    cost: '$',
    done: '+',
    input: '^',
    output: 'v',
    runtime: 'node',
  };

  return {
    accent: colors.cyan,
    muted: colors.dim,
    success: colors.green,
    warning: colors.yellow,
    error: colors.red,
    userBg: colors.bgBlue,
    bold: colors.bold,
    brand: (text: string) => (isColor ? `\x1b[38;2;180;140;255m${text}\x1b[39m` : text),
    icons: isNerd ? nerdIcons : isUnicode ? unicodeIcons : asciiIcons,
  };
}
