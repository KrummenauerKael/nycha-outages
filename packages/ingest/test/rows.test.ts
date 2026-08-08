import { describe, expect, it } from 'vitest';
import type { CategorySummary, FetchedPage, ParseResult } from '@archive/parser';
import {
  buildCountRows,
  buildReviewRows,
  buildSnapshotRow,
  buildSummaryRows,
  countsMatch,
} from '../src/rows';
import type { UploadOutcome } from '../src/storage';

const page: FetchedPage = {
  url: 'https://my.nycha.info/Outages/Outages.aspx',
  httpStatus: 200,
  html: '<html></html>',
  sha256: 'f'.repeat(64),
  fetchedAt: new Date('2026-08-07T12:00:00.000Z'),
  attempts: 1,
};

function parseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    parserVersion: '1.0.0',
    summaries: [],
    observations: [],
    counts: [],
    warnings: [],
    ...overrides,
  };
}

const ok: UploadOutcome = { ok: true, key: 'some/key.html.gz', bytes: 1234 };
const failed: UploadOutcome = { ok: false, key: 'some/key.html.gz', reason: 'HTTP 503' };

describe('countsMatch', () => {
  it('is true when every declared count equals the parsed count', () => {
    expect(
      countsMatch(
        parseResult({
          counts: [{ category: 'elevator', subTable: 'current', declared: 7, parsed: 7 }],
        }),
      ),
    ).toBe(true);
  });

  // A tab that prints no count cannot disagree with us — invariant 3 is about
  // NYCHA's own published number, and absence is not a mismatch.
  it('treats a null declared count as agreement, not failure', () => {
    expect(
      countsMatch(
        parseResult({
          counts: [{ category: 'gas', subTable: 'gas_current', declared: null, parsed: 3 }],
        }),
      ),
    ).toBe(true);
  });

  it('is false on any disagreement', () => {
    expect(
      countsMatch(
        parseResult({
          counts: [
            { category: 'elevator', subTable: 'current', declared: 7, parsed: 7 },
            { category: 'heat_hot_water', subTable: 'current', declared: 9, parsed: 8 },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('buildSnapshotRow', () => {
  it('records the original body hash and the stored object', () => {
    const row = buildSnapshotRow({
      page,
      result: parseResult(),
      upload: ok,
      countsMatched: true,
      retainUntil: new Date('2026-09-06T12:00:00.000Z'),
    });

    expect(row).toMatchObject({
      url: page.url,
      httpStatus: 200,
      attempts: 1,
      sha256: 'f'.repeat(64),
      storageKey: 'some/key.html.gz',
      storedBytes: 1234,
      countsMatched: true,
      parserVersion: '1.0.0',
    });
  });

  // The schema allows a null storage key precisely so a failed upload still
  // produces a snapshot row rather than losing the poll.
  it('leaves the storage key and size null when the upload failed', () => {
    const row = buildSnapshotRow({
      page,
      result: parseResult(),
      upload: failed,
      countsMatched: true,
      retainUntil: null,
    });

    expect(row.storageKey).toBeNull();
    expect(row.storedBytes).toBeNull();
  });
});

describe('buildCountRows', () => {
  it('carries declared and parsed through per category and sub-table', () => {
    const rows = buildCountRows(
      42n,
      parseResult({
        counts: [
          { category: 'elevator', subTable: 'rehab', declared: null, parsed: 5 },
          { category: 'electric', subTable: 'restored_24h', declared: 2, parsed: 2 },
        ],
      }),
    );

    expect(rows).toEqual([
      { snapshotId: 42n, category: 'elevator', subTable: 'rehab', declared: null, parsed: 5 },
      {
        snapshotId: 42n,
        category: 'electric',
        subTable: 'restored_24h',
        declared: 2,
        parsed: 2,
      },
    ]);
  });
});

describe('buildSummaryRows', () => {
  const summary: CategorySummary = {
    category: 'heat_hot_water',
    asOfRaw: '8/6/2026 5:21:00 PM',
    planned: {
      interruptions: 2,
      developments: 2,
      buildings: 3,
      units: 100,
      residents: 250,
    },
    unplanned: {
      interruptions: 5,
      developments: 4,
      buildings: 34,
      units: 2708,
      residents: 5139,
    },
  };

  // Invariant 2: planned and unplanned are never aggregated, anywhere.
  it('emits two rows per category, never a merged one', () => {
    const rows = buildSummaryRows(42n, parseResult({ summaries: [summary] }));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.isPlanned)).toEqual([false, true]);
    expect(rows.find((r) => r.isPlanned === false)).toMatchObject({
      interruptions: 5,
      residents: 5139,
    });
    expect(rows.find((r) => r.isPlanned === true)).toMatchObject({
      interruptions: 2,
      residents: 250,
    });
  });

  it('repeats the as-of text on both rows', () => {
    const rows = buildSummaryRows(42n, parseResult({ summaries: [summary] }));
    expect(rows.every((r) => r.asOfRaw === '8/6/2026 5:21:00 PM')).toBe(true);
  });

  // Gas has no summary block at all, so nothing should be invented for it.
  it('emits nothing when a category has no summary', () => {
    expect(buildSummaryRows(42n, parseResult({ summaries: [] }))).toEqual([]);
  });
});

describe('buildReviewRows', () => {
  it('queues nothing for a clean snapshot', () => {
    expect(buildReviewRows(42n, parseResult(), ok, true)).toEqual([]);
  });

  it('queues a count mismatch with both numbers in the detail', () => {
    const rows = buildReviewRows(
      42n,
      parseResult({
        counts: [{ category: 'heat_hot_water', subTable: 'current', declared: 9, parsed: 8 }],
      }),
      ok,
      false,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('counts_mismatch');
    expect(rows[0]?.detail).toContain('declared 9, parsed 8');
  });

  it('queues a failed upload with the reason', () => {
    const rows = buildReviewRows(42n, parseResult(), failed, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('raw_upload_failed');
    expect(rows[0]?.detail).toContain('HTTP 503');
  });

  it('queues one row per parser warning', () => {
    const rows = buildReviewRows(
      42n,
      parseResult({ warnings: ['unknown icon: foo.png', 'column count drifted'] }),
      ok,
      true,
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reason === 'parser_warning')).toBe(true);
  });

  it('accumulates every independent problem rather than reporting the first', () => {
    const rows = buildReviewRows(
      42n,
      parseResult({
        counts: [{ category: 'elevator', subTable: 'current', declared: 3, parsed: 2 }],
        warnings: ['unknown icon'],
      }),
      failed,
      false,
    );

    expect(rows.map((r) => r.reason)).toEqual([
      'counts_mismatch',
      'raw_upload_failed',
      'parser_warning',
    ]);
  });
});
