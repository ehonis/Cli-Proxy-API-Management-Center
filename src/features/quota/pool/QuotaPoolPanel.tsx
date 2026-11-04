/**
 * Pool panel: chart controls, the visible-range navigator and one card per
 * pooled provider (Claude, Codex). The page owns the settings so the ledger
 * below reads the same projection.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconChevronLeft } from '@/components/ui/icons';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { ResolvedTheme } from '@/types';
import { PoolChart, type PoolChartMode } from './PoolChart';
import {
  BURN_WINDOWS,
  FUTURE_USAGE,
  MAX_OFFSET_WEEKS,
  MIN_OFFSET_WEEKS,
  type BurnWindow,
  type FutureUsage,
  type PoolSettings,
} from './poolSettings';
import { DAY_MS, type PoolModel } from './poolModel';
import {
  bandOpacity,
  formatMonthDay,
  formatPercent,
  formatRate,
  formatWhen,
} from './poolFormat';
import type { PoolProvider } from './poolInputs';
import styles from './QuotaPoolPanel.module.scss';

export interface PoolCardData {
  type: PoolProvider;
  model: PoolModel;
}

export interface QuotaPoolPanelProps {
  settings: PoolSettings;
  onSettingsChange: (patch: Partial<PoolSettings>) => void;
  cards: PoolCardData[];
  range: { startMs: number; endMs: number };
  now: number;
  resolvedTheme: ResolvedTheme;
  /** True until the first history response (or its failure) lands. */
  historyLoading: boolean;
}

