import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeckEntryComparator, getDeckEditorPreferences, defaultSortDirection } from '../web/lib/deck-editor-sort.js';
import { createDeck, DeckStore, exportDeckBackup, parseDeckBackup, validateDeckLibrary } from '../web/lib/decks.js';

function fixture() {
  const cards = [
    { id: 'a', name: 'Zulu', zhName: '阿', manaValue: 3, usd: 1, edhrecRank: 5 },
    { id: 'b', name: 'Alpha', zhName: '波', manaValue: 1, usd: 0, edhrecRank: 20 },
    { id: 'c', name: 'Echo', zhName: '从', manaValue: 1, versionsComplete: true, versions: [{ usd: 8 }, { usd: 2 }], edhrecRank: 2 },
    { id: 'd', name: 'Delta', zhName: '的' },
  ];
  const deck = { ...createDeck('排序'), entries: cards.map(card => ({
    id: 'entry-' + card.id, cardId: card.id, versionId: card.id + '-version', quantity: 1, zone: 'main', categories: [], notes: ''
  })) };
  return { deck, cards: new Map(cards.map(card => [card.id, card])) };
}

function ordered(deck, cards, sortBy, sortDirection) {
  return [...deck.entries].sort(createDeckEntryComparator(deck, cards, { sortBy, sortDirection })).map(entry => entry.cardId);
}

test('deck sorting covers six fields, Chinese pinyin, minimum printing price and zero prices', () => {
  const { deck, cards } = fixture();
  assert.deepEqual(ordered(deck, cards, 'mana', 'asc'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(ordered(deck, cards, 'mana', 'desc'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ordered(deck, cards, 'name-zh', 'asc'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ordered(deck, cards, 'name-en', 'asc'), ['b', 'd', 'c', 'a']);
  assert.deepEqual(ordered(deck, cards, 'price', 'asc'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ordered(deck, cards, 'price', 'desc'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ordered(deck, cards, 'edhrec', 'asc'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ordered(deck, cards, 'edhrec', 'desc'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ordered(deck, cards, 'added', 'desc'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ordered(deck, cards, 'added', 'asc'), ['a', 'b', 'c', 'd']);
  assert.equal(defaultSortDirection('price'), 'desc');
  assert.equal(defaultSortDirection('edhrec'), 'asc');
  assert.equal(defaultSortDirection('added'), 'desc');
});

test('sorts leave stored addition order intact and put missing values last in both directions', () => {
  const { deck, cards } = fixture();
  const original = JSON.stringify(deck);
  cards.delete('b');
  for (const sortBy of ['mana', 'price', 'edhrec']) {
    for (const direction of ['asc', 'desc']) {
      const result = ordered(deck, cards, sortBy, direction);
      assert.deepEqual(new Set(result.slice(-2)), new Set(['b', 'd']));
    }
  }
  assert.equal(JSON.stringify(deck), original);
  cards.get('a').zhName = '';
  assert.doesNotThrow(() => ordered(deck, cards, 'name-zh', 'asc'));
});

test('per-deck display preferences survive saves, library validation, backups and copies, with legacy defaults', () => {
  let raw;
  const storage = { getItem: () => raw || null, setItem: (_, value) => { raw = value; } };
  const store = new DeckStore({ storage });
  const first = store.create('甲');
  const second = store.create('乙');
  assert.deepEqual(getDeckEditorPreferences(first), { groupBy: 'type', viewMode: 'text', sortBy: 'mana', sortDirection: 'asc' });
  first.editorPreferences = { groupBy: 'category', viewMode: 'stack', sortBy: 'price', sortDirection: 'desc' };
  store.save(first);
  const reload = new DeckStore({ storage });
  assert.deepEqual(reload.get(first.id).editorPreferences, first.editorPreferences);
  assert.equal(reload.get(second.id).editorPreferences, undefined);
  const backup = parseDeckBackup(exportDeckBackup(reload.list()));
  assert.deepEqual(backup.decks[0].editorPreferences, first.editorPreferences);
  const library = validateDeckLibrary(JSON.parse(raw));
  assert.deepEqual(library.decks[0].editorPreferences, first.editorPreferences);
  assert.deepEqual(store.copy(first.id).editorPreferences, first.editorPreferences);
  first.editorPreferences.sortBy = 'bad-input';
  assert.throws(() => store.save(first), /显示设置/);
  assert.equal(reload.get(first.id).editorPreferences.sortBy, 'price');
});
