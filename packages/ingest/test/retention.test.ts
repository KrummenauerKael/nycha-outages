import { describe, expect, it } from 'vitest';
import { RAW_RETENTION_DAYS, decideRetention } from '../src/retention';

const fetchedAt = new Date('2026-08-07T12:00:00.000Z');

describe('decideRetention', () => {
  it('expires a healthy snapshot after the window', () => {
    const until = decideRetention({ fetchedAt, countsMatched: true, reviewCount: 0 });

    expect(until).not.toBeNull();
    expect(until?.toISOString()).toBe('2026-09-06T12:00:00.000Z');
    expect((until!.getTime() - fetchedAt.getTime()) / 86_400_000).toBe(RAW_RETENTION_DAYS);
  });

  // The `snapshot` table's contract: a snapshot that failed validation is exempt
  // from retention, because it is the only kind anyone would ever reparse.
  it('keeps a snapshot whose counts did not match, forever', () => {
    expect(decideRetention({ fetchedAt, countsMatched: false, reviewCount: 0 })).toBeNull();
  });

  it('keeps a snapshot that queued anything for review, forever', () => {
    expect(decideRetention({ fetchedAt, countsMatched: true, reviewCount: 1 })).toBeNull();
  });

  it('does not mutate the date it was given', () => {
    const input = new Date(fetchedAt);
    decideRetention({ fetchedAt: input, countsMatched: true, reviewCount: 0 });
    expect(input.toISOString()).toBe(fetchedAt.toISOString());
  });
});
