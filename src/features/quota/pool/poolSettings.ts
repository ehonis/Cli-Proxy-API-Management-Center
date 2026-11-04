/** Chart settings owned by the quota page and shared by the panel. */

import type { PoolChartMode } from './PoolChart';

export const BURN_WINDOWS = [1, 3, 6] as const;
/** The server keeps 21 days of history; two weeks back still shows some of it. */
export const MIN_OFFSET_WEEKS = -2;
export type BurnWindow = (typeof BURN_WINDOWS)[number];

export const FUTURE_USAGE = ['same', 'double', 'half', 'none'] as const;
export type FutureUsage = (typeof FUTURE_USAGE)[number];
export const FUTURE_FACTOR: Record<FutureUsage, number> = {
  same: 1,
  double: 2,
  half: 0.5,
  none: 0,
};

export interface PoolSettings {
  mode: PoolChartMode;
  burnWindow: BurnWindow;
  future: FutureUsage;
  showAccounts: boolean;
  offsetWeeks: number;
}
