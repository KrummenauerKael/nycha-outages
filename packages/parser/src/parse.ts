import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import {
  PARSER_VERSION,
  ParseError,
  type Category,
  type CategorySummary,
  type ChildRow,
  type ImpactFigures,
  type ImpactSource,
  type OutageObservation,
  type ParseResult,
  type ScopeLevel,
  type Service,
  type SubTable,
  type SummaryCounts,
} from './types.js';
import {
  brLines,
  directRows,
  headerMap,
  isVisible,
  norm,
  toHoursOrNull,
  toIntOrNull,
} from './html.js';
import { plannedFromMarker, serviceFromIcon } from './icons.js';

const PREFIX = 'ctl00_ContentPlaceHolder1_';

const LIST_ID: Record<Category, string> = {
  heat_hot_water: 'heatHotWaterOutagesList',
  elevator: 'elevatorOutagesList',
  electric: 'electricOutagesList',
  gas: 'gasOutagesList',
};

interface TableSpec {
  category: Category;
  subTable: SubTable;
  panelId: string;
  countId: string;
}

function spec(category: Category, subTable: SubTable, panel: string, count: string): TableSpec {
  return {
    category,
    subTable,
    panelId: `${PREFIX}${LIST_ID[category]}_${panel}`,
    countId: `${PREFIX}${count}`,
  };
}

/**
 * Every table we expect on the page. Note elevator's fourth sub-table (Rehab)
 * and gas's single flat grid — neither matches the other categories' shape.
 */
const TABLE_SPECS: TableSpec[] = [
  spec(
    'heat_hot_water',
    'current',
    'panOpenOutages',
    `${LIST_ID.heat_hot_water}_lblOutagesCountOpen`,
  ),
  spec(
    'heat_hot_water',
    'restored_24h',
    'panOutagesClosedIn24Hours',
    `${LIST_ID.heat_hot_water}_lblOutagesCountClosed24Hours`,
  ),
  spec(
    'heat_hot_water',
    'upcoming_planned',
    'panPlannedOutages',
    `${LIST_ID.heat_hot_water}_lblOutagesCountPlannedOutage`,
  ),

  spec('elevator', 'current', 'panOpenOutages', `${LIST_ID.elevator}_lblOutagesCountOpen`),
  spec('elevator', 'rehab', 'PanRehab', `${LIST_ID.elevator}_lblOutagesCountRehab`),
  spec(
    'elevator',
    'restored_24h',
    'panOutagesClosedIn24Hours',
    `${LIST_ID.elevator}_lblOutagesCountClosed24Hours`,
  ),
  spec(
    'elevator',
    'upcoming_planned',
    'panPlannedOutages',
    `${LIST_ID.elevator}_lblOutagesCountPlannedOutage`,
  ),

  spec('electric', 'current', 'panOpenOutages', `${LIST_ID.electric}_lblOutagesCountOpen`),
  spec(
    'electric',
    'restored_24h',
    'panOutagesClosedIn24Hours',
    `${LIST_ID.electric}_lblOutagesCountClosed24Hours`,
  ),
  spec(
    'electric',
    'upcoming_planned',
    'panPlannedOutages',
    `${LIST_ID.electric}_lblOutagesCountPlannedOutage`,
  ),

  spec('gas', 'gas_current', 'panData', 'lblGasOutagesCount'),
];

const EMPTY_IMPACT: ImpactFigures = { buildings: null, units: null, residents: null };

function hasFigures(i: ImpactFigures): boolean {
  return i.buildings !== null || i.units !== null || i.residents !== null;
}

