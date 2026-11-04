/** Display formatting shared by the pool chart, its stats and the ledger. */

import { DAY_MS, HOUR_MS, MINUTE_MS } from './poolModel';

export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '--'
    : `${Math.round(value)}%`;

export const formatRate = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  if (value === 0) return '0%/h';
  if (value < 0.1) return '<0.1%/h';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%/h`;
};

/** "Nov 8" */
export const formatMonthDay = (ms: number, locale?: string) =>
  new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** "10:00 AM" in the viewer's locale convention. */
export const formatClock = (ms: number, locale?: string) =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

/** "Tue 10:00 AM" within the coming week, "Nov 12, 10:00 AM" beyond it. */
export const formatWhen = (ms: number, now: number, locale?: string) => {
  const date = new Date(ms);
  if (Math.abs(ms - now) < 6 * DAY_MS) {
    return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${formatClock(ms, locale)}`;
  }
  return `${formatMonthDay(ms, locale)}, ${formatClock(ms, locale)}`;
};

/** "Tue, 10/27, 9:59 PM" — the full instant for a reset cell. */
export const formatResetInstant = (ms: number, locale?: string) =>
  new Date(ms).toLocaleString(locale, {
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** "2d 1h", "3h 40m", "12m", "<1m" */
export const formatDuration = (ms: number) => {
  if (ms < MINUTE_MS) return '<1m';
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
};

/** Crosshair / tooltip stamp: "Mon, Oct 26, 3:00 PM". */
export const formatStamp = (ms: number, locale?: string) =>
  new Date(ms).toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });


/** Runway reset: "Thu 9:06 PM" within the week, "Tue 11/10" beyond, always short. */
export const formatResetCompact = (ms: number, now: number, locale?: string) => {
  const date = new Date(ms);
  const weekday = date.toLocaleDateString(locale, { weekday: 'short' });
  if (Math.abs(ms - now) < 6 * DAY_MS) return `${weekday} ${formatClock(ms, locale)}`;
  return `${weekday} ${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}`;
};

/** Band opacity for account `index` of `count`, spread so no two bands match. */
export function bandOpacity(index: number, count: number) {
  return count <= 1 ? 0.6 : 0.2 + (0.6 * index) / (count - 1);
}

/** "11/10, 12:06 PM": the reset instant for narrow ledger cells. */
export const formatResetNoWeekday = (ms: number, locale?: string) =>
  new Date(ms).toLocaleString(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
