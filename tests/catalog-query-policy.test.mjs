import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCatalogQueryIntent } from '../web/lib/catalog-query-policy.js';
import { commanderScopeQuery } from '../web/lib/deck-target.js';
import { queryClause } from '../web/lib/query-sync.js';
import { searchCards, validateSearch } from '../web/lib/search.js';

const defaults = { generatedClause: '(f:commander)' };

test('blank catalog and default legality or sorting alone remain idle', () => {
  for (const query of ['', ' \n\t ', '(f:commander)', '(f:commander) order:name', 'order:name', 'order:edhrec', 'sort:mv dir:desc']) {
    assert.equal(hasCatalogQueryIntent(query, defaults), false, query);
  }
  assert.equal(hasCatalogQueryIntent(), false);
});

test('a deck commander scope starts a search with or without default legality', () => {
  const scopeClause = queryClause(commanderScopeQuery(['U', 'B']));
  for (const query of [scopeClause, `${scopeClause} order:name`, `(f:commander) AND ${scopeClause} order:name`, `(f:commander)AND${scopeClause} order:name`]) {
    assert.equal(hasCatalogQueryIntent(query, { ...defaults, scopeClause }), true, query);
    assert.equal(validateSearch(query), null);
  }
});

test('a colorless commander is an active scope while no commander has no boundary', () => {
  const scopeClause = queryClause(commanderScopeQuery([]));
  assert.equal(scopeClause, '(ci<=无色)');
  assert.equal(hasCatalogQueryIntent(`(f:commander) AND ${scopeClause} order:name`, { ...defaults, scopeClause }), true);
  const noCommander = queryClause(commanderScopeQuery(null));
  assert.equal(noCommander, '');
  assert.equal(hasCatalogQueryIntent('(f:commander) order:name', { ...defaults, scopeClause: noCommander }), false);
});

test('removed or disabled scope metadata never starts an empty search', () => {
  assert.equal(hasCatalogQueryIntent('', { scopeClause: '(ci<=ub)' }), false);
  assert.equal(hasCatalogQueryIntent('(f:commander) order:name', { ...defaults, scopeClause: '(ci<=ub)' }), false);
  assert.equal(hasCatalogQueryIntent('(f:commander) order:name', { ...defaults, scopeClause: '' }), false);
});

test('manual identity and rewritten scopes remain user search conditions', () => {
  for (const query of ['ci<=ub', 'ci<=无色', '(ci<=g)', '(ci<=ub) OR t:land', 'name:"(ci<=ub)"']) {
    assert.equal(hasCatalogQueryIntent(query, { ...defaults, scopeClause: '(ci<=ub)' }), true, query);
  }
  assert.equal(hasCatalogQueryIntent('f:commander'), true);
});

test('explicit visual conditions and validation errors remain visible without query text', () => {
  assert.equal(hasCatalogQueryIntent('', { hasUserConditions: true }), true);
  assert.equal(hasCatalogQueryIntent('', { error: '法术力值下限不能大于上限' }), true);
  assert.equal(hasCatalogQueryIntent('(f:commander) order:name', { ...defaults, hasUserConditions: true }), true);
});

test('invalid syntax requests validation rather than being hidden as an idle screen', () => {
  for (const query of ['(', 'ci<=', 'order:unknown', 'order:name dir:unknown', 'mv>=invalid']) {
    assert.equal(hasCatalogQueryIntent(query, defaults), true, query);
    assert.notEqual(validateSearch(query), null, query);
  }
});

function card(id, identity, legality = 'legal') {
  return { id, name: id, zhName: id, colorIdentity: identity, colors: identity, manaValue: 1, typeLine: 'Artifact', legalities: { commander: legality }, versions: [] };
}
const cards = [card('colorless', []), card('blue', ['U']), card('black', ['B']), card('blue-black', ['U', 'B']), card('green', ['G']), card('banned-blue', ['U'], 'banned')];

test('the reported deck query returns legal colorless, blue, black and blue-black cards', () => {
  const query = '(f:commander) AND (ci<=ub) order:name';
  assert.equal(hasCatalogQueryIntent(query, { ...defaults, scopeClause: '(ci<=ub)' }), true);
  const result = searchCards(cards, query);
  assert.equal(result.error, null);
  assert.deepEqual(result.cards.map(row => row.id).sort(), ['black', 'blue', 'blue-black', 'colorless']);
});

test('colorless commander scope selects colorless legal cards without excluding all cards', () => {
  const scopeClause = queryClause(commanderScopeQuery([]));
  const query = `(f:commander) AND ${scopeClause} order:name`;
  assert.equal(hasCatalogQueryIntent(query, { ...defaults, scopeClause }), true);
  const result = searchCards(cards, query);
  assert.equal(result.error, null);
  assert.deepEqual(result.cards.map(row => row.id), ['colorless']);
});
