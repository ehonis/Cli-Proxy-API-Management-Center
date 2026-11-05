/**
 * Glue between the quota store, the server history and the pool model.
 *
 * Each pooled provider is pooled on one window at a time: the weekly window
 * (Claude's all-models 7-day limit, Codex's weekly limit) or the 5-hour window.
 * Accounts are sized by plan so a Pro account weighs a fifth of a Max 5x seat.
 */

import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';
import type { QuotaHistorySample, QuotaHistoryWindowInput } from '@/services/api/quotaHistory';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { maskCredentialName } from '../ledger/ledgerModel';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import {
  FIVE_HOUR_MS,
  HOUR_MS,
  WEEK_MS,
  type PoolAccountInput,
  type PoolSamplePoint,
} from './poolModel';
import type { PoolWindow } from './poolSettings';
import { rememberedPlanSize } from './planSizeCache';

export const POOL_PROVIDERS = ['claude', 'codex'] as const;
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

export const isPoolProvider = (type: QuotaProviderType | string): type is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(type);

const WEEKLY_MINUTES = 7 * 24 * 60;

type LiveWindow = { usedPercent: number | null; resetAtMs: number | null; periodMs: number };

const defaultPeriodMs = (window: PoolWindow) => (window === 'weekly' ? WEEK_MS : FIVE_HOUR_MS);

function liveWindowFromQuota(
  provider: PoolProvider,
  quota: QuotaCardState | undefined,
  pooled: PoolWindow
): LiveWindow | null {
  if (!quota || quota.status !== 'success') return null;
  const windows =
    provider === 'claude'
      ? (quota as unknown as ClaudeQuotaState).windows
      : (quota as unknown as CodexQuotaState).windows;
  const id = pooled === 'five-hour' ? 'five-hour' : provider === 'claude' ? 'seven-day' : 'weekly';
  const window = windows?.find((w) => w.id === id);
  if (!window || typeof window.usedPercent !== 'number') return null;
  return {
    usedPercent: window.usedPercent,
    resetAtMs: typeof window.resetAtMs === 'number' ? window.resetAtMs : null,
    periodMs:
      typeof window.periodHours === 'number' && window.periodHours > 0
        ? window.periodHours * HOUR_MS
        : defaultPeriodMs(pooled),
  };
}

/** Pick the recorded window that matches the pooled one. */
function windowFromSample(provider: PoolProvider, sample: QuotaHistorySample, pooled: PoolWindow) {
  if (provider === 'claude') {
    return (pooled === 'weekly' ? sample.windows.seven_day : sample.windows.five_hour) ?? null;
  }
  if (pooled === 'weekly') {
    const candidates = [sample.windows.secondary, sample.windows.primary, sample.windows.weekly];
    return (
      candidates.find(
        (w) => w && (w.windowMinutes === null || w.windowMinutes >= WEEKLY_MINUTES)
      ) ?? null
    );
  }
  const candidates = [sample.windows.primary, sample.windows.secondary];
  return (
    candidates.find((w) => w && (w.windowMinutes === null || w.windowMinutes < WEEKLY_MINUTES)) ??
    null
  );
}

/**
 * Relative plan size, so the pool weighs accounts by what they can actually
 * spend. Claude reports its tier directly (`default_claude_ai` for Pro,
 * `default_claude_max_5x` for Max 5x and Team Premium seats). Codex has no
 * comparable figure, so its accounts count equally. Null while no live quota
 * has loaded.
 */
export function planSize(provider: PoolProvider, quota: QuotaCardState | undefined): number | null {
  if (!quota || quota.status !== 'success') return null;
  if (provider !== 'claude') return 1;
  const { rateLimitTier, planType } = quota as unknown as ClaudeQuotaState;
  const tier = (rateLimitTier ?? '').toLowerCase();
  const multiple = /max_(\d+)x/.exec(tier);
  if (multiple) return Number(multiple[1]);
  if (planType === 'plan_max5') return 5;
  if (planType === 'plan_max20') return 20;
  return 1;
}

