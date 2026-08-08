import { contentHash, identityHash, servicesKey } from '@archive/db';
import type { OutageObservation, ParseResult } from '@archive/parser';

/**
 * Identity and content hashes computed once per parsed row, so nothing downstream
 * recomputes them and risks disagreeing.
 */
export interface IdentifiedObservation {
  observation: OutageObservation;
  identity: string;
  content: string;
  services: string;
}

export function identify(result: ParseResult): IdentifiedObservation[] {
  return result.observations.map((observation) => ({
    observation,
    identity: identityHash(observation),
    content: contentHash(observation),
    services: servicesKey(observation),
  }));
}

export interface DuplicateIdentity {
  identity: string;
  rows: string[];
}

/**
 * Two rows in one snapshot hashing to the same identity.
 *
 * This must never happen: identity was derived empirically to be unique across
 * all 248 rows of the 2026-08-06 fixture, and the `outage_event.identity_hash`
 * unique index enforces it in the database. If it does happen, the two rows are
 * either genuinely distinct outages that identity can no longer tell apart — in
 * which case one would overwrite the other's timeline — or NYCHA has started
 * emitting duplicates.
 *
 * Either way it is invariant 7 territory: refuse to write rather than guess which
 * row wins. Detected before the transaction so the snapshot itself can still be
 * recorded as evidence.
 */
export function duplicateIdentities(identified: IdentifiedObservation[]): DuplicateIdentity[] {
  const byIdentity = new Map<string, IdentifiedObservation[]>();

  for (const item of identified) {
    const bucket = byIdentity.get(item.identity);
    if (bucket) bucket.push(item);
    else byIdentity.set(item.identity, [item]);
  }

  return [...byIdentity.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([identity, rows]) => ({
      identity,
      rows: rows.map(
        ({ observation: o }) =>
          `${o.category}/${o.subTable}#${o.rowIndex} ${o.developmentRaw}` +
          `${o.buildingRaw ? ` / ${o.buildingRaw}` : ''}`,
      ),
    }));
}
