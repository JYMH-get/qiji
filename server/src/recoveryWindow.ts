export const RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
export function withinRecoveryWindow(startedAt: number | string | undefined, now: number): boolean {
  const timestamp = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp <= now && timestamp >= now - RECOVERY_WINDOW_MS;
}
