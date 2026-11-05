/**
 * Weekly and 5-hour limits projected together.
 *
 * Each account has two limits at once: a weekly one and a 5-hour one. Usage
 * draws on both, so an account is usable only while both have room. A run-dry
 * weekly limit locks the account out until the weekly reset, however full its
 * 5-hour window; an empty 5-hour window pauses the weekly drain until it
 * refills. One simulation drives all three views so they agree:
 *
 * - weekly: weekly remaining, throttled by the 5-hour windows;
 * - 5-hour: 5-hour remaining, held at zero while the weekly limit is out;
 * - combined: what can actually be spent right now, in 5-hour units:
 *   min(5-hour remaining, weekly remaining x exchange rate), per account.
 *
 * The exchange rate is how many points of a 5-hour window one point of the
 * weekly limit buys, estimated from recorded history and assumed otherwise.
 * Pure and React-free like poolModel.ts.
 */

import {
  DAY_MS,
  HOUR_MS,
  PROJECTION_HORIZON_MS,
  STEP_MS,
  buildAccountTrack,
  buildPoolModel,
  isIdleAt,
  trackValueAt,
  type PoolAccountInput,
  type PoolAccountProjection,
  type PoolModel,
  type PoolModelOptions,
  type PoolResetEvent,
  type SeriesPoint,
} from './poolModel';

/** Points of a 5-hour window per point of the weekly limit, when history is too thin. */
export const DEFAULT_FIVE_PER_WEEKLY = 8;
const RATIO_LOOKBACK_MS = 7 * DAY_MS;
/** Least recorded weekly / 5-hour drain, in account percent, to trust a measured rate. */
const MIN_WEEKLY_DRAIN = 3;
const MIN_FIVE_DRAIN = 6;
const RATIO_BOUNDS = { min: 1, max: 50 };
const EMPTY_EPSILON = 0.5;
const RESET_CLUSTER_MS = 90 * 60_000;
const MIN_RESET_LABEL = 1;
const FIVE_HOUR_HORIZON_MS = 2 * DAY_MS;

export interface WindowRatio {
  /** 5-hour points per weekly point. */
  value: number;
  source: 'history' | 'assumed';
}

/**
 * Exchange rate from history: total 5-hour drain over total weekly drain, for
 * accounts that recorded both, over the last week. Rises (resets) are ignored.
 */
export function estimateFivePerWeekly(
  weekly: PoolAccountInput[],
  five: PoolAccountInput[],
  now: number
): WindowRatio {
  const fiveByKey = new Map(five.map((a) => [a.key, a]));
  let weeklyDrain = 0;
  let fiveDrain = 0;
  for (const w of weekly) {
    const f = fiveByKey.get(w.key);
    if (!f) continue;
    const wTrack = buildAccountTrack(w, now);
    const fTrack = buildAccountTrack(f, now);
    if (wTrack.length === 0 || fTrack.length === 0) continue;
    const from = Math.max(now - RATIO_LOOKBACK_MS, wTrack[0].t, fTrack[0].t);
    let prevW: number | null = null;
    let prevF: number | null = null;
    for (let t = Math.ceil(from / STEP_MS) * STEP_MS; t <= now; t += STEP_MS) {
      const vw = trackValueAt(wTrack, t);
      const vf = trackValueAt(fTrack, t);
      if (vw === null || vf === null) continue;
      if (prevW !== null && prevF !== null) {
        weeklyDrain += Math.max(0, prevW - vw);
        fiveDrain += Math.max(0, prevF - vf);
      }
      prevW = vw;
      prevF = vf;
    }
  }
  if (weeklyDrain < MIN_WEEKLY_DRAIN || fiveDrain < MIN_FIVE_DRAIN) {
    return { value: DEFAULT_FIVE_PER_WEEKLY, source: 'assumed' };
  }
  const value = Math.max(RATIO_BOUNDS.min, Math.min(RATIO_BOUNDS.max, fiveDrain / weeklyDrain));
  return { value, source: 'history' };
}

export interface LinkedPoolModels {
  weekly: PoolModel;
  fiveHour: PoolModel;
  combined: PoolModel;
  ratio: WindowRatio;
}

export type LinkedPoolOptions = Omit<PoolModelOptions, 'horizonMs'>;

interface WindowState {
  /** Remaining in account percent. */
  remaining: number;
  resetAtMs: number | null;
  periodMs: number;
}

interface AccountState {
  key: string;
  label: string;
  weekly: WindowState | null;
  five: WindowState | null;
  /** Instant of the latest reset applied in the current step, for labels. */
  lastResetMs: number | null;
}

