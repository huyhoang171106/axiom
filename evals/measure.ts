// evals/measure.ts - Đo usage và thời gian một case, giữ chi phí kể cả khi workflow lỗi.
import { redact } from '../src/core/secrets.js';
import { CostTracker } from '../src/llm/cost-tracker.js';

/** Callback phải truyền tracker này vào mọi bước chat/embedding/compaction thuộc case. */
export async function measureCase<T>(id: string, fn: (tracker: CostTracker) => Promise<T>): Promise<{
  value?: T;
  tokens: number;
  costDollars: number;
  latencyMs: number;
  error?: string;
}> {
  // Không dùng tracker toàn cục: hai case chạy xen kẽ vẫn phải có số liệu độc lập.
  const tracker = new CostTracker();
  const started = performance.now();
  let outcome: { value: T } | { error: string };
  try {
    outcome = { value: await fn(tracker) };
  } catch (error) {
    // Fixture hoặc provider có thể reject chuỗi/undefined hay Error có message rỗng.
    // Luôn có nhãn lỗi để caller không nhầm một case chưa tốn token là đã thành công.
    const message = error instanceof Error ? error.message : String(error);
    outcome = { error: redact(`${id}: ${message.trim() || 'Case failed without an error message'}`) };
  }
  const latencyMs = performance.now() - started;
  // Đọc tracker sau cả hai đường success/failure để không làm mất usage trước khi lỗi.
  // Cache read đã nằm trong prompt; cộng riêng cache hoặc totalTokens sẽ tính sai token.
  const usage = tracker.getSessionSummary();
  return {
    ...outcome,
    tokens: usage.totalPromptTokens + usage.totalCompletionTokens,
    costDollars: usage.totalCostDollars,
    latencyMs,
  };
}
