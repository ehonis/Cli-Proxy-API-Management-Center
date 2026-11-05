import { describe, expect, test } from 'bun:test';
import {
  buildAccountTrack,
  buildPoolModel,
  HOUR_MS,
  poolViewRange,
  trackValueAt,
  WEEK_MS,
  type PoolAccountInput,
} from '../src/features/quota/pool/poolModel';

const NOW = Date.UTC(2026, 10, 3, 18, 0, 0);

const account = (overrides: Partial<PoolAccountInput>): PoolAccountInput => ({
  key: 'a',
  label: 'a',
  remaining: 100,
  resetAtMs: NOW + 72 * HOUR_MS,
  periodMs: WEEK_MS,
  observedAtMs: NOW,
  samples: [],
  ...overrides,
});

const options = {
  now: NOW,
  burnWindowHours: 3,
  futureFactor: 1,
  recordedFromMs: NOW - 72 * HOUR_MS,
  projectToMs: NOW + 10 * 24 * HOUR_MS,
};

describe('account track', () => {
  test('interpolates between samples and jumps to 100% at a reset in between', () => {
    const reset = NOW - 10 * HOUR_MS;
    const track = buildAccountTrack(
      account({
        remaining: 90,
        resetAtMs: reset + WEEK_MS,
        samples: [
          { t: NOW - 20 * HOUR_MS, remaining: 40, resetAtMs: reset },
          { t: NOW - 12 * HOUR_MS, remaining: 30, resetAtMs: reset },
        ],
      }),
      NOW
    );
    expect(trackValueAt(track, NOW - 16 * HOUR_MS)).toBeCloseTo(35, 5);
    // Held until the reset, then refilled.
    expect(trackValueAt(track, reset - 1)).toBeCloseTo(30, 5);
    expect(trackValueAt(track, reset)).toBe(100);
    expect(trackValueAt(track, NOW)).toBe(90);
  });

  test('refills after the last sample when its reset has already passed', () => {
    const track = buildAccountTrack(
      account({
        remaining: null,
        samples: [{ t: NOW - 5 * HOUR_MS, remaining: 20, resetAtMs: NOW - HOUR_MS }],
      }),
      NOW
    );
    expect(trackValueAt(track, NOW)).toBe(100);
  });
});

describe('pool model', () => {
  test('sums accounts into the pool and measures burn from recorded drops only', () => {
    const model = buildPoolModel(
      [
        account({
          key: 'busy',
          label: 'busy',
          remaining: 70,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 76, resetAtMs: NOW + 72 * HOUR_MS }],
        }),
        account({ key: 'idle', label: 'idle', remaining: 100 }),
      ],
      options
    );
    expect(model.capacity).toBe(200);
    expect(model.current).toBe(170);
    expect(model.burnPerHour).toBeCloseTo(2, 1);
  });

  test('projects drain onto the soonest-reset account and labels the refill', () => {
    const model = buildPoolModel(
      [
        account({
          key: 'soon',
          label: 'soon',
          remaining: 73,
          resetAtMs: NOW + 10 * HOUR_MS,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 76, resetAtMs: NOW + 10 * HOUR_MS }],
        }),
        account({ key: 'later', label: 'later', remaining: 100, resetAtMs: NOW + 100 * HOUR_MS }),
      ],
      options
    );
    // 1%/h for 10h on the soonest account: 73 → 63, so the reset adds back 37.
    expect(model.nextReset?.delta).toBeCloseTo(37, 0);
    expect(model.nextReset?.t).toBe(NOW + 10 * HOUR_MS);
    expect(model.firstEmpty).toBeNull();
    const later = model.accounts.find((a) => a.key === 'later');
    expect(later?.nextResetMs).toBe(NOW + 100 * HOUR_MS);
  });

  test('future usage "none" keeps the projection flat until resets', () => {
    const model = buildPoolModel(
      [
        account({
          remaining: 50,
          resetAtMs: NOW + 48 * HOUR_MS,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 60, resetAtMs: NOW + 48 * HOUR_MS }],
        }),
      ],
      { ...options, futureFactor: 0 }
    );
    const before = model.projected.find((p) => p.t >= NOW + 24 * HOUR_MS);
    expect(before?.v).toBe(50);
    expect(model.nextReset?.delta).toBeCloseTo(50, 5);
    expect(model.poolEmptyAtMs).toBeNull();
  });

  test('reports when an account and the pool run dry', () => {
    const model = buildPoolModel(
      [
        account({
          remaining: 10,
          resetAtMs: NOW + 200 * HOUR_MS,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 25, resetAtMs: NOW + 200 * HOUR_MS }],
        }),
      ],
      options
    );
    // 5%/h from 10% → empty in about two hours.
    expect(model.firstEmpty?.t).toBeGreaterThan(NOW + HOUR_MS);
    expect(model.firstEmpty!.t).toBeLessThanOrEqual(NOW + 2 * HOUR_MS + 5 * 60_000);
    expect(model.poolEmptyAtMs).toBe(model.firstEmpty!.t);
  });

  test('without history the burn is unknown and the projection is flat', () => {
    const model = buildPoolModel([account({ remaining: 80 })], options);
    expect(model.burnPerHour).toBeNull();
    expect(model.recorded).toEqual([]);
    expect(model.projected.every((p) => p.v === 80 || p.v === 100)).toBe(true);
  });

  test('unloaded accounts without history are left out of the pool', () => {
    const model = buildPoolModel(
      [account({ key: 'x', remaining: 90 }), account({ key: 'y', remaining: null })],
      options
    );
    expect(model.accountCount).toBe(1);
    expect(model.capacity).toBe(100);
  });
});

