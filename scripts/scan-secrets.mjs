#!/usr/bin/env node
/**
 * Zero-dependency secret scanner.
 *
 * The repo is public and carries live credentials in its environment: a
 * Supabase service_role key (bypasses RLS on every table), two Postgres URLs
 * with inline passwords, and the cron shared secret. Any one of those in a
 * commit is a rotation event, and git history is effectively permanent, so the
 * cheapest place to stop it is before the commit exists.
 *
 * Runs in three modes:
 *   --staged  (default)  what is about to be committed, read from the index
 *   --all                every tracked file in the working tree
 *   --history            every line ever added, across all reachable commits
 *
 * `--all` is not enough on its own: a credential deleted from the tip is still
 * live if it sits in an earlier commit, and the tree scan cannot see that.
 *
 * No dependencies on purpose: the pre-commit hook has to work on a clean clone
 * before anyone has run `pnpm install`.
 *
 * A line that genuinely must contain a matching string can opt out with the
 * marker `secret-scan:allow` on that line or the line above it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const ALLOW_MARKER = 'secret-scan:allow';
const MAX_BYTES = 2 * 1024 * 1024;

/** Files that must never be tracked, even if someone runs `git add -f`. */
const FORBIDDEN_PATHS = [
  { pattern: /(^|\/)\.env$/, why: 'local environment file' },
  { pattern: /(^|\/)\.env\.(?!example$)[^/]+$/, why: 'local environment file' },
  { pattern: /(^|\/)\.envrc$/, why: 'direnv environment file' },
  { pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i, why: 'key material' },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, why: 'private SSH key' },
];

/**
 * Content rules. Kept high-signal deliberately — a scanner that cries wolf gets
 * disabled, and a disabled scanner protects nothing.
 */
const RULES = [
  {
    id: 'private-key',
    why: 'PEM private key block',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  },
  {
    id: 'supabase-jwt',
    why: 'JWT — Supabase anon/service_role keys are JWTs',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    id: 'supabase-secret-key',
    why: 'Supabase API key',
    pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/,
  },
  {
    id: 'postgres-url-password',
    why: 'Postgres URL with an inline password',
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:/@]+:([^\s@/]+)@/,
    capture: 1,
  },
  {
    id: 'github-token',
    why: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  },
  {
    id: 'aws-access-key-id',
    why: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'npm-auth-token',
    why: 'npm registry auth token (.npmrc is tracked in this repo)',
    pattern: /_authToken\s*=\s*(\S+)/,
    capture: 1,
  },
  {
    id: 'assigned-secret',
    why: 'a secret env var assigned a real-looking value',
    pattern:
      /\b(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|CRON_SECRET|DATABASE_URL|DIRECT_DATABASE_URL|VERCEL_TOKEN|GITHUB_TOKEN|SUPABASE_ACCESS_TOKEN)\s*[=:]\s*["']?([^\s"',]+)/,
    capture: 2,
  },
];

/**
 * Values that look like credentials but are stand-ins. `.env.example` is meant
 * to be committed and is full of them.
 */
