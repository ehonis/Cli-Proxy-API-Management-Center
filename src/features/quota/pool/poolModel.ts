/**
 * Pool model: every account of one provider summed into a single "remaining"
 * pool (6 accounts = 600%), as recorded by the server and as projected forward
 * at the current burn rate.
 *
 * Pure and React-free, so the maths is testable without a browser. Times are
 * epoch milliseconds, values are remaining percent (100 = untouched account).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** How far the projection looks ahead of now, independent of the visible range. */
export const PROJECTION_HORIZON_MS = 14 * DAY_MS;
/** Resolution of the recorded and projected series. */
export const STEP_MS = 5 * MINUTE_MS;
/** Resets closer together than this are labelled as one jump. */
const RESET_CLUSTER_MS = 90 * MINUTE_MS;
/** Smallest jump worth a label; smaller rises are noise or rounding. */
const MIN_RESET_LABEL = 1;
const EMPTY_EPSILON = 0.5;

export type RoutingStrategy = 'soonest-reset' | 'fill-first' | 'round-robin';

/** A recorded point for one account's governing (weekly) window. */
export interface PoolSamplePoint {
  t: number;
  remaining: number;
  resetAtMs: number | null;
}

export interface PoolAccountInput {
  key: string;
  label: string;
  /** Live remaining percent of the weekly window, null when not loaded. */
  remaining: number | null;
  resetAtMs: number | null;
  periodMs: number;
  /** When the live value was fetched; defaults to now. */
  observedAtMs?: number | null;
  /** Server-recorded history for this account, any order. */
  samples: PoolSamplePoint[];
}

export interface SeriesPoint {
  t: number;
  v: number;
}

export interface PoolResetEvent {
  t: number;
  /** Total pool rise in percentage points, summed over the cluster. */
  delta: number;
  labels: string[];
  projected: boolean;
}

export interface PoolAccountProjection {
  key: string;
  label: string;
  /** First projected moment the account runs dry before its own reset. */
  emptyAtMs: number | null;
  /** Next weekly reset at or after now. */
  nextResetMs: number | null;
}

export interface PoolModel {
  capacity: number;
  accountCount: number;
  current: number | null;
  /** Pool %/h burned over the chosen window, null when history is too thin. */
  burnPerHour: number | null;
  burnWindowHours: number;
  recorded: SeriesPoint[];
  projected: SeriesPoint[];
  /** Per-account stacks, aligned to `recorded` / `projected` timestamps. */
  recordedByAccount: Record<string, number[]>;
  projectedByAccount: Record<string, number[]>;
  /** %/h series for the drain-rate view. */
  recordedRate: SeriesPoint[];
  projectedRate: SeriesPoint[];
  resets: PoolResetEvent[];
  poolEmptyAtMs: number | null;
  firstEmpty: { key: string; label: string; t: number } | null;
  nextReset: PoolResetEvent | null;
  horizonEndMs: number;
  accounts: PoolAccountProjection[];
}

export interface PoolModelOptions {
  now: number;
  /** Lookback for the burn rate, in hours. */
  burnWindowHours: number;
  /** Multiplier applied to the burn rate for the projection (1 = same as now). */
  futureFactor: number;
  /** Earliest recorded time worth building (usually the visible range start). */
  recordedFromMs: number;
  /** Projection is built at least this far, and never shorter than the horizon. */
  projectToMs: number;
  strategy?: RoutingStrategy;
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * Turn one account's samples into a continuous series: linear between samples
 * inside one window, a hold-then-jump at any reset that falls between them,
 * and an automatic jump to 100% at every reset after the last sample.
 */
export function buildAccountTrack(
  account: PoolAccountInput,
  now: number
): SeriesPoint[] {
  const points: PoolSamplePoint[] = account.samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.remaining) && s.t <= now)
    .map((s) => ({ ...s, remaining: clamp(s.remaining) }));
  if (account.remaining !== null) {
    const t = Math.min(now, account.observedAtMs ?? now);
    points.push({ t, remaining: clamp(account.remaining), resetAtMs: account.resetAtMs });
  }
  points.sort((a, b) => a.t - b.t);
  if (points.length === 0) return [];

  const track: SeriesPoint[] = [];
  const pushResetsUntil = (from: PoolSamplePoint, untilMs: number) => {
    let reset = from.resetAtMs;
    let held = from.remaining;
    while (reset !== null && reset > from.t && reset <= untilMs) {
      track.push({ t: reset, v: held });
      track.push({ t: reset, v: 100 });
      held = 100;
      reset += account.periodMs;
    }
    return held;
  };

  track.push({ t: points[0].t, v: points[0].remaining });
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    pushResetsUntil(prev, next.t);
    track.push({ t: next.t, v: next.remaining });
  }
  const last = points[points.length - 1];
  const held = pushResetsUntil(last, now);
  track.push({ t: now, v: held });
  return track;
}

