/**
 * Background quota polling: how often, and whether a refresh is due.
 * Pure apart from the localStorage helpers, so the timing rules are testable.
 */

export const AUTO_REFRESH_INTERVALS = ['off', '1', '2', '5', '10', '15'] as const;
export type AutoRefreshInterval = (typeof AUTO_REFRESH_INTERVALS)[number];
export const DEFAULT_AUTO_REFRESH: AutoRefreshInterval = '5';

export const isAutoRefreshInterval = (value: unknown): value is AutoRefreshInterval =>
  typeof value === 'string' && (AUTO_REFRESH_INTERVALS as readonly string[]).includes(value);

/** Interval in milliseconds, or null when polling is off. */
export function autoRefreshMs(interval: AutoRefreshInterval): number | null {
  return interval === 'off' ? null : Number(interval) * 60_000;
}

/**
 * Due when nothing has refreshed yet in this session's view of the clock, or
 * the last refresh is at least one interval old.
 */
export function isRefreshDue(lastAt: number | null, now: number, intervalMs: number | null) {
  if (intervalMs === null) return false;
  if (lastAt === null) return true;
  return now - lastAt >= intervalMs;
}

const KEY = 'quotaPage.autoRefresh';

/** Kept in localStorage: how often to poll is a standing preference. */
export function readAutoRefresh(): AutoRefreshInterval {
  try {
    const value = localStorage.getItem(KEY);
    return isAutoRefreshInterval(value) ? value : DEFAULT_AUTO_REFRESH;
  } catch {
    return DEFAULT_AUTO_REFRESH;
  }
}

export function writeAutoRefresh(interval: AutoRefreshInterval) {
  try {
    localStorage.setItem(KEY, interval);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}
