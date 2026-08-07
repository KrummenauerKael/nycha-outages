import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_SLUG } from '@archive/config';
import {
  compressForStorage,
  storageConfigFromEnv,
  storageKeyFor,
  uploadSnapshot,
  type StorageConfig,
} from '../src/storage.js';

const SHA = 'a'.repeat(64);
const CONFIG: StorageConfig = {
  url: 'https://project.supabase.co',
  serviceRoleKey: 'test-key-not-a-real-credential',
  bucket: 'snapshots',
};

describe('storageKeyFor', () => {
  it('partitions by UTC date and suffixes with the body hash', () => {
    const key = storageKeyFor(new Date('2026-08-07T21:21:00.000Z'), SHA);
    expect(key).toBe(`${PROJECT_SLUG}/2026/08/07/2026-08-07T21-21Z-${'a'.repeat(12)}.html.gz`);
  });

  it('zero-pads single-digit months, days, hours and minutes', () => {
    expect(storageKeyFor(new Date('2026-01-02T03:04:00.000Z'), SHA)).toContain(
      '/2026/01/02/2026-01-02T03-04Z-',
    );
  });

  // Two fetches inside the same minute must not collide on one immutable key.
  it('separates two fetches in the same minute by hash', () => {
    const at = new Date('2026-08-07T21:21:30.000Z');
    expect(storageKeyFor(at, 'a'.repeat(64))).not.toBe(storageKeyFor(at, 'b'.repeat(64)));
  });

  // Storage layout is UTC on purpose: America/New_York would produce two 01:xx
  // hours on the autumn DST boundary and the keys would stop being monotonic.
  it('stays monotonic across the US DST boundary', () => {
    const before = storageKeyFor(new Date('2026-11-01T05:30:00.000Z'), SHA);
    const after = storageKeyFor(new Date('2026-11-01T06:30:00.000Z'), SHA);
    expect(before < after).toBe(true);
  });
});

describe('compressForStorage', () => {
  const html = `<html><input id="__VIEWSTATE" value="${'x'.repeat(5000)}" /><p>keep me</p></html>`;

  it('round-trips to the stripped body', () => {
    const { gzip } = compressForStorage(html);
    const back = gunzipSync(gzip).toString('utf8');

    expect(back).toContain('__STRIPPED__');
    expect(back).toContain('keep me');
    expect(back).not.toContain('x'.repeat(100));
  });

  it('reports the stored size and beats the original', () => {
    const { gzip, bytes } = compressForStorage(html);
    expect(bytes).toBe(gzip.byteLength);
    expect(bytes).toBeLessThan(Buffer.byteLength(html, 'utf8'));
  });
});

describe('storageConfigFromEnv', () => {
  it('names every missing variable at once', () => {
    expect(() => storageConfigFromEnv({})).toThrow(
      /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET/,
    );
  });

  // The value here is the literal word "placeholder" because scan-secrets.mjs
  // flags anything assigned to SUPABASE_SERVICE_ROLE_KEY that does not look like
  // a stand-in, and it is right to. Using its vocabulary beats an allow marker.
  it('reads a complete environment', () => {
    expect(
      storageConfigFromEnv({
        SUPABASE_URL: 'https://p.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'placeholder',
        SUPABASE_STORAGE_BUCKET: 'snapshots',
      }),
    ).toEqual({
      url: 'https://p.supabase.co',
      serviceRoleKey: 'placeholder',
      bucket: 'snapshots',
    });
  });
});

describe('uploadSnapshot', () => {
  const body = compressForStorage('<html></html>');

  it('POSTs to the object endpoint without upsert', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const outcome = await uploadSnapshot(CONFIG, 'k/e/y.html.gz', body, fetchImpl as typeof fetch);

    expect(outcome).toEqual({ ok: true, key: 'k/e/y.html.gz', bytes: body.bytes });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/storage/v1/object/snapshots/k/e/y.html.gz');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-upsert']).toBe('false');
    expect(headers['content-type']).toBe('application/gzip');
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await uploadSnapshot(
      { ...CONFIG, url: 'https://project.supabase.co/' },
      'k.gz',
      body,
      fetchImpl as typeof fetch,
    );
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://project.supabase.co/storage/v1/object/snapshots/k.gz',
    );
  });

  // A storage failure must never cost us the parsed data, which is the permanent
  // half of the archive. It is reported, not thrown.
  it('reports an HTTP failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('bucket not found', { status: 404 }));

    const outcome = await uploadSnapshot(CONFIG, 'k.gz', body, fetchImpl as typeof fetch);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ key: 'k.gz' });
    if (!outcome.ok) expect(outcome.reason).toContain('404');
  });

  it('reports a network error without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    const outcome = await uploadSnapshot(CONFIG, 'k.gz', body, fetchImpl as typeof fetch);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ECONNRESET');
  });

  it('never puts the service_role key in the failure reason', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403 }));

    const outcome = await uploadSnapshot(CONFIG, 'k.gz', body, fetchImpl as typeof fetch);

    if (!outcome.ok) expect(outcome.reason).not.toContain(CONFIG.serviceRoleKey);
  });
});