/** Value of a track at t: linear inside a segment, latest value on a jump. */
export function trackValueAt(track: SeriesPoint[], t: number): number | null {
  if (track.length === 0) return null;
  if (t <= track[0].t) return track[0].v;
  let lo = 0;
  let hi = track.length - 1;
  if (t >= track[hi].t) return track[hi].v;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  // Several points can share lo's timestamp (a reset jump); take the last.
  while (lo + 1 < track.length && track[lo + 1].t === track[lo].t) lo += 1;
  const a = track[lo];
  const b = track[lo + 1];
  if (!b || b.t === a.t) return a.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

const alignDown = (t: number, step: number) => Math.floor(t / step) * step;

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

export function buildPoolModel(inputs: PoolAccountInput[], options: PoolModelOptions): PoolModel {
  const { now, burnWindowHours, futureFactor, strategy = 'soonest-reset' } = options;
  const horizonEndMs = now + PROJECTION_HORIZON_MS;
  const projectEnd = Math.max(horizonEndMs, options.projectToMs);

  const accounts = inputs.filter((a) => a.remaining !== null || a.samples.length > 0);
  const capacity = accounts.length * 100;
  const tracks = new Map(accounts.map((a) => [a.key, buildAccountTrack(a, now)]));
  const live = accounts.filter((a) => a.remaining !== null);
  const current = accounts.length
    ? accounts.reduce((sum, a) => sum + (trackValueAt(tracks.get(a.key) ?? [], now) ?? 0), 0)
    : null;

  /* ---------- recorded ---------- */

  const firstSample = Math.min(
    ...accounts.map((a) => tracks.get(a.key)?.[0]?.t ?? Number.POSITIVE_INFINITY)
  );
  const recordedStart = Math.max(
    alignDown(options.recordedFromMs - burnWindowHours * HOUR_MS, STEP_MS),
    Number.isFinite(firstSample) ? alignDown(firstSample, STEP_MS) : now
  );

  const recordedTimes: number[] = [];
  for (let t = recordedStart; t < now; t += STEP_MS) recordedTimes.push(t);
  recordedTimes.push(now);

  const recordedByAccount: Record<string, number[]> = {};
  const consumption: number[] = recordedTimes.map(() => 0);
  const recordedRises: { t: number; delta: number; label: string }[] = [];
  for (const account of accounts) {
    const track = tracks.get(account.key) ?? [];
    const values = recordedTimes.map((t) => trackValueAt(track, t) ?? 0);
    recordedByAccount[account.key] = values;
    for (let i = 1; i < values.length; i += 1) {
      const drop = values[i - 1] - values[i];
      if (drop > 0) consumption[i] += drop;
    }
    // Rises come from the track itself so a reset lands on its real instant.
    for (let i = 1; i < track.length; i += 1) {
      const rise = track[i].v - track[i - 1].v;
      if (rise > 0 && track[i].t >= recordedStart && track[i].t <= now) {
        recordedRises.push({ t: track[i].t, delta: rise, label: account.label });
      }
    }
  }
  const recorded = recordedTimes.map((t, i) => ({
    t,
    v: accounts.reduce((sum, a) => sum + recordedByAccount[a.key][i], 0),
  }));

  // Rolling burn: consumption summed over the window ending at each point.
  const windowSteps = Math.max(1, Math.round((burnWindowHours * HOUR_MS) / STEP_MS));
  const recordedRate: SeriesPoint[] = [];
  let rolling = 0;
  for (let i = 0; i < recordedTimes.length; i += 1) {
    rolling += consumption[i];
    if (i - windowSteps >= 0) rolling -= consumption[i - windowSteps];
    const covered = Math.min(i, windowSteps) * STEP_MS;
    recordedRate.push({
      t: recordedTimes[i],
      v: covered >= 15 * MINUTE_MS ? Math.max(0, rolling) / (covered / HOUR_MS) : 0,
    });
  }

  const burnFrom = now - burnWindowHours * HOUR_MS;
  let burned = 0;
  let coveredMs = 0;
  for (let i = 1; i < recordedTimes.length; i += 1) {
    if (recordedTimes[i] <= burnFrom) continue;
    burned += consumption[i];
    coveredMs += recordedTimes[i] - recordedTimes[i - 1];
  }
  const burnPerHour = coveredMs >= 15 * MINUTE_MS ? burned / (coveredMs / HOUR_MS) : null;

  /* ---------- projected ---------- */

  const state = live.map((a) => ({
    key: a.key,
    label: a.label,
    remaining: trackValueAt(tracks.get(a.key) ?? [], now) ?? 0,
    resetAtMs: a.resetAtMs,
    periodMs: a.periodMs,
  }));
  for (const s of state) {
    while (s.resetAtMs !== null && s.resetAtMs <= now) s.resetAtMs += s.periodMs;
  }
  const stale = accounts.filter((a) => a.remaining === null);
  const staleValues = new Map(
    stale.map((a) => [a.key, trackValueAt(tracks.get(a.key) ?? [], now) ?? 0])
  );

  const rate = (burnPerHour ?? 0) * Math.max(0, futureFactor);
  const projectedTimes: number[] = [now];
  for (let t = alignDown(now, STEP_MS) + STEP_MS; t <= projectEnd; t += STEP_MS) {
    projectedTimes.push(t);
  }

  const projectedByAccount: Record<string, number[]> = {};
  for (const a of accounts) projectedByAccount[a.key] = [];
  const projectedRises: { t: number; delta: number; label: string }[] = [];
  const emptyAt = new Map<string, number>();
  const nextResetByKey = new Map(state.map((s) => [s.key, s.resetAtMs]));
  let poolEmptyAtMs: number | null = null;
  let firstEmpty: PoolModel['firstEmpty'] = null;

  const order = () => {
    const active = state.filter((s) => s.remaining > EMPTY_EPSILON);
    if (strategy === 'soonest-reset') {
      active.sort(
        (a, b) =>
          (a.resetAtMs ?? Number.POSITIVE_INFINITY) - (b.resetAtMs ?? Number.POSITIVE_INFINITY) ||
          a.key.localeCompare(b.key)
      );
    } else if (strategy === 'fill-first') {
      active.sort((a, b) => a.key.localeCompare(b.key));
    }
    return active;
  };

  for (let i = 0; i < projectedTimes.length; i += 1) {
    const t = projectedTimes[i];
    if (i > 0) {
      const dtHours = (t - projectedTimes[i - 1]) / HOUR_MS;
      let need = rate * dtHours;
      if (need > 0) {
        const active = order();
        if (strategy === 'round-robin' && active.length > 0) {
          // Spread evenly; whatever an empty account cannot cover rolls on.
          let pool = active;
          while (need > 1e-9 && pool.length > 0) {
            const share = need / pool.length;
            need = 0;
            for (const s of pool) {
              const take = Math.min(share, s.remaining);
              s.remaining -= take;
              need += share - take;
            }
            pool = pool.filter((s) => s.remaining > 1e-9);
          }
        } else {
          for (const s of active) {
            const take = Math.min(need, s.remaining);
            s.remaining -= take;
            need -= take;
            if (need <= 1e-9) break;
          }
        }
      }
      for (const s of state) {
        if (s.remaining <= EMPTY_EPSILON && !emptyAt.has(s.key)) {
          emptyAt.set(s.key, t);
          if (!firstEmpty) firstEmpty = { key: s.key, label: s.label, t };
        }
        while (s.resetAtMs !== null && s.resetAtMs <= t) {
          const delta = 100 - s.remaining;
          if (delta > 0) projectedRises.push({ t: s.resetAtMs, delta, label: s.label });
          s.remaining = 100;
          s.resetAtMs += s.periodMs;
          emptyAt.delete(s.key);
        }
      }
    }
    let total = 0;
    for (const s of state) {
      projectedByAccount[s.key].push(s.remaining);
      total += s.remaining;
    }
    for (const a of stale) {
      const v = staleValues.get(a.key) ?? 0;
      projectedByAccount[a.key].push(v);
      total += v;
    }
    if (i > 0 && poolEmptyAtMs === null && total <= EMPTY_EPSILON && t <= horizonEndMs) {
      poolEmptyAtMs = t;
    }
  }

  const projected = projectedTimes.map((t, i) => ({
    t,
    v: accounts.reduce((sum, a) => sum + (projectedByAccount[a.key][i] ?? 0), 0),
  }));
  const projectedRate = [
    { t: now, v: rate },
    { t: projectEnd, v: rate },
  ];

  const resets = [
    ...clusterResets(recordedRises, false),
    ...clusterResets(projectedRises, true),
  ];
  const nextReset = resets.find((r) => r.projected && r.t > now) ?? null;

  // An account "runs dry" only if that happens before its own next reset.
  const firstEmptyBeforeReset =
    firstEmpty && firstEmpty.t <= horizonEndMs ? firstEmpty : null;

  return {
    capacity,
    accountCount: accounts.length,
    current,
    burnPerHour,
    burnWindowHours,
    recorded: recorded.length > 1 ? recorded : [],
    projected,
    recordedByAccount,
    projectedByAccount,
    recordedRate,
    projectedRate,
    resets,
    poolEmptyAtMs,
    firstEmpty: firstEmptyBeforeReset,
    nextReset,
    horizonEndMs,
    accounts: accounts.map((a) => ({
      key: a.key,
      label: a.label,
      emptyAtMs: projectedEmptyFor(projectedTimes, projectedByAccount[a.key]),
      nextResetMs: nextResetByKey.get(a.key) ?? null,
    })),
  };
}

/** First projected time an account sits at zero, within the horizon. */
function projectedEmptyFor(times: number[], values: number[] | undefined) {
  if (!values) return null;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= EMPTY_EPSILON && values[i - 1] > EMPTY_EPSILON) return times[i];
  }
  return null;
}

/** Visible range: three days back to ten ahead, shifted a week per step. */
export function poolViewRange(now: number, offsetWeeks: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 3 + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 14);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
