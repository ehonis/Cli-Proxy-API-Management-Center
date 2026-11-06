import { describe, expect, test } from 'bun:test';
import {
  FIVE_HOUR_MS,
  HOUR_MS,
  poolViewRange,
  WEEK_MS,
  type PoolAccountInput,
  type PoolModel,
  type SeriesPoint,
} from '../src/features/quota/pool/poolModel';
import {
  buildLinkedPoolModels,
  DEFAULT_FIVE_PER_WEEKLY,
  estimateFivePerWeekly,
  fiveHourWindowsLeft,
} from '../src/features/quota/pool/poolLinked';
import { mergePoolModels } from '../src/features/quota/pool/poolMerge';
import {
  autoRefreshMs,
  isPollDue,
  keepsPreviousReading,
  mergeQueued,
  oldestReading,
} from '../src/features/quota/hooks/autoRefresh';

const NOW = Date.UTC(2026, 10, 3, 18, 0, 0);

const options = {
  now: NOW,
  burnWindowHours: 3,
  futureFactor: 1,
  recordedFromMs: NOW - 24 * HOUR_MS,
  projectToMs: NOW + 10 * 24 * HOUR_MS,
};

/** One account's weekly and 5-hour inputs, drained linearly over the last two hours. */
function pair(opts: {
  key?: string;
  weekly: number;
  five: number;
  weeklyDrop: number;
  fiveDrop: number;
  weeklyResetMs?: number;
  fiveResetMs?: number;
  size?: number;
}) {
  const key = opts.key ?? 'a';
  const weeklyReset = opts.weeklyResetMs ?? NOW + 72 * HOUR_MS;
  const fiveReset = opts.fiveResetMs ?? NOW + 3 * HOUR_MS;
  const weekly: PoolAccountInput = {
    key,
    label: key,
    remaining: opts.weekly,
    resetAtMs: weeklyReset,
    periodMs: WEEK_MS,
    observedAtMs: NOW,
    size: opts.size,
    samples: [
      { t: NOW - 2 * HOUR_MS, remaining: opts.weekly + opts.weeklyDrop, resetAtMs: weeklyReset },
    ],
  };
  const five: PoolAccountInput = {
    key,
    label: key,
    remaining: opts.five,
    resetAtMs: fiveReset,
    periodMs: FIVE_HOUR_MS,
    observedAtMs: NOW,
    size: opts.size,
    samples: [{ t: NOW - 2 * HOUR_MS, remaining: opts.five + opts.fiveDrop, resetAtMs: fiveReset }],
  };
  return { weekly, five };
}

const at = (series: SeriesPoint[], t: number) => {
  let best = series[0];
  for (const p of series) if (p.t <= t) best = p;
  return best.v;
};

describe('weekly / 5-hour exchange rate', () => {
  test('is measured from history when both limits drained', () => {
    const { weekly, five } = pair({ weekly: 50, five: 40, weeklyDrop: 4, fiveDrop: 32 });
    const ratio = estimateFivePerWeekly([weekly], [five], NOW);
    expect(ratio.source).toBe('history');
    expect(ratio.value).toBeCloseTo(8, 1);
  });

  test('falls back to the assumed rate when history is thin', () => {
    const { weekly, five } = pair({ weekly: 50, five: 40, weeklyDrop: 1, fiveDrop: 2 });
    expect(estimateFivePerWeekly([weekly], [five], NOW)).toEqual({
      value: DEFAULT_FIVE_PER_WEEKLY,
      source: 'assumed',
    });
  });
});

