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
 * Due when the oldest reading on screen is at least one interval old, and no
 * attempt was made within the last interval (so a failing credential is
 * retried once per interval, not on every check). Before the first reading
 * lands the page's own first load is in charge, so nothing is due.
 */
export function isPollDue(
  oldestFetchedAt: number | null,
  lastAttemptAt: number | null,
  now: number,
  intervalMs: number
): boolean {
  if (oldestFetchedAt === null || now - oldestFetchedAt < intervalMs) return false;
  return lastAttemptAt === null || now - lastAttemptAt >= intervalMs;
}

/**
 * Whether a background poll's failure should leave the previous reading on
 * screen: only when that reading was a good one.
 */
export function keepsPreviousReading(
  silent: boolean,
  resultStatus: 'success' | 'error',
  previous: { status?: string } | undefined
): boolean {
  return silent && resultStatus === 'error' && previous?.status === 'success';
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
