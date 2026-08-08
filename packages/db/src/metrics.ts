import type { Category, Service } from '@archive/parser';
import { sql, type SQL } from 'drizzle-orm';
import type { Reader } from './client';

/**
 * The metrics. This file is the answer to "where does that number come from",
 * and it is meant to be read by someone checking our work, not only by someone
 * maintaining it.
 *
 * NYCHA publishes live status and no history. Nobody — including NYCHA — can
 * say how long a development went without heat last winter. Everything below
 * exists to answer that, which means every definitional choice here is load
 * bearing and is stated rather than buried in SQL.
 *
 * ## How long an outage lasted
 *
 * Two sources, in strict priority:
 *
 * 1. **NYCHA's own `Restoration Time`**, when published. Invariant 5: it is
 *    authoritative and is never second-guessed against our polling. Values
 *    above 24 are normal; 533 has been observed.
 * 2. **Observed duration** otherwise — from when we first saw the outage until
 *    the observation that records its absence. Invariant 5 forbids deriving a
 *    duration *when NYCHA has given one*; where NYCHA gives nothing, measuring
 *    is the only alternative to pretending the outage never happened. Only 31%
 *    of observed rows carry a restoration figure, so excluding the rest would
 *    undercount by roughly two thirds while looking authoritative.
 *
 * Every figure produced here carries which source it came from. A total mixing
 * both is honest only if it can say so.
 *
 * ## Where an outage ends
 *
 * `effective_end` is, in order: NYCHA's figure (`started_at +
 * restoration_hours`); otherwise the absence record; otherwise now. It is then
 * **capped at now** in all cases.
 *
 * The order matters most precisely where the two sources disagree, and they
 * will: NYCHA can report a 6-hour restoration for an outage the archive then
 * watches for four days. Invariant 5 makes NYCHA's number authoritative, so it
 * wins — but the disagreement is worth surfacing once real closures accumulate,
 * because a systematic gap between reported and observed durations is itself a
 * finding about NYCHA's reporting rather than a defect in ours. NYCHA's restoration time on a current outage is a
 * forecast, and a forecast must never add resident-hours to a week that has not
 * happened yet. An outage with no absence record is `is_ongoing`, and its
 * duration is a **lower bound** — right-censored, in the survival-analysis
 * sense — because it is still running as the number is read.
 *
 * ## Resident-hours
 *
 * `residents x hours`, where residents is the most recent published figure for
 * that outage — NYCHA revises impact mid-outage and the revision wins.
 *
 * Rows where NYCHA published no impact figure (`impact_source = 'missing'`,
 * which today is every gas row) **contribute zero**. They are counted
 * separately as `outagesWithoutImpactFigures` so a total can be presented as
 * "at least N", which is what it is. Imputing a figure from neighbouring rows
 * was considered and rejected: an imputed number is indistinguishable from a
 * measured one once it is rendered, and this dataset's only real asset is that
 * every number in it can be traced to something NYCHA published.
 *
 * ## Apportionment across time buckets
 *
 * An outage spanning a bucket boundary is split by actual overlap, not
 * attributed wholly to the bucket it began in. A 300-hour outage starting on 29
 * January belongs mostly to February, and a chart that puts all of it in
 * January misrepresents which month was bad. Splitting is done by day and each
 * day contributes its real overlap in hours, so partial first and last days are
 * exact rather than rounded.
 */

/** NYC's legal heat season runs 1 October to 31 May. */
export const HEAT_SEASON_START_MONTH = 10;
export const HEAT_SEASON_END_MONTH = 5;

export type Granularity = 'week' | 'month' | 'year' | 'season';

export type ScopeLevel = 'entire_development' | 'building' | 'sectional' | 'unspecified';

export interface MetricFilter {
  /** Exact match on `development_raw`. Canonical ids arrive with #8. */
  development?: string;
  borough?: string;
  category?: Category;
  service?: Service;
  scopeLevel?: ScopeLevel;
  /**
   * Planned status is per service, not per outage (invariant 2). Combined with
   * `service`, both must hold on the *same* service row — otherwise "planned
   * elevator work" would match an outage that is planned for heat and
   * unplanned for elevator.
   *
   * `null` selects rows NYCHA published no marker for, which is every gas row.
   */
  isPlanned?: boolean | null;
  /** Only outages with no closure recorded — still running as of now. */
  ongoingOnly?: boolean;
  /** Inclusive lower bound on overlap, not on start. */
  from?: Date;
  /** Exclusive upper bound on overlap. */
  to?: Date;
}

