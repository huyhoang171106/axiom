// src/tools/denied-actions.ts - Remember denied actions so a reworded retry is denied too (UC-05 criterion 2)

/** TODO(E2): normalize commands, so `pip3 install x` matches a denied `pip install x`. */
export function actionKey(name: string, args: Record<string, unknown>): string {
  return name + JSON.stringify(args);
}

export class DeniedActions {
  private readonly keys = new Set<string>();

  add(key: string): void {
    this.keys.add(key);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }
}