const PLACEHOLDER = [
  /^$/,
  /^[<{[(]/,
  /^(?:your|my|the)[-_]/i,
  /^(?:x{3,}|\*{3,}|\.{3,}|-{3,})$/i,
  /^(?:changeme|placeholder|redacted|example|dummy|fake|sample|todo|unset|null|none|secret|password|pass|pwd|token|key)$/i,
  /^[A-Z][A-Z0-9_]{2,}$/, // PROJECT_REF, PASSWORD, YOUR_KEY_HERE
  /^\$\{?[A-Za-z_]/, // ${VAR} / $VAR interpolation
  // GitHub Actions expressions: `SECRET: ${{ secrets.CRON_SECRET }}` is how a
  // workflow is SUPPOSED to reference a secret. Without this every correctly
  // written workflow trips the assigned-secret rule.
  /^\$\{\{/,
  // Values self-evidently fixtures. Prefixed rather than exact so a test can name
  // what it is testing — `test-secret`, `fake-token` — instead of being forced to
  // the bare word "placeholder" and losing the reason it exists.
  /^(?:test|fake|dummy|sample|example|placeholder|redacted|invalid)[-_]/i,
];

/** `scheme://user:password@host` — the only part worth judging is the password. */
const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/i;

function isPlaceholder(value) {
  // A connection string is judged by its password, not by the whole URL: the
  // host and database name in `.env.example` are legitimately concrete.
  const url = URL_PASSWORD.exec(value);
  if (url) return isPlaceholder(url[1]);

  return PLACEHOLDER.some((p) => p.test(value));
}

function run(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listStaged() {
  return run(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACM'])
    .split('\0')
    .filter(Boolean);
}

function listTracked() {
  return run(['ls-files', '-z']).split('\0').filter(Boolean);
}

function readStaged(path) {
  try {
    return run(['show', `:${path}`]);
  } catch {
    return null;
  }
}

function readWorktree(path) {
  try {
    if (statSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function looksBinary(text) {
  return text.includes('\0');
}

function scanContent(path, text) {
  const findings = [];
  const lines = text.split('\n');

  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue;
    if (index > 0 && lines[index - 1].includes(ALLOW_MARKER)) continue;
    if (line.length > 4000) continue;

    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (rule.capture && isPlaceholder(match[rule.capture] ?? '')) continue;

      findings.push({
        path,
        line: index + 1,
        rule: rule.id,
        why: rule.why,
        // Never echo the match itself — the log would become the leak.
        excerpt: `${match[0].slice(0, 6)}… (${match[0].length} chars)`,
      });
      break;
    }
  }

  return findings;
}

function scanPath(path) {
  const findings = [];

  for (const rule of FORBIDDEN_PATHS) {
    if (!rule.pattern.test(path)) continue;
    findings.push({
      path,
      line: 0,
      rule: 'forbidden-path',
      why: `${rule.why} must never be tracked`,
      excerpt: path,
    });
  }

  return findings;
}

/**
 * Every line ever added, commit by commit. Only `+` lines are examined: a line
 * that a commit merely deletes was already introduced by an earlier one, and
 * flagging it twice makes the report unreadable.
 */
function scanHistory() {
  const commits = run(['rev-list', '--all']).split('\n').filter(Boolean);
  const findings = [];

  for (const sha of commits) {
    const diff = run(['show', '--format=', '--unified=0', '--no-color', '--no-textconv', sha]);
    let file = '(unknown)';

    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) {
        file = line.slice(6);
        continue;
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      if (line.includes(ALLOW_MARKER)) continue;

      for (const hit of scanContent(`${sha.slice(0, 9)} ${file}`, line.slice(1))) {
        findings.push({ ...hit, line: 0 });
      }
    }
  }

  return { findings, count: commits.length, unit: 'commit' };
}

function scanFiles(mode) {
  const paths = mode === 'all' ? listTracked() : listStaged();
  const read = mode === 'all' ? readWorktree : readStaged;
  const findings = [];

  for (const path of paths) {
    findings.push(...scanPath(path));

    const text = read(path);
    if (text === null || looksBinary(text)) continue;
    findings.push(...scanContent(path, text));
  }

  return { findings, count: paths.length, unit: 'file' };
}

function main() {
  const mode = process.argv.includes('--history')
    ? 'history'
    : process.argv.includes('--all')
      ? 'all'
      : 'staged';

  const { findings, count, unit } = mode === 'history' ? scanHistory() : scanFiles(mode);

  if (findings.length === 0) {
    console.log(`secret scan: clean (${count} ${unit}(s), mode: ${mode})`);
    return;
  }

  console.error(`\nsecret scan: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    const where = f.line > 0 ? `${f.path}:${f.line}` : f.path;
    console.error(`  ${where}\n    ${f.rule} — ${f.why}\n    match: ${f.excerpt}\n`);
  }
  console.error('Nothing was committed. If a credential is real, rotate it before anything else');
  console.error('(SECURITY.md has the order). If this is a false positive, add the marker');
  console.error(`\`${ALLOW_MARKER}\` to that line and explain why in the commit message.\n`);
  process.exit(1);
}

main();
