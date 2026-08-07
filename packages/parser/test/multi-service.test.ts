import { describe, expect, it } from 'vitest';
import { ParseError, parseOutagesPage, type ParseResult } from '../src/index.js';

/**
 * These synthetic pages contain only the heat "Current" panel, so the parser
 * correctly reports the other ten panels as absent. Those are expected here;
 * only row-level warnings are under test.
 */
const rowWarnings = (r: ParseResult): string[] =>
  r.warnings.filter((w) => !w.includes('not found'));

/**
 * The 2026-08-06 fixture happens to contain no multi-service rows and no row
 * that is planned for one service and unplanned for another. Both are documented
 * behaviours of this page and both will appear in heat season, so they are
 * covered with synthetic markup that mirrors NYCHA's structure exactly.
 *
 * The mapping under test is POSITIONAL: the Nth span in the Planned column
 * describes the Nth span in the Interruption column, whether or not it is shown.
 */

const P = 'ctl00_ContentPlaceHolder1_heatHotWaterOutagesList';

interface SpanSpec {
  icon: string;
  alt: string;
  visible: boolean;
}

const SERVICE_SPANS: SpanSpec[] = [
  { icon: 'heat-01.svg', alt: 'Heat', visible: false },
  { icon: 'hotwater-01.svg', alt: 'Hot Water', visible: false },
  { icon: 'water-01.svg', alt: 'Water', visible: false },
  { icon: 'elevator-01.svg', alt: 'Elevator', visible: false },
  { icon: 'electricity-01.svg', alt: 'Electric', visible: false },
];

function span(s: SpanSpec): string {
  const display = s.visible ? 'block' : 'none';
  return `<span style="padding-bottom: 5px; display: ${display};">
    <img src="images/${s.icon}" alt="${s.alt}" width="20" height="20" />${s.alt}<br />
  </span>`;
}

function plannedSpan(planned: boolean | null, visible: boolean): string {
  const display = visible ? 'block' : 'none';
  const icon = planned ? 'planned-01.svg' : 'unplanned-01.svg';
  const alt = planned ? 'Planned' : 'Unplanned';
  return `<span style="padding-bottom: 5px; display: ${display};">
    <img src="images/${icon}" alt="${alt}" width="20" height="20" /><br />${alt}
  </span>`;
}

interface RowOptions {
  /** Index -> planned flag, for the services made visible. */
  visible: Record<number, boolean>;
  impact?: [number, number, number] | null;
  children?: Array<{ building: string; impact: [number, number, number] }>;
  /** Emit a Planned column with a different span count (structural corruption). */
  plannedSpanCount?: number;
  icon?: string;
}

function buildPage(opts: RowOptions): string {
  const services = SERVICE_SPANS.map((s, i) => ({
    ...s,
    visible: i in opts.visible,
    ...(opts.icon && i in opts.visible ? { icon: opts.icon } : {}),
  }));

  const interruption = services.map(span).join('\n');

  const plannedCount = opts.plannedSpanCount ?? services.length;
  const planned = Array.from({ length: plannedCount }, (_v, i) =>
    plannedSpan(opts.visible[i] ?? false, i in opts.visible),
  ).join('\n');

  const impactTable = (figures: [number, number, number] | null, hidden: boolean) => `
    <table class="nested"${hidden ? ' style="display: none;"' : ''}>
      <tr><th>Buildings</th><th>Units</th><th>Residents</th></tr>
      <tr>
        <td>${figures ? figures[0] : ''}</td>
        <td>${figures ? figures[1] : ''}</td>
        <td>${figures ? figures[2] : ''}</td>
      </tr>
    </table>`;

  const childRows = (opts.children ?? [])
    .map(
      (c) => `<tr style="padding-left: 20px;">
        <td colspan="5" style="padding-left: 20px;">
          <div style="font-weight: bold">${c.building}</div>
          100 TEST STREET<br />BROOKLYN,NY 11111<br />
        </td>
        <td>${impactTable(c.impact, false)}</td>
      </tr>`,
    )
    .join('\n');

  const rowCount = 1;

  return `<html><body>
  <span id="${P}_lblOutagesCountOpen">${rowCount}</span>
  <div id="${P}_panOpenOutages">
    <table id="grvOutagesOpen">
      <tr>
        <th>Address</th><th>Interruption</th><th>Planned</th>
        <th>Report Date</th><th>Status</th><th>Impact</th>
      </tr>
      <tr style="background:#e2e0df !important">
        <td>
          <div style="font-weight: bold">TEST HOUSES  - Entire Development</div>
          <span style="display: block;">1 TEST AVENUE<br />BROOKLYN, NY 11111<br /></span>
          <span style="display: none;">Sectional</span>
        </td>
        <td>${interruption}</td>
        <td>${planned}</td>
        <td>08/06/2026<br />1:00 PM</td>
        <td><a class="tooltips">Vendor Working <span>Vendor is working to fix the issue</span></a></td>
        <td>${impactTable(opts.impact ?? null, opts.impact == null)}</td>
      </tr>
      ${childRows}
    </table>
  </div>
</body></html>`;
}

