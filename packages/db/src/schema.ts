import {
  CATEGORIES,
  SERVICES,
  SUB_TABLES,
  type Category,
  type ImpactSource,
  type ScopeLevel,
  type Service,
  type SubTable,
} from '@archive/parser';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * Shape notes, verified against the 2026-08-06 fixture (248 rows) rather than
 * assumed. Where fixture and parser disagree the parser wins — the fixture was
 * captured in August and never exercises heat season.
 *
 * - `status` and `borough_raw` are unconstrained TEXT. Borough values are
 *   neighbourhood-level (ASTORIA, FLUSHING, LONG ISLAND CITY and WOODSIDE sit
 *   alongside QUEENS), and one observed status cell held a date string instead
 *   of a label. A CHECK built from today's values would fail on real data.
 * - Closed vocabularies are TEXT + CHECK rather than native enums. Adding a
 *   member to a Postgres enum needs ALTER TYPE and can never be removed, and
 *   NYCHA is expected to change their markup mid-season. A
 *   CHECK is a plain drop-and-recreate. Compile-time safety is preserved with
 *   `$type`, and the allowed values are imported from the parser's own
 *   constants so the two cannot drift apart.
 * - Services are a child table, never a column. Every fixture row has exactly
 *   one service, but that is an artefact of the off-season capture: invariant 2
 *   requires per-service planned flags and multi-service rows are expected.
 * - Every table calls `.enableRLS()`. Zero policies, per project rule —
 *   `service_role` carries BYPASSRLS, everything else sees nothing.
 */

const SCOPE_LEVELS = [
  'entire_development',
  'building',
  'sectional',
  'unspecified',
] as const satisfies readonly ScopeLevel[];

const IMPACT_SOURCES = [
  'row',
  'children_rollup',
  'missing',
] as const satisfies readonly ImpactSource[];

/**
 * Values are compile-time constants from the parser, never user input, so
 * inlining them is safe. `sql.raw` is required because drizzle would otherwise
 * bind them as parameters, which is not legal inside DDL.
 */
function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`"${column}" in (${values.map((v) => `'${v}'`).join(', ')})`);
}

/**
 * One row per fetch. The snapshot ROW is permanent; the raw HTML it points at
 * is not.
 *
 * Raw bodies are transient by decision: they exist so a markup change can be
 * caught and reparsed, not as an archive. `retain_until` sets the window;
 * `raw_discarded_at` records the deletion, so a gap in storage is always
 * explained rather than looking like a lost fetch.
 *
 * A snapshot whose counts did not match, or that queued anything for review,
 * gets a null `retain_until` and is kept indefinitely — those are the only
 * snapshots anyone would ever reparse, and they are rare enough to be free.
 *
 * `sha256` is of the ORIGINAL body, before __VIEWSTATE is stripped, and
 * outlives the object it describes.
 */
export const snapshot = pgTable(
  'snapshot',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    url: text('url').notNull(),
    httpStatus: smallint('http_status').notNull(),
    attempts: smallint('attempts').notNull(),
    /** sha256 of the untouched response body, hex. Survives raw deletion. */
    sha256: char('sha256', { length: 64 }).notNull(),
    /** Object key in Supabase Storage. Null once discarded, or if upload failed. */
    storageKey: text('storage_key'),
    /** Size of the stored gzipped object, for cost tracking against the 1 GB cap. */
    storedBytes: integer('stored_bytes'),
    /**
     * When the raw body becomes eligible for deletion. Null means keep — set
     * only for snapshots that failed validation and may need reparsing.
     */
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    /** Set by the sweeper when the object is deleted. Null while raw still exists. */
    rawDiscardedAt: timestamp('raw_discarded_at', { withTimezone: true }),
    /**
     * Invariant 3, denormalised onto the snapshot so the retention sweeper can
     * decide what to keep without joining every count row.
     */
    countsMatched: boolean('counts_matched').notNull(),
    parserVersion: text('parser_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('snapshot_fetched_at_idx').on(t.fetchedAt),
    // Not unique: NYCHA can legitimately serve a byte-identical page twice.
    index('snapshot_sha256_idx').on(t.sha256),
    // Drives the retention sweeper: still-stored objects that are now eligible.
    index('snapshot_sweep_idx')
      .on(t.retainUntil)
      .where(sql`${t.rawDiscardedAt} is null and ${t.retainUntil} is not null`),
  ],
).enableRLS();

/**
 * Invariant 3. NYCHA prints its own row count on every tab; both theirs and
 * ours are recorded every run, so a silent parser regression is visible in the
 * archive itself and not only in the failing run's logs.
 */