/**
 * What to group by. `service` groups through `observation_service`, so an
 * outage affecting heat and hot water is counted under both — correct, and the
 * reason the counts under this dimension do not sum to the outage total.
 */
export type Dimension = 'development' | 'borough' | 'category' | 'service' | 'scopeLevel';

export type SortField =
  | 'label'
  | 'outages'
  | 'outageHours'
  | 'residentHours'
  | 'averageHoursPerOutage'
  | 'outagesWithoutImpactFigures'
  | 'ongoingOutages';

export type SortDirection = 'asc' | 'desc';

export interface Sort {
  field: SortField;
  direction: SortDirection;
}

/**
 * Whitelists. Sort and grouping choices reach SQL as identifiers rather than
 * bound parameters, so they are mapped through closed unions here and never
 * interpolated from caller input. A UI can pass whatever a user clicked; an
 * unrecognised value cannot become SQL.
 */
const DIMENSION_SQL: Record<Dimension, string> = {
  development: 'development_raw',
  borough: 'borough_raw',
  category: 'category',
  service: 'os.service',
  scopeLevel: 'scope_level',
};

const SORT_SQL: Record<SortField, string> = {
  label: '1',
  outages: 'outages',
  outageHours: 'outage_hours',
  residentHours: 'resident_hours',
  averageHoursPerOutage: 'average_hours_per_outage',
  outagesWithoutImpactFigures: 'outages_without_impact_figures',
  ongoingOutages: 'ongoing_outages',
};

/**
 * Every outage as a single interval with a duration and a provenance label.
 *
 * Built once here and reused by every aggregate below, so there is exactly one
 * place where "how long was this outage" is decided.
 */
function intervalsCte(filter: MetricFilter): SQL {
  const conditions: SQL[] = [];
  if (filter.development) conditions.push(sql`e.development_raw = ${filter.development}`);
  if (filter.borough) conditions.push(sql`e.borough_raw = ${filter.borough}`);
  if (filter.category) conditions.push(sql`e.category = ${filter.category}`);
  if (filter.scopeLevel) conditions.push(sql`e.scope_level = ${filter.scopeLevel}`);
  if (filter.ongoingOnly) conditions.push(sql`closure.ended_at is null`);

  /**
   * Service and planned status are tested together in one `exists`, never as
   * two independent clauses. Invariant 2: the flags are per service, so
   * "planned elevator work" has to mean one service row that is both, not an
   * outage that happens to have a planned service and an elevator service.
   */
  if (filter.service !== undefined || filter.isPlanned !== undefined) {
    const inner: SQL[] = [sql`os.observation_id = latest.observation_id`];
    if (filter.service !== undefined) inner.push(sql`os.service = ${filter.service}`);
    if (filter.isPlanned === null) inner.push(sql`os.is_planned is null`);
    else if (filter.isPlanned !== undefined) inner.push(sql`os.is_planned = ${filter.isPlanned}`);
    conditions.push(
      sql`exists (select 1 from observation_service os where ${sql.join(inner, sql` and `)})`,
    );
  }

  const where = conditions.length ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;

  return sql`
    -- The most recent version of each event. NYCHA revises impact figures and
    -- restoration times mid-outage; the revision is what we believe.
    latest_version as (
      select distinct on (o.event_id)
        o.event_id,
        o.id as observation_id,
        o.restoration_hours,
        o.impact_residents,
        o.impact_source
      from outage_observation o
      where o.is_present
      order by o.event_id, o.first_seen_at desc, o.id desc
    ),
    -- When the archive recorded the outage as gone. Absence is written as a
    -- version, so this is a fact rather than an inference from a gap.
    closure as (
      select event_id, min(first_seen_at) as ended_at
      from outage_observation
      where not is_present
      group by event_id
    ),
    intervals as (
      select
        e.id as event_id,
        e.development_raw,
        e.borough_raw,
        e.category,
        e.scope_level,
        latest.observation_id,
        e.first_seen_at as started_at,
        closure.ended_at is null as is_ongoing,
        latest.restoration_hours,
        coalesce(latest.impact_residents, 0) as residents,
        latest.impact_source,
        -- Priority order, and it matters most exactly where the two disagree:
        -- NYCHA's published figure first, our observed closure second, now()
        -- last. Writing this as coalesce(closure.ended_at, ...) inverted it and
        -- silently preferred the measurement over NYCHA's own number, which is
        -- the opposite of invariant 5.
        least(
          case
            when latest.restoration_hours is not null
              then e.first_seen_at + make_interval(hours => latest.restoration_hours)
            else coalesce(closure.ended_at, now())
          end,
          now()
        ) as effective_end,
        case
          when closure.ended_at is not null and latest.restoration_hours is null then 'observed'
          when latest.restoration_hours is not null then 'nycha_reported'
          else 'ongoing'
        end as duration_source
      from outage_event e
      join latest_version latest on latest.event_id = e.id
      left join closure on closure.event_id = e.id
      ${where}
    )
  `;
}

