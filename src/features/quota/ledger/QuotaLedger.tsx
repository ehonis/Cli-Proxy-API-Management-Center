/**
 * Ledger view: provider summary cards (pooled remaining across credentials)
 * followed by one section per provider with a dense row per credential.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ResolvedTheme } from '@/types';
import { formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import {
  buildProviderSummary,
  formatLedgerAbsolute,
  ledgerColumnsFor,
  ledgerPlanFor,
  ledgerTone,
  maskCredentialName,
  type LedgerColumn,
  type LedgerSummaryBucket,
} from './ledgerModel';
import styles from './QuotaLedger.module.scss';

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  providerOrder: readonly QuotaProviderType[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  showEmails: boolean;
  canRefresh: boolean;
  onRefresh: (entry: QuotaFileEntry) => void;
}

const toneClass = (remaining: number | null) => styles[`tone_${ledgerTone(remaining)}`];

const columnLabel = (t: TFunction, col: { labelKey?: string; label?: string }) =>
  col.labelKey ? t(col.labelKey) : (col.label ?? '');

function ResetText({
  atMs,
  fallback,
  remaining,
  now,
  locale,
}: {
  atMs: number | null;
  fallback?: string | null;
  remaining: number | null;
  now: number;
  locale?: string;
}) {
  const { t } = useTranslation();
  if (atMs !== null && atMs > now) {
    return (
      <span className={styles.reset}>
        <span className={styles.resetRelative}>{formatRelativeInstant(atMs, now, locale)}</span>
        <span className={styles.resetDot}>·</span>
        <span>{formatLedgerAbsolute(atMs)}</span>
      </span>
    );
  }
  const text = fallback && fallback.trim() && fallback.trim() !== '-' ? fallback.trim() : null;
  if (text) return <span className={styles.reset}>{text}</span>;
  return (
    <span className={styles.reset}>
      {remaining === 100 || remaining === null ? t('quota_management.ledger_no_reset') : '—'}
    </span>
  );
}

function ProviderIcon({ type, resolvedTheme }: { type: string; resolvedTheme: ResolvedTheme }) {
  const { t } = useTranslation();
  const src = getAuthFileIcon(type, resolvedTheme);
  return (
    <span
      className={styles.providerIcon}
      style={
        isThemeSurfaceIconProvider(type)
          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
          : undefined
      }
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span>{getTypeLabel(t, type).slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

function SegmentBar({ segments }: { segments: (number | null)[] }) {
  return (
    <div className={styles.segments}>
      {segments.map((value, index) => (
        <div key={index} className={styles.segment}>
          <div
            className={`${styles.segmentFill} ${toneClass(value)}`}
            style={{ width: `${value ?? 0}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function SummaryCard({
  type,
  credentialCount,
  primary,
  secondary,
  resolvedTheme,
  now,
}: {
  type: QuotaProviderType;
  credentialCount: number;
  primary: LedgerSummaryBucket;
  secondary: LedgerSummaryBucket | null;
  resolvedTheme: ResolvedTheme;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const [showSecondary, setShowSecondary] = useState(false);
  const total = primary.totalRemaining;

  return (
    <article className={styles.summaryCard}>
      <header className={styles.summaryHead}>
        <ProviderIcon type={type} resolvedTheme={resolvedTheme} />
        <span className={styles.summaryName}>{getTypeLabel(t, type)}</span>
        <span className={styles.summaryCount}>
          {t('quota_management.ledger_credential_count', { count: credentialCount })}
        </span>
      </header>
      <div className={styles.summaryLabel}>{columnLabel(t, primary)}</div>
      <div className={styles.summaryValue}>
        <span className={styles.summaryBig}>{total === null ? '--' : `${Math.round(total)}%`}</span>
        <span className={styles.summaryOf}>
          {t('quota_management.ledger_of_total', { total: primary.capacity })}
        </span>
      </div>
      <SegmentBar segments={primary.segments} />
      <ResetText
        atMs={primary.soonestResetMs}
        remaining={total === null ? null : 100}
        now={now}
        locale={i18n.resolvedLanguage}
      />
      {secondary && (
        <div className={styles.summarySecondary}>
          <div className={styles.summarySecondaryRow}>
            <span>
              {columnLabel(t, secondary)}{' '}
              <strong>
                {secondary.totalRemaining === null
                  ? '--'
                  : `${Math.round(secondary.totalRemaining)}%`}
              </strong>
            </span>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setShowSecondary((v) => !v)}
            >
              {showSecondary
                ? t('quota_management.ledger_hide')
                : t('quota_management.ledger_show')}
            </button>
          </div>
          {showSecondary && (
            <>
              <SegmentBar segments={secondary.segments} />
              <ResetText
                atMs={secondary.soonestResetMs}
                remaining={null}
                now={now}
                locale={i18n.resolvedLanguage}
              />
            </>
          )}
        </div>
      )}
    </article>
  );
}

function LedgerCell({ col, now, locale }: { col: LedgerColumn; now: number; locale?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.cell} ${col.muted ? styles.cellMuted : ''}`}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel}>{columnLabel(t, col)}</span>
        <span className={styles.cellPct}>
          {col.remaining === null ? '--' : `${Math.round(col.remaining)}%`}
        </span>
      </div>
      <div className={styles.bar}>
        <div
          className={`${styles.barFill} ${toneClass(col.remaining)}`}
          style={{ width: `${col.remaining ?? 0}%` }}
        />
      </div>
      <ResetText
        atMs={col.resetAtMs}
        fallback={col.resetLabel}
        remaining={col.remaining}
        now={now}
        locale={locale}
      />
    </div>
  );
}

function LedgerRow({
  entry,
  quota,
  showEmails,
  canRefresh,
  onRefresh,
  now,
}: {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  showEmails: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const columns = ledgerColumnsFor(entry.type, quota);
  const plan = ledgerPlanFor(entry.type, quota);
  const name = showEmails ? entry.file.name : maskCredentialName(entry.file.name);
  const loading = quota?.status === 'loading';

  return (
    <div className={styles.row}>
      <div className={styles.identity}>
        <div className={styles.fileName} title={showEmails ? entry.file.name : undefined}>
          {name}
        </div>
        <div className={styles.plan}>
          {plan
            ? plan.key
              ? t(plan.key)
              : plan.literal
            : entry.file.disabled
              ? t('quota_management.ledger_disabled')
              : ' '}
        </div>
      </div>
      <div className={styles.cells}>
        {quota?.status === 'error' ? (
          <div className={styles.rowError} title={quota.error}>
            {quota.errorStatus ? `${quota.errorStatus} · ` : ''}
            {quota.error || t('common.unknown_error')}
          </div>
        ) : columns.length === 0 ? (
          <div className={styles.rowIdle}>
            {loading
              ? t('quota_management.ledger_loading')
              : t('quota_management.ledger_not_loaded')}
          </div>
        ) : (
          columns.map((col) => (
            <LedgerCell key={col.id} col={col} now={now} locale={i18n.resolvedLanguage} />
          ))
        )}
      </div>
      <button
        type="button"
        className={styles.refresh}
        onClick={onRefresh}
        disabled={!canRefresh || loading}
      >
        <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
        {t('quota_management.ledger_refresh_quota')}
      </button>
    </div>
  );
}

export function QuotaLedger({
  entries,
  providerOrder,
  quotaFor,
  resolvedTheme,
  showEmails,
  canRefresh,
  onRefresh,
}: QuotaLedgerProps) {
  const { t } = useTranslation();
  const now = useNow();

  const groups = useMemo(
    () =>
      providerOrder
        .map((type) => ({ type, items: entries.filter((entry) => entry.type === type) }))
        .filter((group) => group.items.length > 0),
    [entries, providerOrder]
  );

  const summaries = useMemo(
    () =>
      groups
        .map((group) => buildProviderSummary(group.type, group.items.map(quotaFor)))
        .filter((summary): summary is NonNullable<typeof summary> => summary !== null),
    [groups, quotaFor]
  );

  return (
    <div className={styles.ledger}>
      {summaries.length > 0 && (
        <section className={styles.summaryGrid} aria-label={t('quota_management.ledger_summary')}>
          {summaries.map((summary) => (
            <SummaryCard
              key={summary.type}
              type={summary.type}
              credentialCount={summary.credentialCount}
              primary={summary.primary}
              secondary={summary.secondary}
              resolvedTheme={resolvedTheme}
              now={now}
            />
          ))}
        </section>
      )}

      {groups.map((group) => (
        <section key={group.type} className={styles.section}>
          <h2 className={styles.sectionTitle}>
            {getTypeLabel(t, group.type)}
            <span className={styles.sectionCount}>{group.items.length}</span>
          </h2>
          <div className={styles.rows}>
            {group.items.map((entry) => (
              <LedgerRow
                key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                entry={entry}
                quota={quotaFor(entry)}
                showEmails={showEmails}
                canRefresh={canRefresh && !entry.file.disabled}
                onRefresh={() => onRefresh(entry)}
                now={now}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
