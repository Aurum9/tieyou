import { extractSearchOptions } from './search.js';
// Keep generated filters as a visible top-level conjunct in the editable query.
// If a player edits that conjunct, the input takes ownership of its text.
export function queryClause(query) { return String(query || '').trim() ? `(${String(query).trim()})` : ''; }
function skipQuoted(text, start) {
  let i = start + 1;
  for (; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === '"') return i; }
  return text.length - 1;
}
function topLevelOr(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { i = skipQuoted(text, i); continue; }
    if (text[i] === '(') depth++; else if (text[i] === ')') depth--;
    else if (!depth && /^OR(?=\s|\(|$)/i.test(text.slice(i)) && (i === 0 || /[\s)]/.test(text[i - 1]))) return true;
  }
  return false;
}
export function clauseRange(text, clause) {
  if (!clause || topLevelOr(text)) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { i = skipQuoted(text, i); continue; }
    if (depth === 0 && text.startsWith(clause, i)) {
      const before = text.slice(0, i).trimEnd(), after = text.slice(i + clause.length);
      if ((!before || !/(?:\b(?:OR|NOT)|-)$/i.test(before)) && (!after || /^[\s)]/.test(after))) return [i, i + clause.length];
    }
    if (text[i] === '(') depth++; else if (text[i] === ')') depth--;
  }
  return null;
}
export function removeClause(text, clause) {
  const range = clauseRange(text, clause); if (!range) return text.trim();
  let before = text.slice(0, range[0]).trimEnd(), after = text.slice(range[1]).trimStart();
  if (/\bAND$/i.test(before)) before = before.replace(/\bAND$/i, '').trimEnd();
  if (/^AND\b/i.test(after)) after = after.replace(/^AND\b/i, '').trimStart();
  return [before, after].filter(Boolean).join(' AND ');
}
export function replaceClause(text, oldClause, nextQuery) {
  const nextClause = queryClause(nextQuery), range = clauseRange(text, oldClause);
  if (range && nextClause) return text.slice(0, range[0]) + nextClause + text.slice(range[1]);
  const remaining = range ? removeClause(text, oldClause) : text.trim();
  if (!nextClause) return remaining;
  return remaining ? `${topLevelOr(remaining) ? `(${remaining})` : remaining} AND ${nextClause}` : nextClause;
}
export const SORT_QUERIES = Object.freeze({ name: 'order:name', 'mana-asc': 'order:mv dir:asc', 'mana-desc': 'order:mv dir:desc', 'usd-asc': 'order:usd dir:asc', 'usd-desc': 'order:usd dir:desc', released: 'order:released', edhrec: 'order:edhrec' });
export function sortingQuery(options, defaultSort = 'name') {
  if (options.sort === defaultSort && !options.hasOrder && !options.hasDirection) return '';
  let query = SORT_QUERIES[options.sort] || SORT_QUERIES.name;
  if (options.hasDirection && !/^(mana|usd)-/.test(options.sort)) query += ` dir:${options.descending ? 'desc' : 'asc'}`;
  return query;
}
export function syncQueryClauses(text, { oldVisual = '', visual = '', oldScope = '', scope = '', fallbackSort = 'name', defaultSort = 'name' } = {}) {
  const options = extractSearchOptions(text, fallbackSort);
  let query = replaceClause(options.query, oldVisual, visual);
  query = replaceClause(query, oldScope, scope);
  return { query: [query, sortingQuery(options, defaultSort)].filter(Boolean).join(' '), generatedClause: queryClause(visual), scopeClause: queryClause(scope) };
}