export const snapshotCount = pgTable(
  'snapshot_count',
  {
    snapshotId: bigint('snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id, { onDelete: 'cascade' }),
    category: text('category').$type<Category>().notNull(),
    subTable: text('sub_table').$type<SubTable>().notNull(),
    /** NYCHA's printed count. Nullable because a tab may omit it. */
    declared: integer('declared'),
    parsed: integer('parsed').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotId, t.category, t.subTable] }),
    check('snapshot_count_category_check', oneOf('category', CATEGORIES)),
    check('snapshot_count_sub_table_check', oneOf('sub_table', SUB_TABLES)),
  ],
).enableRLS();

/**
 * The grey summary block, one per category (gas has none). Planned and
 * unplanned are separate rows — invariant 2 forbids aggregating them, so the
 * schema refuses to store them in one.
 */
export const categorySummary = pgTable(
  'category_summary',
  {
    snapshotId: bigint('snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id, { onDelete: 'cascade' }),
    category: text('category').$type<Category>().notNull(),
    isPlanned: boolean('is_planned').notNull(),
    asOfRaw: text('as_of_raw'),
    interruptions: integer('interruptions'),
    developments: integer('developments'),
    buildings: integer('buildings'),
    units: integer('units'),
    residents: integer('residents'),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotId, t.category, t.isPlanned] }),
    check('category_summary_category_check', oneOf('category', CATEGORIES)),
  ],
).enableRLS();

/**
 * A logical outage, stable across snapshots.
 *
 * Every column here is part of identity and none is mutable. The combination
 * was derived empirically, not assumed — candidate keys were tested against
 * all 248 fixture rows:
 *
 *   place (category+development+building+address)   8 collisions
 *   place + sub_table                               3 collisions
 *   place + sub_table + both dates                  1 collision
 *   the columns below                               0 collisions, 248/248
 *
 * The collisions are real distinct outages, not parser noise. SMITH carried
 * three concurrent planned works at one address on three different dates;
 * WAGNER carried a 51-hour entire-development water outage and a 7-hour
 * sectional hot-water outage at the same address at the same time. Scope and
 * services genuinely help identify WHICH outage this is.
 *
 * Impact figures deliberately stay out: NYCHA revises them mid-outage, and a
 * revision must produce a new version, never a phantom new event.
 *
 * `sub_table` is in identity with open eyes. It means one outage progressing
 * from `upcoming_planned` to `current` to `restored_24h` becomes three events.
 * The alternative is worse: the fixture has one place present in all three
 * sub-tables *simultaneously*, so sub-table is not a lifecycle stage, and
 * treating it as one would merge unrelated outages. Over-splitting is
 * recoverable at query time by joining on place; over-merging destroys
 * information permanently.
 */
