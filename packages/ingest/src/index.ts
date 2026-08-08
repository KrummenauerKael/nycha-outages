export { RAW_RETENTION_DAYS, decideRetention, type RetentionInput } from './retention';
export {
  compressForStorage,
  storageConfigFromEnv,
  storageKeyFor,
  uploadSnapshot,
  type CompressedBody,
  type StorageConfig,
  type UploadOutcome,
} from './storage';
export {
  buildCountRows,
  buildReviewRows,
  buildSnapshotRow,
  buildSummaryRows,
  countsMatch,
  type SnapshotRowInput,
} from './rows';
export {
  duplicateIdentities,
  identify,
  type DuplicateIdentity,
  type IdentifiedObservation,
} from './identify';
export {
  persistObservations,
  type ObservationWriteInput,
  type ObservationWriteSummary,
} from './observations';
export { persistSnapshot, type PersistInput, type PersistedSnapshot } from './persist';
export type { Tx } from './tx';
export {
  DuplicateIdentityError,
  IngestValidationError,
  runIngest,
  type IngestDeps,
  type IngestResult,
} from './run';

/**
 * The HTTP endpoint. Deliberately transport-agnostic: `handleIngest` speaks the
 * minimal `(req, res)` shape in `http.ts`, not any framework's types, so the
 * Next route handler in `apps/web` is a ten-line adapter and the whole endpoint
 * stays testable with plain objects.
 */
export { handleIngest, type HandlerDeps } from './handler';
export { checkAuth, type AuthResult } from './auth';
export { jsonSafe, redact, type CronRequest, type CronResponse } from './http';
