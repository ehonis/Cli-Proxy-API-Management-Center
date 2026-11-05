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
 * Whether a background refresh of every polled credential is due. Once any
 * reading has landed, when the oldest one is an interval old (a dead
 * credential among good ones is retried by that same full poll). Before any
 * has landed, only once a credential has failed: until then the page's own
 * first load is in charge. Either way at most one attempt per interval, so a
 * failing poll is not retried on every check.
 */
export function isPollDue(
  oldestFetchedAt: number | null,
  lastAttemptAt: number | null,
  now: number,
  intervalMs: number,
  hasFailedTarget = false
): boolean {
  if (lastAttemptAt !== null && now - lastAttemptAt < intervalMs) return false;
  return oldestFetchedAt !== null ? now - oldestFetchedAt >= intervalMs : hasFailedTarget;
}

/** The oldest reading among these keys, or null when none has landed. */
export function oldestReading(keys: Iterable<string>, fetchedAt: Record<string, number>) {
  let oldest: number | null = null;
  for (const key of keys) {
    const at = fetchedAt[key];
    if (at !== undefined && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}

/**
 * Add a manual load to the one queued behind a background poll. Loads merge
 * by key (a Refresh all and Devin's first-visit load can both arrive during
 * one poll); a queue from an older session is discarded.
 */
export function mergeQueued<T>(
  queued: { targets: T[]; generation: number } | null,
  generation: number,
  targets: T[],
  keyOf: (target: T) => string
): { targets: T[]; generation: number } {
  const kept = queued?.generation === generation ? queued.targets : [];
  const byKey = new Map(kept.map((t) => [keyOf(t), t]));
  for (const t of targets) byKey.set(keyOf(t), t);
  return { targets: [...byKey.values()], generation };
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
