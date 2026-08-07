import { schema } from '@archive/db';
import type { Db } from '@archive/db/client';
import type { FetchedPage, ParseResult } from '@archive/parser';
import { decideRetention } from './retention.js';
import {
  buildCountRows,
  buildReviewRows,
  buildSnapshotRow,
  buildSummaryRows,
  countsMatch,
} from './rows.js';
import type { UploadOutcome } from './storage.js';

export interface PersistInput {
  page: FetchedPage;
  result: ParseResult;
  upload: UploadOutcome;
}

export interface PersistedSnapshot {
  snapshotId: bigint;
  countsMatched: boolean;
  retainUntil: Date | null;
  reviewCount: number;
  countRows: number;
  summaryRows: number;
}

/**
 * Write one snapshot and everything derived from it, in a single transaction.
 *
 * All of it or none of it: a `snapshot` row without its `snapshot_count` children
 * would silently look like a healthy poll, and invariant 3's whole value is that
 * a regression is visible in the archive rather than only in a failing run's log.
 */
export async function persistSnapshot(db: Db, input: PersistInput): Promise<PersistedSnapshot> {
  const { page, result, upload } = input;

  const countsMatched = countsMatch(result);

  // The review rows are needed to decide retention (anything queued is kept
  // forever), but they need a snapshot id that does not exist yet. Count them
  // first with a placeholder id, then build them for real inside the transaction.
  const reviewCount = buildReviewRows(0n, result, upload, countsMatched).length;

  const retainUntil = decideRetention({
    fetchedAt: page.fetchedAt,
    countsMatched,
    reviewCount,
  });

  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.snapshot)
      .values(buildSnapshotRow({ page, result, upload, countsMatched, retainUntil }))
      .returning({ id: schema.snapshot.id });

    if (!inserted) {
      throw new Error('Snapshot insert returned no row');
    }

    const snapshotId = inserted.id;

    const countRows = buildCountRows(snapshotId, result);
    if (countRows.length > 0) {
      await tx.insert(schema.snapshotCount).values(countRows);
    }

    const summaryRows = buildSummaryRows(snapshotId, result);
    if (summaryRows.length > 0) {
      await tx.insert(schema.categorySummary).values(summaryRows);
    }

    const reviewRows = buildReviewRows(snapshotId, result, upload, countsMatched);
    if (reviewRows.length > 0) {
      await tx.insert(schema.reviewQueue).values(reviewRows);
    }

    return {
      snapshotId,
      countsMatched,
      retainUntil,
      reviewCount: reviewRows.length,
      countRows: countRows.length,
      summaryRows: summaryRows.length,
    };
  });
}
