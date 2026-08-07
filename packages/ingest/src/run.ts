import type { Db } from '@archive/db/client';
import {
  fetchOutagesPage,
  parseOutagesPage,
  type FetchedPage,
  type ParseResult,
} from '@archive/parser';
import { persistSnapshot, type PersistedSnapshot } from './persist.js';
import {
  compressForStorage,
  storageConfigFromEnv,
  storageKeyFor,
  uploadSnapshot,
  type StorageConfig,
  type UploadOutcome,
} from './storage.js';

/**
 * Invariant 3: a count mismatch fails the run.
 *
 * Thrown only after the snapshot has been committed, so the evidence outlives the
 * failure. `snapshotId` is on the error because the first thing anyone will want
 * is the row that proves what happened.
 */
export class IngestValidationError extends Error {
  override readonly name = 'IngestValidationError';

  constructor(
    message: string,
    readonly snapshotId: bigint,
    readonly detail: ParseResult['counts'],
  ) {
    super(message);
  }
}

export interface IngestResult extends PersistedSnapshot {
  sha256: string;
  httpStatus: number;
  attempts: number;
  storedBytes: number | null;
  storageKey: string | null;
  observations: number;
  warnings: string[];
}

export interface IngestDeps {
  db: Db;
  /** Injected in tests. Defaults to the real network fetch. */
  fetchPage?: () => Promise<FetchedPage>;
  /** Injected in tests. Defaults to the real Storage upload. */
  upload?: (key: string, page: FetchedPage) => Promise<UploadOutcome>;
  storage?: StorageConfig;
}

/**
 * One poll: fetch, parse, validate, store the raw body, write the snapshot.
 *
 * Ordering is the whole design here.
 *
 * 1. Fetch, then parse. Never interleaved — invariant 6 keeps the fetcher
 *    ignorant of markup so a parser change can never affect what was collected.
 * 2. Compute the count check WITHOUT throwing. `assertCountsMatch` throws, which
 *    is right for a caller that only wants to know; it is wrong here, because
 *    aborting now would discard the one snapshot that documents the regression.
 * 3. Upload the raw body. Failure is recorded, not fatal — the parsed half is
 *    the permanent half.
 * 4. Commit everything in one transaction.
 * 5. Only then, if the counts disagreed, throw. The run fails loudly and the
 *    archive keeps the proof.
 *
 * Writes at the observation and event level — the change-only path — are not part
 * of this step and land next.
 */
export async function runIngest(deps: IngestDeps): Promise<IngestResult> {
  const { db } = deps;

  const page = await (deps.fetchPage ?? (() => fetchOutagesPage()))();
  const result: ParseResult = parseOutagesPage(page.html);

  const key = storageKeyFor(page.fetchedAt, page.sha256);

  const upload = await (
    deps.upload ??
    (async (k: string, p: FetchedPage) => {
      const config = deps.storage ?? storageConfigFromEnv();
      return uploadSnapshot(config, k, compressForStorage(p.html));
    })
  )(key, page);

  const persisted = await persistSnapshot(db, { page, result, upload });

  const ingest: IngestResult = {
    ...persisted,
    sha256: page.sha256,
    httpStatus: page.httpStatus,
    attempts: page.attempts,
    storedBytes: upload.ok ? upload.bytes : null,
    storageKey: upload.ok ? upload.key : null,
    observations: result.observations.length,
    warnings: result.warnings,
  };

  if (!persisted.countsMatched) {
    const bad = result.counts.filter((c) => c.declared !== null && c.declared !== c.parsed);
    throw new IngestValidationError(
      `Parsed row count does not match the count NYCHA displays. Snapshot ${persisted.snapshotId} ` +
        `was committed and its raw body will be kept indefinitely for reparsing. ` +
        bad
          .map((c) => `${c.category}/${c.subTable}: declared ${c.declared}, parsed ${c.parsed}`)
          .join('; '),
      persisted.snapshotId,
      bad,
    );
  }

  return ingest;
}
