import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBracketDeck, createBracketEstimator } from '../server/bracket-estimator.js';
import { DeckStore } from '../web/lib/decks.js';

const commander = { card: 'Kwain, Itinerant Meddler', quantity: 1 };
const a = { card: 'Island', quantity: 2 }, b = { card: 'Sol Ring', quantity: 1 };
test('normalization merges counts and makes card order irrelevant', () => {
  assert.deepEqual(normalizeBracketDeck({ commanders: [commander], main: [b, a] }),
    normalizeBracketDeck({ commanders: [commander], main: [a, b] }));
  assert.throws(() => normalizeBracketDeck({ commanders: [], main: [] }));
  assert.throws(() => normalizeBracketDeck({ commanders: [commander], main: [{ card: 'Island', quantity: 100 }] }));
});
test('bracket cache deduplicates concurrent requests and expires after one day', async () => {
  let time = 0, calls = 0;
  const estimate = createBracketEstimator({ now: () => time, fetcher: async () => {
    calls++;
    return { ok: true, json: async () => ({ bracketTag: 'P', cards: [], combos: [] }) };
  } });
  const deck = normalizeBracketDeck({ commanders: [commander], main: [a, b] });
  const results = await Promise.all([estimate(deck), estimate(deck)]);
  assert.equal(results[0].bracketTag, 'P');
  assert.equal(calls, 1);
  time += 86400000;
  await estimate(deck);
  assert.equal(calls, 2);
});
test('optional target bracket survives saving, loading, and clearing', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const store = new DeckStore({ storage });
  const deck = store.importEntries('Test', [], { targetBracket: 3 });
  assert.equal(new DeckStore({ storage }).get(deck.id).targetBracket, 3);
  store.save({ ...deck, targetBracket: undefined });
  assert.equal(new DeckStore({ storage }).get(deck.id).targetBracket, undefined);
  assert.throws(() => store.save({ ...deck, targetBracket: 6 }));
});
