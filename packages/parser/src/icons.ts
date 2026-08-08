import { ParseError, type Service } from './types';

/**
 * Icon filename -> service. NYCHA identifies services only by image, so this map
 * is load-bearing. An unrecognised filename throws rather than being skipped:
 * a new icon means a new service we would otherwise silently drop.
 */
const SERVICE_BY_ICON: Record<string, Service> = {
  'heat-01.svg': 'heat',
  'hotwater-01.svg': 'hot_water',
  'water-01.svg': 'water',
  'elevator-01.svg': 'elevator',
  'electricity-01.svg': 'electric',
  'gas-01.svg': 'gas',
};

/** "images/hotwater-01.svg" -> "hotwater-01.svg" */
export function iconBasename(src: string): string {
  const parts = src.split('/');
  return (parts[parts.length - 1] ?? src).trim().toLowerCase();
}

export function serviceFromIcon(src: string, context: Record<string, unknown> = {}): Service {
  const base = iconBasename(src);
  const service = SERVICE_BY_ICON[base];
  if (!service) {
    throw new ParseError(`Unknown service icon ${JSON.stringify(base)}`, { ...context, src });
  }
  return service;
}

/**
 * The Planned column marks each service independently. A single row can be
 * planned for one service and unplanned for another, so this is resolved
 * per-span, never once per row.
 */
export function plannedFromMarker(
  alt: string,
  src: string,
  context: Record<string, unknown> = {},
): boolean {
  const a = alt.trim().toLowerCase();
  if (a === 'planned') return true;
  if (a === 'unplanned') return false;

  const base = iconBasename(src);
  if (base.startsWith('planned')) return true;
  if (base.startsWith('unplanned')) return false;

  throw new ParseError(`Cannot classify planned marker (alt=${JSON.stringify(alt)})`, {
    ...context,
    src,
  });
}
