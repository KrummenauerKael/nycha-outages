import { describe, expect, it } from 'vitest';
import { ABSENT_CONTENT_HASH, schema } from '@archive/db';
import { identify } from '../src/identify.js';
import { persistObservations } from '../src/observations.js';
import { fakeDb, observation, parseResultOf } from './helpers.js';

const fetchedAt = new Date('2026-08-07T12:00:00.000Z');

function write(
  observations: ReturnType<typeof observation>[],
  options: Parameters<typeof fakeDb>[0] = {},
) {
  const fake = fakeDb(options);
  const identified = identify(parseResultOf(observations));

  return {
    fake,
    run: () =>
      fake.db.transaction((tx) =>
        persistObservations(tx, {
          snapshotId: 5n,
          fetchedAt,
          identified,
          parserVersion: '1.0.0',
        }),
      ),
  };
}

describe('persistObservations, first sighting', () => {
  it('inserts an event and its first version', async () => {
    const { fake, run } = write([observation()]);
    const summary = await run();

    expect(summary.eventsInserted).toBe(1);
    expect(summary.versionsInserted).toBe(1);
    expect(summary.versionsBumped).toBe(0);
    expect(summary.absencesRecorded).toBe(0);

    const event = fake.rowsFor(schema.outageEvent)[0];
    expect(event).toMatchObject({
      developmentRaw: 'SMITH',
      servicesKey: 'heat',
      firstSeenSnapshotId: 5n,
      lastSeenSnapshotId: 5n,
    });
  });

  it('marks the version present and stamps the parser version', async () => {
    const { fake, run } = write([observation()]);
    await run();

    expect(fake.rowsFor(schema.outageObservation)[0]).toMatchObject({
      isPresent: true,
      parserVersion: '1.0.0',
      impactSource: 'row',
      restorationHours: 5,
    });
  });

  // Invariant 2: one row per service, each with its own flags.
  it('writes one service row per service with per-service flags', async () => {
    const { fake, run } = write([
      observation({
        services: ['heat', 'elevator'],
        isPlannedByService: { heat: true, elevator: false },
        partialServiceByService: { elevator: true },
      }),
    ]);
    const summary = await run();

    expect(summary.serviceRows).toBe(2);

    const rows = fake.rowsFor(schema.observationService);
    expect(rows.find((r) => r['service'] === 'heat')).toMatchObject({
      isPlanned: true,
      isPartialService: null,
    });
    expect(rows.find((r) => r['service'] === 'elevator')).toMatchObject({
      isPlanned: false,
      isPartialService: true,
    });
  });

  // Invariant 4: children are kept so a rollup can be re-audited later.
  it('writes child rows in document order', async () => {
    const { fake, run } = write([
      observation({
        impactSource: 'children_rollup',
        children: [
          {
            buildingRaw: 'A',
            addressRaw: '1 St',
            impact: { buildings: 1, units: 4, residents: 9 },
          },
          {
            buildingRaw: 'B',
            addressRaw: '2 St',
            impact: { buildings: 1, units: 6, residents: 12 },
          },
        ],
      }),
    ]);
    const summary = await run();

    expect(summary.childRows).toBe(2);
    expect(fake.rowsFor(schema.observationChild).map((r) => r['ordinal'])).toEqual([0, 1]);
    expect(fake.rowsFor(schema.observationChild)[1]).toMatchObject({
      buildingRaw: 'B',
      residents: 12,
    });
  });
});

describe('persistObservations, unchanged content', () => {
  const row = observation();
  const identity = identify(parseResultOf([row]))[0]!;

  it('bumps last_seen instead of inserting a version', async () => {
    const fake = fakeDb({
      selectRows: new Map<unknown, Record<string, unknown>[]>([
        [schema.outageEvent, [{ id: 900n, identityHash: identity.identity }]],
        [
          schema.outageObservation,
          [{ id: 7n, eventId: 900n, contentHash: identity.content, isPresent: true }],
        ],
      ]),
      openEventIds: [900n],
    });

    const summary = await fake.db.transaction((tx) =>
      persistObservations(tx, {
        snapshotId: 5n,
        fetchedAt,
        identified: [identity],
        parserVersion: '1.0.0',
      }),
    );

    expect(summary.versionsInserted).toBe(0);
    expect(summary.versionsBumped).toBe(1);
    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsBumped).toBe(1);
    // Still present, so no absence row despite being in the open set.
    expect(summary.absencesRecorded).toBe(0);
    expect(fake.rowsFor(schema.outageObservation)).toEqual([]);
    expect(fake.updatesFor(schema.outageObservation)[0]?.set).toMatchObject({
      lastSeenSnapshotId: 5n,
    });
  });
});

