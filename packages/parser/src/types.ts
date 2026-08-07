/**
 * Bump on ANY change to parsing behaviour. Every structured row is tagged with
 * this, so the full archive can be re-parsed and old rows identified.
 */
export const PARSER_VERSION = '1.0.0';

export const SERVICES = ['heat', 'hot_water', 'water', 'elevator', 'electric', 'gas'] as const;
export type Service = (typeof SERVICES)[number];

export const CATEGORIES = ['heat_hot_water', 'elevator', 'electric', 'gas'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Sub-tables within a category. `rehab` is elevator-only (modernization work,
 * not a service interruption). `gas_current` is the flat single grid gas uses —
 * it has no Impact block, so it can never contribute resident-hours.
 */
export const SUB_TABLES = [
  'current',
  'restored_24h',
  'upcoming_planned',
  'rehab',
  'gas_current',
] as const;
export type SubTable = (typeof SUB_TABLES)[number];

export type ScopeLevel = 'entire_development' | 'building' | 'sectional' | 'unspecified';

export interface ImpactFigures {
  buildings: number | null;
  units: number | null;
  residents: number | null;
}

/** Where a row's impact figures came from. Recorded so rollups stay auditable. */
export type ImpactSource = 'row' | 'children_rollup' | 'missing';

/** An indented `<tr style="padding-left: 20px">` row beneath a parent. */
export interface ChildRow {
  buildingRaw: string | null;
  addressRaw: string | null;
  impact: ImpactFigures;
}

export interface OutageObservation {
  category: Category;
  subTable: SubTable;
  /** Index of the parent row within its sub-table, 0-based. */
  rowIndex: number;

  developmentRaw: string;
  buildingRaw: string | null;
  addressRaw: string | null;
  /**
   * NYCHA hides the address block on sectional rows but still emits it. We keep
   * the text either way and record whether it was actually shown.
   */
  addressDisplayed: boolean;
  boroughRaw: string | null;
  scopeLevel: ScopeLevel;
  isSectional: boolean;

  /** Services actually affected — derived from inline `display`, not icon presence. */
  services: Service[];
  /** Per-service planned flag. A row can be planned for one service, unplanned for another. */
  isPlannedByService: Partial<Record<Service, boolean>>;
  /**
   * Per-service PARTIAL SERVICE label — a real signal, only ever emitted on
   * elevator and electric spans. In the 2026-08-06 fixture 43 of 74 restored
   * elevator rows carry it and 31 do not, so "some elevators still running" is
   * distinguishable from a total outage. Heat/hot water/water never carry it.
   */
  partialServiceByService: Partial<Record<Service, boolean>>;

  /** Raw as displayed (America/New_York, no timezone marker). Normalised downstream. */
  reportDateRaw: string | null;
  scheduledDateRaw: string | null;
  status: string | null;
  /** Authoritative duration from NYCHA, in hours. Values well over 24 occur. */
  restorationHours: number | null;
  /** Gas only: the Location column. */
  locationRaw: string | null;

  impact: ImpactFigures;
  impactSource: ImpactSource;
  children: ChildRow[];
}

export interface SummaryCounts {
  interruptions: number | null;
  developments: number | null;
  buildings: number | null;
  units: number | null;
  residents: number | null;
}

/**
 * The grey summary block. There is one PER CATEGORY (heat/hot water, elevator,
 * electric) — not one citywide block. Gas has none.
 */
export interface CategorySummary {
  category: Category;
  asOfRaw: string | null;
  planned: SummaryCounts;
  unplanned: SummaryCounts;
}

export interface ParseResult {
  parserVersion: string;
  summaries: CategorySummary[];
  observations: OutageObservation[];
  /** NYCHA's own tab counts vs. rows we actually parsed. Mismatch = we lost data. */
  counts: Array<{
    category: Category;
    subTable: SubTable;
    declared: number | null;
    parsed: number;
  }>;
  warnings: string[];
}

/**
 * Thrown when the document violates a structural assumption. Always prefer
 * throwing over guessing: a silently wrong parse is far worse than a failed run,
 * because the raw HTML is archived and can be re-parsed once the code is fixed.
 */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ParseError';
  }
}
