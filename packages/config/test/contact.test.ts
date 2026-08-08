import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTACT_EMAIL_ENV,
  MissingContactEmailError,
  PROJECT_SLUG,
  contactEmail,
  contactEmailOrNull,
  userAgent,
} from '../src/index.js';

const original = process.env[CONTACT_EMAIL_ENV];

function setContact(value: string | undefined): void {
  if (value === undefined) delete process.env[CONTACT_EMAIL_ENV];
  else process.env[CONTACT_EMAIL_ENV] = value;
}

afterEach(() => setContact(original));

describe('contactEmail', () => {
  it('returns the configured address', () => {
    setContact('archive@nycha-outages.org');
    expect(contactEmail()).toBe('archive@nycha-outages.org');
  });

  it('trims surrounding whitespace', () => {
    setContact('  archive@nycha-outages.org \n');
    expect(contactEmail()).toBe('archive@nycha-outages.org');
  });

  it('accepts plus-addressing and subdomains', () => {
    setContact('me+nycha@mail.example-host.co.uk');
    expect(contactEmail()).toBe('me+nycha@mail.example-host.co.uk');
  });

  it('throws when unset', () => {
    setContact(undefined);
    expect(() => contactEmail()).toThrow(MissingContactEmailError);
  });

  it('throws when empty or whitespace only', () => {
    setContact('   ');
    expect(() => contactEmail()).toThrow(MissingContactEmailError);
  });

  it.each([
    'not-an-email',
    'missing-domain@',
    '@missing-local.org',
    'no-tld@localhostish',
    'two@at@signs.org',
  ])('rejects the malformed address %j', (value) => {
    setContact(value);
    expect(() => contactEmail()).toThrow(MissingContactEmailError);
  });

  // A header injected through the User-Agent would let the env var forge
  // arbitrary request headers, so these must never pass validation.
  it.each(['a@b.org\r\nX-Injected: 1', 'a@b.org, c@d.org', 'a b@c.org', '"quoted"@c.org'])(
    'rejects the header-unsafe address %j',
    (value) => {
      setContact(value);
      expect(() => contactEmail()).toThrow(MissingContactEmailError);
    },
  );

  // The old fallback value must not work as a way to silence the check.
  it.each(['unset@example.invalid', 'me@example.com', 'me@example.org', 'me@localhost.local'])(
    'rejects the unreachable address %j',
    (value) => {
      setContact(value);
      expect(() => contactEmail()).toThrow(/unreachable domain/i);
    },
  );

  // Bare hostnames fail the format check first; either way they never ship.
  it.each(['me@localhost', 'me@test'])('rejects the bare hostname %j', (value) => {
    setContact(value);
    expect(() => contactEmail()).toThrow(MissingContactEmailError);
  });

  it('names the env var and the docs in the failure message', () => {
    setContact(undefined);
    expect(() => contactEmail()).toThrow(/ARCHIVE_CONTACT_EMAIL/);
    // Points at a file that ships in the repo. SECURITY.md used to be named
    // here, but it is no longer published, so it cannot help a reader.
    expect(() => contactEmail()).toThrow(/\.env\.example/);
  });
});

describe('contactEmailOrNull', () => {
  it('returns null instead of throwing when unset', () => {
    setContact(undefined);
    expect(contactEmailOrNull()).toBeNull();
  });

  it('returns the address when valid', () => {
    setContact('archive@nycha-outages.org');
    expect(contactEmailOrNull()).toBe('archive@nycha-outages.org');
  });
});

describe('userAgent', () => {
  it('embeds the slug and the contact address', () => {
    setContact('archive@nycha-outages.org');
    const ua = userAgent();
    expect(ua).toContain(PROJECT_SLUG);
    expect(ua).toContain('+mailto:archive@nycha-outages.org');
  });

  it('contains no control characters that could split the header', () => {
    setContact('archive@nycha-outages.org');
    // eslint-disable-next-line no-control-regex
    expect(userAgent()).not.toMatch(/[\u0000-\u001f]/);
  });

  it('refuses to build a User-Agent without a contact address', () => {
    setContact(undefined);
    expect(() => userAgent()).toThrow(MissingContactEmailError);
  });
});