describe('persistObservations, changed content', () => {
  it('inserts a new version when the content hash differs', async () => {
    const row = observation({ restorationHours: 51 });
    const identity = identify(parseResultOf([row]))[0]!;

    const fake = fakeDb({
      selectRows: new Map<unknown, Record<string, unknown>[]>([
        [schema.outageEvent, [{ id: 900n, identityHash: identity.identity }]],
        [
          schema.outageObservation,
          [{ id: 7n, eventId: 900n, contentHash: 'stale'.padEnd(64, '0'), isPresent: true }],
        ],
      ]),
      openEventIds: [900n],
    });

    const summary = await fake.db.transaction((tx) =>
      persistObservations(tx, {
        snapshotId: 5n,
        fetchedAt,
        identified: [identity],
        parserVersion: '1.0.0',
      }),
    );

    expect(summary.versionsInserted).toBe(1);
    expect(summary.versionsBumped).toBe(0);
    expect(fake.rowsFor(schema.outageObservation)[0]).toMatchObject({ restorationHours: 51 });
  });

  // Reappearing after an absence must open a fresh version, never resurrect the
  // closed one, even if the content happens to hash identically to before.
  it('opens a new version when the current version recorded absence', async () => {
    const row = observation();
    const identity = identify(parseResultOf([row]))[0]!;

    const fake = fakeDb({
      selectRows: new Map<unknown, Record<string, unknown>[]>([
        [schema.outageEvent, [{ id: 900n, identityHash: identity.identity }]],
        [
          schema.outageObservation,
          [{ id: 7n, eventId: 900n, contentHash: identity.content, isPresent: false }],
        ],
      ]),
    });

    const summary = await fake.db.transaction((tx) =>
      persistObservations(tx, {
        snapshotId: 5n,
        fetchedAt,
        identified: [identity],
        parserVersion: '1.0.0',
      }),
    );

    expect(summary.versionsInserted).toBe(1);
    expect(summary.versionsBumped).toBe(0);
  });
});

describe('persistObservations, absence', () => {
  // The fact the archive exists for: an outage that stops being published has
  // ended, and that is recorded explicitly rather than inferred from a gap.
  it('closes an open event that is no longer on the page', async () => {
    const { fake, run } = write([observation()], { openEventIds: [555n] });
    const summary = await run();

    expect(summary.absencesRecorded).toBe(1);

    const absent = fake.rowsFor(schema.outageObservation).find((r) => r['isPresent'] === false);

    expect(absent).toMatchObject({
      eventId: 555n,
      contentHash: ABSENT_CONTENT_HASH,
      isPresent: false,
      impactSource: 'missing',
      rowIndex: -1,
    });
  });

  // Absence means nothing was published. Carrying the last known figures forward
  // would read as NYCHA having reported them for this hour.
  it('leaves impact null on an absence row', async () => {
    const { fake, run } = write([], { openEventIds: [555n] });
    await run();

    const absent = fake.rowsFor(schema.outageObservation)[0];
    expect(absent?.['impactBuildings']).toBeUndefined();
    expect(absent?.['impactResidents']).toBeUndefined();
    expect(absent?.['restorationHours']).toBeUndefined();
  });

  it('does not close an event that is still present', async () => {
    const row = observation();
    const identity = identify(parseResultOf([row]))[0]!;

    const fake = fakeDb({
      selectRows: new Map<unknown, Record<string, unknown>[]>([
        [schema.outageEvent, [{ id: 900n, identityHash: identity.identity }]],
      ]),
      openEventIds: [900n],
    });

    const summary = await fake.db.transaction((tx) =>
      persistObservations(tx, {
        snapshotId: 5n,
        fetchedAt,
        identified: [identity],
        parserVersion: '1.0.0',
      }),
    );

    expect(summary.absencesRecorded).toBe(0);
  });

  it('closes several at once', async () => {
    const { fake, run } = write([], { openEventIds: [1n, 2n, 3n] });
    const summary = await run();

    expect(summary.absencesRecorded).toBe(3);
    expect(fake.rowsFor(schema.outageObservation)).toHaveLength(3);
  });
});
