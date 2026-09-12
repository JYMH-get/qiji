/** Weighted least-active scheduling. The cursor is only a tie breaker. */
export class RouteConcurrency {
  private next = new Map<string, string>();
  clear() { this.next.clear(); }
  select(key: string, pool: { id: string; active: number; weight: number }[]): string {
    if (!pool.length || pool.some(r => !Number.isFinite(r.weight) || r.weight <= 0 || !Number.isInteger(r.active) || r.active < 0)) throw new Error('无有效并发候选');
    const start = Math.max(0, pool.findIndex(r => r.id === this.next.get(key)));
    let selected = start;
    for (let offset = 1; offset < pool.length; offset++) {
      const i = (start + offset) % pool.length;
      if (pool[i].active / pool[i].weight < pool[selected].active / pool[selected].weight - 1e-9) selected = i;
    }
    this.next.set(key, pool[(selected + 1) % pool.length].id);
    return pool[selected].id;
  }
}

export function migrateRouteConcurrency(lines: { members: { concurrencyWeight?: number; frequencyPercent?: number; weight?: number; failureRetainPercent?: number; slowRequestSec?: number; slowWeightPercent?: number }[] }[]) {
  for (const line of lines) for (const r of line.members) {
    r.concurrencyWeight ??= r.frequencyPercent !== undefined ? r.frequencyPercent / 100 : r.weight ?? 1;
    r.failureRetainPercent ??= 50;
    delete r.frequencyPercent; delete r.weight; delete r.slowRequestSec; delete r.slowWeightPercent;
  }
}
