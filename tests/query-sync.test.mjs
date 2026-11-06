import test from 'node:test';
import assert from 'node:assert/strict';
import { queryClause, clauseRange, removeClause, replaceClause, syncQueryClauses } from '../dist/lib/query-sync.js';
import { searchCards, extractSearchOptions } from '../dist/lib/search.js';
test('visible generated filters are replaced without accumulating stale constraints', () => { const clause = queryClause('c:u AND f:commander'); let q = replaceClause('Sol Ring order:edhrec', '', 'c:u AND f:commander'); assert.equal(q, `Sol Ring order:edhrec AND ${clause}`); q = replaceClause(q, clause, 'c:g AND f:commander'); assert.equal(q, 'Sol Ring order:edhrec AND (c:g AND f:commander)'); assert.equal(removeClause(q, queryClause('c:g AND f:commander')), 'Sol Ring order:edhrec'); });
test('manual prefix/suffix edits retain visual ownership and removal keeps valid AND syntax', () => { const c = '(f:commander)'; for (const text of [`${c} AND name:Elf`, `name:Elf AND ${c}`, `name:Elf ${c} order:name`]) { assert.ok(clauseRange(text, c)); assert.equal(removeClause(text, c).includes(c), false); } assert.equal(removeClause(`${c} AND (ci<=ug) AND order:edhrec`, c), '(ci<=ug) AND order:edhrec'); });
test('quoted text, nested clauses, negative clauses and OR branches are never mistaken for owned filters', () => { const c = '(c:u)'; for (const text of ['o:"(c:u)"', '((c:u) AND t:elf)', '-(c:u)', 'NOT (c:u)', '(c:u) OR name:Forest']) assert.equal(clauseRange(text, c), null, text); });
test('adding filters to a manual OR expression preserves its whole meaning', () => { assert.equal(replaceClause('name:Elf OR name:Forest', '', 'mv<=2'), '(name:Elf OR name:Forest) AND (mv<=2)'); });
test('removing an entire generated clause leaves an empty query and treats manual rewrites as user-owned', () => { assert.equal(removeClause('(f:commander)', '(f:commander)'), ''); assert.equal(clauseRange('(c:r)', '(c:u)'), null); assert.equal(queryClause('  '), ''); });
test('removing a middle conjunct clears both neighboring separators', () => { assert.equal(removeClause('name:foo AND (f:commander) AND mv<=3', '(f:commander)'), 'name:foo AND mv<=3'); });
test('manual OR conditions retain global sorting outside the generated boolean group', () => {
  const result = syncQueryClauses('t:Creature OR t:Artifact order:edhrec', { visual: 'c:g', scope: 'ci<=ug' });
  assert.equal(result.query, '(t:Creature OR t:Artifact) AND (c:g) AND (ci<=ug) order:edhrec'); assert.equal(extractSearchOptions(result.query).sort, 'edhrec'); assert.equal(searchCards([], result.query).error, null);
});
test('sort aliases and explicit directions survive repeated filter and commander-scope changes', () => {
  let result = syncQueryClauses('Elf sort:edhrec dir:desc', { visual: 'f:commander' });
  assert.equal(result.query, 'Elf AND (f:commander) order:edhrec dir:desc');
  result = syncQueryClauses(result.query, { oldVisual: result.generatedClause, visual: 'mv<=3', scope: 'ci<=g' });
  assert.equal(result.query, 'Elf AND (mv<=3) AND (ci<=g) order:edhrec dir:desc');
  assert.equal(extractSearchOptions(result.query).descending, true);
});
test('default name ordering stays in the sort control while commander scope remains visible', () => {
  assert.equal(syncQueryClauses('').query, '');
  const result = syncQueryClauses('', { scope: 'ci<=ub' });
  assert.equal(result.query, '(ci<=ub)'); assert.equal(result.scopeClause, '(ci<=ub)'); assert.equal(result.generatedClause, '');
  assert.equal(syncQueryClauses(result.query, { oldScope: result.scopeClause, scope: 'ci<=g' }).query, '(ci<=g)');
});
test('explicit handwritten sort and nondefault ordering continue to work', () => {
  assert.equal(syncQueryClauses('Elf order:name', { scope: 'ci<=ub' }).query, 'Elf AND (ci<=ub) order:name');
  assert.equal(syncQueryClauses('Elf', { fallbackSort: 'edhrec' }).query, 'Elf order:edhrec');
});
