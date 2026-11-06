import { clauseRange, removeClause } from './query-sync.js';
import { extractSearchOptions } from './search.js';

/** Default controls may leave the catalog idle; a selected commander scope is a search. */
export function hasCatalogQueryIntent(query, { generatedClause = '', scopeClause = '', hasUserConditions = false, error = null } = {}) {
  if (error || hasUserConditions) return true;
  const text = String(query ?? '').trim();
  if (scopeClause && clauseRange(text, scopeClause)) return true;
  // Remove only the default visual clause. The commander boundary remains an
  // explicit condition even when it is the only restriction chosen in a deck.
  const manual = removeClause(text, generatedClause);
  try { return Boolean(extractSearchOptions(manual).query.trim()); }
  catch { return Boolean(manual.trim()); } // Let search validation explain malformed input.
}
