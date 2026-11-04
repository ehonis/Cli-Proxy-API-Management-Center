/**
 * Ledger view: one collapsible card per provider, a shared column header, and
 * a dense row per credential with every limit, its runway under the pool
 * projection, and the row's actions.
 */

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { DAY_MS, type PoolModel } from '../pool/poolModel';
import { credentialLabel, displayCredentialLabel } from '../pool/poolInputs';
import {
  formatDuration,
  formatPercent,
  formatResetCompact,
  formatResetInstant,
  formatResetNoWeekday,
  formatWhen,
} from '../pool/poolFormat';
import {
  buildProviderSummary,
  ledgerColumnsFor,
  ledgerTone,
  type LedgerColumn,
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
  onReset: (entry: QuotaFileEntry) => void;
  resettingKey: string | null;
  pools: Partial<Record<QuotaProviderType, PoolModel>>;
  fetchedAt: Record<string, number>;
  now: number;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (type: QuotaProviderType) => void;
}

const columnLabel = (t: TFunction, col: { labelKey?: string; label?: string }) =>
  col.labelKey ? t(col.labelKey) : (col.label ?? '');

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
      {src ? <img src={src} alt="" /> : <span>{getTypeLabel(t, type).slice(0, 1)}</span>}
    </span>
  );
}