function sumField(children: ChildRow[], key: keyof ImpactFigures): number | null {
  const present = children.map((c) => c.impact[key]).filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/** Read a `<table class="nested">` of Buildings/Units/Residents. Blanks -> null. */
function parseImpact(
  $: CheerioAPI,
  $cell: Cheerio<Element>,
  ctx: Record<string, unknown>,
): ImpactFigures {
  const $nested = $cell.children('table.nested').first();
  if ($nested.length === 0) return { ...EMPTY_IMPACT };

  const $dataRow = directRows($nested as Cheerio<Element>)
    .filter((_i, el) => $(el).children('td').length > 0)
    .first();
  if ($dataRow.length === 0) return { ...EMPTY_IMPACT };

  const $tds = $dataRow.children('td');
  return {
    buildings: toIntOrNull($tds.eq(0).text(), ctx),
    units: toIntOrNull($tds.eq(1).text(), ctx),
    residents: toIntOrNull($tds.eq(2).text(), ctx),
  };
}

interface AddressParts {
  developmentRaw: string;
  buildingRaw: string | null;
  addressRaw: string | null;
  addressDisplayed: boolean;
  boroughRaw: string | null;
  scopeLevel: ScopeLevel;
  isSectional: boolean;
}

function boroughFrom(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^(.+?),\s*NY\b/i.exec(line);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseAddressCell($: CheerioAPI, $cell: Cheerio<Element>): AddressParts {
  const boldText = norm($cell.children('div').first().text());
  const $spans = $cell.children('span');
  const $addr = $spans.eq(0) as Cheerio<Element>;
  const $sect = $spans.eq(1) as Cheerio<Element>;

  const addressLines = brLines($, $addr);
  const addressDisplayed = $addr.length > 0 && isVisible($addr);

  // "Sectional" is emitted on every row; only the display tells you it applies.
  const isSectional = $sect.length > 0 && isVisible($sect) && /sectional/i.test(norm($sect.text()));

  const m = /^(.*?)\s+-\s+(Entire Development|Building\s+.+)$/i.exec(boldText);
  const developmentRaw = m?.[1] ? m[1].trim() : boldText;
  const suffix = m?.[2]?.trim() ?? null;

  let scopeLevel: ScopeLevel = 'unspecified';
  let buildingRaw: string | null = null;
  if (isSectional) {
    scopeLevel = 'sectional';
  } else if (suffix && /^entire development$/i.test(suffix)) {
    scopeLevel = 'entire_development';
  } else if (suffix && /^building/i.test(suffix)) {
    scopeLevel = 'building';
    buildingRaw = suffix;
  }

  return {
    developmentRaw,
    buildingRaw,
    addressRaw: addressLines.length > 0 ? addressLines.join(', ') : null,
    addressDisplayed,
    boroughRaw: boroughFrom(addressLines),
    scopeLevel,
    isSectional,
  };
}

interface ServiceParts {
  services: Service[];
  isPlannedByService: Partial<Record<Service, boolean>>;
  partialServiceByService: Partial<Record<Service, boolean>>;
}

function parseServices(
  $: CheerioAPI,
  $interruption: Cheerio<Element>,
  $planned: Cheerio<Element> | null,
  ctx: Record<string, unknown>,
): ServiceParts {
  const $iSpans = $interruption.children('span');
  const $pSpans = $planned ? $planned.children('span') : null;

  if ($pSpans && $pSpans.length !== $iSpans.length) {
    throw new ParseError(
      'Interruption and Planned columns have different span counts; per-service ' +
        'planned mapping is positional and can no longer be trusted',
      { ...ctx, interruptionSpans: $iSpans.length, plannedSpans: $pSpans.length },
    );
  }

  const services: Service[] = [];
  const isPlannedByService: Partial<Record<Service, boolean>> = {};
  const partialServiceByService: Partial<Record<Service, boolean>> = {};

  $iSpans.each((i, el) => {
    const $s = $(el) as Cheerio<Element>;
    if (!isVisible($s)) return; // icon is emitted but does not apply to this row

    const src = $s.find('img').first().attr('src') ?? '';
    const service = serviceFromIcon(src, { ...ctx, spanIndex: i });
    services.push(service);
    partialServiceByService[service] = $s.find('.elevator-partial-service').length > 0;

    if ($pSpans) {
      const $img = $pSpans.eq(i).find('img').first();
      isPlannedByService[service] = plannedFromMarker(
        $img.attr('alt') ?? '',
        $img.attr('src') ?? '',
        {
          ...ctx,
          spanIndex: i,
          service,
        },
      );
    }
  });

  return { services, isPlannedByService, partialServiceByService };
}

/** Status is an anchor whose nested <span> holds the tooltip text; strip it. */
function parseStatus($cell: Cheerio<Element>): string | null {
  const $a = $cell.find('a').first();
  if ($a.length > 0) {
    const $clone = $a.clone();
    $clone.find('span').remove();
    return norm($clone.text()) || null;
  }
  return norm($cell.text()) || null;
}

function parseChildRow(
  $: CheerioAPI,
  $row: Cheerio<Element>,
  ctx: Record<string, unknown>,
): ChildRow {
  const $tds = $row.children('td');
  const $first = $tds.eq(0) as Cheerio<Element>;
  const buildingRaw = norm($first.children('div').first().text()) || null;

  const $clone = $first.clone();
  $clone.children('div').remove();
  const lines = brLines($, $clone as Cheerio<Element>);

  return {
    buildingRaw,
    addressRaw: lines.length > 0 ? lines.join(', ') : null,
    impact: parseImpact($, $tds.eq($tds.length - 1) as Cheerio<Element>, ctx),
  };
}

function parseStandardTable(
  $: CheerioAPI,
  s: TableSpec,
  $table: Cheerio<Element>,
  warnings: string[],
): OutageObservation[] {
  const $rows = directRows($table);
  const $header = $rows.filter((_i, el) => $(el).children('th').length > 0).first();
  if ($header.length === 0) {
    throw new ParseError('Table has no header row', { panelId: s.panelId });
  }
  const cols = headerMap($, $header as Cheerio<Element>);

  const idxAddress = cols.get('address');
  const idxInterruption = cols.get('interruption');
  const idxPlanned = cols.get('planned');
  const idxReport = cols.get('report date');
  const idxScheduled = cols.get('scheduled date');
  const idxStatus = cols.get('status');
  const idxRestoration = cols.get('restoration time');
  const idxImpact = cols.get('impact');

  if (idxAddress === undefined || idxInterruption === undefined) {
    throw new ParseError('Table is missing Address/Interruption columns', {
      panelId: s.panelId,
      columns: [...cols.keys()],
    });
  }

  const observations: OutageObservation[] = [];

  $rows.each((_i, el) => {
    const $row = $(el) as Cheerio<Element>;
    if ($row.children('th').length > 0) return; // header

    const style = $row.attr('style') ?? '';
    const ctx = { panelId: s.panelId, rowIndex: observations.length };

    // Indented child rows belong to the parent immediately above them.
    if (/padding-left/i.test(style)) {
      const parent = observations[observations.length - 1];
      if (!parent) {
        throw new ParseError('Child row appeared before any parent row', ctx);
      }
      parent.children.push(parseChildRow($, $row, ctx));
      return;
    }

    const $tds = $row.children('td');
    const address = parseAddressCell($, $tds.eq(idxAddress) as Cheerio<Element>);
    const svc = parseServices(
      $,
      $tds.eq(idxInterruption) as Cheerio<Element>,
      idxPlanned === undefined ? null : ($tds.eq(idxPlanned) as Cheerio<Element>),
      ctx,
    );

    observations.push({
      category: s.category,
      subTable: s.subTable,
      rowIndex: observations.length,
      ...address,
      ...svc,
      reportDateRaw:
        idxReport === undefined
          ? null
          : brLines($, $tds.eq(idxReport) as Cheerio<Element>).join(' ') || null,
      scheduledDateRaw:
        idxScheduled === undefined
          ? null
          : brLines($, $tds.eq(idxScheduled) as Cheerio<Element>).join(' ') || null,
      status: idxStatus === undefined ? null : parseStatus($tds.eq(idxStatus) as Cheerio<Element>),
      restorationHours:
        idxRestoration === undefined ? null : toHoursOrNull($tds.eq(idxRestoration).text(), ctx),
      locationRaw: null,
      impact:
        idxImpact === undefined
          ? { ...EMPTY_IMPACT }
          : parseImpact($, $tds.eq(idxImpact) as Cheerio<Element>, ctx),
      impactSource: 'missing',
      children: [],
    });
  });

  // Resolve parent/child impact only after all children are attached.
  for (const obs of observations) {
    const rowFigures = obs.impact;
    let source: ImpactSource;

    if (hasFigures(rowFigures)) {
      source = 'row';
      if (obs.children.length > 0) {
        const rolled = sumField(obs.children, 'residents');
        if (rolled !== null && rowFigures.residents !== null && rolled !== rowFigures.residents) {
          warnings.push(
            `${s.category}/${s.subTable} row ${obs.rowIndex} (${obs.developmentRaw}): parent ` +
              `residents ${rowFigures.residents} != children sum ${rolled}; kept parent figure`,
          );
        }
      }
    } else if (obs.children.length > 0) {
      source = 'children_rollup';
      obs.impact = {
        buildings: sumField(obs.children, 'buildings'),
        units: sumField(obs.children, 'units'),
        residents: sumField(obs.children, 'residents'),
      };
    } else {
      source = 'missing';
      warnings.push(
        `${s.category}/${s.subTable} row ${obs.rowIndex} (${obs.developmentRaw}): no impact ` +
          `figures on the row and no child rows to roll up`,
      );
    }
    obs.impactSource = source;
  }

  return observations;
}

/**
 * Gas is structurally unlike the other three: one flat grid, no Impact block,
 * no Status, no planned/unplanned marker. It therefore cannot contribute to
 * resident-hours, and `isPlannedByService` is left empty rather than guessed.
 */
function parseGasTable($: CheerioAPI, s: TableSpec, $table: Cheerio<Element>): OutageObservation[] {
  const $rows = directRows($table);
  const $header = $rows.filter((_i, el) => $(el).children('th').length > 0).first();
  if ($header.length === 0)
    throw new ParseError('Gas table has no header row', { panelId: s.panelId });
  const cols = headerMap($, $header as Cheerio<Element>);

  const idxAddress = cols.get('address') ?? 0;
  const idxLocation = cols.get('location');
  const idxOutage = cols.get('outage');
  const idxReported = cols.get('reported');
  const idxEst = cols.get('est. completion');

  const observations: OutageObservation[] = [];

  $rows.each((_i, el) => {
    const $row = $(el) as Cheerio<Element>;
    if ($row.children('th').length > 0) return;
    const $tds = $row.children('td');
    if ($tds.length === 0) return;

    const ctx = { panelId: s.panelId, rowIndex: observations.length };
    const $cell = $tds.eq(idxAddress) as Cheerio<Element>;
    const $divs = $cell.children('div');
    const developmentRaw = norm($divs.eq(0).text());

    const $body = $divs.eq(1) as Cheerio<Element>;
    const $inner = $body.children('div');
    const $visibleInner = $inner.filter((_j, d) => isVisible($(d) as Cheerio<Element>));
    const lineRaw = norm($visibleInner.last().text()) || null;

    const $bodyClone = $body.clone();
    $bodyClone.children('div').remove();
    const addressRaw = norm($bodyClone.text()) || null;

    const services: Service[] = [];
    if (idxOutage !== undefined) {
      const src = $tds.eq(idxOutage).find('img').first().attr('src');
      if (src) services.push(serviceFromIcon(src, ctx));
    }

    observations.push({
      category: s.category,
      subTable: s.subTable,
      rowIndex: observations.length,
      developmentRaw,
      buildingRaw: lineRaw,
      addressRaw,
      addressDisplayed: true,
      boroughRaw: boroughFrom(addressRaw ? [addressRaw] : []),
      scopeLevel: 'unspecified',
      isSectional: false,
      services,
      isPlannedByService: {},
      partialServiceByService: {},
      reportDateRaw: idxReported === undefined ? null : norm($tds.eq(idxReported).text()) || null,
      scheduledDateRaw: null,
      status: idxEst === undefined ? null : norm($tds.eq(idxEst).text()) || null,
      restorationHours: null,
      locationRaw: idxLocation === undefined ? null : norm($tds.eq(idxLocation).text()) || null,
      impact: { ...EMPTY_IMPACT },
      impactSource: 'missing',
      children: [],
    });
  });

  return observations;
}

function parseSummaries($: CheerioAPI): CategorySummary[] {
  const summaries: CategorySummary[] = [];
  const withSummary: Category[] = ['heat_hot_water', 'elevator', 'electric'];

  for (const category of withSummary) {
    const $panel = $(`#${PREFIX}${LIST_ID[category]}_grayboxPanel`);
    if ($panel.length === 0) continue;

    const asOfRaw = norm($panel.find('h3.outagesSectionTitle').first().text()) || null;
    const $table = $panel.find('table').first() as Cheerio<Element>;

    const read = ($tds: Cheerio<Element>): SummaryCounts => ({
      interruptions: toIntOrNull($tds.eq(1).text()),
      developments: toIntOrNull($tds.eq(2).text()),
      buildings: toIntOrNull($tds.eq(3).text()),
      units: toIntOrNull($tds.eq(4).text()),
      residents: toIntOrNull($tds.eq(5).text()),
    });

    const blank: SummaryCounts = {
      interruptions: null,
      developments: null,
      buildings: null,
      units: null,
      residents: null,
    };
    let planned = blank;
    let unplanned = blank;

    directRows($table).each((_i, el) => {
      const $tds = $(el).children('td') as Cheerio<Element>;
      if ($tds.length === 0) return;
      const label = norm($tds.eq(0).text()).toLowerCase();
      if (label === 'planned') planned = read($tds);
      else if (label === 'unplanned') unplanned = read($tds);
    });

    summaries.push({ category, asOfRaw, planned, unplanned });
  }

  return summaries;
}

/**
 * Parse a stored Outages.aspx document. Pure: no network, no filesystem, no
 * database. Everything it needs is in the HTML string.
 */
export function parseOutagesPage(html: string): ParseResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const observations: OutageObservation[] = [];
  const counts: ParseResult['counts'] = [];

  for (const s of TABLE_SPECS) {
    const $panel = $(`#${s.panelId}`);
    const declared = toIntOrNull($(`#${s.countId}`).text());

    if ($panel.length === 0) {
      warnings.push(`Panel ${s.panelId} not found (${s.category}/${s.subTable})`);
      counts.push({ category: s.category, subTable: s.subTable, declared, parsed: 0 });
      continue;
    }

    const $table = $panel.find('table').first() as Cheerio<Element>;
    if ($table.length === 0) {
      counts.push({ category: s.category, subTable: s.subTable, declared, parsed: 0 });
      continue;
    }

    const rows =
      s.subTable === 'gas_current'
        ? parseGasTable($, s, $table)
        : parseStandardTable($, s, $table, warnings);

    observations.push(...rows);
    counts.push({ category: s.category, subTable: s.subTable, declared, parsed: rows.length });
  }

  return {
    parserVersion: PARSER_VERSION,
    summaries: parseSummaries($),
    observations,
    counts,
    warnings,
  };
}

/**
 * NYCHA prints its own row count on every tab. Comparing it to what we parsed is
 * the cheapest possible guard against silently capturing a subset — the exact
 * failure that would look healthy all season and ruin the dataset. Call this on
 * every ingest run and fail the run if it throws.
 */
export function assertCountsMatch(result: ParseResult): void {
  const bad = result.counts.filter((c) => c.declared !== null && c.declared !== c.parsed);
  if (bad.length > 0) {
    throw new ParseError('Parsed row count does not match the count NYCHA displays', {
      mismatches: bad,
    });
  }
}