describe('pool model edge cases', () => {
  test('an account already at zero is empty now, not in five minutes', () => {
    const model = buildPoolModel(
      [account({ key: 'dry', label: 'dry', remaining: 0 }), account({ key: 'ok', remaining: 100 })],
      options
    );
    expect(model.firstEmpty?.t).toBe(NOW);
    expect(model.accounts.find((a) => a.key === 'dry')?.emptyAtMs).toBe(NOW);
  });

  test('projected drain rate falls to zero once the pool is empty', () => {
    const model = buildPoolModel(
      [
        account({
          remaining: 10,
          resetAtMs: NOW + 200 * HOUR_MS,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 25, resetAtMs: NOW + 200 * HOUR_MS }],
        }),
      ],
      options
    );
    expect(model.projectedRate[0].v).toBeCloseTo(5, 1);
    const later = model.projectedRate.find((p) => p.t >= NOW + 5 * HOUR_MS);
    expect(later?.v).toBe(0);
    expect(model.projectedRate.length).toBe(model.projected.length);
  });

  test('the headline burn equals the last point of the drain-rate series', () => {
    const model = buildPoolModel(
      [
        account({
          remaining: 70,
          samples: [
            { t: NOW - 7 * HOUR_MS - 7 * 60_000, remaining: 90, resetAtMs: NOW + 72 * HOUR_MS },
            { t: NOW - 3 * HOUR_MS, remaining: 80, resetAtMs: NOW + 72 * HOUR_MS },
          ],
        }),
      ],
      options
    );
    expect(model.burnPerHour).toBeCloseTo(model.recordedRate[model.recordedRate.length - 1].v, 9);
  });

  test('an unloaded account still refills at its recorded reset', () => {
    const model = buildPoolModel(
      [
        account({
          key: 'stale',
          remaining: null,
          samples: [{ t: NOW - HOUR_MS, remaining: 40, resetAtMs: NOW + 5 * HOUR_MS }],
        }),
      ],
      options
    );
    expect(model.nextReset?.delta).toBeCloseTo(60, 5);
    expect(model.projected[model.projected.length - 1].v).toBe(100);
  });
});