describe('multi-service rows', () => {
  it('resolves several affected services on one row', () => {
    const result = parseOutagesPage(
      buildPage({ visible: { 0: false, 3: false }, impact: [1, 2, 3] }),
    );
    const row = result.observations[0];
    expect(row?.services).toEqual(['heat', 'elevator']);
  });

  it('maps planned/unplanned per service, positionally', () => {
    // Heat is PLANNED, elevator is UNPLANNED, on the same row.
    const result = parseOutagesPage(
      buildPage({ visible: { 0: true, 3: false }, impact: [1, 2, 3] }),
    );
    const row = result.observations[0];

    expect(row?.services).toEqual(['heat', 'elevator']);
    expect(row?.isPlannedByService).toEqual({ heat: true, elevator: false });
  });

  it('does not let a planned service contaminate an unplanned one', () => {
    const result = parseOutagesPage(
      buildPage({ visible: { 1: false, 4: true }, impact: [1, 2, 3] }),
    );
    const row = result.observations[0];

    expect(row?.isPlannedByService).toEqual({ hot_water: false, electric: true });
  });
});

describe('structural failures are loud', () => {
  it('throws when the Planned column no longer aligns with Interruption', () => {
    expect(() =>
      parseOutagesPage(buildPage({ visible: { 0: false }, plannedSpanCount: 3 })),
    ).toThrow(ParseError);
  });

  it('throws on an unrecognised service icon rather than dropping it', () => {
    expect(() =>
      parseOutagesPage(buildPage({ visible: { 0: false }, icon: 'sewage-01.svg' })),
    ).toThrow(ParseError);
  });
});

describe('blank impact fields', () => {
  it('rolls up children when the parent is blank', () => {
    const result = parseOutagesPage(
      buildPage({
        visible: { 0: false },
        impact: null,
        children: [
          { building: 'Building 01', impact: [1, 50, 80] },
          { building: 'Building 02', impact: [1, 60, 95] },
        ],
      }),
    );
    const row = result.observations[0];

    expect(row?.impactSource).toBe('children_rollup');
    expect(row?.impact).toEqual({ buildings: 2, units: 110, residents: 175 });
    expect(rowWarnings(result)).toEqual([]);
  });

  it('warns loudly when a row has neither its own figures nor children', () => {
    const result = parseOutagesPage(buildPage({ visible: { 0: false }, impact: null }));
    const row = result.observations[0];

    expect(row?.impactSource).toBe('missing');
    expect(row?.impact).toEqual({ buildings: null, units: null, residents: null });
    expect(rowWarnings(result)).toHaveLength(1);
    expect(rowWarnings(result)[0]).toContain('no impact');
  });

  it('warns when parent figures disagree with the children beneath them', () => {
    const result = parseOutagesPage(
      buildPage({
        visible: { 0: false },
        impact: [2, 110, 999],
        children: [
          { building: 'Building 01', impact: [1, 50, 80] },
          { building: 'Building 02', impact: [1, 60, 95] },
        ],
      }),
    );

    expect(result.observations[0]?.impactSource).toBe('row');
    expect(rowWarnings(result)[0]).toContain('!= children sum 175');
  });
});
