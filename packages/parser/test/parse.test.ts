import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertCountsMatch,
  parseOutagesPage,
  type OutageObservation,
  type ParseResult,
} from '../src/index';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/outages-2026-08-06T21-21Z.html', import.meta.url),
);

let result: ParseResult;
let heatCurrent: OutageObservation[];

beforeAll(() => {
  result = parseOutagesPage(readFileSync(FIXTURE, 'utf8'));
  heatCurrent = result.observations.filter(
    (o) => o.category === 'heat_hot_water' && o.subTable === 'current',
  );
});

const row = (i: number): OutageObservation => {
  const r = heatCurrent[i];
  if (!r) throw new Error(`fixture row ${i} missing`);
  return r;
};

describe('completeness', () => {
  it('parses exactly the row count NYCHA prints on every tab', () => {
    // The failure this guards against — capturing a subset while looking healthy —
    // would be invisible until the season was already lost.
    expect(() => assertCountsMatch(result)).not.toThrow();
  });

  it('covers all four categories including elevator Rehab and the flat gas grid', () => {
    const shape = Object.fromEntries(
      result.counts.map((c) => [`${c.category}/${c.subTable}`, c.parsed]),
    );
    expect(shape).toEqual({
      'heat_hot_water/current': 7,
      'heat_hot_water/restored_24h': 25,
      'heat_hot_water/upcoming_planned': 56,
      'elevator/current': 7,
      'elevator/rehab': 11,
      'elevator/restored_24h': 74,
      'elevator/upcoming_planned': 5,
      'electric/current': 3,
      'electric/restored_24h': 2,
      'electric/upcoming_planned': 0,
      'gas/gas_current': 58,
    });
  });

  it('parses without warnings on a known-good page', () => {
    expect(result.warnings).toEqual([]);
  });
});

describe('cross-validation against NYCHA totals', () => {
  // The strongest available check: NYCHA independently publishes per-category
  // totals. If our parsing, our parent/child rollup, or our planned/unplanned
  // split were wrong, these sums would diverge.
  const sum = (rows: OutageObservation[], key: 'buildings' | 'units' | 'residents') =>
    rows.reduce((acc, o) => acc + (o.impact[key] ?? 0), 0);

  it('unplanned current heat rows sum to NYCHA published unplanned totals', () => {
    const summary = result.summaries.find((s) => s.category === 'heat_hot_water');
    const unplanned = heatCurrent.filter((o) => !Object.values(o.isPlannedByService).some(Boolean));

    expect(unplanned.length).toBe(summary?.unplanned.interruptions);
    expect(sum(unplanned, 'buildings')).toBe(summary?.unplanned.buildings);
    expect(sum(unplanned, 'units')).toBe(summary?.unplanned.units);
    expect(sum(unplanned, 'residents')).toBe(summary?.unplanned.residents);
  });

  it('planned current heat rows sum to NYCHA published planned totals', () => {
    const summary = result.summaries.find((s) => s.category === 'heat_hot_water');
    const planned = heatCurrent.filter((o) => Object.values(o.isPlannedByService).some(Boolean));

    expect(planned.length).toBe(summary?.planned.interruptions);
    expect(sum(planned, 'residents')).toBe(summary?.planned.residents);
    // The single planned row is a sectional whose figures exist ONLY on children.
    // This total therefore only balances if the rollup is correct.
    expect(sum(planned, 'units')).toBe(156);
  });

  it('keeps planned and unplanned separable on every row', () => {
    for (const o of result.observations) {
      if (o.category === 'gas') continue; // gas carries no planned marker at all
      for (const s of o.services) {
        expect(typeof o.isPlannedByService[s]).toBe('boolean');
      }
    }
  });
});

describe('service resolution via inline display', () => {
  it('reports only the services actually affected, not every emitted icon', () => {
    // Every row emits all five icons. A presence-based selector would return
    // five services here instead of one.
    expect(row(0).services).toEqual(['hot_water']);
    expect(row(4).services).toEqual(['water']);
  });

  it('never returns more services than exist', () => {
    for (const o of result.observations) {
      expect(o.services.length).toBeGreaterThan(0);
      expect(new Set(o.services).size).toBe(o.services.length);
    }
  });
});

