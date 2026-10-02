/**
 * Ledger view model: flattens each provider's quota state into at most three
 * "remaining %" columns per credential, plus a per-provider pooled summary.
 *
 * Pure and React-free. Percentages are always *remaining* (100 = untouched),
 * matching the meters on the card view.
 */

import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  XaiQuotaState,
} from '@/types';
import type { QuotaProviderType } from '../providers/types';
import type { QuotaCardState } from '../providers';

export interface LedgerColumn {
  id: string;
  /** i18n key when available, otherwise a literal label. */
  labelKey?: string;
  label?: string;
  remaining: number | null;
  resetAtMs: number | null;
  /** Fallback reset text baked by the provider when no instant is known. */
  resetLabel?: string | null;
  /** Shown greyed out: informational, not the bucket that governs routing. */
  muted?: boolean;
}

const clampPct = (value: number) => Math.max(0, Math.min(100, value));

const remainingFromUsed = (used: number | null | undefined): number | null =>
  typeof used === 'number' && Number.isFinite(used) ? clampPct(100 - used) : null;

const finiteMs = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function claudeColumns(quota: ClaudeQuotaState): LedgerColumn[] {
  const byId = new Map((quota.windows ?? []).map((w) => [w.id, w]));
  const fable = byId.get('seven-day-fable');
  const columns: LedgerColumn[] = [];
  const push = (id: string, muted = false) => {
    const w = byId.get(id);
    if (!w) return;
    columns.push({
      id,
      labelKey: w.labelKey,
      label: w.label,
      remaining: remainingFromUsed(w.usedPercent),
      resetAtMs: finiteMs(w.resetAtMs),
      resetLabel: w.resetLabel,
      muted,
    });
  };
  push('seven-day-fable');
  push('five-hour');
  push('seven-day', Boolean(fable));
  if (columns.length < 3) push('seven-day-opus', true);
  return columns.slice(0, 3);
}

function codexColumns(quota: CodexQuotaState): LedgerColumn[] {
  const windows = quota.windows ?? [];
  const order = ['weekly', 'five-hour', 'monthly'];
  const picked = order
    .map((id) => windows.find((w) => w.id === id))
    .filter((w): w is NonNullable<typeof w> => Boolean(w));
  return picked.slice(0, 3).map((w) => ({
    id: w.id,
    labelKey: w.labelKey,
    label: w.label,
    remaining: remainingFromUsed(w.usedPercent),
    resetAtMs: finiteMs(w.resetAtMs),
    resetLabel: w.resetLabel,
  }));
}

function xaiColumns(quota: XaiQuotaState): LedgerColumn[] {
  const billing = quota.billing;
  if (!billing) return [];
  const endMs = billing.periodEnd ? Date.parse(billing.periodEnd) : NaN;
  return [
    {
      id: 'billing',
      labelKey: 'quota_management.ledger_weekly_limit',
      remaining: remainingFromUsed(billing.usagePercent),
      resetAtMs: Number.isFinite(endMs) ? endMs : null,
    },
  ];
}

function kimiColumns(quota: KimiQuotaState): LedgerColumn[] {
  return (quota.rows ?? []).slice(0, 3).map((row) => ({
    id: row.id,
    labelKey: row.labelKey,
    label: row.label,
    remaining: row.limit > 0 ? clampPct(((row.limit - row.used) / row.limit) * 100) : null,
    resetAtMs: finiteMs(row.resetAtMs),
    resetLabel: row.resetHint,
  }));
}

function antigravityColumns(quota: AntigravityQuotaState): LedgerColumn[] {
  return (quota.groups ?? [])
    .flatMap((group) => group.buckets.map((bucket) => ({ group, bucket })))
    .slice(0, 3)
    .map(({ group, bucket }) => ({
      id: `${group.id}:${bucket.id}`,
      label: bucket.label || group.label,
      remaining:
        typeof bucket.remainingFraction === 'number'
          ? clampPct(bucket.remainingFraction * 100)
          : null,
      resetAtMs: finiteMs(bucket.resetAtMs),
      resetLabel: bucket.resetTime,
    }));
}

function devinColumns(quota: DevinQuotaState): LedgerColumn[] {
  return (quota.windows ?? []).map((w) => ({
    id: w.id,
    label: w.label ?? w.id,
    remaining: w.remainingPercent === null ? null : clampPct(w.remainingPercent),
    resetAtMs: finiteMs(w.resetAtMs),
  }));
}

function metaColumns(quota: MetaQuotaState): LedgerColumn[] {
  return (quota.data?.windows ?? []).map((w) => ({
    id: w.id,
    labelKey:
      w.id === 'weekly'
        ? 'quota_management.ledger_weekly_limit'
        : 'quota_management.ledger_window_limit',
    remaining: remainingFromUsed(w.usedPercent),
    resetAtMs: typeof w.resetAt === 'number' ? w.resetAt * 1000 : null,
  }));
}

export function ledgerColumnsFor(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined
): LedgerColumn[] {
  if (!quota || quota.status !== 'success') return [];
  switch (type) {
    case 'claude':
      return claudeColumns(quota as unknown as ClaudeQuotaState);
    case 'codex':
      return codexColumns(quota as unknown as CodexQuotaState);
    case 'xai':
      return xaiColumns(quota as unknown as XaiQuotaState);
    case 'kimi':
      return kimiColumns(quota as unknown as KimiQuotaState);
    case 'antigravity':
      return antigravityColumns(quota as unknown as AntigravityQuotaState);
    case 'devin':
      return devinColumns(quota as unknown as DevinQuotaState);
    case 'meta':
      return metaColumns(quota as unknown as MetaQuotaState);
    default:
      return [];
  }
}

