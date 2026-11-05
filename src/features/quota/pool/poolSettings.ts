/** Chart settings owned by the quota page and shared by the panel. */

import type { PoolChartMode } from './PoolChart';
import type { QuietHours } from './poolModel';

export const POOL_WINDOWS = ['weekly', 'five-hour', 'combined'] as const;
export type PoolWindow = (typeof POOL_WINDOWS)[number];

export const BURN_WINDOWS = [1, 3, 6] as const;
/**
 * Paging bounds, in pages (a week in weekly view, a day in 5-hour view). The
 * server keeps 21 days of history; beyond a page or two ahead the projection is
 * only a repeating sawtooth.
 */
export const OFFSET_LIMITS: Record<PoolWindow, { min: number; max: number }> = {
  weekly: { min: -2, max: 1 },
  'five-hour': { min: -14, max: 1 },
  combined: { min: -2, max: 1 },
};

/** One card per provider, or every provider added into one pool. */
export const POOL_PROVIDER_MODES = ['separate', 'combined'] as const;
export type PoolProviderMode = (typeof POOL_PROVIDER_MODES)[number];
export type BurnWindow = (typeof BURN_WINDOWS)[number];

export const FUTURE_USAGE = ['same', 'double', 'half', 'none'] as const;
export type FutureUsage = (typeof FUTURE_USAGE)[number];
export const FUTURE_FACTOR: Record<FutureUsage, number> = {
  same: 1,
  double: 2,
  half: 0.5,
  none: 0,
};

/**
 * Nightly blocks when the projection assumes no usage, independent of the
 * Future-usage factor. Ids are "start-end" in local hours.
 */
export const QUIET_HOURS = ['off', '22-6', '23-7', '0-8', '1-9', '2-10'] as const;
export type QuietHoursId = (typeof QUIET_HOURS)[number];

export const isQuietHoursId = (value: unknown): value is QuietHoursId =>
  typeof value === 'string' && (QUIET_HOURS as readonly string[]).includes(value);

export function quietHoursOf(id: QuietHoursId): QuietHours | null {
  if (id === 'off') return null;
  const [startHour, endHour] = id.split('-').map(Number);
  return { startHour, endHour };
}

const QUIET_KEY = 'quotaPage.quietHours';

/** Kept in localStorage: a sleep schedule outlives the tab, unlike the other chart settings. */
export function readQuietHours(): QuietHoursId {
  try {
    const value = localStorage.getItem(QUIET_KEY);
    return isQuietHoursId(value) ? value : 'off';
  } catch {
    return 'off';
  }
}

export function writeQuietHours(id: QuietHoursId) {
  try {
    localStorage.setItem(QUIET_KEY, id);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

const OFF_DAYS_KEY = 'quotaPage.offDays';

/** Weekdays (0 = Sunday) with no usage, sorted and de-duplicated. */
export function normalizeOffDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

export function readOffDays(): number[] {
  try {
    return normalizeOffDays(JSON.parse(localStorage.getItem(OFF_DAYS_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function writeOffDays(days: readonly number[]) {
  try {
    localStorage.setItem(OFF_DAYS_KEY, JSON.stringify(days));
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

export interface PoolSettings {
  mode: PoolChartMode;
  window: PoolWindow;
  burnWindow: BurnWindow;
  future: FutureUsage;
  quiet: QuietHoursId;
  offDays: number[];
  showAccounts: boolean;
  providers: PoolProviderMode;
  /** Pages away from today: weeks in weekly and combined view, days in 5-hour view. */
  offset: number;
}