export function credentialLabel(file: AuthFileItem): string {
  const label = typeof file.label === 'string' ? file.label.trim() : '';
  if (label) return label;
  const email = typeof file.email === 'string' ? file.email.trim() : '';
  if (email) return email;
  return file.name.replace(/\.json$/i, '');
}

/** The label shown on screen: emails stay masked until Show emails is on. */
export function displayCredentialLabel(file: AuthFileItem, showEmails: boolean): string {
  const label = credentialLabel(file);
  return showEmails || !/\S+@\S+\.\S+/.test(label) ? label : maskCredentialName(label);
}

export function samplesByAuthIndex(samples: QuotaHistorySample[]) {
  const map = new Map<string, QuotaHistorySample[]>();
  for (const sample of samples) {
    const list = map.get(sample.authIndex);
    if (list) list.push(sample);
    else map.set(sample.authIndex, [sample]);
  }
  return map;
}

export function poolInputsFor(
  provider: PoolProvider,
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  history: Map<string, QuotaHistorySample[]>,
  fetchedAt: (entry: QuotaFileEntry) => number | null,
  showEmails = false,
  pooled: PoolWindow = 'weekly'
): PoolAccountInput[] {
  return entries
    .filter((entry) => entry.type === provider && !entry.file.disabled)
    .map((entry) => {
      const quota = quotaFor(entry);
      const live = liveWindowFromQuota(provider, quota, pooled);
      const authIndex = normalizeAuthIndex(entry.file.auth_index ?? entry.file.authIndex);
      const samples: PoolSamplePoint[] = [];
      for (const sample of (authIndex && history.get(authIndex)) || []) {
        if (sample.provider !== provider) continue;
        const window = windowFromSample(provider, sample, pooled);
        if (!window) continue;
        samples.push({ t: sample.t, remaining: 100 - window.used, resetAtMs: window.resetAtMs });
      }
      return {
        key: getQuotaCacheKey(entry.file),
        // Labels surface in stats and tooltips, so they obey Show emails too.
        label: displayCredentialLabel(entry.file, showEmails),
        remaining: live ? 100 - (live.usedPercent ?? 0) : null,
        resetAtMs: live?.resetAtMs ?? null,
        periodMs: live?.periodMs ?? defaultPeriodMs(pooled),
        size: planSize(provider, quota) ?? rememberedPlanSize(getQuotaCacheKey(entry.file)) ?? 1,
        observedAtMs: live ? fetchedAt(entry) : null,
        samples,
      };
    });
}

/** The windows sent back to the server as an "active" history sample. */
export function historyWindowsFromQuota(
  provider: PoolProvider,
  quota: QuotaCardState | undefined
): Record<string, QuotaHistoryWindowInput> | null {
  if (!quota || quota.status !== 'success') return null;
  const out: Record<string, QuotaHistoryWindowInput> = {};
  if (provider === 'claude') {
    const ids: Record<string, string> = {
      'seven-day': 'seven_day',
      'five-hour': 'five_hour',
      'seven-day-fable': 'seven_day_fable',
    };
    for (const w of (quota as unknown as ClaudeQuotaState).windows ?? []) {
      const id = ids[w.id];
      if (id && typeof w.usedPercent === 'number') {
        out[id] = { used: w.usedPercent, resetAtMs: w.resetAtMs ?? null };
      }
    }
  } else {
    const ids: Record<string, string> = { 'five-hour': 'primary', weekly: 'secondary' };
    for (const w of (quota as unknown as CodexQuotaState).windows ?? []) {
      const id = ids[w.id];
      if (id && typeof w.usedPercent === 'number') {
        out[id] = {
          used: w.usedPercent,
          resetAtMs: w.resetAtMs ?? null,
          windowMinutes: typeof w.periodHours === 'number' ? Math.round(w.periodHours * 60) : null,
        };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
