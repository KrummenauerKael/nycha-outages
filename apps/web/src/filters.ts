import { CATEGORIES, SERVICES, type Category, type Service } from '@archive/parser';
import type { Granularity, MetricFilter } from '@archive/db/metrics';

/**
 * Turns URL search params into a validated filter.
 *
 * Filters live in the URL rather than in component state so that every view is
 * a link. A resident can send "my development, this season" to a council member
 * or a reporter and they see the same page — which for an accountability record
 * is a feature, not a convenience.
 *
 * Unrecognised values fall back to the default rather than throwing. A mistyped
 * query string should show the whole dataset, not an error page.
 */

export const GRANULARITIES = ['week', 'month', 'season', 'year'] as const;

export interface DashboardParams {
  granularity: Granularity;
  filter: MetricFilter;
  /** Echoed back so the form can show what is currently selected. */
  selected: {
    development: string;
    category: string;
    service: string;
    from: string;
    to: string;
  };
}

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Parses `YYYY-MM-DD`. Returns undefined for anything else, including junk. */
function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function readParams(params: Record<string, string | string[] | undefined>): DashboardParams {
  const granularityRaw = one(params['granularity']);
  const granularity = (GRANULARITIES as readonly string[]).includes(granularityRaw)
    ? (granularityRaw as Granularity)
    : 'month';

  const development = one(params['development']);
  const categoryRaw = one(params['category']);
  const serviceRaw = one(params['service']);
  const fromRaw = one(params['from']);
  const toRaw = one(params['to']);

  const category = (CATEGORIES as readonly string[]).includes(categoryRaw)
    ? (categoryRaw as Category)
    : undefined;
  const service = (SERVICES as readonly string[]).includes(serviceRaw)
    ? (serviceRaw as Service)
    : undefined;
  const from = parseDate(fromRaw);
  const to = parseDate(toRaw);

  const filter: MetricFilter = {
    ...(development && { development }),
    ...(category && { category }),
    ...(service && { service }),
    ...(from && { from }),
    ...(to && { to }),
  };

  return {
    granularity,
    filter,
    selected: { development, category: categoryRaw, service: serviceRaw, from: fromRaw, to: toRaw },
  };
}

/**
 * Human labels. NYCHA's own vocabulary is `heat_hot_water` and `restored_24h`;
 * a resident should not have to read a database column name.
 */
export const CATEGORY_LABELS: Record<Category, string> = {
  heat_hot_water: 'Heat and hot water',
  elevator: 'Elevator',
  electric: 'Electricity',
  gas: 'Gas',
};

export const SERVICE_LABELS: Record<Service, string> = {
  heat: 'Heat',
  hot_water: 'Hot water',
  water: 'Water',
  elevator: 'Elevator',
  electric: 'Electricity',
  gas: 'Gas',
};

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  week: 'By week',
  month: 'By month',
  season: 'By heat season',
  year: 'By year',
};
