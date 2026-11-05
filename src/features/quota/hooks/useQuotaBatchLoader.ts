/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 提交按 provider 分组进行 —— 快的提供商先落地，不等慢的。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent, useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { keepsPreviousReading } from './autoRefresh';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import type { QuotaProviderType } from '../providers/types';

interface BatchFetchResult {
  name: string;
  cacheKey: string;
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
  errorStatus?: number;
}

export interface LoadQuotaOptions {
  /**
   * Background refresh: keep the current values on screen instead of loading
   * placeholders, and keep a good reading when the new fetch fails.
   */
  silent?: boolean;
}

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const silentRef = useRef(false);
  /** A manual load that arrived while a background poll was running. */
  const queuedRef = useRef<{ targets: QuotaFileEntry[]; generation: number } | null>(null);

  const loadQuota = useCallback(
    async (targets: QuotaFileEntry[], options: LoadQuotaOptions = {}): Promise<boolean> => {
      if (targets.length === 0) return false;
      const silent = options.silent === true;
      if (loadingRef.current) {
        // Never drop an explicit refresh behind a background poll; run it next.
        if (!silent && silentRef.current) {
          queuedRef.current = {
            targets,
            generation: useQuotaStore.getState().cacheGeneration,
          };
        }
        return false;
      }
      silentRef.current = silent;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      // A background poll stays invisible: no spinner, Refresh all stays usable.
      if (!silent) setBatchLoading(true);

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        await Promise.all(
          Array.from(groups.entries()).map(async ([type, entries]) => {
            const adapter = QUOTA_ADAPTERS[type];
            const setQuota = getQuotaSetter(adapter);

            if (!silent) {
              commitIfQuotaCacheCurrent(cacheGeneration, () => {
                setQuota((prev) => {
                  const nextState = { ...prev };
                  entries.forEach(({ file }) => {
                    nextState[getQuotaCacheKey(file)] = adapter.buildLoadingState();
                  });
                  return nextState;
                });
              });
            }

            const results = await Promise.all(
              entries.map(async ({ file }): Promise<BatchFetchResult> => {
                const cacheKey = getQuotaCacheKey(file);
                try {
                  const data = await adapter.fetchQuota(file, t);
                  return { name: file.name, cacheKey, status: 'success', data };
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : t('common.unknown_error');
                  return {
                    name: file.name,
                    cacheKey,
                    status: 'error',
                    error: message,
                    errorStatus: getStatusFromError(err),
                  };
                }
              })
            );

            if (requestId !== requestIdRef.current) return;

            const committedStates = new Map<string, QuotaCardState>();
            setQuota((prev) => {
              const nextState = { ...prev };
              results.forEach((result) => {
                // A failed background poll keeps the last good reading.
                if (keepsPreviousReading(silent, result.status, prev[result.cacheKey])) return;
                commitIfQuotaCacheCurrent(
                  cacheGeneration,
                  () => {
                    nextState[result.cacheKey] =
                      result.status === 'success'
                        ? adapter.buildSuccessState(result.data)
                        : adapter.buildErrorState(
                            result.error || t('common.unknown_error'),
                            result.errorStatus
                          );
                    committedStates.set(result.cacheKey, nextState[result.cacheKey]);
                  },
                  result.name
                );
              });
              return nextState;
            });
            results.forEach((result, index) => {
              const state = committedStates.get(result.cacheKey);
              if (result.status === 'success' && state) {
                void enrichQuotaInBackground(adapter, entries[index].file, result.data, state, t);
              }
            });
          })
        );
        return true;
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
          silentRef.current = false;
          const queued = queuedRef.current;
          queuedRef.current = null;
          // Dropped if the session changed meanwhile: its targets belong to the old one.
          if (queued && queued.generation === useQuotaStore.getState().cacheGeneration) {
            void loadQuotaRef.current(queued.targets);
          }
        }
      }
    },
    [t]
  );
  const loadQuotaRef = useRef(loadQuota);
  useEffect(() => {
    loadQuotaRef.current = loadQuota;
  }, [loadQuota]);

  return { batchLoading, loadQuota };
}
