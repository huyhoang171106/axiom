// src/core/repetition-guard.ts - Detects an agent stuck re-issuing the identical tool call.
// Ported from InterShade's RepetitionGuard.

export class RepetitionGuard {
  private last = '';
  private count = 0;

  constructor(private readonly threshold = 3) {}

  /** Records a call; returns an intervention message once the same call has been made `threshold` times in a row. */
  record(name: string, args: Record<string, unknown>): string | undefined {
    const sig = `${name}\0${JSON.stringify(args)}`;
    this.count = sig === this.last ? this.count + 1 : 1;
    this.last = sig;
    if (this.count < this.threshold) return undefined;
    return (
      `[REPETITION GUARD] You have called \`${name}\` with identical arguments ${this.count} times in a row without ` +
      `progress. Stop repeating it: work out why it is not helping, try a different approach, or report the blocker.`
    );
  }

  reset(): void {
    this.last = '';
    this.count = 0;
  }
}
