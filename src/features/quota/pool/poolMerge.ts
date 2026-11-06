/**
 * Every provider's pool added into one, for the "all providers" card.
 *
 * Each provider's pool is already in plan units (its biggest plan = 100%), so
 * the sum reads as "how many full plans' worth is left" across Claude and
 * Codex together. The merged model's "accounts" are the providers themselves,
 * so the breakdown bands and tooltip show one band per provider.
 */

import type {
  PoolAccountProjection,
  PoolLimitEvent,
  PoolModel,
  PoolResetEvent,
  SeriesPoint,
} from './poolModel';

const EMPTY_EPSILON = 0.5;

export interface PoolMergePart {
  key: string;
  label: string;
  model: PoolModel;
}

/** No recorded value before the first observation; hold the last value afterward. */
function heldValueAt(series: SeriesPoint[], t: number): number {
  if (series.length === 0 || t < series[0].t) return 0;
  if (t === series[0].t) return series[0].v;
  const last = series[series.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (b.t === a.t) return b.v;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}

function unionTimes(seriesList: SeriesPoint[][]) {
  const set = new Set<number>();
  for (const series of seriesList) for (const p of series) set.add(p.t);
  const earliest = Math.min(...set);
  for (const series of seriesList) {
    if (series.length && series[0].t > earliest) set.add(series[0].t - 1);
  }
  return [...set].sort((a, b) => a - b);
}

function sumSeries(seriesList: SeriesPoint[][]): SeriesPoint[] {
  const present = seriesList.filter((s) => s.length > 0);
  if (present.length === 0) return [];
  const times = unionTimes(present);
  return times.map((t) => ({ t, v: present.reduce((sum, s) => sum + heldValueAt(s, t), 0) }));
}

const sumNullable = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;

export function mergePoolModels(parts: PoolMergePart[], now: number): PoolModel {
  const models = parts.map((p) => p.model);
  const recordedParts = models.map((m) =>
    m.recorded.length || m.current === null ? m.recorded : [{ t: now, v: m.current }]
  );
  const recorded = sumSeries(recordedParts);
  const projected = sumSeries(models.map((m) => m.projected));
  const recordedByAccount: Record<string, number[]> = {};
  const projectedByAccount: Record<string, number[]> = {};
  for (const [index, part] of parts.entries()) {
    recordedByAccount[part.key] = recorded.map((p) => heldValueAt(recordedParts[index], p.t));
    projectedByAccount[part.key] = projected.map((p) => heldValueAt(part.model.projected, p.t));
  }
  const horizonEndMs = Math.max(now, ...models.map((m) => m.horizonEndMs));

  let poolEmptyAtMs: number | null = null;
  for (const p of projected) {
    if (p.t > horizonEndMs) break;
    if (p.v <= EMPTY_EPSILON) {
      poolEmptyAtMs = p.t;
      break;
    }
  }

  const firstEmpty =
    models
      .map((m) => m.firstEmpty)
      .filter((f): f is NonNullable<PoolModel['firstEmpty']> => f !== null)
      .sort((a, b) => a.t - b.t)[0] ?? null;

  const resetsByTime = new Map<string, PoolResetEvent>();
  for (const reset of models.flatMap((m) => m.resets)) {
    const key = `${reset.t}-${reset.projected}`;
    const previous = resetsByTime.get(key);
    resetsByTime.set(
      key,
      previous
        ? {
            ...previous,
            delta: previous.delta + reset.delta,
            labels: [...new Set([...previous.labels, ...reset.labels])],
          }
        : { ...reset, labels: [...reset.labels] }
    );
  }
  const resets = [...resetsByTime.values()].sort((a, b) => a.t - b.t);
  const nextReset = resets.find((r) => r.projected && r.t > now && r.t <= horizonEndMs) ?? null;
  // Each provider's accounts keep their own names, so the chart can still say whose limit it is.
  const eventsByTime = new Map<string, PoolLimitEvent>();
  for (const event of models.flatMap((m) => m.limitEvents)) {
    const key = `${event.kind}-${event.t}`;
    const previous = eventsByTime.get(key);
    eventsByTime.set(key, {
      ...event,
      labels: [...new Set([...(previous?.labels ?? []), ...event.labels])],
    });
  }
  const limitEvents = [...eventsByTime.values()].sort((a, b) => a.t - b.t);

  const accounts: PoolAccountProjection[] = parts.map((part) => ({
    key: part.key,
    label: part.label,
    share: part.model.capacity,
    emptyAtMs: part.model.poolEmptyAtMs,
    nextResetMs: part.model.nextReset?.t ?? null,
  }));

  return {
    capacity: models.reduce((sum, m) => sum + m.capacity, 0),
    accountCount: models.reduce((sum, m) => sum + m.accountCount, 0),
    current: sumNullable(models.map((m) => m.current)),
    burnPerHour: sumNullable(models.map((m) => m.burnPerHour)),
    burnWindowHours: models[0]?.burnWindowHours ?? 0,
    recorded,
    projected,
    recordedByAccount,
    projectedByAccount,
    recordedRate: sumSeries(models.map((m) => m.recordedRate)),
    projectedRate: sumSeries(models.map((m) => m.projectedRate)),
    resets,
    limitEvents,
    poolEmptyAtMs,
    firstEmpty,
    nextReset,
    horizonEndMs,
    accounts,
  };
}
