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
  const seenRef = useRef(new Map<string, QuotaCardState>());
  const [fetchedAt, setFetchedAt] = useState<Record<string, number>>({});

  useEffect(() => {
    const fresh: Record<string, number> = {};
    let posted = false;
    for (const entry of entries) {
      const key = getQuotaCacheKey(entry.file);
      const quota = quotaFor(entry);
      if (!quota || quota.status !== 'success') continue;
      if (seenRef.current.get(key) === quota) continue;
      seenRef.current.set(key, quota);
      fresh[key] = Date.now();
      if (!historySupported || !isPoolProvider(entry.type)) continue;
      const authIndex = normalizeAuthIndex(entry.file.auth_index ?? entry.file.authIndex);
      const windows = historyWindowsFromQuota(entry.type, quota);
      if (!authIndex || !windows) continue;
      posted = true;
      void quotaHistoryApi.record(authIndex, entry.type, windows).catch(() => {});
    }
    if (Object.keys(fresh).length > 0) setFetchedAt((prev) => ({ ...prev, ...fresh }));
    if (posted) onRecorded();
  }, [entries, quotaFor, historySupported, onRecorded]);

  return fetchedAt;
}
