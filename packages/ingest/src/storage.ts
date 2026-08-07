import { gzipSync } from 'node:zlib';
import { PROJECT_SLUG } from '@archive/config';
import { stripViewState } from '@archive/parser';

/**
 * Supabase Storage upload, over the REST API with no SDK.
 *
 * `@supabase/supabase-js` would pull a dependency tree in to do one PUT. The
 * same reasoning as `scripts/scan-secrets.mjs`: the fewer things that sit between
 * this process and the credential it holds, the better.
 */

/** Two-digit zero pad, for building the object key. */
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Object key for a snapshot: date-partitioned so a month can be listed or swept
 * without walking the whole bucket, and suffixed with the body hash so two
 * fetches in the same minute cannot collide.
 *
 * Uses UTC throughout. NYCHA's own timestamps are America/New_York and are kept
 * raw for the parser to deal with; storage layout deliberately does not inherit
 * that, so keys stay monotonic across DST.
 */
export function storageKeyFor(fetchedAt: Date, sha256: string): string {
  const y = fetchedAt.getUTCFullYear();
  const m = pad(fetchedAt.getUTCMonth() + 1);
  const d = pad(fetchedAt.getUTCDate());
  const hh = pad(fetchedAt.getUTCHours());
  const mm = pad(fetchedAt.getUTCMinutes());

  return `${PROJECT_SLUG}/${y}/${m}/${d}/${y}-${m}-${d}T${hh}-${mm}Z-${sha256.slice(0, 12)}.html.gz`;
}

export interface CompressedBody {
  gzip: Buffer;
  /** Bytes actually stored, for tracking against the 1 GB cap. */
  bytes: number;
}

/**
 * Strip `__VIEWSTATE` then gzip. Order matters: the 143 KB of encrypted base64 is
 * incompressible, so stripping first is what makes the archive affordable. The
 * sha256 recorded on the snapshot row is of the ORIGINAL body and is computed by
 * the fetcher before this runs, so provenance survives the edit.
 */
export function compressForStorage(html: string): CompressedBody {
  const gzip = gzipSync(Buffer.from(stripViewState(html), 'utf8'), { level: 9 });
  return { gzip, bytes: gzip.byteLength };
}

export interface StorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

/**
 * Reads storage configuration from the environment. Throws rather than defaulting,
 * for the same reason `createDb` does: a run that uploads nowhere but reports
 * success is worse than a run that fails.
 */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const url = env['SUPABASE_URL'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  const bucket = env['SUPABASE_STORAGE_BUCKET'];

  const missing = [
    url ? null : 'SUPABASE_URL',
    serviceRoleKey ? null : 'SUPABASE_SERVICE_ROLE_KEY',
    bucket ? null : 'SUPABASE_STORAGE_BUCKET',
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(
      `Storage is not configured: ${missing.join(', ')} unset. See .env.example. ` +
        'The bucket must be private; these tables and objects have no public read path.',
    );
  }

  // Narrowed by the check above; the non-null assertions are what the compiler
  // needs to see it.
  return { url: url!, serviceRoleKey: serviceRoleKey!, bucket: bucket! };
}

export type UploadOutcome =
  { ok: true; key: string; bytes: number } | { ok: false; key: string; reason: string };

/**
 * PUT the gzipped body at `key`.
 *
 * Never throws. A storage failure must not lose the parsed data, which is the
 * permanent half of the archive — the caller records the failure on the snapshot
 * row (null `storage_key`) and queues it for review instead. Invariant 7 allows
 * either throwing or queueing; queueing is right here, because an hourly cron
 * that dies on a transient 503 loses a poll it can never retake.
 */
export async function uploadSnapshot(
  config: StorageConfig,
  key: string,
  body: CompressedBody,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadOutcome> {
  const endpoint = `${config.url.replace(/\/+$/, '')}/storage/v1/object/${config.bucket}/${key}`;

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        'content-type': 'application/gzip',
        // Snapshots are immutable. An overwrite would mean two different fetches
        // resolved to one key, which is a bug worth surfacing, not smoothing over.
        'x-upsert': 'false',
        'cache-control': 'max-age=31536000, immutable',
      },
      body: new Uint8Array(body.gzip),
    });

    if (!response.ok) {
      // Read the body for the message but never echo headers — the request
      // carried the service_role key.
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        key,
        reason: `HTTP ${response.status} ${detail.slice(0, 200)}`.trim(),
      };
    }

    return { ok: true, key, bytes: body.bytes };
  } catch (error) {
    return { ok: false, key, reason: error instanceof Error ? error.message : String(error) };
  }
}