function LimitCell({
  col,
  label,
  now,
}: {
  col: LedgerColumn | undefined;
  label: string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  if (!col) {
    return (
      <div className={styles.cell} role="cell">
        <span className={styles.cellLabel}>{label}</span>
        <span className={styles.cellEmpty}>--</span>
      </div>
    );
  }
  const hasReset = col.resetAtMs !== null && col.resetAtMs > now;
  const fallback =
    col.resetLabel && col.resetLabel.trim() && col.resetLabel.trim() !== '-'
      ? col.resetLabel.trim()
      : null;
  const tone = ledgerTone(col.remaining);
  const locale = i18n.resolvedLanguage;
  const instant = hasReset ? formatResetInstant(col.resetAtMs!, locale) : null;
  // Without a countdown the bottom line says why, instead of crowding the top.
  const reason =
    fallback && col.remaining !== 100 ? fallback : t('quota_management.ledger_no_reset');
  const bottom = instant ? (
    <>
      <span className={styles.dateLong}>{instant}</span>
      <span className={styles.dateShort}>{formatResetNoWeekday(col.resetAtMs!, locale)}</span>
    </>
  ) : (
    reason
  );
  return (
    <div className={styles.cell} role="cell">
      <span className={styles.cellLabel}>{label}</span>
      <div className={styles.cellTop}>
        <span className={styles.cellPct}>{formatPercent(col.remaining)}</span>
        {hasReset && (
          <span className={styles.cellIn}>
            {t('quota_management.ledger_in', { duration: formatDuration(col.resetAtMs! - now) })}
          </span>
        )}
      </div>
      <div
        className={styles.bar}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={col.remaining ?? undefined}
        aria-label={label}
      >
        <div
          className={`${styles.barFill} ${styles[`tone_${tone}`]}`}
          style={{ width: `${col.remaining ?? 0}%` }}
        />
      </div>
      <div className={styles.cellDate} title={instant ?? reason}>
        {bottom}
      </div>
    </div>
  );
}

function RunwayCell({ pool, rowKey, now }: { pool: PoolModel; rowKey: string; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const account = pool.accounts.find((a) => a.key === rowKey);
  if (!account) {
    return (
      <div className={styles.runway} role="cell">
        <span className={styles.cellEmpty}>--</span>
      </div>
    );
  }
  const runsDry =
    account.emptyAtMs !== null &&
    (account.nextResetMs === null || account.emptyAtMs < account.nextResetMs);
  return (
    <div className={styles.runway} role="cell">
      <span className={styles.cellLabel}>{t('quota_management.ledger_runway')}</span>
      {account.emptyAtMs !== null ? (
        <div className={runsDry ? styles.runwayWarn : styles.runwayMain}>
          {account.emptyAtMs <= now
            ? t('quota_management.ledger_runway_empty_now')
            : t('quota_management.ledger_runway_empty', {
                duration: formatDuration(account.emptyAtMs - now),
              })}
        </div>
      ) : (
        <div className={styles.runwayMain}>
          {t('quota_management.ledger_runway_over', {
            // "Over 13 days" for a 14-day horizon: strictly less than what was simulated.
            count: Math.max(1, Math.ceil((pool.horizonEndMs - now) / DAY_MS) - 1),
          })}
        </div>
      )}
      <div className={styles.runwaySub}>
        {account.nextResetMs !== null
          ? t('quota_management.ledger_resets_at', {
              when: formatResetCompact(account.nextResetMs, now, locale),
            })
          : t('quota_management.ledger_no_reset')}
      </div>
    </div>
  );
}

function ClaudeResetAction({
  entry,
  quota,
  disabled,
  onRefresh,
}: {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const reset = useClaudeResetGrants(
    entry.file,
    quota?.status === 'success',
    disabled,
    quota,
    onRefresh
  );
  return (
    <>
      <span className={styles.resetsLeft}>
        {t('claude_reset.remaining')}: <b>{reset.count ?? '--'}</b>
      </span>
      <button
        type="button"
        className={styles.action}
        onClick={reset.confirm}
        disabled={reset.blocked}
        title={reset.message ? t(`claude_reset.${reset.message}`) : t('claude_reset.scope')}
      >
        <IconRefreshCw size={13} className={reset.busy ? styles.spinning : undefined} />
        {t(`claude_reset.${reset.buttonLabel}`)}
      </button>
    </>
  );
}

function LedgerRow({
  entry,
  quota,
  columns,
  pool,
  showEmails,
  canRefresh,
  onRefresh,
  onReset,
  resetting,
  fetchedAt,
  now,
  resolvedTheme,
}: {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  columns: LedgerColumn[];
  pool: PoolModel | undefined;
  showEmails: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
  onReset: () => void;
  resetting: boolean;
  fetchedAt: number | undefined;
  now: number;
  resolvedTheme: ResolvedTheme;
}) {
  const { t } = useTranslation();
  const key = getQuotaCacheKey(entry.file);
  const rowColumns = ledgerColumnsFor(entry.type, quota);
  const loading = quota?.status === 'loading';
  const adapter = QUOTA_ADAPTERS[entry.type];
  const canCodexReset =
    entry.type === 'codex' &&
    quota?.status === 'success' &&
    Boolean(adapter.resetQuota) &&
    Boolean(adapter.canResetQuota?.(quota));

  const label = credentialLabel(entry.file);
  const shownName = displayCredentialLabel(entry.file, showEmails);
  const email = typeof entry.file.email === 'string' ? entry.file.email : '';
  const updated = loading
    ? t('quota_management.ledger_loading')
    : fetchedAt
      ? now - fetchedAt < 60_000
        ? t('quota_management.ledger_just_now')
        : t('quota_management.ledger_ago', { duration: formatDuration(now - fetchedAt) })
      : entry.file.disabled
        ? t('quota_management.ledger_disabled')
        : t('quota_management.ledger_not_loaded');

  return (
    <div className={styles.row} role="row">
      <div className={styles.identity} role="rowheader">
        <div className={styles.name} title={showEmails ? entry.file.name : undefined}>
          {shownName}
        </div>
        <div className={styles.sub}>
          <ProviderIcon type={entry.type} resolvedTheme={resolvedTheme} />
          <span className={styles.subText}>
            <span className={styles.subProvider}>
              {showEmails && email && email !== label ? email : getTypeLabel(t, entry.type)}
              {' · '}
            </span>
            {updated}
          </span>
        </div>
      </div>

      {quota?.status === 'error' ? (
        <div className={styles.rowError} role="cell" title={quota.error}>
          {quota.errorStatus ? `${quota.errorStatus} · ` : ''}
          {quota.error || t('common.unknown_error')}
        </div>
      ) : rowColumns.length === 0 ? (
        <div className={styles.rowIdle} role="cell">
          {loading ? t('quota_management.ledger_loading') : t('quota_management.ledger_not_loaded')}
        </div>
      ) : (
        <>
          {columns.map((col) => (
            <LimitCell
              key={col.id}
              col={rowColumns.find((c) => c.id === col.id)}
              label={columnLabel(t, col)}
              now={now}
            />
          ))}
          {pool && <RunwayCell pool={pool} rowKey={key} now={now} />}
        </>
      )}

      <div className={styles.actions} role="cell">
        {entry.type === 'claude' && (
          <ClaudeResetAction
            entry={entry}
            quota={quota}
            disabled={!canRefresh || loading}
            onRefresh={onRefresh}
          />
        )}
        {canCodexReset && (
          <button
            type="button"
            className={styles.action}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
          >
            <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
            {t('claude_reset.use')}
          </button>
        )}
        <button
          type="button"
          className={`${styles.action} ${styles.actionStrong}`}
          onClick={onRefresh}
          disabled={!canRefresh || loading}
        >
          <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
          {t('quota_management.ledger_refresh_quota')}
        </button>
      </div>
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
  onReset,
  resettingKey,
  pools,
  fetchedAt,
  now,
  collapsed,
  onToggleCollapsed,
}: QuotaLedgerProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  const groups = useMemo(
    () =>
      providerOrder
        .map((type) => {
          const items = entries.filter((entry) => entry.type === type);
          // Union of the columns any row reports, in first-seen order, so one
          // header lines up with every row in the group.
          const columns: LedgerColumn[] = [];
          for (const entry of items) {
            for (const col of ledgerColumnsFor(type, quotaFor(entry))) {
              if (!columns.some((c) => c.id === col.id)) columns.push(col);
            }
          }
          return { type, items, columns };
        })
        .filter((group) => group.items.length > 0),
    [entries, providerOrder, quotaFor]
  );

  return (
    <div className={styles.ledger}>
      {groups.map((group) => {
        const pool = pools[group.type];
        const isCollapsed = collapsed.has(group.type);
        const summary = pool ? null : buildProviderSummary(group.type, group.items.map(quotaFor));
        const total = pool ? pool.current : (summary?.primary.totalRemaining ?? null);
        const capacity = pool ? pool.capacity : (summary?.primary.capacity ?? 0);
        const bodyId = `ledger-${group.type}`;
        const columnCount = Math.max(1, group.columns.length) + (pool ? 1 : 0);

        return (
          <section
            key={group.type}
            className={styles.group}
            aria-label={getTypeLabel(t, group.type)}
            style={{ '--ledger-cols': columnCount } as CSSProperties}
          >
            <header className={styles.groupHead}>
              <ProviderIcon type={group.type} resolvedTheme={resolvedTheme} />
              <h2 className={styles.groupName}>{getTypeLabel(t, group.type)}</h2>
              <span className={styles.groupCount}>{group.items.length}</span>
              {total !== null && (
                <span className={styles.groupPool}>
                  <b>{formatPercent(total)}</b>{' '}
                  {t('quota_management.ledger_of_pool', { total: `${capacity}%` })}
                </span>
              )}
              {pool?.nextReset && (
                <span className={styles.groupReset}>
                  {t('quota_management.pool_next_reset')}{' '}
                  <b>+{Math.round(pool.nextReset.delta)}%</b>
                  {' · '}
                  {formatWhen(pool.nextReset.t, now, locale)}
                </span>
              )}
              <button
                type="button"
                className={styles.collapse}
                aria-expanded={!isCollapsed}
                aria-controls={bodyId}
                onClick={() => onToggleCollapsed(group.type)}
              >
                {isCollapsed
                  ? t('quota_management.ledger_expand')
                  : t('quota_management.ledger_collapse')}
                <IconChevronDown size={14} className={isCollapsed ? undefined : styles.chevronUp} />
              </button>
            </header>

            {!isCollapsed && (
              <div className={styles.table} id={bodyId} role="table">
                <div className={styles.headRow} role="row">
                  <div role="columnheader">{t('quota_management.ledger_credential')}</div>
                  {group.columns.length === 0 ? (
                    <div role="columnheader" />
                  ) : (
                    group.columns.map((col) => (
                      <div key={col.id} role="columnheader">
                        {columnLabel(t, col)}
                      </div>
                    ))
                  )}
                  {pool && <div role="columnheader">{t('quota_management.ledger_runway')}</div>}
                  <div role="columnheader">
                    <span className={styles.srOnly}>{t('quota_management.ledger_actions')}</span>
                  </div>
                </div>
                {group.items.map((entry) => {
                  const key = getQuotaCacheKey(entry.file);
                  return (
                    <LedgerRow
                      key={`${entry.type}:${key}`}
                      entry={entry}
                      quota={quotaFor(entry)}
                      columns={group.columns}
                      pool={pool}
                      showEmails={showEmails}
                      canRefresh={canRefresh && !entry.file.disabled}
                      onRefresh={() => onRefresh(entry)}
                      onReset={() => onReset(entry)}
                      resetting={resettingKey === key}
                      fetchedAt={fetchedAt[key]}
                      now={now}
                      resolvedTheme={resolvedTheme}
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
