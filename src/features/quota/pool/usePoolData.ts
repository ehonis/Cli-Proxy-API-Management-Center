/**
 * Server history + per-credential fetch times for the pool panel and ledger.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { quotaHistoryApi, type QuotaHistorySample } from '@/services/api/quotaHistory';
import { apiClient } from '@/services/api/client';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { historyWindowsFromQuota, isPoolProvider } from './poolInputs';

const HISTORY_HOURS = 21 * 24;
const HISTORY_POLL_MS = 2 * 60_000;

export type HistoryStatus = 'loading' | 'ready' | 'unsupported' | 'error';

/**
 * Polls the server's recorded history while the page is visible. A 404 means
 * the backend predates the endpoint: the chart then shows projection only.
 */
export function useQuotaHistory(enabled: boolean) {
  const [samples, setSamples] = useState<QuotaHistorySample[]>([]);
  const [status, setStatus] = useState<HistoryStatus>('loading');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    const id = ++requestRef.current;
    const revision = apiClient.getConnectionRevision();
    try {
      const result = await quotaHistoryApi.list(HISTORY_HOURS);
      if (id !== requestRef.current || revision !== apiClient.getConnectionRevision()) return;
      setSamples(result.samples);
      setStatus('ready');
    } catch (err: unknown) {
      if (id !== requestRef.current) return;
      setStatus(getStatusFromError(err) === 404 ? 'unsupported' : 'error');
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, HISTORY_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      requestRef.current += 1;
    };
  }, [enabled, load]);

  return { samples, status, reload: load };
}

/**
 * When each quota result landed, keyed by the result object itself. Module
 * scoped so leaving the page and coming back keeps the real age ("14m ago")
 * instead of stamping everything "just now" again, and so each result is
 * reported to the server once.
 */
const landedAt = new WeakMap<QuotaCardState, number>();
/** Results already reported to the server as active samples. */
const posted = new WeakSet<QuotaCardState>();

/**
 * Remembers when each credential's quota last landed, and reports that fresh
 * reading to the server as an "active" history sample so accounts that carry
 * no traffic still get recorded points.
 */
export function useQuotaFetchTimes(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  historySupported: boolean,
  onRecorded: () => void
) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const posts: Promise<unknown>[] = [];
    let fresh = false;
    for (const entry of entries) {
      const quota = quotaFor(entry);
      if (!quota || quota.status !== 'success') continue;
      if (!landedAt.has(quota)) {
        landedAt.set(quota, Date.now());
        fresh = true;
      }
      // Only report once the endpoint is known to exist; results that landed
      // earlier are sent as soon as it is.
      if (!historySupported || posted.has(quota) || !isPoolProvider(entry.type)) continue;
      const authIndex = normalizeAuthIndex(entry.file.auth_index ?? entry.file.authIndex);
      const windows = historyWindowsFromQuota(entry.type, quota);
      if (!authIndex || !windows) continue;
      posted.add(quota);
      posts.push(quotaHistoryApi.record(authIndex, entry.type, windows));
    }
    if (fresh) setVersion((v) => v + 1);
    // Reload once every POST has settled, so the new points are in the reply.
    if (posts.length > 0) void Promise.allSettled(posts).then(onRecorded);
  }, [entries, quotaFor, historySupported, onRecorded]);

  const fetchedAt: Record<string, number> = {};
  for (const entry of entries) {
    const quota = quotaFor(entry);
    const at = quota ? landedAt.get(quota) : undefined;
    if (at !== undefined) fetchedAt[getQuotaCacheKey(entry.file)] = at;
  }
  return fetchedAt;
}
