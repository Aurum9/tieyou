const hasValue = value => value !== null && value !== undefined && String(value).trim() !== '';

/**
 * Whether the user has supplied a search condition worth loading the catalog for.
 * EDH legality is a default boundary: toggling commanderOnly in either direction,
 * or changing a color relation without selecting colors, does not start a search.
 * An active validation error counts as intent so it can be shown before data loads.
 */
export function hasSearchIntent(query, visual = {}) {
  if (hasValue(query) || hasValue(visual?.query) || visual?.error) return true;
  const filters = visual?.filters || {};
  if (['colors', 'identities', 'types'].some(key => Array.isArray(filters[key]) && filters[key].length)) return true;
  if (hasValue(filters.minManaValue) || hasValue(filters.maxManaValue)) return true;
  return hasValue(filters.translation) && filters.translation !== 'all';
}
