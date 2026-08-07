import { createHash } from 'node:crypto';
import { CRAWL, SOURCE, userAgent } from '@archive/config';

export interface FetchedPage {
  url: string;
  httpStatus: number;
  /** Full response body, exactly as received. */
  html: string;
  /** sha256 of the untouched body — provenance survives VIEWSTATE stripping. */
  sha256: string;
  fetchedAt: Date;
  attempts: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * __VIEWSTATE is ~143 KB of encrypted base64. It is incompressible (it accounts
 * for roughly three quarters of the gzipped archive) and useless for re-parsing,
 * since it is opaque server state. We keep the document byte-for-byte otherwise
 * and record the sha256 of the original body for integrity.
 */
export function stripViewState(html: string): string {
  return html.replace(
    /(id="__VIEWSTATE"\s+value=")[^"]*(")/,
    (_m, open: string, close: string) => `${open}__STRIPPED__${close}`,
  );
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Fetch the outages page. Network only — no parsing, no storage. Serial by
 * construction; the caller must not run these concurrently against the origin.
 */
export async function fetchOutagesPage(url: string = SOURCE.outagesUrl): Promise<FetchedPage> {
  // Resolved once, before the loop: a missing contact address is a configuration
  // fault, not a transient one. Inside the loop it would be swallowed by the
  // retry catch and surface four attempts later as a bogus network error.
  const ua = userAgent();
  let lastError: unknown;

  for (let attempt = 1; attempt <= CRAWL.maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': ua,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(CRAWL.timeoutMs),
      });

      const html = await response.text();

      if (isRetryable(response.status) && attempt < CRAWL.maxAttempts) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(CRAWL.backoffBaseMs * 2 ** (attempt - 1));
        continue;
      }

      return {
        url,
        httpStatus: response.status,
        html,
        sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
        fetchedAt: new Date(),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < CRAWL.maxAttempts) {
        await sleep(CRAWL.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${CRAWL.maxAttempts} attempts`, {
    cause: lastError,
  });
}
