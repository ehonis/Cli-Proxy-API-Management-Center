import { describe, expect, test } from 'bun:test';
import {
  buildPoolModel,
  HOUR_MS,
  idleSpans,
  isIdleAt,
  isQuietAt,
  quietSpans,
  trackValueAt,
  WEEK_MS,
  type PoolAccountInput,
} from '../src/features/quota/pool/poolModel';
import {
  isQuietHoursId,
  normalizeOffDays,
  quietHoursOf,
} from '../src/features/quota/pool/poolSettings';

// Local time on purpose: quiet hours follow the viewer's clock.
const NOW = new Date(2026, 10, 3, 18, 0, 0).getTime();
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0).getTime();
const NIGHT = { startHour: 22, endHour: 6 };

const busy = (): PoolAccountInput => ({
  key: 'busy',
  label: 'busy',
  remaining: 70,
  resetAtMs: NOW + 72 * HOUR_MS,
  periodMs: WEEK_MS,
  observedAtMs: NOW,
  samples: [{ t: NOW - 3 * HOUR_MS, remaining: 76, resetAtMs: NOW + 72 * HOUR_MS }],
});

const model = (quietHours: typeof NIGHT | null, offDays: number[] = []) =>
  buildPoolModel([busy()], {
    now: NOW,
    burnWindowHours: 3,
    futureFactor: 1,
    recordedFromMs: NOW - 24 * HOUR_MS,
    projectToMs: NOW + 48 * HOUR_MS,
    quietHours,
    offDays,
  });

describe('quiet hours', () => {
  test('a block that wraps midnight covers late night and early morning only', () => {
    expect(isQuietAt(at(3, 23), NIGHT)).toBe(true);
    expect(isQuietAt(at(4, 3), NIGHT)).toBe(true);
    expect(isQuietAt(at(4, 6), NIGHT)).toBe(false);
    expect(isQuietAt(at(3, 21), NIGHT)).toBe(false);
    expect(isQuietAt(at(3, 23), null)).toBe(false);
    expect(isQuietAt(at(4, 3), { startHour: 1, endHour: 9 })).toBe(true);
    expect(isQuietAt(at(4, 9), { startHour: 1, endHour: 9 })).toBe(false);
  });

  test('the projection holds flat through the night and resumes at the same burn', () => {
    const quiet = model(NIGHT);
    const v = (t: number) => trackValueAt(quiet.projected, t) ?? NaN;
    // 2%/h from 6 PM to 10 PM, then nothing until 6 AM.
    expect(v(at(3, 22))).toBeCloseTo(62, 0);
    expect(v(at(4, 2))).toBeCloseTo(62, 0);
    expect(v(at(4, 6))).toBeCloseTo(62, 0);
    expect(v(at(4, 8))).toBeCloseTo(58, 0);
    // The burn rate shown in the header is still the measured one.
    expect(quiet.burnPerHour).toBeCloseTo(2, 1);
    // The drain-rate series drops to zero overnight.
    expect(trackValueAt(quiet.projectedRate, at(4, 1))).toBe(0);
    expect(trackValueAt(quiet.projectedRate, at(4, 9))).toBeCloseTo(2, 1);
  });

  test('a later pool-empty time than without quiet hours', () => {
    const plain = model(null);
    const quiet = model(NIGHT);
    expect(plain.accounts[0].emptyAtMs).not.toBeNull();
    expect(quiet.accounts[0].emptyAtMs).not.toBeNull();
    expect(quiet.accounts[0].emptyAtMs!).toBeGreaterThan(plain.accounts[0].emptyAtMs!);
    // 70% at 2%/h, idle 10 PM to 6 AM: 4h tonight, 16h tomorrow, then 15h more = 9 PM day 3.
    expect(Math.abs(quiet.accounts[0].emptyAtMs! - at(5, 21))).toBeLessThanOrEqual(HOUR_MS / 4);
    // Without quiet hours the same 35h of burn runs straight through: 5 AM day 3.
    expect(Math.abs(plain.accounts[0].emptyAtMs! - at(5, 5))).toBeLessThanOrEqual(HOUR_MS / 4);
  });

  test('spans are clipped to the range and land on the local clock', () => {
    const spans = quietSpans(NOW, at(5, 12), NIGHT);
    expect(spans).toEqual([
      { startMs: at(3, 22), endMs: at(4, 6) },
      { startMs: at(4, 22), endMs: at(5, 6) },
    ]);
    expect(quietSpans(at(4, 2), at(4, 4), NIGHT)).toEqual([{ startMs: at(4, 2), endMs: at(4, 4) }]);
    expect(quietSpans(NOW, at(5, 12), null)).toEqual([]);
  });

  test('preset ids parse, and anything else is rejected', () => {
    expect(quietHoursOf('off')).toBeNull();
    expect(quietHoursOf('23-7')).toEqual({ startHour: 23, endHour: 7 });
    expect(isQuietHoursId('0-8')).toBe(true);
    expect(isQuietHoursId('3-4')).toBe(false);
    expect(isQuietHoursId(null)).toBe(false);
  });
});

describe('off days', () => {
  // Nov 3, 2026 is a Tuesday; Nov 4 a Wednesday.
  const WED = 3;

  test('a whole local day is idle, the days around it are not', () => {
    expect(isIdleAt(at(4, 0), { offDays: [WED] })).toBe(true);
    expect(isIdleAt(at(4, 13), { offDays: [WED] })).toBe(true);
    expect(isIdleAt(at(3, 23), { offDays: [WED] })).toBe(false);
    expect(isIdleAt(at(5, 0), { offDays: [WED] })).toBe(false);
    expect(isIdleAt(at(5, 3), { offDays: [WED], quietHours: NIGHT })).toBe(true);
  });

  test('the projection spends nothing on an off day', () => {
    const off = model(null, [WED]);
    const v = (t: number) => trackValueAt(off.projected, t) ?? NaN;
    // 2%/h from 6 PM Tuesday to midnight, flat all Wednesday, draining again Thursday.
    expect(v(at(4, 0))).toBeCloseTo(58, 0);
    expect(v(at(4, 23))).toBeCloseTo(58, 0);
    expect(v(at(5, 2))).toBeCloseTo(54, 0);
    expect(trackValueAt(off.projectedRate, at(4, 12))).toBe(0);
  });

  test('an off day joins the quiet blocks on either side into one span', () => {
    expect(idleSpans(NOW, at(6, 0), { quietHours: NIGHT, offDays: [WED] })).toEqual([
      { startMs: at(3, 22), endMs: at(5, 6) },
      { startMs: at(5, 22), endMs: at(6, 0) },
    ]);
    expect(idleSpans(NOW, at(6, 0), { offDays: [WED] })).toEqual([
      { startMs: at(4, 0), endMs: at(5, 0) },
    ]);
    expect(idleSpans(NOW, at(6, 0), {})).toEqual([]);
  });

  test('stored days are cleaned up', () => {
    expect(normalizeOffDays([6, 0, 6, 9, -1, 2.5, '3'])).toEqual([0, 6]);
    expect(normalizeOffDays('nope')).toEqual([]);
  });
});
