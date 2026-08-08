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
        <h1>NYCHA service interruption archive</h1>
        <h2>This page can&rsquo;t load the archive right now</h2>
        <p>
          Something on our side is failing, and we would rather show you nothing than show you
          numbers we cannot stand behind.
        </p>
        <p>
          <strong>This does not mean there are no service interruptions.</strong> It means this page
          cannot currently read the record. Collection continues in the background either way, so
          nothing is being lost while this is broken.
        </p>
        <p>Please try again in a few minutes.</p>
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
      <h1>NYCHA service interruption archive</h1>
      <p>
        NYCHA publishes which buildings currently have no heat, hot water, water, elevator,
        electricity or gas — but only right now, with no history. This archive records that page
        every hour so the question &ldquo;how long did this go on?&rdquo; can be answered at all.
      </p>

      {health.snapshots === 0 ? (
        <p>
          <strong>Nothing has been collected yet.</strong> No conclusions can be drawn from this
          page.
        </p>
      ) : (
        <p>
          Collecting since <time>{health.firstFetchedAt?.toISOString().slice(0, 10)}</time>.{' '}
          {num(health.snapshots)} hourly readings so far.{' '}
          <strong>Nothing before that date is covered</strong> — an empty period below means the
          archive was not yet running, not that nothing was broken.
        </p>
      )}

      <section>
        <h2>Choose what to look at</h2>
        {/*
          A plain GET form. No JavaScript required, every result is a shareable
          URL, and it degrades to something usable on any device or assistive
          technology. For a civic record that is the correct default.
        */}
        <form method="get">
          <p>
            <label htmlFor="development">Development</label>{' '}
            <select id="development" name="development" defaultValue={selected.development}>
              <option value="">All developments</option>
              {developments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="category">Kind of interruption</label>{' '}
            <select id="category" name="category" defaultValue={selected.category}>
              <option value="">All kinds</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </p>

          <p>
            <label htmlFor="service">Specific service</label>{' '}
            <select id="service" name="service" defaultValue={selected.service}>
              <option value="">All services</option>
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
            <button type="submit">Show</button> <a href="/">Reset</a>
          </p>
        </form>
      </section>

      <section>
        <h2>Totals for this selection</h2>
        {distinctOutages === 0 ? (
          <p>
            No interruptions recorded for this selection.{' '}
            {health.snapshots > 0 &&
              'That may mean the period requested is outside what has been collected so far.'}
          </p>
        ) : (
          <>
            <dl>
              <dt>Interruptions</dt>
              <dd>{num(distinctOutages)}</dd>
              <dt>Total time without service</dt>
              <dd>{hours(totalOutageHours)}</dd>
              <dt>Resident-hours lost (at least)</dt>
              <dd>{num(totalResidentHours)}</dd>
            </dl>

            <h3>What &ldquo;resident-hours&rdquo; means</h3>
            <p>
              One resident-hour is one person going one hour without the service. A building of 100
              people with no hot water for 10 hours is 1,000 resident-hours. It is a way of counting
              that treats a long outage in a large development as bigger than a short one in a small
              building — which is how residents experience it, and which a simple count of
              interruptions hides.
            </p>

            {totalWithoutFigures > 0 && (
              <p>
                <strong>This total is a floor, not a full count.</strong> NYCHA published no
                resident figures for {num(totalWithoutFigures)} of these interruptions, so they
                contribute nothing to the number above. The real figure is higher. Gas interruptions
                never carry impact figures at all.
              </p>
            )}

            <h3>Where these durations come from</h3>
            <p>
              NYCHA states a restoration time for some interruptions and not others. Where it does,
              that figure is used. Where it does not, the duration is measured from when this
              archive first saw the interruption until it stopped appearing.
            </p>
            <ul>
              <li>{num(sources.nychaReported)} using NYCHA&rsquo;s own stated restoration time</li>
              <li>{num(sources.observed)} measured by this archive</li>
              <li>
                {num(sources.ongoing)} still unresolved — their durations are counted only up to
                now, so they will grow
              </li>
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>{GRANULARITY_LABELS[granularity]}</h2>
        {series.length === 0 ? (
          <p>Nothing collected for this period.</p>
        ) : (
          <table>
            <caption>
              Interruptions are counted once in every period they were ongoing, so this column
              cannot be added up. Hours can be.
            </caption>
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Interruptions</th>
                <th scope="col">Hours without service</th>
                <th scope="col">Resident-hours (at least)</th>
                <th scope="col">Average length</th>
                <th scope="col">Still unresolved</th>
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
      </section>

      <section>
        <h2>By development</h2>
        {totals.length === 0 ? (
          <p>Nothing collected for this selection.</p>
        ) : (
          <table>
            <caption>
              Ranked by resident-hours lost. Developments NYCHA spells more than one way currently
              appear more than once, which understates each of them.
            </caption>
            <thead>
              <tr>
                <th scope="col">Development</th>
                <th scope="col">Borough</th>
                <th scope="col">Interruptions</th>
                <th scope="col">Hours without service</th>
                <th scope="col">Resident-hours (at least)</th>
                <th scope="col">Average length</th>
                <th scope="col">No figures published</th>
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
                  <td>{row.borough ?? '—'}</td>
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

      <section>
        <h2>How to read this honestly</h2>
        <ul>
          <li>
            <strong>Resident-hour totals are floors.</strong> Interruptions without published impact
            figures contribute zero rather than an estimate. Nothing here is imputed.
          </li>
          <li>
            <strong>Unresolved interruptions are still running.</strong> Their hours are counted
            only up to now, so those figures increase every hour.
          </li>
          <li>
            <strong>An interruption spanning two periods is split between them</strong> by the hours
            that actually fell in each, not assigned wholly to the one it started in.
          </li>
          <li>
            <strong>An empty period means no collection, not no interruptions.</strong> This archive
            began on {health.firstFetchedAt?.toISOString().slice(0, 10) ?? 'a date not yet set'}.
          </li>
          <li>
            <strong>Planned and unplanned work is never combined.</strong> A scheduled shutoff and a
            broken boiler are different events and counting them together would flatter one and
            malign the other.
          </li>
          {health.countMismatches > 0 && (
            <li>
              <strong>
                {num(health.countMismatches)} readings disagreed with NYCHA&rsquo;s own published
                row counts
              </strong>{' '}
              and are flagged for review rather than quietly accepted.
            </li>
          )}
        </ul>
      </section>
    </main>
  );
}
