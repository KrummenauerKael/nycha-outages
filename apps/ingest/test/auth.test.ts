import { describe, expect, it } from 'vitest';
import { checkAuth } from '../src/auth.js';
import type { CronRequest } from '../src/http.js';

const SECRET = 'test-secret';

const req = (authorization?: string | string[]): CronRequest => ({
  method: 'GET',
  headers: authorization === undefined ? {} : { authorization },
});

describe('checkAuth', () => {
  it('accepts the configured bearer token', () => {
    expect(checkAuth(req(`Bearer ${SECRET}`), { CRON_SECRET: SECRET })).toBe('ok');
  });

  it('rejects a wrong token', () => {
    expect(checkAuth(req('Bearer nope'), { CRON_SECRET: SECRET })).toBe('denied');
  });

  it('rejects a missing header', () => {
    expect(checkAuth(req(), { CRON_SECRET: SECRET })).toBe('denied');
  });

  it('rejects the bare secret without the Bearer scheme', () => {
    expect(checkAuth(req(SECRET), { CRON_SECRET: SECRET })).toBe('denied');
  });

  it('rejects a duplicated header arriving as an array', () => {
    expect(checkAuth(req([`Bearer ${SECRET}`, `Bearer ${SECRET}`]), { CRON_SECRET: SECRET })).toBe(
      'denied',
    );
  });

  it('is case sensitive on the scheme', () => {
    expect(checkAuth(req(`bearer ${SECRET}`), { CRON_SECRET: SECRET })).toBe('denied');
  });

  /**
   * The route is a public URL that writes to the archive and polls a public
   * agency under our User-Agent. An unset secret must never read as "allow all".
   */
  it('fails closed when CRON_SECRET is unset', () => {
    expect(checkAuth(req('Bearer anything'), {})).toBe('unconfigured');
  });

  it('fails closed when CRON_SECRET is empty', () => {
    expect(checkAuth(req('Bearer '), { CRON_SECRET: '' })).toBe('unconfigured');
  });

  // Neither a prefix nor an extension may pass. Hashing before the comparison is
  // what removes the length signal a raw timingSafeEqual would leak by throwing.
  it('rejects a prefix of the correct token', () => {
    expect(checkAuth(req('Bearer test-secre'), { CRON_SECRET: SECRET })).toBe('denied');
  });

  it('rejects a token with trailing content', () => {
    expect(checkAuth(req(`Bearer ${SECRET}x`), { CRON_SECRET: SECRET })).toBe('denied');
  });
});
