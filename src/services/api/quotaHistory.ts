/**
 * Server-recorded quota history (fork endpoint `/quota/history`).
 *
 * The server appends a sample whenever a credential's passive rate-limit
 * headers move, and the dashboard adds an "active" sample after each quota
 * fetch, so idle accounts still get points. Backends without the endpoint
 * answer 404; callers treat that as "no history" rather than an error.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

export interface QuotaHistoryWindow {
  used: number;
  resetAtMs: number | null;
  windowMinutes: number | null;
}

export interface QuotaHistorySample {
  t: number;
  authIndex: string;
  provider: string;
  source: 'passive' | 'active';
  windows: Record<string, QuotaHistoryWindow>;
}

export interface QuotaHistoryResponse {
  now: number | null;
  samples: QuotaHistorySample[];
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const normalizeWindow = (raw: unknown): QuotaHistoryWindow | null => {
  if (!isRecord(raw)) return null;
  const used = finite(raw.used);
  if (used === null) return null;
  return {
    used,
    resetAtMs: finite(raw.reset_at),
    windowMinutes: finite(raw.window_minutes),
  };
};

const normalizeSample = (raw: unknown): QuotaHistorySample | null => {
  if (!isRecord(raw)) return null;
  const t = finite(raw.t);
  const authIndex = typeof raw.auth_index === 'string' ? raw.auth_index : null;
  const provider = typeof raw.provider === 'string' ? raw.provider : null;
  if (t === null || !authIndex || !provider || !isRecord(raw.windows)) return null;
  const windows: Record<string, QuotaHistoryWindow> = {};
  for (const [id, value] of Object.entries(raw.windows)) {
    const window = normalizeWindow(value);
    if (window) windows[id] = window;
  }
  return {
    t,
    authIndex,
    provider,
    source: raw.source === 'active' ? 'active' : 'passive',
    windows,
  };
};

export interface QuotaHistoryWindowInput {
  used: number;
  resetAtMs?: number | null;
  windowMinutes?: number | null;
}

export const quotaHistoryApi = {
  list: async (hours: number): Promise<QuotaHistoryResponse> => {
    const data = await apiClient.get<unknown>('/quota/history', { params: { hours } });
    const samples = isRecord(data) && Array.isArray(data.samples) ? data.samples : [];
    return {
      now: isRecord(data) ? finite(data.now) : null,
      samples: samples
        .map(normalizeSample)
        .filter((sample): sample is QuotaHistorySample => sample !== null),
    };
  },

  record: (authIndex: string, provider: string, windows: Record<string, QuotaHistoryWindowInput>) =>
    apiClient.post('/quota/history', {
      auth_index: authIndex,
      provider,
      windows: Object.fromEntries(
        Object.entries(windows).map(([id, w]) => [
          id,
          {
            used: w.used,
            ...(w.resetAtMs ? { reset_at: w.resetAtMs } : {}),
            ...(w.windowMinutes ? { window_minutes: w.windowMinutes } : {}),
          },
        ])
      ),
    }),
};