/** Plan string shown under the filename ("Max", "Pro", ...), as an i18n key or literal. */
export function ledgerPlanFor(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined
): { key?: string; literal?: string } | null {
  if (!quota || quota.status !== 'success') return null;
  if (type === 'claude') {
    const plan = (quota as unknown as ClaudeQuotaState).planType;
    return plan ? { key: `claude_quota.${plan}` } : null;
  }
  if (type === 'codex') {
    const plan = (quota as unknown as CodexQuotaState).planType;
    if (!plan) return null;
    const normalized = plan.toLowerCase();
    if (['pro', 'plus', 'team', 'free'].includes(normalized)) {
      return { key: `codex_quota.plan_${normalized}` };
    }
    return { literal: plan };
  }
  if (type === 'antigravity') {
    const sub = (quota as unknown as AntigravityQuotaState).subscription;
    return sub?.tierName ? { literal: sub.tierName } : null;
  }
  if (type === 'meta') {
    const name = (quota as unknown as MetaQuotaState).data?.planName;
    return name ? { literal: name } : null;
  }
  return null;
}

export interface LedgerSummaryBucket {
  /** Column id this bucket aggregates (the provider's primary column). */
  columnId: string;
  labelKey?: string;
  label?: string;
  /** Sum of remaining % across credentials that reported this column. */
  totalRemaining: number | null;
  /** 100 × number of credentials counted. */
  capacity: number;
  /** One segment per credential, in list order; null = not loaded / unknown. */
  segments: (number | null)[];
  soonestResetMs: number | null;
}

export interface LedgerProviderSummary {
  type: QuotaProviderType;
  credentialCount: number;
  primary: LedgerSummaryBucket;
  secondary: LedgerSummaryBucket | null;
}

function aggregate(columnsPerCred: LedgerColumn[][], index: number): LedgerSummaryBucket | null {
  const template = columnsPerCred.find((cols) => cols[index])?.[index];
  if (!template) return null;
  let total = 0;
  let counted = 0;
  let soonest: number | null = null;
  const now = Date.now();
  const segments = columnsPerCred.map((cols) => {
    const col = cols.find((c) => c.id === template.id);
    if (!col || col.remaining === null) return null;
    total += col.remaining;
    counted += 1;
    if (
      col.resetAtMs !== null &&
      col.resetAtMs > now &&
      (soonest === null || col.resetAtMs < soonest)
    ) {
      soonest = col.resetAtMs;
    }
    return col.remaining;
  });
  return {
    columnId: template.id,
    labelKey: template.labelKey,
    label: template.label,
    totalRemaining: counted > 0 ? total : null,
    capacity: Math.max(1, columnsPerCred.length) * 100,
    segments,
    soonestResetMs: soonest,
  };
}

/**
 * The secondary bucket is the provider's last (usually greyed) column — e.g.
 * Claude's all-models 7-day limit beneath the Fable 7-day headline.
 */
export function buildProviderSummary(
  type: QuotaProviderType,
  quotas: (QuotaCardState | undefined)[]
): LedgerProviderSummary | null {
  const columnsPerCred = quotas.map((quota) => ledgerColumnsFor(type, quota));
  const primary =
    aggregate(columnsPerCred, 0) ??
    ({
      columnId: 'unknown',
      labelKey: 'quota_management.ledger_weekly_limit',
      totalRemaining: null,
      capacity: Math.max(1, quotas.length) * 100,
      segments: quotas.map(() => null),
      soonestResetMs: null,
    } satisfies LedgerSummaryBucket);
  const lastIndex = Math.max(0, ...columnsPerCred.map((cols) => cols.length - 1));
  const secondary =
    type === 'claude' && lastIndex > 0 ? aggregate(columnsPerCred, lastIndex) : null;
  return { type, credentialCount: quotas.length, primary, secondary };
}

/** `claude-tom@lazorpoint.dev.json` → `claude-t•••@l•••.dev.json`. */
export function maskCredentialName(name: string): string {
  const at = name.indexOf('@');
  if (at === -1) return name;
  const local = name.slice(0, at);
  const domain = name.slice(at + 1);
  const sep = Math.max(local.lastIndexOf('-'), local.lastIndexOf('_'));
  const prefix = local.slice(0, sep + 1);
  const user = local.slice(sep + 1);
  const maskedUser = user ? `${user[0]}•••` : '';
  const firstDot = domain.indexOf('.');
  const host = firstDot === -1 ? domain : domain.slice(0, firstDot);
  const rest = firstDot === -1 ? '' : domain.slice(firstDot);
  // Keep only the last label before the extension (".dev.json", ".com.json").
  const restParts = rest.split('.').filter(Boolean);
  const tail = restParts.length > 2 ? `.${restParts.slice(-2).join('.')}` : rest;
  const maskedHost = host ? `${host[0]}•••` : '';
  return `${prefix}${maskedUser}@${maskedHost}${tail}`;
}

export type LedgerTone = 'high' | 'medium' | 'low' | 'unknown';

export const LEDGER_HIGH_THRESHOLD = 60;
export const LEDGER_LOW_THRESHOLD = 25;

export function ledgerTone(remaining: number | null): LedgerTone {
  if (remaining === null) return 'unknown';
  if (remaining >= LEDGER_HIGH_THRESHOLD) return 'high';
  if (remaining >= LEDGER_LOW_THRESHOLD) return 'medium';
  return 'low';
}

/** `in 1 day · 09/12, 23:00` — relative first, then the local absolute instant. */
export function formatLedgerAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