describe('partial loading', () => {
  test('burn measured across all accounts is spent across all of them', () => {
    const history = (key: string) =>
      account({
        key,
        label: key,
        remaining: null,
        samples: [
          { t: NOW - 3 * HOUR_MS, remaining: 90, resetAtMs: NOW + 150 * HOUR_MS },
          { t: NOW - 60_000, remaining: 81, resetAtMs: NOW + 150 * HOUR_MS },
        ],
      });
    const model = buildPoolModel(
      [
        account({ key: 'live', remaining: 60, resetAtMs: NOW + 150 * HOUR_MS }),
        ...['b', 'c', 'd'].map(history),
      ],
      options
    );
    // ~9%/h in total. Soonest-reset ties break by key, so "b" drains first
    // (81% / 9%/h ≈ 9h) instead of the one loaded account taking it all.
    expect(model.burnPerHour).toBeCloseTo(9, 0);
    expect(model.firstEmpty?.key).toBe('b');
    expect(model.firstEmpty!.t).toBeGreaterThan(NOW + 8 * HOUR_MS);
    expect(model.accounts.find((a) => a.key === 'live')?.emptyAtMs ?? Infinity).toBeGreaterThan(
      model.firstEmpty!.t
    );
  });

  test('a run-dry in a later weekly cycle is not "first empty"', () => {
    const model = buildPoolModel(
      [
        account({
          remaining: 100,
          resetAtMs: NOW + 2 * HOUR_MS,
          samples: [{ t: NOW - 3 * HOUR_MS, remaining: 100, resetAtMs: NOW + 2 * HOUR_MS }],
        }),
      ],
      { ...options, futureFactor: 0 }
    );
    expect(model.firstEmpty).toBeNull();
  });
});

describe('view range', () => {
  test('starts three days back at local midnight and spans fourteen calendar days', () => {
    const range = poolViewRange(NOW, 0);
    const start = new Date(range.startMs);
    expect(start.getHours()).toBe(0);
    const end = new Date(range.endMs);
    const days = Math.round((range.endMs - range.startMs) / (24 * HOUR_MS));
    expect(days).toBe(14);
    expect(end.getHours()).toBe(0);
    const next = poolViewRange(NOW, 1);
    expect(Math.round((next.startMs - range.startMs) / (24 * HOUR_MS))).toBe(7);
  });
});

describe('plan-weighted pool', () => {
  test('sizes each account against the biggest plan', () => {
    const model = buildPoolModel(
      [
        account({ key: 'team', label: 'team', remaining: 50, size: 5 }),
        account({ key: 'pro', label: 'pro', remaining: 50, size: 1 }),
      ],
      options
    );
    // Max 5x seat = 100%, Pro = 20%.
    expect(model.capacity).toBeCloseTo(120, 5);
    expect(model.current).toBeCloseTo(60, 5);
    expect(model.accounts.find((a) => a.key === 'pro')?.share).toBeCloseTo(20, 5);
  });

  test('a reset adds back only the account’s own share', () => {
    const model = buildPoolModel(
      [
        account({ key: 'team', remaining: 100, size: 5, resetAtMs: NOW + 100 * HOUR_MS }),
        account({ key: 'pro', remaining: 0, size: 1, resetAtMs: NOW + 2 * HOUR_MS }),
      ],
      { ...options, futureFactor: 0 }
    );
    expect(model.nextReset?.delta).toBeCloseTo(20, 5);
  });

  test('equal sizes keep the old 100% per account', () => {
    const model = buildPoolModel(
      [account({ key: 'a' }), account({ key: 'b', label: 'b' })],
      options
    );
    expect(model.capacity).toBe(200);
  });
});

describe('5-hour view range', () => {
  test('spans two days starting twelve hours back, a day per page', () => {
    const range = poolViewRange(NOW, 0, 'five-hour');
    expect(range.endMs - range.startMs).toBe(48 * HOUR_MS);
    expect(range.startMs).toBe(NOW - 12 * HOUR_MS);
    const next = poolViewRange(NOW, 1, 'five-hour');
    expect(next.startMs - range.startMs).toBe(24 * HOUR_MS);
  });
});
