import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { ParseError } from './types';

/** Collapse whitespace and trim. NYCHA's markup is heavily indented. */
export function norm(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The single most important rule in this parser.
 *
 * NYCHA emits EVERY service icon and EVERY planned/unplanned marker on EVERY
 * row, and uses an inline `display` to say which ones actually apply. Selecting
 * on icon presence reports every row as affecting all five services, which looks
 * plausible and is completely wrong. Always go through this function.
 */
export function isVisible($el: Cheerio<Element>): boolean {
  const style = $el.attr('style') ?? '';
  if (/display\s*:\s*none/i.test(style)) return false;
  return true;
}

/** Parse "1,259" -> 1259. Blank -> null. Anything else throws. */
export function toIntOrNull(raw: string, context: Record<string, unknown> = {}): number | null {
  const cleaned = norm(raw).replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) {
    throw new ParseError(`Expected an integer, got ${JSON.stringify(raw)}`, context);
  }
  return Number.parseInt(cleaned, 10);
}

/** Restoration Time is given in whole or fractional hours, often well over 24. */
export function toHoursOrNull(raw: string, context: Record<string, unknown> = {}): number | null {
  const cleaned = norm(raw)
    .replace(/hours?/i, '')
    .replace(/,/g, '')
    .trim();
  if (cleaned === '') return null;
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new ParseError(`Expected hours, got ${JSON.stringify(raw)}`, context);
  }
  return Number.parseFloat(cleaned);
}

/**
 * Direct `<tr>` children of a table. parse5 inserts a `<tbody>`, so a naive
 * `.children('tr')` finds nothing, and `.find('tr')` would wrongly descend into
 * the nested Impact tables.
 */
export function directRows($table: Cheerio<Element>): Cheerio<Element> {
  const $tbody = $table.children('tbody');
  const $rows = $tbody.length > 0 ? $tbody.children('tr') : $table.children('tr');
  return $rows as Cheerio<Element>;
}

/** Map header cell text -> column index, so we never depend on column order. */
export function headerMap($: CheerioAPI, $row: Cheerio<Element>): Map<string, number> {
  const map = new Map<string, number>();
  $row.children('th').each((i, el) => {
    map.set(norm($(el).text()).toLowerCase(), i);
  });
  return map;
}

export function requireColumn(
  map: Map<string, number>,
  name: string,
  context: Record<string, unknown>,
): number {
  const idx = map.get(name.toLowerCase());
  if (idx === undefined) {
    throw new ParseError(`Missing expected column ${JSON.stringify(name)}`, {
      ...context,
      available: [...map.keys()],
    });
  }
  return idx;
}

/** Split a cell's text on <br> into trimmed lines. */
export function brLines($: CheerioAPI, $cell: Cheerio<Element>): string[] {
  const html = $cell.html() ?? '';
  return html
    .split(/<br\s*\/?>/i)
    .map((chunk) => norm($(`<div>${chunk}</div>`).text()))
    .filter((line) => line !== '');
}
