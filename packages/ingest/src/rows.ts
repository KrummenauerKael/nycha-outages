import type { schema } from '@archive/db';
import type { CategorySummary, FetchedPage, ParseResult, SummaryCounts } from '@archive/parser';
import type { DuplicateIdentity } from './identify';
import type { UploadOutcome } from './storage';

/**
 * Pure translation from parser output to insertable rows. Kept separate from the
 * transaction so the shape of what gets written is testable without a database.
 */

type SnapshotInsert = typeof schema.snapshot.$inferInsert;
type SnapshotCountInsert = typeof schema.snapshotCount.$inferInsert;
type CategorySummaryInsert = typeof schema.categorySummary.$inferInsert;
type ReviewQueueInsert = typeof schema.reviewQueue.$inferInsert;

/**
 * Invariant 3. NYCHA prints a row count on every tab; a null declared count means
 * the tab omitted it, which is not a mismatch. Only a present-and-different count
 * is a failure.
 */
export function countsMatch(result: ParseResult): boolean {
  return result.counts.every((c) => c.declared === null || c.declared === c.parsed);
}

export interface SnapshotRowInput {
  page: FetchedPage;
  result: ParseResult;
  upload: UploadOutcome;
  countsMatched: boolean;
  retainUntil: Date | null;
}

export function buildSnapshotRow({
  page,
  result,
  upload,
  countsMatched,
  retainUntil,
}: SnapshotRowInput): SnapshotInsert {
  return {
    fetchedAt: page.fetchedAt,
    url: page.url,
    httpStatus: page.httpStatus,
    attempts: page.attempts,
    // Of the original body, before __VIEWSTATE was stripped. Outlives the object.
    sha256: page.sha256,
    storageKey: upload.ok ? upload.key : null,
    storedBytes: upload.ok ? upload.bytes : null,
    retainUntil,
    countsMatched,
    parserVersion: result.parserVersion,
  };
}

export function buildCountRows(snapshotId: bigint, result: ParseResult): SnapshotCountInsert[] {
  return result.counts.map((c) => ({
    snapshotId,
    category: c.category,
    subTable: c.subTable,
    declared: c.declared,
    parsed: c.parsed,
  }));
}

function summaryRow(
  snapshotId: bigint,
  summary: CategorySummary,
  isPlanned: boolean,
  counts: SummaryCounts,
): CategorySummaryInsert {
  return {
    snapshotId,
    category: summary.category,
    isPlanned,
    asOfRaw: summary.asOfRaw,
    interruptions: counts.interruptions,
    developments: counts.developments,
    buildings: counts.buildings,
    units: counts.units,
    residents: counts.residents,
  };
}

/**
 * Two rows per category summary, never one.
 *
 * Invariant 2 forbids aggregating planned and unplanned anywhere, and the table's
 * primary key is (snapshot, category, is_planned) precisely so the schema cannot
 * express the merged form.
 */
export function buildSummaryRows(snapshotId: bigint, result: ParseResult): CategorySummaryInsert[] {
  return result.summaries.flatMap((s) => [
    summaryRow(snapshotId, s, false, s.unplanned),
    summaryRow(snapshotId, s, true, s.planned),
  ]);
}

/**
 * Everything a human needs to look at. Invariant 7: never guess — anything
 * unexpected is queued rather than dropped or coerced.
 *
 * A count mismatch is queued *as well as* thrown, so the reason survives in the
 * archive itself and not only in a log line that will have rotated away.
 */
export function buildReviewRows(
  snapshotId: bigint,
  result: ParseResult,
  upload: UploadOutcome,
  countsMatched: boolean,
  duplicates: DuplicateIdentity[] = [],
): ReviewQueueInsert[] {
  const rows: ReviewQueueInsert[] = [];

  // Listed first: it is the only one of these that suppresses the observation
  // writes entirely, so it is what a human should read first.
  for (const duplicate of duplicates) {
    rows.push({
      snapshotId,
      reason: 'duplicate_identity',
      detail: `${duplicate.identity.slice(0, 12)}… shared by ${duplicate.rows.join(' | ')}`,
    });
  }

  if (!countsMatched) {
    const bad = result.counts.filter((c) => c.declared !== null && c.declared !== c.parsed);
    rows.push({
      snapshotId,
      reason: 'counts_mismatch',
      detail: bad
        .map((c) => `${c.category}/${c.subTable}: declared ${c.declared}, parsed ${c.parsed}`)
        .join('; '),
    });
  }

  if (!upload.ok) {
    rows.push({
      snapshotId,
      reason: 'raw_upload_failed',
      detail: `key ${upload.key}: ${upload.reason}`,
    });
  }

  for (const warning of result.warnings) {
    rows.push({ snapshotId, reason: 'parser_warning', detail: warning });
  }

  return rows;
}
