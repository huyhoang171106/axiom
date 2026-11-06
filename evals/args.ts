// evals/args.ts - Parse tham số eval tường minh, không tự chọn toàn bộ hay fallback mock.
export interface EvalArgs {
  ucs: string[];
  all: boolean;
  mock: boolean;
  partial: boolean;
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { ucs: [], all: false, mock: false, partial: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--mock') args.mock = true;
    else if (flag === '--all') args.all = true;
    else if (flag === '--partial') args.partial = true;
    else if (flag === '--uc') {
      const uc = argv[++i];
      if (!uc || uc.startsWith('-')) throw new Error('Usage: --uc <NN>, e.g. --uc 01');
      if (!/^\d{2}$/.test(uc)) throw new Error(`--uc expects a two-digit number, got "${uc}"`);
      // Chạy mỗi UC một lần dù người dùng nhập lặp, giữ thứ tự chọn ban đầu.
      if (!args.ucs.includes(uc)) args.ucs.push(uc);
    } else throw new Error(`Unknown eval argument: ${flag}`);
  }
  if (!args.all && args.ucs.length === 0) throw new Error('Pass --uc NN or --all');
  if (args.all && args.ucs.length) throw new Error('Use --uc NN or --all, not both');
  return args;
}
