import { desc, inArray, sql } from 'drizzle-orm';
import { ABSENT_CONTENT_HASH, schema } from '@archive/db';
import type { IdentifiedObservation } from './identify';
import type { Tx } from './tx';

/**
 * Change-only observation writes.
 *
 * Three cases per parsed row, and one that has no parsed row at all:
 *
 *   new identity        insert an `outage_event` plus its first version
 *   same content        bump `last_seen` on the existing version, write nothing
 *   changed content     insert a new version; the old one keeps its own window
 *   gone from the page  insert an `is_present = false` version
 *
 * The last case is the one the archive exists for. "The outage ended" is the most
 * valuable fact here, and inferring it from a gap between rows would make every
 * resident-hours query a guess, so absence is recorded explicitly.
 */

/** Sentinel `row_index` for an absence version, which has no row on the page. */
const ABSENT_ROW_INDEX = -1;

export interface ObservationWriteInput {
  snapshotId: bigint;
  fetchedAt: Date;
  identified: IdentifiedObservation[];
  parserVersion: string;
}

export interface ObservationWriteSummary {
  eventsInserted: number;
  eventsBumped: number;
  versionsInserted: number;
  versionsBumped: number;
  absencesRecorded: number;
  serviceRows: number;
  childRows: number;
}

interface CurrentVersion {
  id: bigint;
  contentHash: string;
  isPresent: boolean;
}

/**
 * Events whose most recent version is still `is_present`, across the whole
 * archive — the set that can newly disappear.
 *
 * Deliberately not derived from `outage_event.last_seen_snapshot_id`. That would
 * be cheaper, but it cannot distinguish "disappeared this run" from "disappeared
 * six runs ago", so a skipped cron would leave events open forever with no way to
 * notice. Asking the observation timeline directly is self-healing: whatever runs
 * were missed, the next successful one closes everything that is actually gone.
 *
 * Kept as raw SQL because the "latest row per group" shape has no drizzle
 * equivalent. Uses `outage_observation_event_idx` on (event_id, first_seen_at).
 * If this ever becomes the slow part of a run, that is the point to reconsider a
 * denormalised open/closed flag — not before.
 */
async function openEventIds(tx: Tx): Promise<Set<bigint>> {
  const rows = (await tx.execute(sql`
    select o.event_id
    from outage_observation o
    where o.is_present
      and not exists (
        select 1
        from outage_observation later
        where later.event_id = o.event_id
          and (later.first_seen_at, later.id) > (o.first_seen_at, o.id)
      )
  `)) as unknown as { event_id: string | bigint | number }[];

  return new Set(rows.map((r) => BigInt(r.event_id)));
}

/**
 * The newest version of each of the given events. Fetches every version for those
 * events and takes the newest in memory: the set is bounded by how many rows are
 * on the page right now (a few hundred), and each of those changes a handful of
 * times over its life, so this stays small and avoids a second raw query.
 */
async function currentVersions(tx: Tx, eventIds: bigint[]): Promise<Map<bigint, CurrentVersion>> {
  if (eventIds.length === 0) return new Map();

  const rows = await tx
    .select({
      id: schema.outageObservation.id,
      eventId: schema.outageObservation.eventId,
      contentHash: schema.outageObservation.contentHash,
      isPresent: schema.outageObservation.isPresent,
    })
    .from(schema.outageObservation)
    .where(inArray(schema.outageObservation.eventId, eventIds))
    .orderBy(desc(schema.outageObservation.firstSeenAt), desc(schema.outageObservation.id));

  const current = new Map<bigint, CurrentVersion>();
  for (const row of rows) {
    // Ordered newest first, so the first sighting of an event id is its current
    // version and later ones are history.
    if (!current.has(row.eventId)) {
      current.set(row.eventId, {
        id: row.id,
        contentHash: row.contentHash,
        isPresent: row.isPresent,
      });
    }
  }

  return current;
}

