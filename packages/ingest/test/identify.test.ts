import { describe, expect, it } from 'vitest';
import { duplicateIdentities, identify } from '../src/identify.js';
import { observation, parseResultOf } from './helpers.js';

describe('identify', () => {
  it('computes identity, content and services key per row', () => {
    const [item] = identify(parseResultOf([observation()]));

    expect(item?.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.content).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.services).toBe('heat');
  });

  // Identity must survive a revision; content must not. This is the property the
  // whole change-only scheme rests on.
  it('keeps identity stable when only mutable content changes', () => {
    const before = identify(parseResultOf([observation({ restorationHours: 5 })]))[0];
    const after = identify(parseResultOf([observation({ restorationHours: 51 })]))[0];

    expect(after?.identity).toBe(before?.identity);
    expect(after?.content).not.toBe(before?.content);
  });

  it('sorts the services key so page order cannot affect identity', () => {
    const a = identify(parseResultOf([observation({ services: ['heat', 'hot_water'] })]))[0];
    const b = identify(parseResultOf([observation({ services: ['hot_water', 'heat'] })]))[0];

    expect(a?.identity).toBe(b?.identity);
    expect(a?.services).toBe('heat,hot_water');
  });

  it('distinguishes two outages that differ only by sub-table', () => {
    const current = identify(parseResultOf([observation({ subTable: 'current' })]))[0];
    const restored = identify(parseResultOf([observation({ subTable: 'restored_24h' })]))[0];

    expect(current?.identity).not.toBe(restored?.identity);
  });
});

describe('duplicateIdentities', () => {
  it('finds nothing in a clean snapshot', () => {
    const identified = identify(
      parseResultOf([
        observation({ developmentRaw: 'SMITH' }),
        observation({ developmentRaw: 'WAGNER' }),
      ]),
    );

    expect(duplicateIdentities(identified)).toEqual([]);
  });

  // rowIndex is excluded from identity on purpose, so two rows differing only by
  // position are a genuine collision — exactly the case that must never be written.
  it('detects two rows that differ only by position', () => {
    const identified = identify(
      parseResultOf([observation({ rowIndex: 0 }), observation({ rowIndex: 1 })]),
    );

    const duplicates = duplicateIdentities(identified);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.rows).toHaveLength(2);
    expect(duplicates[0]?.rows[0]).toContain('SMITH');
  });

  it('reports each colliding identity once, with all of its rows', () => {
    const identified = identify(
      parseResultOf([
        observation({ rowIndex: 0 }),
        observation({ rowIndex: 1 }),
        observation({ rowIndex: 2 }),
      ]),
    );

    const duplicates = duplicateIdentities(identified);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.rows).toHaveLength(3);
  });
});