describe('linked projection', () => {
  test('weekly-exhausted seats contribute no usable 5-hour history or current capacity', () => {
    const locked = pair({ key: 'locked', weekly: 0, five: 100, weeklyDrop: 0, fiveDrop: 0 });
    const ready = pair({ key: 'ready', weekly: 60, five: 22, weeklyDrop: 0, fiveDrop: 12 });
    const model = buildLinkedPoolModels(
      [locked.weekly, ready.weekly],
      [locked.five, ready.five],
      options
    ).fiveHour;
    expect(model.current).toBe(22);
    expect(model.recorded.at(-1)?.v).toBe(model.projected[0].v);
    expect(model.recordedByAccount.locked.every((v) => v === 0)).toBe(true);
    expect(model.recorded.at(0)?.v).toBe(34);
    expect(model.accounts.find((a) => a.key === 'locked')?.nextResetMs).toBe(
      locked.weekly.resetAtMs
    );
  });

  test('gates historical capacity at the weekly limit without treating the lockout as burn', () => {
    const { weekly, five } = pair({ weekly: 0, five: 80, weeklyDrop: 10, fiveDrop: 10 });
    weekly.samples.push({ t: NOW - HOUR_MS, remaining: 0, resetAtMs: weekly.resetAtMs });
    const model = buildLinkedPoolModels([weekly], [five], options).fiveHour;
    expect(at(model.recorded, NOW - 2 * HOUR_MS)).toBe(90);
    expect(at(model.recorded, NOW - HOUR_MS)).toBe(0);
    expect(model.current).toBe(0);
    expect(model.burnPerHour).toBeCloseTo(5);
    expect(model.resets.filter((r) => !r.projected)).toHaveLength(0);
  });

  test('a weekly reset restores historical 5-hour capacity only after it happens', () => {
    const reset = NOW - HOUR_MS;
    const { weekly, five } = pair({ weekly: 90, five: 80, weeklyDrop: 0, fiveDrop: 0 });
    weekly.samples = [{ t: NOW - 2 * HOUR_MS, remaining: 0, resetAtMs: reset }];
    const model = buildLinkedPoolModels([weekly], [five], options).fiveHour;
    expect(at(model.recorded, NOW - 2 * HOUR_MS)).toBe(0);
    expect(at(model.recorded, reset - 5 * 60_000)).toBe(0);
    expect(at(model.recorded, reset)).toBe(80);
    expect(model.current).toBe(80);
    expect(model.resets.find((r) => !r.projected)?.delta).toBe(80);
  });

  test('gating preserves plan weights and accounts with no weekly window', () => {
    const small = pair({ key: 'small', weekly: 0, five: 100, weeklyDrop: 0, fiveDrop: 0, size: 1 });
    const big = pair({ key: 'big', weekly: 50, five: 40, weeklyDrop: 0, fiveDrop: 0, size: 5 });
    const model = buildLinkedPoolModels([small.weekly], [small.five, big.five], options).fiveHour;
    expect(model.capacity).toBe(120);
    expect(model.current).toBe(40);
    expect(model.recorded.at(-1)?.v).toBe(model.projected[0].v);
  });

  test('a run-dry weekly limit locks the 5-hour view out past its own reset', () => {
    // 2 weekly %/h (16 five %/h at a rate of 8): weekly 5% lasts 2.5h.
    const { weekly, five } = pair({ weekly: 5, five: 52, weeklyDrop: 4, fiveDrop: 32 });
    const {
      weekly: w,
      fiveHour: f,
      combined: c,
      ratio,
    } = buildLinkedPoolModels([weekly], [five], options);
    expect(ratio.value).toBeCloseTo(8, 1);
    expect(w.poolEmptyAtMs).not.toBeNull();
    expect(w.poolEmptyAtMs! - NOW).toBeGreaterThanOrEqual(2.2 * HOUR_MS);
    expect(w.poolEmptyAtMs! - NOW).toBeLessThanOrEqual(2.6 * HOUR_MS);
    // The 5-hour window refills at +3h, but the weekly limit is out by then.
    expect(at(f.projected, NOW + 4 * HOUR_MS)).toBe(0);
    expect(at(c.projected, NOW + 4 * HOUR_MS)).toBe(0);
    // Before then the combined view is capped by what is left of the week.
    expect(at(c.projected, NOW + HOUR_MS)).toBeCloseTo(24, 0);
    // Back after the weekly reset.
    expect(at(c.projected, NOW + 73 * HOUR_MS)).toBeGreaterThan(0);
    expect(c.firstEmpty?.key).toBe('a');
  });

  test('an empty 5-hour window pauses the weekly drain until it refills', () => {
    const { weekly, five } = pair({ weekly: 80, five: 10, weeklyDrop: 4, fiveDrop: 32 });
    const { weekly: w, fiveHour: f } = buildLinkedPoolModels([weekly], [five], options);
    // 10% of the 5-hour window is 1.25% of the week; then nothing until +3h.
    expect(at(w.projected, NOW + 2 * HOUR_MS)).toBeCloseTo(78.75, 1);
    expect(at(f.projected, NOW + 2 * HOUR_MS)).toBe(0);
    expect(at(f.projected, NOW + 3 * HOUR_MS + 10 * 60_000)).toBeGreaterThan(90);
  });

  test('weekly views carry the weekly horizon, 5-hour views two days', () => {
    const { weekly, five } = pair({ weekly: 80, five: 80, weeklyDrop: 0, fiveDrop: 0 });
    const linked = buildLinkedPoolModels([weekly], [five], options);
    expect(linked.weekly.horizonEndMs - NOW).toBe(14 * 24 * HOUR_MS);
    expect(linked.fiveHour.horizonEndMs - NOW).toBe(2 * 24 * HOUR_MS);
    expect(linked.combined.horizonEndMs - NOW).toBe(14 * 24 * HOUR_MS);
    expect(linked.combined.capacity).toBe(100);
    // With an assumed rate of 8, 80% of the week is 6.4 full 5-hour windows.
    expect(fiveHourWindowsLeft(linked)).toBeCloseTo(6.4, 5);
  });

  test('with thin history the measured 5-hour burn still drives the projection', () => {
    // Weekly has not ticked yet; the 5-hour window fell 30 points in two hours.
    const { weekly, five } = pair({ weekly: 90, five: 50, weeklyDrop: 0, fiveDrop: 30 });
    const { fiveHour, ratio } = buildLinkedPoolModels([weekly], [five], options);
    expect(ratio.source).toBe('assumed');
    expect(fiveHour.burnPerHour).toBeCloseTo(15, 0);
    expect(at(fiveHour.projected, NOW + HOUR_MS)).toBeCloseTo(35, 0);
  });

  test('a locked-out account is back at its first refill, not a later weekly reset', () => {
    // 5-hour empty now, refills in an hour; the weekly limit runs out later on.
    const { weekly, five } = pair({
      weekly: 10,
      five: 0,
      weeklyDrop: 4,
      fiveDrop: 32,
      fiveResetMs: NOW + HOUR_MS,
    });
    const { combined } = buildLinkedPoolModels([weekly], [five], options);
    const account = combined.accounts[0];
    expect(account.emptyAtMs).toBe(NOW);
    expect(account.nextResetMs).not.toBeNull();
    expect(account.nextResetMs! - NOW).toBeGreaterThanOrEqual(HOUR_MS);
    expect(account.nextResetMs! - NOW).toBeLessThanOrEqual(HOUR_MS + 5 * 60_000);
  });

  test('an account with no 5-hour window is limited by its weekly only', () => {
    const { weekly } = pair({ weekly: 50, five: 0, weeklyDrop: 0, fiveDrop: 0 });
    const linked = buildLinkedPoolModels([weekly], [], options);
    expect(linked.fiveHour.accountCount).toBe(0);
    expect(linked.combined.accountCount).toBe(1);
    expect(linked.combined.current).toBe(100);
  });
});

