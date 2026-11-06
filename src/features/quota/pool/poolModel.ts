/**
 * Pool model: every account of one provider summed into a single "remaining"
 * pool, as recorded by the server and as projected forward at the current burn
 * rate. Accounts are weighted by plan size: the biggest plan counts as 100%, so
 * a Team Premium seat (5x) plus a Pro account (1x) is a 120% pool.
 *
 * Pure and React-free, so the maths is testable without a browser. Times are
 * epoch milliseconds. Inputs are each account's own remaining percent; every
 * output is in pool percent.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/** How far the projection looks ahead of now, independent of the visible range. */
export const PROJECTION_HORIZON_MS = 14 * DAY_MS;
export const FIVE_HOUR_MS = 5 * HOUR_MS;
/** Resolution of the recorded and projected series. */
export const STEP_MS = 5 * MINUTE_MS;
/** Resets closer together than this are labelled as one jump. */
const RESET_CLUSTER_MS = 90 * MINUTE_MS;
/** Smallest jump worth a label; smaller rises are noise or rounding. */
const MIN_RESET_LABEL = 1;
const EMPTY_EPSILON = 0.5;

export type RoutingStrategy = 'soonest-reset' | 'fill-first' | 'round-robin';

/** A recorded point for one account's pooled (weekly or 5-hour) window. */
export interface PoolSamplePoint {
  t: number;
  remaining: number;
  resetAtMs: number | null;
}