export async function persistObservations(
  tx: Tx,
  { snapshotId, fetchedAt, identified, parserVersion }: ObservationWriteInput,
): Promise<ObservationWriteSummary> {
  const seen = { lastSeenSnapshotId: snapshotId, lastSeenAt: fetchedAt };
  const opened = {
    firstSeenSnapshotId: snapshotId,
    firstSeenAt: fetchedAt,
    ...seen,
  };

  // --- events ------------------------------------------------------------
  const identities = identified.map((i) => i.identity);

  const existingEvents =
    identities.length > 0
      ? await tx
          .select({
            id: schema.outageEvent.id,
            identityHash: schema.outageEvent.identityHash,
          })
          .from(schema.outageEvent)
          .where(inArray(schema.outageEvent.identityHash, identities))
      : [];

  const eventIdByIdentity = new Map(existingEvents.map((e) => [e.identityHash, e.id]));

  const newEvents = identified.filter((i) => !eventIdByIdentity.has(i.identity));
  if (newEvents.length > 0) {
    const inserted = await tx
      .insert(schema.outageEvent)
      .values(
        newEvents.map(({ observation: o, identity, services }) => ({
          identityHash: identity,
          category: o.category,
          subTable: o.subTable,
          developmentRaw: o.developmentRaw,
          buildingRaw: o.buildingRaw,
          addressRaw: o.addressRaw,
          boroughRaw: o.boroughRaw,
          scheduledDateRaw: o.scheduledDateRaw,
          reportDateRaw: o.reportDateRaw,
          scopeLevel: o.scopeLevel,
          isSectional: o.isSectional,
          servicesKey: services,
          ...opened,
        })),
      )
      .returning({
        id: schema.outageEvent.id,
        identityHash: schema.outageEvent.identityHash,
      });

    for (const row of inserted) eventIdByIdentity.set(row.identityHash, row.id);
  }

  // One statement for every event that already existed: last_seen is the same
  // value for all of them, so there is nothing to vary per row.
  if (existingEvents.length > 0) {
    await tx
      .update(schema.outageEvent)
      .set(seen)
      .where(
        inArray(
          schema.outageEvent.identityHash,
          existingEvents.map((e) => e.identityHash),
        ),
      );
  }

  // --- versions ----------------------------------------------------------
  const presentEventIds = [...eventIdByIdentity.values()];
  const current = await currentVersions(tx, presentEventIds);

  const unchanged: bigint[] = [];
  const changed: IdentifiedObservation[] = [];

  for (const item of identified) {
    const eventId = eventIdByIdentity.get(item.identity);
    if (eventId === undefined) {
      // Unreachable: every identity was either found or inserted above.
      throw new Error(`No event id resolved for identity ${item.identity}`);
    }

    const version = current.get(eventId);
    // A version that recorded absence never counts as unchanged, even if the
    // hashes somehow matched — reappearing has to open a new version.
    if (version && version.isPresent && version.contentHash === item.content) {
      unchanged.push(version.id);
    } else {
      changed.push(item);
    }
  }

  if (unchanged.length > 0) {
    await tx
      .update(schema.outageObservation)
      .set(seen)
      .where(inArray(schema.outageObservation.id, unchanged));
  }

  let serviceRows = 0;
  let childRows = 0;

  if (changed.length > 0) {
    const inserted = await tx
      .insert(schema.outageObservation)
      .values(
        changed.map(({ observation: o, identity, content }) => ({
          eventId: eventIdByIdentity.get(identity)!,
          contentHash: content,
          isPresent: true,
          addressDisplayed: o.addressDisplayed,
          status: o.status,
          restorationHours: o.restorationHours,
          locationRaw: o.locationRaw,
          impactBuildings: o.impact.buildings,
          impactUnits: o.impact.units,
          impactResidents: o.impact.residents,
          impactSource: o.impactSource,
          rowIndex: o.rowIndex,
          parserVersion,
          ...opened,
        })),
      )
      .returning({
        id: schema.outageObservation.id,
        eventId: schema.outageObservation.eventId,
      });

    // An event appears at most once per snapshot, so event id identifies which
    // inserted row belongs to which parsed observation without relying on the
    // order Postgres returns.
    const observationIdByEvent = new Map(inserted.map((r) => [r.eventId, r.id]));

    const services = changed.flatMap(({ observation: o, identity }) => {
      const observationId = observationIdByEvent.get(eventIdByIdentity.get(identity)!)!;
      // Invariant 2: one row per service, each carrying its own flags. Never
      // collapsed onto the observation, and never aggregated across services.
      return o.services.map((service) => ({
        observationId,
        service,
        isPlanned: o.isPlannedByService[service] ?? null,
        isPartialService: o.partialServiceByService[service] ?? null,
      }));
    });

    if (services.length > 0) {
      await tx.insert(schema.observationService).values(services);
      serviceRows = services.length;
    }

    // Invariant 4: children are kept even though the parser has already rolled
    // their figures into the parent, so a rollup can be re-checked later without
    // re-parsing the raw page.
    const children = changed.flatMap(({ observation: o, identity }) => {
      const observationId = observationIdByEvent.get(eventIdByIdentity.get(identity)!)!;
      return o.children.map((child, ordinal) => ({
        observationId,
        ordinal,
        buildingRaw: child.buildingRaw,
        addressRaw: child.addressRaw,
        buildings: child.impact.buildings,
        units: child.impact.units,
        residents: child.impact.residents,
      }));
    });

    if (children.length > 0) {
      await tx.insert(schema.observationChild).values(children);
      childRows = children.length;
    }
  }

  // --- absence -----------------------------------------------------------
  const present = new Set(presentEventIds);
  const gone = [...(await openEventIds(tx))].filter((id) => !present.has(id));

  if (gone.length > 0) {
    await tx.insert(schema.outageObservation).values(
      gone.map((eventId) => ({
        eventId,
        contentHash: ABSENT_CONTENT_HASH,
        isPresent: false,
        // Nothing was published, so nothing is claimed. Impact stays null rather
        // than carrying the last known figures forward, which would look like
        // NYCHA had reported them for this hour.
        addressDisplayed: false,
        impactSource: 'missing' as const,
        rowIndex: ABSENT_ROW_INDEX,
        parserVersion,
        ...opened,
      })),
    );
  }

  return {
    eventsInserted: newEvents.length,
    eventsBumped: existingEvents.length,
    versionsInserted: changed.length,
    versionsBumped: unchanged.length,
    absencesRecorded: gone.length,
    serviceRows,
    childRows,
  };
}