/**
 * Splits each interval into daily slices carrying their real overlap in hours.
 *
 * `generate_series` over the interval's days, intersected back against the
 * interval itself, so the first and last day contribute partial hours rather
 * than a whole one. Every bucketed figure is a sum over these slices, which is
 * what makes week, month, season and year mutually consistent — they are the
 * same numbers grouped differently, not four separate calculations.
 */
function slicesCte(): SQL {
  return sql`
    slices as (
      select
        i.*,
        day::date as day,
        extract(epoch from (
          least(i.effective_end, day + interval '1 day') - greatest(i.started_at, day)
        )) / 3600.0 as hours_in_day
      from intervals i
      cross join lateral generate_series(
        date_trunc('day', i.started_at),
        date_trunc('day', i.effective_end),
        interval '1 day'
      ) as day
      where least(i.effective_end, day + interval '1 day') > greatest(i.started_at, day)
    )
  `;
}

/**
 * Dates are bound as ISO strings with an explicit cast, not as `Date` objects.
 *
 * These queries go through `db.execute`, which hands parameters to postgres.js
 * raw rather than through drizzle's column encoders, and the driver rejects a
 * `Date` outright. The `::timestamptz` cast is what keeps the comparison a
 * timestamp comparison rather than a string one.
 */
function windowFilter(filter: MetricFilter, ...extra: SQL[]): SQL {
  const parts: SQL[] = [...extra];
  if (filter.from) parts.push(sql`day >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to) parts.push(sql`day < ${filter.to.toISOString()}::timestamptz`);
  return parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;
}

/**
 * The bucket label for a day.
 *
 * Season is not a calendar period, so it cannot use `date_trunc`. A heat season
 * is named for the year it starts in: 1 October 2026 through 31 May 2027 is
 * "2026-27", and June through September falls outside any heat season and is
 * labelled as such rather than being silently folded into a neighbour.
 */
function bucketExpression(granularity: Granularity): SQL {
  if (granularity === 'season') {
    return sql`case
      when extract(month from day) >= ${HEAT_SEASON_START_MONTH}
        then extract(year from day) || '-' || right((extract(year from day) + 1)::text, 2)
      when extract(month from day) <= ${HEAT_SEASON_END_MONTH}
        then (extract(year from day) - 1) || '-' || right(extract(year from day)::text, 2)
      else 'off-season ' || extract(year from day)
    end`;
  }
  return sql`to_char(date_trunc(${granularity}, day::timestamptz), 'YYYY-MM-DD')`;
}

export interface TimeBucket {
  /** `2026-W32`-ish for weeks, `2026-10-01` for months, `2026-27` for seasons. */
  bucket: string;
  /** Distinct outages overlapping this bucket. Not additive across buckets. */
  outages: number;
  /** Hours of outage that actually fell inside this bucket. */
  outageHours: number;
  /**
   * A floor. Outages with no published impact figure contribute zero; see
   * `outagesWithoutImpactFigures`.
   */
  residentHours: number;
  /** Mean hours per outage within the bucket. */
  averageHoursPerOutage: number;
  outagesWithoutImpactFigures: number;
  /** Still running, so this bucket's hours are a lower bound. */
  ongoingOutages: number;
}

/**
 * The time series behind every chart.
 *
 * `outages` counts distinct outages overlapping the bucket, so it is
 * deliberately **not** additive across buckets — one outage spanning three
 * weeks appears in all three. Hours are additive; counts are not. Any UI
 * summing the count column is wrong, which is why the two are named
 * differently rather than both being "total".
 */
export async function timeSeries(
  db: Reader,
  granularity: Granularity,
  filter: MetricFilter = {},
  /** Chronological by default; `desc` puts the most recent period first. */
  order: SortDirection = 'asc',
): Promise<TimeBucket[]> {
  const rows = await db.execute(sql`
    with ${intervalsCte(filter)}, ${slicesCte()}
    select
      ${bucketExpression(granularity)} as bucket,
      count(distinct event_id)::int as outages,
      round(sum(hours_in_day)::numeric, 2)::float8 as outage_hours,
      round(sum(hours_in_day * residents)::numeric, 2)::float8 as resident_hours,
      round((sum(hours_in_day) / nullif(count(distinct event_id), 0))::numeric, 2)::float8
        as average_hours_per_outage,
      count(distinct event_id) filter (where impact_source = 'missing')::int
        as outages_without_impact_figures,
      count(distinct event_id) filter (where is_ongoing)::int as ongoing_outages
    from slices
    ${windowFilter(filter)}
    group by 1
    order by 1 ${sql.raw(order === 'desc' ? 'desc' : 'asc')}
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    bucket: String(r['bucket']),
    outages: Number(r['outages']),
    outageHours: Number(r['outage_hours'] ?? 0),
    residentHours: Number(r['resident_hours'] ?? 0),
    averageHoursPerOutage: Number(r['average_hours_per_outage'] ?? 0),
    outagesWithoutImpactFigures: Number(r['outages_without_impact_figures']),
    ongoingOutages: Number(r['ongoing_outages']),
  }));
}

