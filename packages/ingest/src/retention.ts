/**
 * Retention policy for raw HTML. Invariant 6: the raw body is transient, parsed
 * data is permanent.
 *
 * The window exists for exactly one purpose — so a mid-season markup change can
 * be noticed and the affected snapshots reparsed before the evidence is gone.
 * Once it closes, a parser bug found later cannot be fixed retroactively. That
 * is accepted deliberately, which is why validation on the way in is strict.
 */

/**
 * Days a healthy snapshot's raw body is kept. Long enough that a markup change
 * spanning a weekend plus a working week is still recoverable, short enough that
 * hourly collection stays inside Supabase Free's 1 GB storage cap.
 */
export const RAW_RETENTION_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface RetentionInput {
  fetchedAt: Date;
  /** Invariant 3 — did NYCHA's printed counts match what we parsed? */
  countsMatched: boolean;
  /** Anything queued for a human. Non-zero means this snapshot may need reparsing. */
  reviewCount: number;
}

/**
 * When the raw body becomes eligible for deletion, or null to keep it forever.
 *
 * Null is returned for anything that failed validation or queued a review, per
 * the `snapshot` table's contract: those are the only snapshots anyone would
 * ever reparse, and they are rare enough to be free. Everything else expires.
 */
export function decideRetention({
  fetchedAt,
  countsMatched,
  reviewCount,
}: RetentionInput): Date | null {
  if (!countsMatched || reviewCount > 0) return null;
  return new Date(fetchedAt.getTime() + RAW_RETENTION_DAYS * MS_PER_DAY);
}
