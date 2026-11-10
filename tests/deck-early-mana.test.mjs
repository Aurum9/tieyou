import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEarlyManaCard } from '../web/lib/deck-early-mana-cards.js';
import { earlyManaProbabilities } from '../web/lib/deck-early-mana.js';

function card(typeLine, manaCost, oracleText, quantity = 1) {
  return { typeLine, manaCost, oracleText, quantity };
}

const forest = card('Basic Land — Forest', '', '', 2);
const elf = card('Creature — Elf Druid', '{G}', '{T}: Add {G}.');
const signet = card('Artifact', '{2}', '{T}: Add one mana of any color in your commander\'s color identity.');
const tomb = card('Land', '', '{T}: Add {C}{C}. This land deals 2 damage to you.');
const ritual = card('Instant', '{B}', 'Add {B}{B}.');
const talisman = { ...card('Artifact', '', 'Suspend 3—{1}\n{T}: Add {C}{C}.'), tags: ['ramp'] };

function estimateTurns(cards, options = {}) {
  const profiles = cards.map(({ quantity, ...source }) => ({
    ...classifyEarlyManaCard(source, { commanderColors: ['G'] }), quantity,
  }));
  return earlyManaProbabilities(profiles, { handSize: 7, drawFirstTurn: false, trials: 8, ...options })
    .turns;
}

function estimate(cards, options = {}) {
  return estimateTurns(cards, options).slice(0, 2).map(({ setupProbability, probability }) => [setupProbability, probability]);
}

test('two-turn estimates distinguish establishing an accelerator from having extra mana to spend', () => {
  assert.deepEqual(estimate([forest]), [[0, 0], [0, 0]]);
  assert.deepEqual(estimate([forest, elf]), [[1, 0], [1, 1]]);
  assert.deepEqual(estimate([forest, signet]), [[0, 0], [1, 0]]);
  const paidSignet = card('Artifact', '{2}', '{1}, {T}: Add {W}{U}.');
  assert.deepEqual(estimate([tomb, paidSignet]), [[1, 1], [1, 1]]);
  assert.deepEqual(estimate([forest, tomb]), [[1, 1], [1, 1]]);
  assert.deepEqual(estimate([tomb], { handSize: 0 }), [[0, 0], [1, 0]]);
  assert.deepEqual(estimate([card('Basic Land — Swamp', '', ''), ritual]), [[1, 1], [1, 0]]);
});

test('two-turn estimates require the right color, timing, and an available mana ability', () => {
  const islands = card('Basic Land — Island', '', '', 2);
  const forestTapland = card('Land — Forest', '', 'This land enters tapped.', 2);
  assert.deepEqual(estimate([islands, elf]), [[0, 0], [0, 0]]);
  assert.deepEqual(estimate([forestTapland, elf]), [[0, 0], [1, 0]]);
  assert.deepEqual(estimate([forest, talisman]), [[0, 0], [0, 0]]);
  assert.ok(classifyEarlyManaCard(talisman).excluded.ramp);
  assert.deepEqual(estimate([tomb], { handSize: 0, drawFirstTurn: true }), [[1, 1], [1, 0]]);
});

test('turn three measures four spendable mana with the same cards and earlier setup', () => {
  const threeForests = { ...forest, quantity: 3 };
  assert.deepEqual(estimateTurns([threeForests, elf])[2], { turn: 3, threshold: 4, probability: 1 });
  assert.equal(estimateTurns([forest, elf])[2].probability, 0);
  assert.equal(estimateTurns([tomb], { handSize: 0 })[2].probability, 0);
  assert.equal(estimateTurns([{ ...tomb, quantity: 2 }], { handSize: 0 })[2].probability, 1);
});

test('paid London mulligans preserve a ramp spell if possible and draw bottomed copies in order', () => {
  const ring = card('Artifact', '{1}', '{T}: Add {C}{C}.');
  const filler = card('Sorcery', '{4}', 'Draw a card.', 3);
  const keepRamp = { keepLandCounts: [4], minimumHandSize: 6 };
  assert.deepEqual(estimate([{ ...forest, quantity: 3 }, ring, filler], { mulligan: keepRamp }), [[1, 1], [1, 1]]);

  const shortDeck = [{ ...forest, quantity: 5 }, tomb];
  const mulligan = { keepLandCounts: [5], minimumHandSize: 5 };
  const rows = estimateTurns(shortDeck, { mulligan, trials: 40 });
  assert.ok(rows[0].probability > 0 && rows[0].probability < 1);
  assert.equal(rows[1].probability, 1);
  assert.equal(rows[2].probability, 1);
  assert.deepEqual(estimate(shortDeck, { mulligan, drawFirstTurn: true }), [[1, 1], [1, 1]]);
});