export interface DevelopmentTotals {
  development: string;
  borough: string | null;
  outages: number;
  outageHours: number;
  residentHours: number;
  averageHoursPerOutage: number;
  outagesWithoutImpactFigures: number;
  ongoingOutages: number;
}

export interface AggregateRow {
  /** The grouped value: a development name, borough, category, service, scope. */
  label: string;
  /** Present when grouping by development; null otherwise. */
  borough: string | null;
  outages: number;
  outageHours: number;
  residentHours: number;
  averageHoursPerOutage: number;
  outagesWithoutImpactFigures: number;
  ongoingOutages: number;
}

export interface AggregateOptions {
  dimension: Dimension;
  filter?: MetricFilter;
  sort?: Sort;
  limit?: number;
  offset?: number;
}

/**
 * Totals grouped by any dimension, sorted by any column.
 *
 * This is the general form; `timeSeries` is the same numbers grouped by period
 * instead. Between them a UI can ask most questions worth asking of this data —
 * worst developments this season, which borough loses the most resident-hours,
 * whether elevator outages run longer than heat ones, which scope of outage
 * dominates — without new SQL each time.
 *
 * `dimension` and `sort` are mapped through closed unions rather than
 * interpolated, so a control that passes through a user's click cannot reach
 * the database as SQL.
 *
 * Grouping by `service` counts an outage once per service it affects, so those
 * rows do not sum to the outage total. That is the honest shape of the data —
 * one broken riser really does take out heat and hot water — and flattening it
 * would mean choosing a single service per outage arbitrarily.
 */
