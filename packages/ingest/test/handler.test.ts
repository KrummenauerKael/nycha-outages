import { describe, expect, it } from 'vitest';
import { DuplicateIdentityError, IngestValidationError, type IngestResult } from '../src/run';
import { handleIngest } from '../src/handler';
import { jsonSafe, redact, type CronRequest, type CronResponse } from '../src/http';

const SECRET = 'test-secret';
const env = { CRON_SECRET: SECRET };
const authorized: CronRequest = {
  method: 'GET',
  headers: { authorization: `Bearer ${SECRET}` },
};

function capture() {
  const captured: { code?: number; body?: unknown } = {};
  const res: CronResponse = {
    status(code) {
      captured.code = code;
      return res;
    },
    json(body) {
      captured.body = body;
    },
  };
  return { res, captured };
}

const result = {
  snapshotId: 42n,
  countsMatched: true,
  retainUntil: new Date('2026-09-06T12:00:00.000Z'),
  reviewCount: 0,
  countRows: 33,
  summaryRows: 24,
  duplicates: [],
  observations: {
    eventsInserted: 248,
    eventsBumped: 0,
    versionsInserted: 248,
    versionsBumped: 0,
    absencesRecorded: 0,
    serviceRows: 248,
    childRows: 90,
  },
  sha256: 'a'.repeat(64),
  httpStatus: 200,
  attempts: 1,
  storedBytes: 40556,
  storageKey: 'k.html.gz',
  parsedRows: 248,
  warnings: [],
} satisfies IngestResult;

describe('handleIngest, authorization', () => {
  it('401s an unauthorized caller without polling', async () => {
    const { res, captured } = capture();
    let polled = false;

    await handleIngest({ method: 'GET', headers: {} }, res, {
      env,
      ingest: async () => {
        polled = true;
        return result;
      },
    });

    expect(captured.code).toBe(401);
    expect(polled).toBe(false);
  });

  // 503 rather than 401: the caller did nothing wrong, and a broken deploy should
  // not look like an attacker being turned away.
  it('503s when the secret is not configured', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, { env: {}, ingest: async () => result });

    expect(captured.code).toBe(503);
    expect(captured.body).toMatchObject({ error: 'cron_secret_not_configured' });
  });

  it('405s an unexpected method', async () => {
    const { res, captured } = capture();

    await handleIngest({ method: 'DELETE', headers: {} }, res, { env, ingest: async () => result });

    expect(captured.code).toBe(405);
  });

  it('accepts POST, for the backstop and manual re-runs', async () => {
    const { res, captured } = capture();

    await handleIngest({ method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, res, {
      env,
      ingest: async () => result,
    });

    expect(captured.code).toBe(200);
  });
});

describe('handleIngest, success', () => {
  it('returns the summary with bigint ids as strings', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, { env, ingest: async () => result });

    expect(captured.code).toBe(200);
    expect(captured.body).toMatchObject({
      ok: true,
      // A raw bigint would make JSON.stringify throw and turn a good poll into a
      // 500; a JSON number would lose precision past 2^53.
      snapshotId: '42',
      parsedRows: 248,
    });
  });

  it('is serialisable, which a raw bigint would not be', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, { env, ingest: async () => result });

    expect(() => JSON.stringify(captured.body)).not.toThrow();
  });
});

describe('handleIngest, failures', () => {
  // 500 on purpose: the data is safe, but invariant 3 is only useful if the run
  // visibly fails in Vercel's cron log and the Actions run.
  it('500s a count mismatch and names the committed snapshot', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, {
      env,
      ingest: () => {
        throw new IngestValidationError('mismatch', 7n, [
          { category: 'elevator', subTable: 'current', declared: 3, parsed: 2 },
        ]);
      },
    });

    expect(captured.code).toBe(500);
    expect(captured.body).toMatchObject({
      ok: false,
      error: 'counts_mismatch',
      snapshotId: '7',
    });
  });

  it('500s a duplicate identity', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, {
      env,
      ingest: () => {
        throw new DuplicateIdentityError('collision', 9n, [{ identity: 'a'.repeat(64), rows: [] }]);
      },
    });

    expect(captured.code).toBe(500);
    expect(captured.body).toMatchObject({ error: 'duplicate_identity', snapshotId: '9' });
  });

  it('never returns a connection string in an error message', async () => {
    const { res, captured } = capture();

    await handleIngest(authorized, res, {
      env,
      ingest: () => {
        throw new Error(
          'connect ECONNREFUSED postgresql://postgres.ref:test-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
        );
      },
    });

    expect(captured.code).toBe(500);
    const body = JSON.stringify(captured.body);
    expect(body).not.toContain('test-password');
    expect(body).toContain('<redacted-connection-string>');
  });
});

describe('jsonSafe', () => {
  it('converts bigints and dates through nested structures', () => {
    expect(
      jsonSafe({ id: 1n, at: new Date('2026-01-01T00:00:00.000Z'), xs: [2n, { y: 3n }] }),
    ).toEqual({ id: '1', at: '2026-01-01T00:00:00.000Z', xs: ['2', { y: '3' }] });
  });

  it('leaves null and primitives alone', () => {
    expect(jsonSafe({ a: null, b: 1, c: 'x', d: false })).toEqual({
      a: null,
      b: 1,
      c: 'x',
      d: false,
    });
  });
});

describe('redact', () => {
  it('removes a connection string', () => {
    expect(redact('postgres://u:test-password@h:5432/d failed')).toContain(
      '<redacted-connection-string>',
    );
  });

  it('removes a JWT', () => {
    expect(redact('key eyJhbGciOi.eyJyb2xlIjo.c2lnbmF0dXJl here')).toContain('<redacted-jwt>');
  });

  /**
   * Assembled at runtime so the source carries no literal key shape. The
   * `supabase-secret-key` rule has no placeholder escape, and correctly so — there
   * is no harmless-looking real prefix for that pattern, unlike a password field
   * where "test-password" is self-evidently a fixture.
   */
  it('removes a Supabase secret key', () => {
    const fake = ['sb', 'secret', 'abcdefgh12345678'].join('_');
    expect(redact(`${fake} leaked`)).toContain('<redacted-key>');
  });

  it('leaves an ordinary message untouched', () => {
    expect(redact('ECONNRESET')).toBe('ECONNRESET');
  });
});
