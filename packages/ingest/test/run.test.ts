import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { schema } from '@archive/db';
import type { FetchedPage } from '@archive/parser';
import { IngestValidationError, runIngest } from '../src/run.js';
import type { UploadOutcome } from '../src/storage.js';
import { fakeDb } from './helpers.js';

/**
 * Reaches into the parser package's fixture on purpose. This is the only place
 * that exercises the whole pipeline against a real NYCHA response — 248 rows,
 * four categories, NYCHA's own published totals — and a synthetic page would
 * prove nothing about it.
 */
const FIXTURE = fileURLToPath(
  new URL('../../parser/test/fixtures/outages-2026-08-06T21-21Z.html', import.meta.url),
);

const html = readFileSync(FIXTURE, 'utf8');

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://my.nycha.info/Outages/Outages.aspx',
    httpStatus: 200,
    html,
    sha256: 'a'.repeat(64),
    fetchedAt: new Date('2026-08-06T21:21:00.000Z'),
    attempts: 1,
    ...overrides,
  };
}

const uploaded: UploadOutcome = { ok: true, key: 'k.html.gz', bytes: 4096 };

describe('runIngest, against the real fixture', () => {
  it('commits a snapshot with its counts and summaries', async () => {
    const fake = fakeDb();

    const result = await runIngest({
      db: fake.db,
      fetchPage: async () => page(),
      upload: async () => uploaded,
    });

    expect(result.countsMatched).toBe(true);
    expect(result.snapshotId).toBe(42n);
    expect(result.observations).toBeGreaterThan(200);
    expect(result.countRows).toBeGreaterThan(0);
    expect(result.summaryRows).toBeGreaterThan(0);
    expect(result.reviewCount).toBe(0);
    expect(fake.committed()).toBe(true);
  });

  it('sets a retention date on a healthy snapshot', async () => {
    const fake = fakeDb();

    const result = await runIngest({
      db: fake.db,
      fetchPage: async () => page(),
      upload: async () => uploaded,
    });

    expect(result.retainUntil).not.toBeNull();
    // 30 days after the fetch.
    expect(result.retainUntil?.toISOString()).toBe('2026-09-05T21:21:00.000Z');
  });

  it('emits two summary rows per category and never a merged one', async () => {
    const fake = fakeDb();

    await runIngest({ db: fake.db, fetchPage: async () => page(), upload: async () => uploaded });

    const summaries = fake.rowsFor(schema.categorySummary);
    const planned = summaries.filter((r) => r['isPlanned'] === true);
    const unplanned = summaries.filter((r) => r['isPlanned'] === false);

    expect(planned).toHaveLength(unplanned.length);
    expect(summaries).toHaveLength(planned.length + unplanned.length);
  });

  it('records the original body hash, not the hash of what was stored', async () => {
    const fake = fakeDb();

    await runIngest({
      db: fake.db,
      fetchPage: async () => page({ sha256: 'c'.repeat(64) }),
      upload: async () => uploaded,
    });

    expect(fake.rowsFor(schema.snapshot)[0]?.['sha256']).toBe('c'.repeat(64));
  });
});

describe('runIngest, count mismatch', () => {
  /**
   * Truncating the document drops rows while NYCHA's printed totals stay in the
   * part that survives, which is exactly the shape of a silent parser regression.
   */
  const truncated = html.slice(0, Math.floor(html.length * 0.6));

  it('commits the snapshot BEFORE it throws', async () => {
    const fake = fakeDb(7n);

    await expect(
      runIngest({
        db: fake.db,
        fetchPage: async () => page({ html: truncated }),
        upload: async () => uploaded,
      }),
    ).rejects.toThrow(IngestValidationError);

    // The point of the ordering: the evidence survived the failure.
    expect(fake.committed()).toBe(true);
    expect(fake.rowsFor(schema.snapshot)).toHaveLength(1);
    expect(fake.rowsFor(schema.snapshot)[0]?.['countsMatched']).toBe(false);
  });

  it('exempts the snapshot from retention so it can be reparsed', async () => {
    const fake = fakeDb();

    await expect(
      runIngest({
        db: fake.db,
        fetchPage: async () => page({ html: truncated }),
        upload: async () => uploaded,
      }),
    ).rejects.toThrow(IngestValidationError);

    expect(fake.rowsFor(schema.snapshot)[0]?.['retainUntil']).toBeNull();
  });

  it('queues the mismatch for review as well as throwing', async () => {
    const fake = fakeDb();

    await expect(
      runIngest({
        db: fake.db,
        fetchPage: async () => page({ html: truncated }),
        upload: async () => uploaded,
      }),
    ).rejects.toThrow(IngestValidationError);

    const queued = fake.rowsFor(schema.reviewQueue);
    expect(queued.some((r) => r['reason'] === 'counts_mismatch')).toBe(true);
  });

  it('puts the snapshot id on the error', async () => {
    const fake = fakeDb(99n);

    await runIngest({
      db: fake.db,
      fetchPage: async () => page({ html: truncated }),
      upload: async () => uploaded,
    }).then(
      () => expect.unreachable('should have thrown'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(IngestValidationError);
        expect((error as IngestValidationError).snapshotId).toBe(99n);
        expect((error as IngestValidationError).detail.length).toBeGreaterThan(0);
      },
    );
  });
});

describe('runIngest, failed raw upload', () => {
  const failed: UploadOutcome = { ok: false, key: 'k.html.gz', reason: 'HTTP 503' };

  // The parsed half is permanent, the raw half is transient. Losing the raw body
  // must not cost us the poll, so this is queued rather than thrown.
  it('still commits, and does not throw', async () => {
    const fake = fakeDb();

    const result = await runIngest({
      db: fake.db,
      fetchPage: async () => page(),
      upload: async () => failed,
    });

    expect(fake.committed()).toBe(true);
    expect(result.storageKey).toBeNull();
    expect(result.storedBytes).toBeNull();
    expect(result.countsMatched).toBe(true);
  });

  it('queues the failure and keeps the snapshot exempt from retention', async () => {
    const fake = fakeDb();

    const result = await runIngest({
      db: fake.db,
      fetchPage: async () => page(),
      upload: async () => failed,
    });

    expect(result.reviewCount).toBe(1);
    expect(fake.rowsFor(schema.reviewQueue)[0]?.['reason']).toBe('raw_upload_failed');
    expect(result.retainUntil).toBeNull();
  });
});