export async function aggregate(db: Reader, options: AggregateOptions): Promise<AggregateRow[]> {
  const filter = options.filter ?? {};
  const sort = options.sort ?? { field: 'residentHours', direction: 'desc' };
  const dimension = sql.raw(DIMENSION_SQL[options.dimension]);
  const orderBy = sql.raw(`${SORT_SQL[sort.field]} ${sort.direction === 'asc' ? 'asc' : 'desc'}`);

  // Only the service dimension needs the join; adding it unconditionally would
  // multiply rows and silently inflate every other grouping's hour totals.
  const serviceJoin =
    options.dimension === 'service'
      ? sql`join observation_service os on os.observation_id = slices.observation_id`
      : sql``;

  // Borough is only meaningful when the group is a place.
  const boroughColumn =
    options.dimension === 'development' ? sql`max(borough_raw)` : sql`cast(null as text)`;

  const rows = await db.execute(sql`
    with ${intervalsCte(filter)}, ${slicesCte()}
    select
      ${dimension} as label,
      ${boroughColumn} as borough,
      count(distinct event_id)::int as outages,
      round(sum(hours_in_day)::numeric, 2)::float8 as outage_hours,
      round(sum(hours_in_day * residents)::numeric, 2)::float8 as resident_hours,
      round((sum(hours_in_day) / nullif(count(distinct event_id), 0))::numeric, 2)::float8
        as average_hours_per_outage,
      count(distinct event_id) filter (where impact_source = 'missing')::int
        as outages_without_impact_figures,
      count(distinct event_id) filter (where is_ongoing)::int as ongoing_outages
    from slices
    ${serviceJoin}
    ${windowFilter(filter, sql`${dimension} is not null`)}
    group by 1
    order by ${orderBy} nulls last
    limit ${options.limit ?? 100}
    offset ${options.offset ?? 0}
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    label: String(r['label']),
    borough: r['borough'] === null || r['borough'] === undefined ? null : String(r['borough']),
    outages: Number(r['outages']),
    outageHours: Number(r['outage_hours'] ?? 0),
    residentHours: Number(r['resident_hours'] ?? 0),
    averageHoursPerOutage: Number(r['average_hours_per_outage'] ?? 0),
    outagesWithoutImpactFigures: Number(r['outages_without_impact_figures']),
    ongoingOutages: Number(r['ongoing_outages']),
  }));
}

/** Per-development totals. Thin wrapper over `aggregate` for the common case. */
export async function developmentTotals(
  db: Reader,
  filter: MetricFilter = {},
  limit = 100,
): Promise<DevelopmentTotals[]> {
  const rows = await aggregate(db, { dimension: 'development', filter, limit });
  return rows.map(({ label, ...rest }) => ({ development: label, ...rest }));
}

export interface DurationSourceBreakdown {
  /** NYCHA published a restoration time. */
  nychaReported: number;
  /** Measured from our own observation timeline. */
  observed: number;
  /** Still open; its duration is a lower bound. */
  ongoing: number;
}

/**
 * How the durations behind a total were arrived at.
 *
 * Belongs on screen next to any headline figure. A number built mostly from
 * NYCHA's own reporting and one built mostly from our measurements deserve
 * different amounts of trust, and only this tells them apart.
 */
export async function durationSources(
  db: Reader,
  filter: MetricFilter = {},
): Promise<DurationSourceBreakdown> {
  const rows = (await db.execute(sql`
    with ${intervalsCte(filter)}
    select duration_source, count(*)::int as n from intervals group by 1
  `)) as unknown as Record<string, unknown>[];

  const by = new Map(rows.map((r) => [String(r['duration_source']), Number(r['n'])]));
  return {
    nychaReported: by.get('nycha_reported') ?? 0,
    observed: by.get('observed') ?? 0,
    ongoing: by.get('ongoing') ?? 0,
  };
}

/** Distinct development names, for the dashboard's filter control. */
export async function developmentNames(db: Reader): Promise<string[]> {
  const rows = (await db.execute(sql`
    select distinct development_raw from outage_event order by development_raw
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => String(r['development_raw']));
}

export interface FilterOptions {
  developments: string[];
  boroughs: string[];
  categories: string[];
  services: string[];
  scopeLevels: string[];
}

/**
 * Every value a filter control can offer, in one round trip.
 *
 * Read from the data rather than from the type unions on purpose: NYCHA is the
 * source of truth for what actually appears, and offering a filter that returns
 * nothing — a borough with no outages, a category out of season — is a worse
 * experience than a shorter list. Heat, for instance, should not be selectable
 * in August, because it genuinely does not occur.
 */
export async function filterOptions(db: Reader): Promise<FilterOptions> {
  const rows = (await db.execute(sql`
    select 'development' as kind, development_raw as value from outage_event
    union select 'borough', borough_raw from outage_event
    union select 'category', category from outage_event
    union select 'scopeLevel', scope_level from outage_event
    union select 'service', os.service from observation_service os
    order by 1, 2
  `)) as unknown as Record<string, unknown>[];

  const pick = (kind: string): string[] =>
    rows.filter((r) => r['kind'] === kind && r['value'] !== null).map((r) => String(r['value']));

  return {
    developments: pick('development'),
    boroughs: pick('borough'),
    categories: pick('category'),
    services: pick('service'),
    scopeLevels: pick('scopeLevel'),
  };
}