/** Remaining and next reset at `now`, the way buildPoolModel starts its projection. */
function startOf(input: PoolAccountInput | undefined, now: number): WindowState | null {
  if (!input || (input.remaining === null && input.samples.length === 0)) return null;
  let resetAtMs = input.resetAtMs;
  if (input.remaining === null) {
    let latest: PoolAccountInput['samples'][number] | null = null;
    for (const sample of input.samples) if (!latest || sample.t > latest.t) latest = sample;
    resetAtMs = latest?.resetAtMs ?? null;
  }
  while (resetAtMs !== null && resetAtMs <= now) resetAtMs += input.periodMs;
  const remaining = trackValueAt(buildAccountTrack(input, now), now) ?? 0;
  return { remaining, resetAtMs, periodMs: input.periodMs };
}

const usable = (s: AccountState, ratio: number) =>
  Math.min(s.weekly ? s.weekly.remaining : Infinity, s.five ? s.five.remaining / ratio : Infinity);

/** Combined value in 5-hour account percent: what the account can spend right now. */
const combinedOf = (s: AccountState, ratio: number) =>
  Math.min(
    100,
    s.five ? s.five.remaining : Infinity,
    s.weekly ? s.weekly.remaining * ratio : Infinity
  );

/** 5-hour value as shown: zero while the weekly limit has the account locked out. */
const fiveShownOf = (s: AccountState) =>
  s.five ? (s.weekly && s.weekly.remaining <= EMPTY_EPSILON ? 0 : s.five.remaining) : 0;

function clusterResets(raw: { t: number; delta: number; label: string }[], projected: boolean) {
  const sorted = [...raw].sort((a, b) => a.t - b.t);
  const out: PoolResetEvent[] = [];
  for (const event of sorted) {
    const last = out[out.length - 1];
    if (last && event.t - last.t <= RESET_CLUSTER_MS) {
      last.delta += event.delta;
      if (!last.labels.includes(event.label)) last.labels.push(event.label);
    } else {
      out.push({ t: event.t, delta: event.delta, labels: [event.label], projected });
    }
  }
  return out.filter((event) => event.delta >= MIN_RESET_LABEL);
}

/** Projected half of one view, before it is folded into a PoolModel. */
interface ProjectedView {
  byAccount: Record<string, number[]>;
  rates: number[];
  rises: { t: number; delta: number; key: string; label: string }[];
}

function emptyView(keys: string[]): ProjectedView {
  return { byAccount: Object.fromEntries(keys.map((k) => [k, []])), rates: [], rises: [] };
}

/**
 * Fold a projected view into a base model: recorded half from the base, the
 * projected half and every forward-looking stat from the joint simulation.
 */
function withProjection(
  base: PoolModel,
  times: number[],
  view: ProjectedView,
  options: {
    now: number;
    horizonEndMs: number;
    burnPerHour: number | null;
    nextResetOf: (key: string) => number | null;
    /** Only count a run-dry before the account's own next reset. */
    beforeResetOnly: boolean;
    /** Report the first projected refill after a run-dry as the account's next reset. */
    resetFromRecovery?: boolean;
  }
): PoolModel {
  const { now, horizonEndMs } = options;
  const shareOf = new Map(base.accounts.map((a) => [a.key, a.share]));
  const projectedByAccount: Record<string, number[]> = {};
  for (const account of base.accounts) {
    const share = account.share / 100;
    projectedByAccount[account.key] = (view.byAccount[account.key] ?? []).map((v) => v * share);
  }
  const projected: SeriesPoint[] = times.map((t, i) => ({
    t,
    v: base.accounts.reduce((sum, a) => sum + (projectedByAccount[a.key][i] ?? 0), 0),
  }));

  let poolEmptyAtMs: number | null = null;
  let firstEmpty: PoolModel['firstEmpty'] = null;
  for (let i = 0; i < times.length && times[i] <= horizonEndMs; i += 1) {
    if (poolEmptyAtMs === null && base.accounts.length > 0 && projected[i].v <= EMPTY_EPSILON) {
      poolEmptyAtMs = times[i];
    }
    if (!firstEmpty) {
      const dry = base.accounts.find((a) => {
        if ((projectedByAccount[a.key][i] ?? 0) > EMPTY_EPSILON * (a.share / 100)) return false;
        if (!options.beforeResetOnly) return true;
        const reset = options.nextResetOf(a.key);
        return reset === null || times[i] < reset;
      });
      if (dry) firstEmpty = { key: dry.key, label: dry.label, t: times[i] };
    }
  }

  const rises = view.rises
    .filter((r) => shareOf.has(r.key))
    .map((r) => ({ t: r.t, delta: (r.delta * (shareOf.get(r.key) ?? 100)) / 100, label: r.label }));
  const projectedResets = clusterResets(rises, true);
  const resets = [...base.resets.filter((r) => !r.projected), ...projectedResets];
  const nextReset = projectedResets.find((r) => r.t > now && r.t <= horizonEndMs) ?? null;

  const accounts: PoolAccountProjection[] = base.accounts.map((a) => {
    let emptyAtMs: number | null = null;
    let recoveryMs: number | null = null;
    const values = projectedByAccount[a.key];
    const dry = EMPTY_EPSILON * (a.share / 100);
    for (let i = 0; i < times.length && times[i] <= horizonEndMs; i += 1) {
      if ((values[i] ?? 0) <= dry) {
        emptyAtMs = times[i];
        for (let j = i + 1; j < times.length; j += 1) {
          if ((values[j] ?? 0) > dry) {
            recoveryMs = times[j];
            break;
          }
        }
        break;
      }
    }
    const nextResetMs =
      options.resetFromRecovery && emptyAtMs !== null ? recoveryMs : options.nextResetOf(a.key);
    return { ...a, emptyAtMs, nextResetMs };
  });

  return {
    ...base,
    burnPerHour: options.burnPerHour,
    projected,
    projectedByAccount,
    projectedRate: times.map((t, i) => ({ t, v: view.rates[i] ?? 0 })),
    resets,
    poolEmptyAtMs,
    firstEmpty,
    nextReset,
    horizonEndMs,
    accounts,
  };
}

