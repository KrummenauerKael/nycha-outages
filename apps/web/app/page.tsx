import {
  archiveHealth,
  currentCountsByService,
  currentLoadByDevelopment,
} from '@archive/db/queries';
import { readDb } from '@/db';

/**
 * Scaffolding, not a design.
 *
 * Unstyled semantic HTML that proves the read layer reaches the database and
 * renders. Its job is to be replaced: the visual language should come from the
 * subject — a public-accountability record of people without heat — and nothing
 * here should survive into that by inertia.
 */

/** Never prerendered. The whole point is what is true right now. */
export const dynamic = 'force-dynamic';

export default async function Home() {
  let data;
  try {
    /**
     * Inside the try, not above it. `readDb` throws synchronously when
     * DATABASE_URL is unset, and hoisting it out of here sends that throw
     * straight past the message below to Next's generic error page.
     */
    const db = readDb();
    const [health, byService, byDevelopment] = await Promise.all([
      archiveHealth(db),
      currentCountsByService(db),
      currentLoadByDevelopment(db, 20),
    ]);
    data = { health, byService, byDevelopment };
  } catch (error) {
    /**
     * Shown, not swallowed. A dashboard that renders an empty state when the
     * database is unreachable is indistinguishable from one reporting that
     * nothing is broken — the most dangerous output this application could
     * produce.
     */
    return (
      <main>
        <h1>NYCHA service interruption archive</h1>
        <h2>Cannot reach the archive</h2>
        <p>
          This is a connection failure, not a report that no outages exist. Nothing below should be
          read as data.
        </p>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
      </main>
    );
  }

  const { health, byService, byDevelopment } = data;

  return (
    <main>
      <h1>NYCHA service interruption archive</h1>

      <section>
        <h2>Collection</h2>
        {health.snapshots === 0 ? (
          <p>No snapshots yet. Nothing has been collected.</p>
        ) : (
          <dl>
            <dt>Snapshots</dt>
            <dd>{health.snapshots}</dd>
            <dt>First collected</dt>
            <dd>{health.firstFetchedAt?.toISOString() ?? '—'}</dd>
            <dt>Last collected</dt>
            <dd>{health.lastFetchedAt?.toISOString() ?? '—'}</dd>
            <dt>Count mismatches</dt>
            <dd>{health.countMismatches}</dd>
            <dt>Raw HTML retained</dt>
            <dd>{health.rawRetained}</dd>
          </dl>
        )}
      </section>

      <section>
        <h2>Open interruptions by service</h2>
        <p>
          Planned and unplanned are counted separately and must never be summed. One outage
          affecting two services appears under both.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Unplanned</th>
              <th scope="col">Planned</th>
              <th scope="col">No marker published</th>
            </tr>
          </thead>
          <tbody>
            {byService.length === 0 ? (
              <tr>
                <td colSpan={4}>No open interruptions recorded.</td>
              </tr>
            ) : (
              byService.map((row) => (
                <tr key={row.service}>
                  <th scope="row">{row.service}</th>
                  <td>{row.unplanned}</td>
                  <td>{row.planned}</td>
                  <td>{row.unmarked}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Developments with the most open interruptions</h2>
        <p>
          Resident counts are a floor, not a total — NYCHA does not publish an impact figure for
          every row.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Development</th>
              <th scope="col">Borough</th>
              <th scope="col">Open</th>
              <th scope="col">Residents affected (floor)</th>
              <th scope="col">Rows with no figures</th>
            </tr>
          </thead>
          <tbody>
            {byDevelopment.length === 0 ? (
              <tr>
                <td colSpan={5}>No open interruptions recorded.</td>
              </tr>
            ) : (
              byDevelopment.map((row) => (
                <tr key={row.development}>
                  <th scope="row">{row.development}</th>
                  <td>{row.borough ?? '—'}</td>
                  <td>{row.openOutages}</td>
                  <td>{row.residentsAffected}</td>
                  <td>{row.withoutImpactFigures}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
