/**
 * Polls quota in the background while the page is visible, and catches up at
 * once when the tab comes back into view with stale numbers.
 */

import { useEffect, useRef } from 'react';
import { pollScope, type PollScope } from './autoRefresh';

/** How often to check whether a refresh is due; the interval itself is coarser. */
const CHECK_MS = 15_000;
/** Lets the page's own first load claim the loader before the poller looks. */
const MOUNT_DELAY_MS = 1_500;

export interface QuotaAutoRefreshOptions {
  /** False while disconnected or while the file list is loading. */
  enabled: boolean;
  intervalMs: number | null;
  /** Oldest reading among the poll targets; null until one lands. */
  oldestFetchedAt: number | null;
  /** A poll target whose fetches have only ever failed, so it has no age. */
  hasFailedWithoutReading: boolean;
  /** Starts a refresh of the given scope; resolves false when the loader was busy. */
  run: (scope: PollScope) => Promise<boolean>;
}

export function useQuotaAutoRefresh({
  enabled,
  intervalMs,
  oldestFetchedAt,
  hasFailedWithoutReading,
  run,
}: QuotaAutoRefreshOptions) {
  // Read through refs so the timers are not torn down on every render.
  const latest = useRef({ oldestFetchedAt, hasFailedWithoutReading, run });
  useEffect(() => {
    latest.current = { oldestFetchedAt, hasFailedWithoutReading, run };
  });
  const lastAttemptAt = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || intervalMs === null) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      const { oldestFetchedAt: oldest, hasFailedWithoutReading: failed } = latest.current;
      const scope = pollScope(oldest, lastAttemptAt.current, now, intervalMs, failed);
      if (scope === null) return;
      const previous = lastAttemptAt.current;
      lastAttemptAt.current = now;
      void latest.current
        .run(scope)
        .catch(() => true)
        .then((started) => {
          // Busy loader: nothing was attempted, so try again on the next check.
          if (!started) lastAttemptAt.current = previous;
        });
    };
    const mountTimer = window.setTimeout(check, MOUNT_DELAY_MS);
    const timer = window.setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      window.clearTimeout(mountTimer);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, intervalMs]);
}
