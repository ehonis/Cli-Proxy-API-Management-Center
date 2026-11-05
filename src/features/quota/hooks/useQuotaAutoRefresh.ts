/**
 * Polls quota in the background while the page is visible, and catches up at
 * once when the tab comes back into view with stale numbers.
 */

import { useEffect, useRef } from 'react';
import { isRefreshDue } from './autoRefresh';

/** How often to check whether a refresh is due; the interval itself is coarser. */
const CHECK_MS = 15_000;
/** Lets the page's own first load claim the loader before the poller looks. */
const MOUNT_DELAY_MS = 1_500;

export interface QuotaAutoRefreshOptions {
  /** False while disconnected or while the file list is loading. */
  enabled: boolean;
  intervalMs: number | null;
  /** Last completed refresh; null until the page's first load lands. */
  lastRefreshAt: number | null;
  /** Starts a refresh; resolves false when the loader was busy. */
  run: () => Promise<boolean>;
}

export function useQuotaAutoRefresh({
  enabled,
  intervalMs,
  lastRefreshAt,
  run,
}: QuotaAutoRefreshOptions) {
  // Read through refs so the timers are not torn down on every render.
  const latest = useRef({ lastRefreshAt, run });
  useEffect(() => {
    latest.current = { lastRefreshAt, run };
  });
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || intervalMs === null) return;
    const check = () => {
      if (inFlight.current || document.visibilityState !== 'visible') return;
      const { lastRefreshAt: last, run: start } = latest.current;
      // The first load belongs to the page; the poller only keeps it fresh.
      if (last === null || !isRefreshDue(last, Date.now(), intervalMs)) return;
      inFlight.current = true;
      void start()
        .catch(() => false)
        .finally(() => {
          inFlight.current = false;
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
