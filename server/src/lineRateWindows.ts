import type { RouteSuccessRateWindow } from './contract.ts';
import { measuredSuccessRate } from './availabilityHistory.ts';

export const LINE_RATE_HOURS = [1, 5, 10, 24] as const;
export interface LineRateLog { model: string; startedAt: string; finishedAt?: string; status: string; excluded?:boolean }

/** One pass over the light request index. Completed requests are weighted individually. */
export function aggregateLineRateWindows(
  logs: Iterable<LineRateLog>, tracking: Record<string, { since: number }>, now: number,
): Map<string, RouteSuccessRateWindow[]> {
  const rows = new Map(Object.keys(tracking).map(id => [id, LINE_RATE_HOURS.map(hours => ({
    hours, requests: 0, success: 0, failed: 0, running: 0, excluded:0, successRate: null, insufficientSamples: true,
  } as RouteSuccessRateWindow))]));
  for (const log of logs) {
    if (typeof log.model !== 'string' || !log.model.startsWith('route:')) continue;
    const id = log.model.slice(6), windows = rows.get(id);
    if (!windows) continue;
    const started = Date.parse(log.startedAt);
    if (!Number.isFinite(started) || started > now || started < tracking[id].since) continue;
    const status = Date.parse(log.finishedAt ?? '') > now ? 'running' : log.status;
    if (status !== 'success' && status !== 'failed' && status !== 'running' && status !== 'excluded') continue;
    for (const window of windows) {
      if (started < now - window.hours * 3_600_000) continue;
      window.requests++;
      if(status==='excluded')window.excluded=(window.excluded??0)+1;else window[status]++;
    }
  }
  for (const windows of rows.values()) for (const window of windows) {
    window.successRate = measuredSuccessRate(window.success, window.failed);
    window.insufficientSamples = window.successRate === null;
  }
  return rows;
}