export const outageEvent = pgTable(
  'outage_event',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /** sha256 over every identity column below, in declared order. */
    identityHash: char('identity_hash', { length: 64 }).notNull(),

    category: text('category').$type<Category>().notNull(),
    subTable: text('sub_table').$type<SubTable>().notNull(),
    developmentRaw: text('development_raw').notNull(),
    buildingRaw: text('building_raw'),
    addressRaw: text('address_raw'),
    /** Neighbourhood-level and free text. Null for every gas row. */
    boroughRaw: text('borough_raw'),
    /** Kept raw; formats differ by category and gas omits the time component. */
    scheduledDateRaw: text('scheduled_date_raw'),
    reportDateRaw: text('report_date_raw'),
    scopeLevel: text('scope_level').$type<ScopeLevel>().notNull(),
    isSectional: boolean('is_sectional').notNull(),
    /**
     * Sorted, comma-joined service names. Denormalised purely so identity is a
     * single-row hash; `observation_service` remains the queryable form and the
     * only place per-service flags live.
     */
    servicesKey: text('services_key').notNull(),

    firstSeenSnapshotId: bigint('first_seen_snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    /** Bumped on every snapshot the event is present in, without a new version. */
    lastSeenSnapshotId: bigint('last_seen_snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('outage_event_identity_hash_key').on(t.identityHash),
    // Rejoining the over-split lifecycle: all events at one place, any stage.
    index('outage_event_place_idx').on(t.category, t.developmentRaw, t.buildingRaw),
    index('outage_event_last_seen_idx').on(t.lastSeenAt),
    check('outage_event_category_check', oneOf('category', CATEGORIES)),
    check('outage_event_sub_table_check', oneOf('sub_table', SUB_TABLES)),
    check('outage_event_scope_level_check', oneOf('scope_level', SCOPE_LEVELS)),
  ],
).enableRLS();

/**
 * A version in an event's timeline. Change-only writes: a new row is inserted
 * only when `content_hash` differs from the event's current version.
 *
 * Absence is a version too. When an event stops appearing, a row with
 * `is_present = false` closes the timeline, because "the outage ended" is the
 * single most important fact in the archive and inferring it from a gap
 * between rows would make every resident-hours query a guess.
 */
export const outageObservation = pgTable(
  'outage_observation',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'bigint' })
      .notNull()
      .references(() => outageEvent.id, { onDelete: 'cascade' }),
    /** sha256 over the mutable content below. Sentinel value when absent. */
    contentHash: char('content_hash', { length: 64 }).notNull(),
    isPresent: boolean('is_present').notNull().default(true),

    firstSeenSnapshotId: bigint('first_seen_snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenSnapshotId: bigint('last_seen_snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),

    /** NYCHA emits the address even when it hides it on sectional rows. */
    addressDisplayed: boolean('address_displayed').notNull(),

    /** Free text. One observed value was a date string, not a status label. */
    status: text('status'),
    /**
     * Invariant 5: authoritative, never derived from polling deltas. Integer
     * hours; 533 observed, so nothing here may assume a 24-hour ceiling.
     */
    restorationHours: integer('restoration_hours'),
    /** Gas-only column. Null in every row of the first fixture, gas included. */
    locationRaw: text('location_raw'),

    impactBuildings: integer('impact_buildings'),
    impactUnits: integer('impact_units'),
    impactResidents: integer('impact_residents'),
    /**
     * Invariant 4. Recorded so a rollup can be audited later: `row` means the
     * parent carried its own figures, `children_rollup` means they were summed
     * from indented child rows, `missing` means none were published.
     */
    impactSource: text('impact_source').$type<ImpactSource>().notNull(),

    /** Position within its sub-table in the snapshot that produced this version. */
    rowIndex: integer('row_index').notNull(),
    parserVersion: text('parser_version').notNull(),
  },
  (t) => [
    index('outage_observation_event_idx').on(t.eventId, t.firstSeenAt),
    uniqueIndex('outage_observation_event_content_idx').on(t.eventId, t.contentHash, t.firstSeenAt),
    index('outage_observation_present_idx')
      .on(t.eventId)
      .where(sql`${t.isPresent}`),
    check('outage_observation_impact_source_check', oneOf('impact_source', IMPACT_SOURCES)),
    // 533 hours observed; the ceiling here only rejects negatives.
    check('outage_observation_restoration_hours_check', sql`"restoration_hours" >= 0`),
  ],
).enableRLS();

/**
 * Invariant 2, the one that most needs enforcing structurally: planned and
 * partial-service are per service, not per row. One row can be planned for
 * heat and unplanned for elevator, so these can never be columns on the
 * observation.
 *
 * Both flags are nullable because gas publishes neither.
 */
export const observationService = pgTable(
  'observation_service',
  {
    observationId: bigint('observation_id', { mode: 'bigint' })
      .notNull()
      .references(() => outageObservation.id, { onDelete: 'cascade' }),
    service: text('service').$type<Service>().notNull(),
    isPlanned: boolean('is_planned'),
    /** Real signal, elevator and electric only. Always true on rehab rows. */
    isPartialService: boolean('is_partial_service'),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.service] }),
    index('observation_service_service_idx').on(t.service),
    check('observation_service_service_check', oneOf('service', SERVICES)),
  ],
).enableRLS();

/**
 * Indented child rows. Retained even though their figures are already rolled
 * up into the parent, so a rollup can be re-checked without re-parsing.
 * Children always name a specific building and always carry full figures.
 */
export const observationChild = pgTable(
  'observation_child',
  {
    observationId: bigint('observation_id', { mode: 'bigint' })
      .notNull()
      .references(() => outageObservation.id, { onDelete: 'cascade' }),
    /** Document order beneath the parent. */
    ordinal: smallint('ordinal').notNull(),
    buildingRaw: text('building_raw'),
    addressRaw: text('address_raw'),
    buildings: integer('buildings'),
    units: integer('units'),
    residents: integer('residents'),
  },
  (t) => [primaryKey({ columns: [t.observationId, t.ordinal] })],
).enableRLS();

/**
 * Rows the parser could not resolve. Invariant 7: never guess. Anything
 * unexpected lands here for a human rather than being dropped or coerced.
 */
export const reviewQueue = pgTable(
  'review_queue',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    snapshotId: bigint('snapshot_id', { mode: 'bigint' })
      .notNull()
      .references(() => snapshot.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    detail: text('detail'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('review_queue_unresolved_idx')
      .on(t.snapshotId)
      .where(sql`${t.resolvedAt} is null`),
  ],
).enableRLS();