describe('limit markers', () => {
  const kinds = (events: { kind: string }[], kind: string) => events.filter((e) => e.kind === kind);

  test('mark the weekly run-out and refill, not a 5-hour run-out the weekly one hides', () => {
    const { weekly, five } = pair({ weekly: 5, five: 52, weeklyDrop: 4, fiveDrop: 32 });
    const models = buildLinkedPoolModels([weekly], [five], options);
    const events = models.weekly.limitEvents;
    const out = kinds(events, 'weekly-out');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].t).toBe(models.weekly.poolEmptyAtMs!);
    expect(out[0].labels).toEqual(['a']);
    expect(kinds(events, 'weekly-reset')[0].t).toBe(NOW + 72 * HOUR_MS);
    // The 5-hour window still has room when the weekly limit locks the account out.
    expect(kinds(events, 'five-out').filter((e) => e.t < NOW + 72 * HOUR_MS)).toEqual([]);
    // One simulation, so every view marks the same moments.
    expect(models.fiveHour.limitEvents).toEqual(events);
    expect(models.combined.limitEvents).toEqual(events);
  });

  test('mark a 5-hour run-out once per window', () => {
    const { weekly, five } = pair({ weekly: 80, five: 10, weeklyDrop: 4, fiveDrop: 32 });
    const { weekly: w } = buildLinkedPoolModels([weekly], [five], options);
    const fiveOut = kinds(w.limitEvents, 'five-out').filter((e) => e.t < NOW + 3 * HOUR_MS);
    expect(fiveOut.length).toBe(1);
    expect(fiveOut[0].t - NOW).toBeLessThanOrEqual(HOUR_MS);
  });

  test('an account already dry at Now gets no marker for it', () => {
    const { weekly, five } = pair({ weekly: 0, five: 60, weeklyDrop: 4, fiveDrop: 32 });
    const { weekly: w } = buildLinkedPoolModels([weekly], [five], options);
    expect(kinds(w.limitEvents, 'weekly-out').filter((e) => e.t < NOW + 72 * HOUR_MS)).toEqual([]);
  });

  test('accounts running out close together share one marker', () => {
    const a = pair({ key: 'a', weekly: 1, five: 60, weeklyDrop: 4, fiveDrop: 32 });
    const b = pair({ key: 'b', weekly: 1, five: 60, weeklyDrop: 4, fiveDrop: 32 });
    const { weekly: w } = buildLinkedPoolModels([a.weekly, b.weekly], [a.five, b.five], options);
    const out = kinds(w.limitEvents, 'weekly-out').filter((e) => e.t < NOW + 72 * HOUR_MS);
    expect(out.length).toBe(1);
    expect(out[0].labels.sort()).toEqual(['a', 'b']);
  });

  test('survive the provider merge', () => {
    const { weekly, five } = pair({ weekly: 5, five: 52, weeklyDrop: 4, fiveDrop: 32 });
    const { weekly: w } = buildLinkedPoolModels([weekly], [five], options);
    const merged = mergePoolModels([{ key: 'claude', label: 'Claude', model: w }], NOW);
    expect(merged.limitEvents).toEqual(w.limitEvents);
  });
});

