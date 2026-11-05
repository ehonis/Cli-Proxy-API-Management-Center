/**
 * When the quota page last finished a batch of fetches, manual or automatic.
 *
 * Module scoped so leaving the page and coming back keeps the real age, and
 * keyed by the quota cache generation so a new connection starts unrefreshed.
 */

import { useSyncExternalStore } from 'react';

let state: { generation: number; at: number } | null = null;
const listeners = new Set<() => void>();

export function markQuotaRefreshed(generation: number, at = Date.now()) {
  state = { generation, at };
  listeners.forEach((listener) => listener());
}

/** Last completed refresh for this cache generation, or null if none yet. */
export function lastQuotaRefreshAt(generation: number): number | null {
  return state && state.generation === generation ? state.at : null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useLastQuotaRefresh(generation: number): number | null {
  return useSyncExternalStore(
    subscribe,
    () => lastQuotaRefreshAt(generation),
    () => null
  );
}

/** Test hook: forget the last refresh. */
export function resetQuotaRefreshClock() {
  state = null;
}
