import { schema } from '@archive/db';
import type { Db } from '@archive/db/client';
import type { FetchedPage, ParseResult } from '@archive/parser';
import { duplicateIdentities, identify, type DuplicateIdentity } from './identify.js';
import { persistObservations, type ObservationWriteSummary } from './observations.js';
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
  duplicates: DuplicateIdentity[];
  /**
   * Null when the observation timeline was deliberately left untouched. See the
   * gate in `persistSnapshot`.
   */
  observations: ObservationWriteSummary | null;
}

/**
 * Write one snapshot and everything derived from it, in a single transaction.
 *
 * All of it or none of it: a `snapshot` row without its `snapshot_count` children
 * would look like a healthy poll, and invariant 3's whole value is that a
 * regression is visible in the archive rather than only in a failing run's log.
 */
export async function persistSnapshot(db: Db, input: PersistInput): Promise<PersistedSnapshot> {
  const { page, result, upload } = input;

  const countsMatched = countsMatch(result);
  const identified = identify(result);
  const duplicates = duplicateIdentities(identified);

  /**
   * THE GATE. Observations are written only from a snapshot that fully validated.
   *
   * This is not defensive tidiness, it is the difference between an archive and a
   * ruined one. Absence is recorded by subtracting the identities in this snapshot
   * from the set of currently-open events, so a snapshot that silently lost rows —
   * a markup change, a truncated response, a parser regression — would not merely
   * miss data. It would close hundreds of outages that are still ongoing, and
   * "ended at 14:00" is indistinguishable from the truth after the fact.
   *
   * A count mismatch is exactly the signal that rows were lost, which is why
   * invariant 3 exists. So when it fires, the snapshot and its counts are still
   * recorded as evidence, and the timeline is left strictly alone.
   */
  const timelineWritable = countsMatched && duplicates.length === 0;

  // Review rows are needed to decide retention, but need a snapshot id that does
  // not exist yet. Count them against a placeholder, then build them for real.
  const reviewCount = buildReviewRows(0n, result, upload, countsMatched, duplicates).length;

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

    const reviewRows = buildReviewRows(snapshotId, result, upload, countsMatched, duplicates);
    if (reviewRows.length > 0) {
      await tx.insert(schema.reviewQueue).values(reviewRows);
    }

    const observations = timelineWritable
      ? await persistObservations(tx, {
          snapshotId,
          fetchedAt: page.fetchedAt,
          identified,
          parserVersion: result.parserVersion,
        })
      : null;

    return {
      snapshotId,
      countsMatched,
      retainUntil,
      reviewCount: reviewRows.length,
      countRows: countRows.length,
      summaryRows: summaryRows.length,
      duplicates,
      observations,
    };
  });
}