describe('provider merge', () => {
  const model = (capacity: number, values: number[], emptyAt: number | null): PoolModel => {
    const series = values.map((v, i) => ({ t: NOW + i * HOUR_MS, v }));
    return {
      capacity,
      accountCount: 1,
      current: values[0],
      burnPerHour: 1,
      burnWindowHours: 3,
      recorded: [],
      projected: series,
      recordedByAccount: {},
      projectedByAccount: {},
      recordedRate: [],
      projectedRate: [],
      resets: [],
      limitEvents: [],
      poolEmptyAtMs: emptyAt,
      firstEmpty: emptyAt === null ? null : { key: 'x', label: 'x', t: emptyAt },
      nextReset: null,
      horizonEndMs: NOW + 24 * HOUR_MS,
      accounts: [],
    };
  };

  test('adds pools and reports the providers as its breakdown', () => {
    const merged = mergePoolModels(
      [
        { key: 'claude', label: 'Claude', model: model(120, [60, 0, 0], NOW + HOUR_MS) },
        { key: 'codex', label: 'Codex', model: model(200, [150, 100, 0], NOW + 2 * HOUR_MS) },
      ],
      NOW
    );
    expect(merged.capacity).toBe(320);
    expect(merged.current).toBe(210);
    expect(merged.burnPerHour).toBe(2);
    expect(merged.accounts.map((a) => [a.key, a.share])).toEqual([
      ['claude', 120],
      ['codex', 200],
    ]);
    expect(merged.projectedByAccount.codex).toEqual([150, 100, 0]);
    // Empty only when every provider is.
    expect(merged.poolEmptyAtMs).toBe(NOW + 2 * HOUR_MS);
    expect(merged.firstEmpty?.t).toBe(NOW + HOUR_MS);
  });

  test('simultaneous provider resets share a marker and sum the refill', () => {
    const a = model(100, [40, 60, 0], NOW + HOUR_MS);
    const b = model(100, [20, 50, 0], NOW + HOUR_MS);
    a.limitEvents = [{ t: NOW + HOUR_MS, kind: 'weekly-reset', labels: ['A'] }];
    b.limitEvents = [{ t: NOW + HOUR_MS, kind: 'weekly-reset', labels: ['B'] }];
    a.resets = [{ t: NOW + HOUR_MS, delta: 20, labels: ['A'], projected: true }];
    b.resets = [{ t: NOW + HOUR_MS, delta: 30, labels: ['B'], projected: true }];
    const merged = mergePoolModels(
      [
        { key: 'claude', label: 'Claude', model: a },
        { key: 'codex', label: 'Codex', model: b },
      ],
      NOW
    );
    expect(merged.limitEvents).toEqual([
      { t: NOW + HOUR_MS, kind: 'weekly-reset', labels: ['A', 'B'] },
    ]);
    expect(merged.resets).toEqual([
      { t: NOW + HOUR_MS, delta: 50, labels: ['A', 'B'], projected: true },
    ]);
    expect(merged.nextReset?.delta).toBe(50);
  });
});