export interface PoolAccountInput {
  key: string;
  label: string;
  /** Live remaining percent of the pooled window, null when not loaded. */
  remaining: number | null;
  resetAtMs: number | null;
  periodMs: number;
  /** Relative plan size (Pro = 1, Max 5x = 5); defaults to 1. */
  size?: number;
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

/** What a limit marker on the chart stands for. */
export type PoolLimitEventKind = 'weekly-out' | 'five-out' | 'weekly-reset';

/**
 * A projected moment worth a marker: an account's weekly or 5-hour limit
 * running dry, or its weekly limit refilling. Accounts that hit the same
 * kind within a short span share one event.
 */
export interface PoolLimitEvent {
  t: number;
  kind: PoolLimitEventKind;
  labels: string[];
}

export interface PoolAccountProjection {
  key: string;
  label: string;
  /** The account's full share of the pool, in pool percent (biggest plan = 100). */
  share: number;
  /** First projected moment the account runs dry before its own reset. */
  emptyAtMs: number | null;
  /** Next reset of the pooled window at or after now. */
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
  /** Projected limit run-outs and weekly refills, sorted by time. */
  limitEvents: PoolLimitEvent[];
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
  /** How far ahead the empty / next-reset stats look; defaults to two weeks. */
  horizonMs?: number;
  strategy?: RoutingStrategy;
  /** A daily block, in local time, when the projection assumes no usage at all. */
  quietHours?: QuietHours | null;
  /** Local weekdays (0 = Sunday) with no usage at all. */
  offDays?: readonly number[];
}

/** When the projection assumes the owner spends nothing. */
export interface IdleSchedule {
  quietHours?: QuietHours | null;
  offDays?: readonly number[];
}

/** Local-time hours [startHour, endHour); wraps midnight when start > end. */
export interface QuietHours {
  startHour: number;
  endHour: number;
}

/** True when t falls inside the daily quiet block, in the browser's local time. */
export function isQuietAt(t: number, quiet: QuietHours | null | undefined): boolean {
  if (!quiet || quiet.startHour === quiet.endHour) return false;
  const d = new Date(t);
  const hour = d.getHours() + d.getMinutes() / 60;
  return quiet.startHour < quiet.endHour
    ? hour >= quiet.startHour && hour < quiet.endHour
    : hour >= quiet.startHour || hour < quiet.endHour;
}

/** True on an off day or inside the nightly quiet block, in local time. */
export function isIdleAt(t: number, schedule: IdleSchedule): boolean {
  if (schedule.offDays?.includes(new Date(t).getDay())) return true;
  return isQuietAt(t, schedule.quietHours);
}

/**
 * Every idle stretch overlapping [fromMs, toMs]: whole off days plus the quiet
 * blocks, merged where they touch so a Saturday off joins Friday night's block.
 */
export function idleSpans(
  fromMs: number,
  toMs: number,
  schedule: IdleSchedule
): { startMs: number; endMs: number }[] {
  const spans = quietSpans(fromMs, toMs, schedule.quietHours);
  if (schedule.offDays?.length && toMs > fromMs) {
    const day = new Date(fromMs);
    day.setHours(0, 0, 0, 0);
    while (day.getTime() < toMs) {
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      if (schedule.offDays.includes(day.getDay())) {
        const a = Math.max(fromMs, day.getTime());
        const b = Math.min(toMs, next.getTime());
        if (b > a) spans.push({ startMs: a, endMs: b });
      }
      day.setTime(next.getTime());
    }
  }
  spans.sort((a, b) => a.startMs - b.startMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Every quiet block overlapping [fromMs, toMs], clipped to it. Built from local
 * midnights so a daylight-saving change still lands each block on the clock.
 */
export function quietSpans(
  fromMs: number,
  toMs: number,
  quiet: QuietHours | null | undefined
): { startMs: number; endMs: number }[] {
  if (!quiet || quiet.startHour === quiet.endHour || toMs <= fromMs) return [];
  const spans: { startMs: number; endMs: number }[] = [];
  const day = new Date(fromMs);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1);
  while (day.getTime() <= toMs) {
    const start = new Date(day);
    start.setHours(quiet.startHour, 0, 0, 0);
    const end = new Date(day);
    if (quiet.endHour <= quiet.startHour) end.setDate(end.getDate() + 1);
    end.setHours(quiet.endHour, 0, 0, 0);
    const a = Math.max(fromMs, start.getTime());
    const b = Math.min(toMs, end.getTime());
    if (b > a) spans.push({ startMs: a, endMs: b });
    day.setDate(day.getDate() + 1);
  }
  return spans;
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * Turn one account's samples into a continuous series: linear between samples
 * inside one window, a hold-then-jump at any reset that falls between them,
 * and an automatic jump to 100% at every reset after the last sample.
 */
export function buildAccountTrack(account: PoolAccountInput, now: number): SeriesPoint[] {
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
  const idle: IdleSchedule = { quietHours: options.quietHours, offDays: options.offDays };
  const horizonEndMs = now + (options.horizonMs ?? PROJECTION_HORIZON_MS);
  const projectEnd = Math.max(horizonEndMs, options.projectToMs);

  const accounts = inputs.filter((a) => a.remaining !== null || a.samples.length > 0);
  const sizeOf = (a: PoolAccountInput) => (a.size && a.size > 0 ? a.size : 1);
  const biggest = Math.max(1e-9, ...accounts.map(sizeOf));
  // Full share of the pool for each account, in pool percent.
  const fullOf = new Map(accounts.map((a) => [a.key, (100 * sizeOf(a)) / biggest]));
  const capacity = accounts.reduce((sum, a) => sum + (fullOf.get(a.key) ?? 100), 0);
  const tracks = new Map(
    accounts.map((a) => {
      const scale = (fullOf.get(a.key) ?? 100) / 100;
      return [a.key, buildAccountTrack(a, now).map((p) => ({ t: p.t, v: p.v * scale }))];
    })
  );
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

  // Rolling burn over the window ending at each point, divided by the time
  // the window actually covers, so the last (partial) step and the headline
  // burn figure agree exactly.
  const windowMs = burnWindowHours * HOUR_MS;
  const recordedRate: SeriesPoint[] = [];
  let rolling = 0;
  let tail = 0;
  for (let i = 0; i < recordedTimes.length; i += 1) {
    rolling += consumption[i];
    while (tail < i && recordedTimes[i] - recordedTimes[tail] > windowMs) {
      tail += 1;
      rolling -= consumption[tail];
    }
    const covered = recordedTimes[i] - recordedTimes[tail];
    recordedRate.push({
      t: recordedTimes[i],
      v: covered >= 15 * MINUTE_MS ? Math.max(0, rolling) / (covered / HOUR_MS) : 0,
    });
  }
  const lastCovered =
    recordedTimes.length > 1 ? recordedTimes[recordedTimes.length - 1] - recordedTimes[tail] : 0;
  const burnPerHour =
    lastCovered >= 15 * MINUTE_MS ? recordedRate[recordedRate.length - 1].v : null;

  /* ---------- projected ---------- */

  // Unloaded accounts still refill at their recorded reset; they just carry
  // no projected usage, since nothing says they are being used.
  const lastRecordedReset = (a: PoolAccountInput) => {
    let latest: PoolSamplePoint | null = null;
    for (const sample of a.samples) if (!latest || sample.t > latest.t) latest = sample;
    return latest?.resetAtMs ?? null;
  };
  const state = accounts.map((a) => ({
    key: a.key,
    label: a.label,
    remaining: trackValueAt(tracks.get(a.key) ?? [], now) ?? 0,
    full: fullOf.get(a.key) ?? 100,
    resetAtMs: a.remaining !== null ? a.resetAtMs : lastRecordedReset(a),
    periodMs: a.periodMs,
  }));
  for (const s of state) {
    while (s.resetAtMs !== null && s.resetAtMs <= now) s.resetAtMs += s.periodMs;
  }

  const rate = (burnPerHour ?? 0) * Math.max(0, futureFactor);
  const projectedTimes: number[] = [now];
  for (let t = alignDown(now, STEP_MS) + STEP_MS; t <= projectEnd; t += STEP_MS) {
    projectedTimes.push(t);
  }

  const projectedByAccount: Record<string, number[]> = {};
  for (const a of accounts) projectedByAccount[a.key] = [];
  const projectedRates: number[] = [];
  const projectedRises: { t: number; delta: number; label: string }[] = [];
  const nextResetByKey = new Map(state.map((s) => [s.key, s.resetAtMs]));
  let poolEmptyAtMs: number | null = null;
  let firstEmpty: PoolModel['firstEmpty'] = null;

  const order = () => {
    // Every account with a known level is routable: the burn was measured
    // across all of them, so it has to be spent across all of them too.
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
    let consumed: number;
    if (i > 0) {
      const dtHours = (t - projectedTimes[i - 1]) / HOUR_MS;
      // Nothing is spent while the owner is idle; the burn resumes after.
      const wanted = isIdleAt((t + projectedTimes[i - 1]) / 2, idle) ? 0 : rate * dtHours;
      let need = wanted;
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
      consumed = (wanted - Math.max(0, need)) / dtHours;
      for (const s of state) {
        while (s.resetAtMs !== null && s.resetAtMs <= t) {
          const delta = s.full - s.remaining;
          if (delta > 0) projectedRises.push({ t: s.resetAtMs, delta, label: s.label });
          s.remaining = s.full;
          s.resetAtMs += s.periodMs;
        }
      }
    } else {
      // Start the dashed line at the measured burn; any Future-usage factor
      // shows as a step right after Now.
      consumed = burnPerHour ?? 0;
    }
    // Checked from the first step, so an account already at zero reads as
    // empty now rather than "in five minutes".
    // Only a run-dry before that account's own next reset counts; one in a
    // later cycle is a projection artefact, not a warning for now.
    if (!firstEmpty && t <= horizonEndMs) {
      const dry = state.find((s) => {
        const reset = nextResetByKey.get(s.key);
        return s.remaining <= EMPTY_EPSILON && (reset === null || reset === undefined || t < reset);
      });
      if (dry) firstEmpty = { key: dry.key, label: dry.label, t };
    }
    let total = 0;
    for (const s of state) {
      projectedByAccount[s.key].push(s.remaining);
      total += s.remaining;
    }
    projectedRates.push(total <= EMPTY_EPSILON ? 0 : consumed);
    if (poolEmptyAtMs === null && total <= EMPTY_EPSILON && t <= horizonEndMs) {
      poolEmptyAtMs = t;
    }
  }

  const projected = projectedTimes.map((t, i) => ({
    t,
    v: accounts.reduce((sum, a) => sum + (projectedByAccount[a.key][i] ?? 0), 0),
  }));
  const projectedRate = projectedTimes.map((t, i) => ({ t, v: projectedRates[i] }));

  const resets = [...clusterResets(recordedRises, false), ...clusterResets(projectedRises, true)];
  const nextReset = resets.find((r) => r.projected && r.t > now && r.t <= horizonEndMs) ?? null;

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
    limitEvents: [],
    poolEmptyAtMs,
    firstEmpty,
    nextReset,
    horizonEndMs,
    accounts: accounts.map((a) => ({
      key: a.key,
      label: a.label,
      share: fullOf.get(a.key) ?? 100,
      emptyAtMs: projectedEmptyFor(projectedTimes, projectedByAccount[a.key], horizonEndMs),
      nextResetMs: nextResetByKey.get(a.key) ?? null,
    })),
  };
}

/** First projected time an account sits at zero (now, if it already does), within the horizon. */
function projectedEmptyFor(times: number[], values: number[] | undefined, horizonEndMs: number) {
  if (!values) return null;
  for (let i = 0; i < values.length && times[i] <= horizonEndMs; i += 1) {
    if (values[i] <= EMPTY_EPSILON) return times[i];
  }
  return null;
}

/**
 * Visible range. Weekly: three days back to ten ahead, a week per step.
 * 5-hour: twelve hours back to a day and a half ahead, a day per step.
 * Combined: a day back to a week ahead, a week per step, so every 5-hour
 * window still reads as its own tooth.
 */
export function poolViewRange(
  now: number,
  offset: number,
  window: 'weekly' | 'five-hour' | 'combined' = 'weekly'
) {
  if (window === 'five-hour') {
    const startMs = Math.floor(now / HOUR_MS) * HOUR_MS - 12 * HOUR_MS + offset * DAY_MS;
    return { startMs, endMs: startMs + 2 * DAY_MS };
  }
  if (window === 'combined') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1 + offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 8);
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  const offsetWeeks = offset;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 3 + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 14);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
