/**
 * The ONLY module in this repo that carries naming, attribution or contact
 * details. Everything else — schema, parser, fetcher, scripts — stays neutral,
 * so the project can be renamed or handed over by editing this file alone.
 *
 * No identity is hardcoded here. The repo is public; the contact address is
 * supplied through the environment so it never enters git history.
 */

/** Short, neutral identifier. Used in the User-Agent and storage key prefix. */
export const PROJECT_SLUG = 'nycha-outage-archive';

/** Human-readable name, for docs and any future UI. */
export const PROJECT_NAME = 'NYCHA Service Interruption Archive';

/** Env var carrying the address published to the origin. Never committed. */
export const CONTACT_EMAIL_ENV = 'ARCHIVE_CONTACT_EMAIL';

/**
 * Thrown when outbound identity cannot be established. Crawling a public
 * agency without a reachable human on the other end is not acceptable, so this
 * is fatal rather than a warning — see invariant 7, fail loudly.
 */
export class MissingContactEmailError extends Error {
  override readonly name = 'MissingContactEmailError';

  constructor(reason: string) {
    super(
      `${reason} Set ${CONTACT_EMAIL_ENV} to a monitored address before running the fetcher. ` +
        'It is intentionally not committed: see .env.example and SECURITY.md.',
    );
  }
}

/**
 * Deliberately conservative. A User-Agent is a header, so anything that could
 * terminate or split it (whitespace, quotes, commas, angle brackets, control
 * characters) is rejected outright rather than escaped.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>()[\]\\"]+@[^\s@,;:<>()[\]\\".]+(\.[^\s@,;:<>()[\]\\".]+)+$/;

/**
 * Reserved TLDs that can never receive mail (RFC 2606, RFC 6761) plus the
 * conventional stand-ins. Without this the original placeholder
 * (`unset@example.invalid`) could be pasted into the env var to silence the
 * check, which defeats the point of having one.
 */
const UNREACHABLE_TLDS = new Set([
  'invalid',
  'example',
  'test',
  'local',
  'localhost',
  'localdomain',
  'internal',
]);

/** Second-level stand-ins reserved for documentation. */
const UNREACHABLE_DOMAINS = new Set(['example.com', 'example.net', 'example.org']);

function validate(candidate: string): string {
  if (!EMAIL_PATTERN.test(candidate)) {
    throw new MissingContactEmailError(`${CONTACT_EMAIL_ENV} is not a usable email address.`);
  }

  const domain = candidate.slice(candidate.lastIndexOf('@') + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (UNREACHABLE_DOMAINS.has(domain) || UNREACHABLE_TLDS.has(tld)) {
    throw new MissingContactEmailError(
      `${CONTACT_EMAIL_ENV} points at the unreachable domain "${domain}".`,
    );
  }

  return candidate;
}

/**
 * Contact address published in the outbound User-Agent so NYCHA can reach a
 * human. Throws if unset, malformed, or pointed at a reserved domain — there is
 * no fallback by design, because a silent fallback means crawling anonymously.
 */
export function contactEmail(): string {
  const raw = process.env[CONTACT_EMAIL_ENV]?.trim();

  if (!raw) {
    throw new MissingContactEmailError(`${CONTACT_EMAIL_ENV} is not set.`);
  }

  return validate(raw);
}

/**
 * Non-throwing probe, for startup checks and diagnostics that want to report
 * configuration state rather than abort. Anything that actually touches the
 * network must use {@link contactEmail}.
 */
export function contactEmailOrNull(): string | null {
  try {
    return contactEmail();
  } catch (error) {
    if (error instanceof MissingContactEmailError) return null;
    throw error;
  }
}

/**
 * Descriptive User-Agent for polite crawling. NYCHA publishes no robots.txt
 * (verified 404 on 2026-08-06), so there is no directive to honour, but we
 * still identify ourselves and stay well under any reasonable rate.
 */
export function userAgent(): string {
  return `${PROJECT_SLUG}/1.0 (+mailto:${contactEmail()}) research archival; contact for removal`;
}

/** Upstream source. */
export const SOURCE = {
  name: 'New York City Housing Authority (NYCHA)',
  outagesUrl: 'https://my.nycha.info/Outages/Outages.aspx',
  origin: 'https://my.nycha.info',
} as const;

/** Politeness settings applied by the fetcher. */
export const CRAWL = {
  /** Milliseconds between successive requests to the origin. Serial only. */
  delayMs: 2_000,
  /** Per-request timeout. */
  timeoutMs: 45_000,
  /** Retry attempts on transient failure, with exponential backoff. */
  maxAttempts: 4,
  backoffBaseMs: 1_000,
} as const;