const ACCENTS: Record<PoolProvider, { dark: string; light: string }> = {
  claude: { dark: '#ef7f63', light: '#d4593b' },
  codex: { dark: '#9b95ff', light: '#5b54e0' },
};

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={value === option.value}
          className={styles.segment}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
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
      {src ? <img src={src} alt="" /> : <span>{getTypeLabel(t, type).slice(0, 1)}</span>}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PoolCard({
  card,
  settings,
  range,
  now,
  resolvedTheme,
  historyLoading,
}: {
  card: PoolCardData;
  settings: PoolSettings;
  range: { startMs: number; endMs: number };
  now: number;
  resolvedTheme: ResolvedTheme;
  historyLoading: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { model } = card;
  const name = getTypeLabel(t, card.type);
  const accent = ACCENTS[card.type][resolvedTheme === 'dark' ? 'dark' : 'light'];

  const poolEmpty = model.poolEmptyAtMs
    ? formatWhen(model.poolEmptyAtMs, now, locale)
    : t('quota_management.pool_not_by', { date: formatMonthDay(model.horizonEndMs, locale) });
  const firstEmpty = model.firstEmpty
    ? `${model.firstEmpty.label} · ${formatWhen(model.firstEmpty.t, now, locale)}`
    : t('quota_management.pool_none_before_reset');

  return (
    <article
      className={styles.card}
      style={{ '--pool-accent': accent } as CSSProperties}
      aria-label={t('quota_management.pool_card_label', { name })}
    >
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <ProviderIcon type={card.type} resolvedTheme={resolvedTheme} />
          <h2>{name}</h2>
          <span className={styles.cardCount}>
            {t('quota_management.pool_accounts', { count: model.accountCount })}
          </span>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.bigValue}>
            <span className={styles.big}>{formatPercent(model.current)}</span>
            <span className={styles.of}>
              {t('quota_management.pool_of', { total: `${model.capacity}%` })}
            </span>
          </div>
          <dl className={styles.stats}>
            <Stat label={t('quota_management.pool_empty')}>
              <span className={model.poolEmptyAtMs ? styles.warn : undefined}>{poolEmpty}</span>
            </Stat>
            <Stat label={t('quota_management.pool_first_empty')}>
              <span className={model.firstEmpty ? styles.warn : undefined}>{firstEmpty}</span>
            </Stat>
            <Stat label={t('quota_management.pool_next_reset')}>
              {model.nextReset ? (
                <>
                  <strong>+{Math.round(model.nextReset.delta)}%</strong>{' '}
                  {formatWhen(model.nextReset.t, now, locale)}
                </>
              ) : (
                t('quota_management.pool_no_reset')
              )}
            </Stat>
            <Stat label={t('quota_management.pool_burn', { hours: model.burnWindowHours })}>
              {historyLoading && model.burnPerHour === null ? '…' : formatRate(model.burnPerHour)}
            </Stat>
          </dl>
        </div>
      </header>

      <PoolChart
        model={model}
        mode={settings.mode}
        startMs={range.startMs}
        endMs={range.endMs}
        now={now}
        showAccounts={settings.showAccounts}
        label={name}
      />

      <footer className={styles.legend}>
        <span className={styles.legendTitle}>
          {settings.mode === 'rate'
            ? t('quota_management.pool_legend_rate')
            : t('quota_management.pool_legend_pool')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchSolid} />
          {t('quota_management.pool_legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchDashed} />
          {t('quota_management.pool_legend_projected')}
        </span>
        {settings.showAccounts &&
          settings.mode === 'remaining' &&
          model.accounts.map((account, index) => (
            <span key={account.key} className={styles.legendItem}>
              <span
                className={styles.swatchBand}
                style={{ opacity: bandOpacity(index, model.accounts.length) }}
              />
              {account.label}
            </span>
          ))}
      </footer>
    </article>
  );
}

export function QuotaPoolPanel({
  settings,
  onSettingsChange,
  cards,
  range,
  now,
  resolvedTheme,
  historyLoading,
}: QuotaPoolPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  if (cards.length === 0) return null;

  const rangeText = t('quota_management.pool_range', {
    from: formatMonthDay(range.startMs, locale),
    to: formatMonthDay(range.endMs - DAY_MS, locale),
  });

  return (
    <section className={styles.panel} aria-label={t('quota_management.pool_section')}>
      <div className={styles.controls}>
        <Segmented<PoolChartMode>
          label={t('quota_management.pool_view')}
          value={settings.mode}
          onChange={(mode) => onSettingsChange({ mode })}
          options={[
            { value: 'remaining', label: t('quota_management.pool_mode_remaining') },
            { value: 'rate', label: t('quota_management.pool_mode_rate') },
          ]}
        />
        <div className={styles.labelled}>
          <span className={styles.controlLabel} id="pool-burn-label">
            {t('quota_management.pool_burn_rate')}
          </span>
          <Segmented<BurnWindow>
            label={t('quota_management.pool_burn_rate')}
            value={settings.burnWindow}
            onChange={(burnWindow) => onSettingsChange({ burnWindow })}
            options={BURN_WINDOWS.map((hours) => ({ value: hours, label: `${hours}h` }))}
          />
        </div>
        <div className={styles.labelled}>
          <span className={styles.controlLabel} id="pool-future-label">
            {t('quota_management.pool_future')}
          </span>
          <div className={styles.futureSelect}>
            <Select
              value={settings.future}
              onChange={(value) => onSettingsChange({ future: value as FutureUsage })}
              ariaLabelledBy="pool-future-label"
              ariaLabel={t('quota_management.pool_future')}
              size="sm"
              options={FUTURE_USAGE.map((value) => ({
                value,
                label: t(`quota_management.pool_future_${value}`),
              }))}
            />
          </div>
        </div>
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={settings.showAccounts && settings.mode === 'remaining'}
          disabled={settings.mode !== 'remaining'}
          onClick={() => onSettingsChange({ showAccounts: !settings.showAccounts })}
        >
          {t('quota_management.pool_accounts_toggle')}
        </button>
      </div>

      <div className={styles.rangeRow}>
        <span className={styles.rangeText} aria-live="polite">
          {rangeText}
        </span>
        <button
          type="button"
          className={styles.navButton}
          onClick={() => onSettingsChange({ offsetWeeks: settings.offsetWeeks - 1 })}
          disabled={settings.offsetWeeks <= MIN_OFFSET_WEEKS}
          aria-label={t('quota_management.windows_prev')}
          title={t('quota_management.windows_prev')}
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          type="button"
          className={styles.todayButton}
          onClick={() => onSettingsChange({ offsetWeeks: 0 })}
          data-current={settings.offsetWeeks === 0 ? 'true' : 'false'}
        >
          {t('quota_management.windows_today')}
        </button>
        <button
          type="button"
          className={`${styles.navButton} ${styles.navNext}`}
          onClick={() => onSettingsChange({ offsetWeeks: settings.offsetWeeks + 1 })}
          disabled={settings.offsetWeeks >= MAX_OFFSET_WEEKS}
          aria-label={t('quota_management.windows_next')}
          title={t('quota_management.windows_next')}
        >
          <IconChevronLeft size={16} />
        </button>
      </div>

      {cards.map((card) => (
        <PoolCard
          key={card.type}
          card={card}
          settings={settings}
          range={range}
          now={now}
          resolvedTheme={resolvedTheme}
          historyLoading={historyLoading}
        />
      ))}
    </section>
  );
}
