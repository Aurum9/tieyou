import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeckMembership } from '../web/lib/deck-membership.js';

const entry = (cardId, quantity, zone = 'main', versionId = 'printing-a') => ({ cardId, quantity, zone, versionId });
const decks = [
  { id: 'first', entries: [entry('sol-ring', 1), entry('sol-ring', 2, 'main', 'printing-b'), entry('sol-ring', 1, 'considering'), entry('commander', 1, 'commander')] },
  { id: 'second', entries: [entry('sol-ring', 1), entry('commander', 2, 'main')] },
  { id: 'empty', entries: [] }
];

test('selected-deck membership combines printings by Oracle ID and reports each zone', () => {
  const membership = buildDeckMembership(decks, 'first');
  assert.deepEqual(membership.get('sol-ring'), { main: 3, commander: 0, considering: 1, total: 4, deckCount: 1, label: '已在主牌 ×3 · 候选 ×1' });
  assert.deepEqual(membership.get('commander'), { main: 0, commander: 1, considering: 0, total: 1, deckCount: 1, label: '已在统帅 ×1' });
  assert.equal(membership.has('missing'), false);
});

test('unselected target aggregates counts but counts each containing deck once', () => {
  const membership = buildDeckMembership(decks);
  assert.deepEqual(membership.get('sol-ring'), { main: 4, commander: 0, considering: 1, total: 5, deckCount: 2, label: '已在 2 套卡组' });
  assert.equal(membership.get('commander').deckCount, 2);
  assert.equal(membership.get('commander').total, 3);
  assert.deepEqual(buildDeckMembership(decks, ''), membership);
});

test('missing explicit target remains empty and never falls back to another deck', () => {
  assert.equal(buildDeckMembership(decks, 'deleted').size, 0);
  assert.equal(buildDeckMembership(decks, 'empty').size, 0);
  assert.equal(buildDeckMembership([]).size, 0);
});

test('membership building never changes source entries and each rebuild reflects fresh quantities', () => {
  const source = structuredClone(decks), before = structuredClone(source);
  const previous = buildDeckMembership(source, 'first');
  assert.deepEqual(source, before);
  source[0].entries[0].quantity = 5;
  assert.equal(buildDeckMembership(source, 'first').get('sol-ring').main, 7);
  assert.equal(previous.get('sol-ring').main, 3);
});

test('only valid supported-zone entries contribute to membership', () => {
  const membership = buildDeckMembership([{ id: 'draft', entries: [entry('valid', 2), entry('zero', 0), entry('negative', -1), entry('fraction', 1.5), entry('wrong-zone', 1, 'exile'), entry('', 1)] }], 'draft');
  assert.deepEqual([...membership.keys()], ['valid']);
});
