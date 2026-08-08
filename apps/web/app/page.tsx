import { CATEGORIES, SERVICES } from '@archive/parser';
import { redact } from '@archive/ingest';
import { archiveHealth } from '@archive/db/queries';
import {
  developmentNames,
  developmentTotals,
  durationSources,
  timeSeries,
} from '@archive/db/metrics';
import { withDb } from '@/db';
import {
  CATEGORY_LABELS,
  GRANULARITIES,
  GRANULARITY_LABELS,
  SERVICE_LABELS,
  readParams,
} from '@/filters';

/**
 * Scaffolding, not a design.
 *
 * Unstyled semantic HTML. The structure, the copy and the honesty rules are the
 * work here; the visual language should be derived from the subject later and
 * nothing in this file should survive into it by inertia.
 *
 * The copy is not placeholder, though. Every caveat below exists because the
 * number it sits next to is easy to misread, and a public-accountability figure
 * that gets misread is worse than one nobody sees.
 */

export const dynamic = 'force-dynamic';

const num = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * Records a read failure to the server log and returns nothing to the caller.
 *
 * Nothing technical reaches the page. Earlier this rendered the error itself,
 * which put a full SQL statement — and, on a connection failure, potentially
 * the connection string postgres.js quotes back — in front of every visitor.
 * Internals are for the operator; a resident checking whether their building
 * is on the list needs a sentence, not a stack trace.
 *
 * drizzle wraps driver errors and puts the whole statement in `.message`,
 * leaving the actual reason in `.cause`, so the log takes the cause. `redact`
 * still runs: Vercel's logs are not public but they are retained, and a
 * credential written down anywhere is a credential to rotate.
 */
function logReadFailure(error: unknown): void {
  const detail =
    error instanceof Error
      ? error.cause instanceof Error
        ? error.cause.message
        : error.message
      : String(error);
  console.error('[dashboard] archive read failed:', redact(detail));
}