/** Shares (biggest plan = 100) over every account that has either window. */
function sharesOf(inputs: PoolAccountInput[]) {
  const withData = inputs.filter((a) => a.remaining !== null || a.samples.length > 0);
  const sizeOf = (a: PoolAccountInput) => (a.size && a.size > 0 ? a.size : 1);
  const biggest = Math.max(1e-9, ...withData.map(sizeOf));
  const shares = new Map<string, number>();
  for (const a of withData)
    shares.set(a.key, Math.max(shares.get(a.key) ?? 0, (100 * sizeOf(a)) / biggest));
  return shares;
}

/**
 * Recorded half of the combined view: min(5-hour, weekly x rate) per account
 * along the recorded timeline, in pool percent.
 */
function combinedRecorded(
  keys: string[],
  shares: Map<string, number>,
  weeklyByKey: Map<string, PoolAccountInput>,
  fiveByKey: Map<string, PoolAccountInput>,
  labels: Map<string, string>,
  ratio: number,
  options: LinkedPoolOptions
) {
  const { now } = options;
  const tracks = keys.map((key) => {
    const w = weeklyByKey.get(key);
    const f = fiveByKey.get(key);
    return {
      key,
      weekly: w ? buildAccountTrack(w, now) : [],
      five: f ? buildAccountTrack(f, now) : [],
    };
  });
  const first = Math.min(
    ...tracks.flatMap((tr) =>
      [tr.weekly[0]?.t, tr.five[0]?.t].filter((t): t is number => t !== undefined)
    )
  );
  const start = Math.max(
    Math.floor((options.recordedFromMs - options.burnWindowHours * HOUR_MS) / STEP_MS) * STEP_MS,
    Number.isFinite(first) ? Math.floor(first / STEP_MS) * STEP_MS : now
  );
  const times: number[] = [];
  for (let t = start; t < now; t += STEP_MS) times.push(t);
  times.push(now);

  const byAccount: Record<string, number[]> = {};
  const rises: { t: number; delta: number; label: string }[] = [];
  for (const tr of tracks) {
    const share = (shares.get(tr.key) ?? 100) / 100;
    const values = times.map((t) => {
      const vw = tr.weekly.length ? trackValueAt(tr.weekly, t) : null;
      const vf = tr.five.length ? trackValueAt(tr.five, t) : null;
      const own = Math.min(100, vf ?? Infinity, vw === null ? Infinity : vw * ratio);
      return (Number.isFinite(own) ? own : 0) * share;
    });
    byAccount[tr.key] = values;
    for (let i = 1; i < values.length; i += 1) {
      const rise = values[i] - values[i - 1];
      // A refill shows as a step; gradual creep is just a weekly cap lifting.
      if (rise >= MIN_RESET_LABEL) {
        rises.push({ t: times[i], delta: rise, label: labels.get(tr.key) ?? tr.key });
      }
    }
  }
  const recorded = times.map((t, i) => ({
    t,
    v: keys.reduce((sum, key) => sum + byAccount[key][i], 0),
  }));
  return {
    recorded: recorded.length > 1 ? recorded : [],
    byAccount,
    resets: clusterResets(rises, false),
  };
}