describe('auto-refresh timing', () => {
  const FIVE_MIN = autoRefreshMs('5')!;

  test('is due once the oldest reading is an interval old', () => {
    expect(FIVE_MIN).toBe(5 * 60_000);
    expect(autoRefreshMs('off')).toBeNull();
    expect(isPollDue(NOW - 4 * 60_000, null, NOW, FIVE_MIN)).toBe(false);
    expect(isPollDue(NOW - 5 * 60_000, null, NOW, FIVE_MIN)).toBe(true);
  });

  test('leaves the first load to the page until something fails', () => {
    expect(isPollDue(null, null, NOW, FIVE_MIN)).toBe(false);
    expect(isPollDue(null, null, NOW, FIVE_MIN, true)).toBe(true);
    expect(isPollDue(null, NOW - 60_000, NOW, FIVE_MIN, true)).toBe(false);
  });

  test('retries a failing poll once per interval, not on every check', () => {
    // The reading stayed old because the last attempt failed a minute ago.
    expect(isPollDue(NOW - 30 * 60_000, NOW - 60_000, NOW, FIVE_MIN)).toBe(false);
    expect(isPollDue(NOW - 30 * 60_000, NOW - FIVE_MIN, NOW, FIVE_MIN)).toBe(true);
  });

  test('a full poll comes at most one check after the interval', () => {
    // Checks every 15s; each full poll lands its good readings 2s later.
    const CHECK = 15_000;
    let oldest: number | null = 0;
    let lastAttempt: number | null = null;
    const polls: number[] = [];
    for (let t = CHECK; t <= 40 * 60_000; t += CHECK) {
      if (isPollDue(oldest, lastAttempt, t, FIVE_MIN, true)) {
        lastAttempt = t;
        polls.push(t);
        oldest = t + 2_000;
      }
    }
    const gaps = polls.slice(1).map((t, i) => t - polls[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(FIVE_MIN + CHECK);
  });

  test('oldest reading ignores keys that never landed', () => {
    expect(oldestReading(['a', 'b', 'c'], { a: 30, b: 10 })).toBe(10);
    expect(oldestReading(['c'], { a: 30 })).toBeNull();
  });

  test('queued manual loads merge, and an old session queue is dropped', () => {
    const key = (t: string) => t;
    const first = mergeQueued(null, 1, ['all-a', 'all-b'], key);
    expect(mergeQueued(first, 1, ['devin', 'all-a'], key).targets).toEqual([
      'all-a',
      'all-b',
      'devin',
    ]);
    expect(mergeQueued(first, 2, ['devin'], key)).toEqual({ targets: ['devin'], generation: 2 });
  });

  test('a failed background poll keeps only a good previous reading', () => {
    expect(keepsPreviousReading(true, 'error', { status: 'success' })).toBe(true);
    expect(keepsPreviousReading(true, 'error', { status: 'error' })).toBe(false);
    expect(keepsPreviousReading(true, 'error', undefined)).toBe(false);
    expect(keepsPreviousReading(false, 'error', { status: 'success' })).toBe(false);
    expect(keepsPreviousReading(true, 'success', { status: 'success' })).toBe(false);
  });
});

describe('combined view range', () => {
  test('runs from yesterday through a week ahead, paging by weeks', () => {
    const range = poolViewRange(NOW, 0, 'combined');
    expect(range.startMs).toBeLessThanOrEqual(NOW - 24 * HOUR_MS);
    expect(range.endMs).toBeGreaterThan(NOW + 6 * 24 * HOUR_MS);
    const next = poolViewRange(NOW, 1, 'combined');
    expect(Math.round((next.startMs - range.startMs) / HOUR_MS / 24)).toBe(7);
  });
});
