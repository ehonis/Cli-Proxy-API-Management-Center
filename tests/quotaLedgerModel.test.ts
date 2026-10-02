import { describe, expect, test } from 'bun:test';
import {
  buildProviderSummary,
  ledgerColumnsFor,
  ledgerTone,
  maskCredentialName,
} from '../src/features/quota/ledger/ledgerModel';
import type { QuotaCardState } from '../src/features/quota/providers';

const claude = (fable: number, fiveHour: number, sevenDay: number, resetAtMs: number) =>
  ({
    status: 'success',
    planType: 'plan_max',
    windows: [
      { id: 'five-hour', label: '5h', usedPercent: fiveHour, resetLabel: '', resetAtMs: null },
      { id: 'seven-day', label: '7d', usedPercent: sevenDay, resetLabel: '', resetAtMs },
      { id: 'seven-day-fable', label: 'Fable', usedPercent: fable, resetLabel: '', resetAtMs },
    ],
  }) as unknown as QuotaCardState;

describe('ledger model', () => {
  test('masks credential filenames', () => {
    expect(maskCredentialName('claude-tom@lazorpoint.dev.json')).toBe('claude-t•••@l•••.dev.json');
    expect(maskCredentialName('codex-ab@mail.example.co.uk.json')).toBe('codex-a•••@m•••.uk.json');
    expect(maskCredentialName('no-email.json')).toBe('no-email.json');
  });

  test('claude columns: fable first, all-models 7-day muted', () => {
    const cols = ledgerColumnsFor('claude', claude(42, 0, 21, 1));
    expect(cols.map((c) => c.id)).toEqual(['seven-day-fable', 'five-hour', 'seven-day']);
    expect(cols[0].remaining).toBe(58);
    expect(cols[2].muted).toBe(true);
  });

  test('summary pools remaining across credentials', () => {
    const soon = Date.now() + 3_600_000;
    const later = Date.now() + 86_400_000;
    const summary = buildProviderSummary('claude', [
      claude(42, 0, 21, later),
      claude(0, 0, 0, soon),
      undefined,
    ]);
    expect(summary?.primary.totalRemaining).toBe(158);
    expect(summary?.primary.capacity).toBe(300);
    expect(summary?.primary.segments).toEqual([58, 100, null]);
    expect(summary?.primary.soonestResetMs).toBe(soon);
    expect(summary?.secondary?.columnId).toBe('seven-day');
  });

  test('tones', () => {
    expect(ledgerTone(100)).toBe('high');
    expect(ledgerTone(58)).toBe('medium');
    expect(ledgerTone(17)).toBe('low');
    expect(ledgerTone(null)).toBe('unknown');
  });
});
