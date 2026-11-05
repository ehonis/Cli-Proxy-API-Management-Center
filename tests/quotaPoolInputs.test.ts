import { describe, expect, test } from 'bun:test';
import { planSize, poolInputsFor } from '../src/features/quota/pool/poolInputs';
import { FIVE_HOUR_MS } from '../src/features/quota/pool/poolModel';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import type { QuotaCardState } from '../src/features/quota/providers';
import type { QuotaHistorySample } from '../src/services/api/quotaHistory';

const NOW = Date.UTC(2026, 10, 4, 18, 0, 0);

const claudeQuota = (tier: string | null, planType: string | null = null) =>
  ({
    status: 'success',
    planType,
    rateLimitTier: tier,
    windows: [
      { id: 'five-hour', label: '5h', usedPercent: 40, resetAtMs: NOW + HOUR, periodHours: 5 },
      { id: 'seven-day', label: '7d', usedPercent: 10, resetAtMs: NOW + 3 * DAY, periodHours: 168 },
    ],
  }) as unknown as QuotaCardState;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('plan size', () => {
  test('reads the multiple from the Claude rate-limit tier', () => {
    expect(planSize('claude', claudeQuota('default_claude_max_5x', 'plan_team'))).toBe(5);
    expect(planSize('claude', claudeQuota('default_claude_max_20x'))).toBe(20);
    expect(planSize('claude', claudeQuota('default_claude_ai', 'plan_pro'))).toBe(1);
  });

  test('falls back to 1 when nothing says otherwise', () => {
    expect(planSize('claude', claudeQuota(null))).toBe(1);
    expect(planSize('claude', undefined)).toBeNull();
    expect(planSize('codex', claudeQuota('default_claude_max_5x'))).toBe(1);
  });
});

describe('pooled window', () => {
  const entry = {
    type: 'claude',
    file: { name: 'a.json', type: 'claude', auth_index: 'idx-a', email: 'a@example.com' },
  } as unknown as QuotaFileEntry;
  const history = new Map<string, QuotaHistorySample[]>([
    [
      'idx-a',
      [
        {
          t: NOW - HOUR,
          authIndex: 'idx-a',
          provider: 'claude',
          windows: {
            five_hour: { used: 30, resetAtMs: NOW + HOUR, windowMinutes: null },
            seven_day: { used: 8, resetAtMs: NOW + 3 * DAY, windowMinutes: null },
          },
        } as unknown as QuotaHistorySample,
      ],
    ],
  ]);
  const quota = claudeQuota('default_claude_max_5x');

  test('weekly reads the 7-day window', () => {
    const [input] = poolInputsFor(
      'claude',
      [entry],
      () => quota,
      history,
      () => NOW,
      true
    );
    expect(input.remaining).toBe(90);
    expect(input.samples[0].remaining).toBe(92);
    expect(input.size).toBe(5);
  });

  test('5-hour reads the 5-hour window', () => {
    const [input] = poolInputsFor(
      'claude',
      [entry],
      () => quota,
      history,
      () => NOW,
      true,
      'five-hour'
    );
    expect(input.remaining).toBe(60);
    expect(input.samples[0].remaining).toBe(70);
    expect(input.periodMs).toBe(FIVE_HOUR_MS);
  });
});