/** Hours are more legible as days once they run long. */
function hours(value: number): string {
  if (value < 48) return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} hrs`;
  return `${num(value)} hrs (${(value / 24).toLocaleString('en-US', { maximumFractionDigits: 1 })} days)`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { granularity, filter, selected } = readParams(await searchParams);

  let data;
  try {
    /**
     * One connection, opened and closed inside this request, with the queries
     * run in series rather than concurrently.
     *
     * Concurrency here bought nothing: each query returns in tens of
     * milliseconds, so five in series is still well under half a second, and a
     * single connection cannot go stale between them. `withDb` throws
     * synchronously on a missing DATABASE_URL, which is why the call sits
     * inside the try rather than above it.
     */
    data = await withDb(async (db) => ({
      health: await archiveHealth(db),
      developments: await developmentNames(db),
      series: await timeSeries(db, granularity, filter),
      totals: await developmentTotals(db, filter, 50),
      sources: await durationSources(db, filter),
    }));
  } catch (error) {
    logReadFailure(error);
    return (
      <main>
        <h1>NYCHA service interruptions</h1>
        <p>Data unavailable. This is a fault on our side, not a report of zero interruptions.</p>
        <p>Collection is unaffected. Try again shortly.</p>
      </main>
    );
  }

  const { health, developments, series, totals, sources } = data;

  const totalOutageHours = series.reduce((sum, b) => sum + b.outageHours, 0);
  const totalResidentHours = series.reduce((sum, b) => sum + b.residentHours, 0);
  const totalWithoutFigures = totals.reduce((sum, d) => sum + d.outagesWithoutImpactFigures, 0);
  const distinctOutages = totals.reduce((sum, d) => sum + d.outages, 0);

  return (
    <main>
      <h1>NYCHA service interruptions</h1>

      {health.snapshots === 0 ? (
        <p>No data collected yet.</p>
      ) : (
        <p>
          {num(health.snapshots)} hourly readings since{' '}
          <time>{health.firstFetchedAt?.toISOString().slice(0, 10)}</time>. Earlier periods are not
          covered.
        </p>
      )}

      <section>
        <h2>Filter</h2>
        <form method="get">
          <p>
            <label htmlFor="development">Development</label>{' '}
            <select id="development" name="development" defaultValue={selected.development}>
              <option value="">All</option>
              {developments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="category">Category</label>{' '}
            <select id="category" name="category" defaultValue={selected.category}>
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="service">Service</label>{' '}
            <select id="service" name="service" defaultValue={selected.service}>
              <option value="">All</option>
              {SERVICES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LABELS[s]}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="granularity">Group by</label>{' '}
            <select id="granularity" name="granularity" defaultValue={granularity}>
              {GRANULARITIES.map((g) => (
                <option key={g} value={g}>
                  {GRANULARITY_LABELS[g]}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="from">From</label>{' '}
            <input id="from" type="date" name="from" defaultValue={selected.from} />{' '}
            <label htmlFor="to">To</label>{' '}
            <input id="to" type="date" name="to" defaultValue={selected.to} />
          </p>

          <p>
            <button type="submit">Apply</button> <a href="/">Reset</a>
          </p>
        </form>
      </section>

      <section>
        <h2>Totals</h2>
        {distinctOutages === 0 ? (
          <p>No interruptions match this filter.</p>
        ) : (
          <>
            <dl>
              <dt>Interruptions</dt>
              <dd>{num(distinctOutages)}</dd>
              <dt>Time without service</dt>
              <dd>{hours(totalOutageHours)}</dd>
              <dt>Resident-hours (floor)</dt>
              <dd>{num(totalResidentHours)}</dd>
              <dt>Duration from NYCHA</dt>
              <dd>{num(sources.nychaReported)}</dd>
              <dt>Duration measured here</dt>
              <dd>{num(sources.observed)}</dd>
              <dt>Unresolved</dt>
              <dd>{num(sources.ongoing)}</dd>
            </dl>
            {totalWithoutFigures > 0 && (
              <p>
                <small>
                  Floor excludes {num(totalWithoutFigures)} interruptions with no published resident
                  figures.
                </small>
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <h2>{GRANULARITY_LABELS[granularity]}</h2>
        {series.length === 0 ? (
          <p>No data for this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Interruptions</th>
                <th scope="col">Hours</th>
                <th scope="col">Resident-hours</th>
                <th scope="col">Average</th>
                <th scope="col">Unresolved</th>
              </tr>
            </thead>
            <tbody>
              {series.map((bucket) => (
                <tr key={bucket.bucket}>
                  <th scope="row">{bucket.bucket}</th>
                  <td>{num(bucket.outages)}</td>
                  <td>{hours(bucket.outageHours)}</td>
                  <td>{num(bucket.residentHours)}</td>
                  <td>{hours(bucket.averageHoursPerOutage)}</td>
                  <td>{num(bucket.ongoingOutages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <small>
            Interruptions appear in every period they span, so the column is not additive.
          </small>
        </p>
      </section>

      <section>
        <h2>By development</h2>
        {totals.length === 0 ? (
          <p>No interruptions match this filter.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Development</th>
                <th scope="col">Borough</th>
                <th scope="col">Interruptions</th>
                <th scope="col">Hours</th>
                <th scope="col">Resident-hours</th>
                <th scope="col">Average</th>
                <th scope="col">No figures</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((row) => (
                <tr key={row.development}>
                  <th scope="row">
                    <a
                      href={`/?development=${encodeURIComponent(row.development)}&granularity=${granularity}`}
                    >
                      {row.development}
                    </a>
                  </th>
                  <td>{row.borough ?? ''}</td>
                  <td>{num(row.outages)}</td>
                  <td>{hours(row.outageHours)}</td>
                  <td>{num(row.residentHours)}</td>
                  <td>{hours(row.averageHoursPerOutage)}</td>
                  <td>{num(row.outagesWithoutImpactFigures)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
