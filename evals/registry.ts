// evals/registry.ts - Ánh xạ mã UC tới runner; mỗi làn chỉ thêm dòng đăng ký của mình.
import { runUc01 } from './uc01/run.js';
import { runUc02 } from './uc02/run.js';
import { runUc03 } from './uc03/run.js';
import { runUc04 } from './uc04/run.js';
import type { UcRunner } from './types.js';

export const UC_RUNNERS: Record<string, UcRunner> = {
  '01': runUc01,
  '02': runUc02,
  '03': runUc03,
  '04': runUc04,
};
