// evals/registry.ts - Ánh xạ mã UC tới runner; mỗi làn chỉ thêm dòng đăng ký của mình.
import { runUc01 } from './uc01/run.js';
import type { UcRunner } from './types.js';

export const UC_RUNNERS: Record<string, UcRunner> = {
  '01': runUc01,
};