describe('row scope', () => {
  it('reads Entire Development rows', () => {
    expect(row(0).developmentRaw).toBe('LONG ISLAND BAPTIST HOUSES');
    expect(row(0).scopeLevel).toBe('entire_development');
    expect(row(0).isSectional).toBe(false);
    expect(row(0).addressDisplayed).toBe(true);
    expect(row(0).boroughRaw).toBe('BROOKLYN');
  });

  it('reads Sectional rows and still captures the hidden address', () => {
    const marlboro = row(1);
    expect(marlboro.developmentRaw).toBe('MARLBORO');
    expect(marlboro.isSectional).toBe(true);
    expect(marlboro.scopeLevel).toBe('sectional');
    // NYCHA hides the address block on sectional rows but still emits it.
    expect(marlboro.addressDisplayed).toBe(false);
    expect(marlboro.addressRaw).toContain('29 AVENUE W');
  });

  it('reads Building NN rows', () => {
    const building = result.observations.find((o) => o.scopeLevel === 'building');
    expect(building?.buildingRaw).toMatch(/^Building\s+\d+/);
  });
});

describe('parent/child impact rollup', () => {
  it('rolls children up when the parent row has blank figures', () => {
    const marlboro = row(1);
    expect(marlboro.impactSource).toBe('children_rollup');
    expect(marlboro.children).toHaveLength(2);
    expect(marlboro.children.map((c) => c.buildingRaw)).toEqual(['Building 23', 'Building 25']);
    expect(marlboro.impact).toEqual({ buildings: 2, units: 112, residents: 196 });
  });

  it('rolls up a larger sectional correctly', () => {
    const nostrand = row(2);
    expect(nostrand.children).toHaveLength(8);
    expect(nostrand.impact).toEqual({ buildings: 8, units: 576, residents: 938 });
  });

  it('never double counts: rows with their own figures ignore children', () => {
    expect(row(0).impactSource).toBe('row');
    expect(row(0).impact).toEqual({ buildings: 4, units: 232, residents: 443 });
    for (const o of result.observations) {
      if (o.impactSource === 'row') expect(o.children).toHaveLength(0);
    }
  });

  it('never drops: every non-gas row ends up with figures', () => {
    for (const o of result.observations) {
      if (o.category === 'gas') continue;
      expect(o.impactSource).not.toBe('missing');
      expect(o.impact.residents).not.toBeNull();
    }
  });
});

describe('restoration time', () => {
  it('takes NYCHA-reported hours as authoritative, including values over 24', () => {
    const hours = result.observations
      .map((o) => o.restorationHours)
      .filter((h): h is number => h !== null);

    expect(hours.length).toBe(101);
    expect(hours.filter((h) => h > 24).length).toBe(12);
    expect(Math.max(...hours)).toBe(533);
  });

  it('only appears on the Restored Within Last 24 Hours sub-table', () => {
    for (const o of result.observations) {
      if (o.restorationHours !== null) expect(o.subTable).toBe('restored_24h');
    }
  });
});

describe('gas', () => {
  const gasRows = () => result.observations.filter((o) => o.category === 'gas');

  it('parses the flat grid with its line designation', () => {
    const first = gasRows()[0];
    expect(first?.developmentRaw).toBe('SOTOMAYOR');
    expect(first?.buildingRaw).toBe('A-LINE');
    expect(first?.services).toEqual(['gas']);
    expect(first?.status).toBe('In Progress');
  });

  it('carries no impact figures, so it can never contribute resident-hours', () => {
    for (const o of gasRows()) {
      expect(o.impact).toEqual({ buildings: null, units: null, residents: null });
      // Not guessed as planned or unplanned — the source simply does not say.
      expect(o.isPlannedByService).toEqual({});
    }
  });
});

describe('summary blocks', () => {
  it('finds one summary per category rather than a single citywide block', () => {
    expect(result.summaries.map((s) => s.category)).toEqual([
      'heat_hot_water',
      'elevator',
      'electric',
    ]);
    expect(result.summaries[0]?.asOfRaw).toContain('August 06, 2026 at 05:14 PM');
  });
});

describe('PARTIAL SERVICE', () => {
  it('is a genuine per-row signal, not decoration', () => {
    // Distinguishes "some elevators still running" from a total outage, which
    // matters for any impact metric built on elevator data.
    const restoredElevator = result.observations.filter(
      (o) => o.category === 'elevator' && o.subTable === 'restored_24h',
    );
    const partial = restoredElevator.filter((o) => o.partialServiceByService.elevator === true);

    expect(partial.length).toBe(43);
    expect(restoredElevator.length - partial.length).toBe(31);
  });

  it('is only ever attached to elevator and electric', () => {
    for (const o of result.observations) {
      if (o.category === 'gas') continue; // gas has no per-service span markup
      for (const s of o.services) {
        if (s === 'elevator' || s === 'electric') continue;
        expect(o.partialServiceByService[s]).toBe(false);
      }
    }
  });
});