/**
 * Build the weekly, 5-hour and combined models for one provider from one joint
 * simulation. Inputs are matched by account key.
 */
export function buildLinkedPoolModels(
  weeklyInputs: PoolAccountInput[],
  fiveInputs: PoolAccountInput[],
  options: LinkedPoolOptions
): LinkedPoolModels {
  const { now, burnWindowHours, futureFactor, strategy = 'soonest-reset' } = options;
  const idle = { quietHours: options.quietHours, offDays: options.offDays };
  const weeklyHorizon = now + PROJECTION_HORIZON_MS;
  const fiveHorizon = now + FIVE_HOUR_HORIZON_MS;
  const projectEnd = Math.max(weeklyHorizon, options.projectToMs);

  // Only the recorded half, burn and shares are kept from these; the joint
  // simulation below replaces their projection, so project no further than now.
  const recordedOnly = { ...options, horizonMs: 0, projectToMs: now };
  const weeklyBase = buildPoolModel(weeklyInputs, recordedOnly);
  const fiveBase = buildPoolModel(fiveInputs, recordedOnly);
  const ratio = estimateFivePerWeekly(weeklyInputs, fiveInputs, now);
  const k = ratio.value;

  /* ---------- joint state ---------- */

  const weeklyByKey = new Map(weeklyInputs.map((a) => [a.key, a]));
  const fiveByKey = new Map(fiveInputs.map((a) => [a.key, a]));
  const shares = sharesOf([...weeklyInputs, ...fiveInputs]);
  const keys = [...shares.keys()];
  const labels = new Map<string, string>();
  for (const a of [...fiveInputs, ...weeklyInputs]) labels.set(a.key, a.label);

  const state: AccountState[] = keys.map((key) => ({
    key,
    label: labels.get(key) ?? key,
    weekly: startOf(weeklyByKey.get(key), now),
    five: startOf(fiveByKey.get(key), now),
    lastResetMs: null,
  }));
  const firstReset = new Map(
    state.map((s) => [
      s.key,
      { weekly: s.weekly?.resetAtMs ?? null, five: s.five?.resetAtMs ?? null },
    ])
  );

  // Demand in weekly account-percent of the biggest plan per hour. The 5-hour
  // limit moves several times faster than the weekly one, whose whole-percent
  // ticks can read as zero over a short window, so its measured burn wins.
  const measured =
    fiveBase.burnPerHour !== null ? fiveBase.burnPerHour / k : weeklyBase.burnPerHour;
  const demand = (measured ?? 0) * Math.max(0, futureFactor);

  /* ---------- simulation ---------- */

  const times: number[] = [now];
  for (let t = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS; t <= projectEnd; t += STEP_MS) {
    times.push(t);
  }
  const views = { weekly: emptyView(keys), five: emptyView(keys), combined: emptyView(keys) };
  const record = (s: AccountState) => {
    const values = {
      weekly: s.weekly ? s.weekly.remaining : 0,
      five: fiveShownOf(s),
      combined: combinedOf(s, k),
    };
    for (const name of ['weekly', 'five', 'combined'] as const) {
      const series = views[name].byAccount[s.key];
      const prev = series[series.length - 1];
      if (prev !== undefined && values[name] - prev >= MIN_RESET_LABEL && s.lastResetMs !== null) {
        views[name].rises.push({
          t: s.lastResetMs,
          delta: values[name] - prev,
          key: s.key,
          label: s.label,
        });
      }
      series.push(values[name]);
    }
  };

  const order = () => {
    const active = state.filter((s) => usable(s, k) > EMPTY_EPSILON / 100);
    const weeklyReset = (s: AccountState) => s.weekly?.resetAtMs ?? Number.POSITIVE_INFINITY;
    if (strategy === 'soonest-reset') {
      active.sort((a, b) => weeklyReset(a) - weeklyReset(b) || a.key.localeCompare(b.key));
    } else if (strategy === 'fill-first') {
      active.sort((a, b) => a.key.localeCompare(b.key));
    }
    return active;
  };
  // Demand is in pool units (biggest plan = 100); accounts hold their own percent.
  const shareFrac = (s: AccountState) => (shares.get(s.key) ?? 100) / 100;
  const take = (s: AccountState, poolUnits: number) => {
    const own = poolUnits / shareFrac(s);
    // Snap float dust to zero so a drained limit reads exactly empty.
    const drain = (value: number, by: number) => (value - by < 1e-9 ? 0 : value - by);
    if (s.weekly) s.weekly.remaining = drain(s.weekly.remaining, own);
    if (s.five) s.five.remaining = drain(s.five.remaining, own * k);
  };
  const capacityOf = (s: AccountState) => {
    const own = usable(s, k);
    return Number.isFinite(own) ? own * shareFrac(s) : 0;
  };

  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    let consumed = measured ?? 0;
    for (const s of state) s.lastResetMs = null;
    if (i > 0) {
      const dtHours = (t - times[i - 1]) / HOUR_MS;
      const wanted = isIdleAt((t + times[i - 1]) / 2, idle) ? 0 : demand * dtHours;
      let need = wanted;
      if (need > 0) {
        let active = order();
        if (strategy === 'round-robin') {
          while (need > 1e-9 && active.length > 0) {
            const share = need / active.length;
            need = 0;
            for (const s of active) {
              const got = Math.min(share, capacityOf(s));
              take(s, got);
              need += share - got;
            }
            active = active.filter((s) => capacityOf(s) > 1e-9);
          }
        } else {
          for (const s of active) {
            const got = Math.min(need, capacityOf(s));
            take(s, got);
            need -= got;
            if (need <= 1e-9) break;
          }
        }
      }
      consumed = (wanted - Math.max(0, need)) / dtHours;
      for (const s of state) {
        for (const w of [s.weekly, s.five]) {
          while (w && w.resetAtMs !== null && w.resetAtMs <= t) {
            s.lastResetMs = Math.max(s.lastResetMs ?? 0, w.resetAtMs);
            w.remaining = 100;
            w.resetAtMs += w.periodMs;
          }
        }
      }
    }
    for (const s of state) record(s);
    const anyUsable = state.some((s) => capacityOf(s) > EMPTY_EPSILON / 100);
    const rate = anyUsable ? consumed : 0;
    views.weekly.rates.push(rate);
    views.five.rates.push(rate * k);
    views.combined.rates.push(rate * k);
  }

  /* ---------- fold into models ---------- */

  const nextWeekly = (key: string) => firstReset.get(key)?.weekly ?? null;
  const nextFive = (key: string) => firstReset.get(key)?.five ?? null;
  const burn = measured;

  const weekly = withProjection(weeklyBase, times, views.weekly, {
    now,
    horizonEndMs: weeklyHorizon,
    burnPerHour: burn,
    nextResetOf: nextWeekly,
    beforeResetOnly: true,
  });
  const fiveHour = withProjection(fiveBase, times, views.five, {
    now,
    horizonEndMs: fiveHorizon,
    burnPerHour: burn === null ? null : burn * k,
    nextResetOf: nextFive,
    beforeResetOnly: true,
  });

  const rec = combinedRecorded(keys, shares, weeklyByKey, fiveByKey, labels, k, options);
  const combinedAccounts: PoolAccountProjection[] = keys.map((key) => ({
    key,
    label: labels.get(key) ?? key,
    share: shares.get(key) ?? 100,
    emptyAtMs: null,
    nextResetMs: null,
  }));
  const combinedBase: PoolModel = {
    capacity: combinedAccounts.reduce((sum, a) => sum + a.share, 0),
    accountCount: keys.length,
    // The live value at Now, which also anchors the chart when history is thin.
    current: keys.length
      ? state.reduce((sum, s) => sum + (views.combined.byAccount[s.key][0] ?? 0) * shareFrac(s), 0)
      : null,
    burnPerHour: null,
    burnWindowHours,
    recorded: rec.recorded,
    projected: [],
    recordedByAccount: rec.byAccount,
    projectedByAccount: {},
    recordedRate: fiveBase.recordedRate,
    projectedRate: [],
    resets: rec.resets,
    poolEmptyAtMs: null,
    firstEmpty: null,
    nextReset: null,
    horizonEndMs: weeklyHorizon,
    accounts: combinedAccounts,
  };
  const combined = withProjection(combinedBase, times, views.combined, {
    now,
    horizonEndMs: weeklyHorizon,
    burnPerHour: burn === null ? null : burn * k,
    // A locked-out account is back when the projection first refills it,
    // whichever limit was binding; otherwise its next 5-hour window.
    nextResetOf: (key) => nextFive(key) ?? nextWeekly(key),
    beforeResetOnly: false,
    resetFromRecovery: true,
  });

  return { weekly, fiveHour, combined, ratio };
}

/**
 * How many full 5-hour windows the remaining weekly limit still buys, in
 * windows of the biggest plan. The rough "how much is left this week" figure.
 */
export function fiveHourWindowsLeft(models: LinkedPoolModels): number | null {
  const weekly = models.weekly.current;
  return weekly === null ? null : (weekly * models.ratio.value) / 100;
}
