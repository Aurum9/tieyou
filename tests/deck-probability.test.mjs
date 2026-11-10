import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMulliganLandCount, consecutiveLandProbabilities, mulliganLandStats, openingHitProbability, openingLandStats,
} from '../web/lib/deck-probability.js';

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return result;
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} should match ${expected}`);
}

test('seven-card opening land probabilities and expectation match the 99-card, 36-land baseline', () => {
  const result = openingLandStats(99, 36);
  assert.equal(result.handSize, 7);
  assert.equal(result.distribution.length, 8);
  close(result.expected, 28 / 11);
  for (const { lands, probability } of result.distribution) {
    close(probability, choose(36, lands) * choose(63, 7 - lands) / choose(99, 7));
  }
  close(result.distribution.reduce((sum, row) => sum + row.probability, 0), 1);
  close(openingHitProbability(99, 1), 7 / 99);
  close(openingHitProbability(99, 3), 1 - choose(96, 7) / choose(99, 7));
});

test('land-drop probabilities match exhaustive shuffles for both first-turn draw settings', () => {
  const deckSize = 6;
  const landCount = 3;
  const handSize = 2;
  const turns = 5;
  const shuffles = [];
  function enumerate(prefix, remainder) {
    if (!remainder.length) { shuffles.push(prefix); return; }
    for (let i = 0; i < remainder.length; i++) {
      enumerate([...prefix, remainder[i]], remainder.filter((_, j) => j !== i));
    }
  }
  enumerate([], [true, true, true, false, false, false]);
  for (const drawFirstTurn of [true, false]) {
    const actual = consecutiveLandProbabilities(deckSize, landCount, { handSize, drawFirstTurn, turns });
    assert.deepEqual(actual.map(row => row.turn), [1, 2, 3, 4, 5]);
    for (const { turn, probability } of actual) {
      const successes = shuffles.filter(shuffle => {
        for (let current = 1; current <= turn; current++) {
          const seen = handSize + current - (drawFirstTurn ? 0 : 1);
          if (shuffle.slice(0, seen).filter(Boolean).length < current) return false;
        }
        return true;
      });
      close(probability, successes.length / shuffles.length);
    }
  }
});

test('empty and short libraries, duplicate quantities and input limits stay well defined', () => {
  assert.deepEqual(openingLandStats(0, 0), { handSize: 0, expected: 0, distribution: [{ lands: 0, probability: 1 }] });
  assert.deepEqual(openingLandStats(2, 1), {
    handSize: 2, expected: 1,
    distribution: [{ lands: 0, probability: 0 }, { lands: 1, probability: 1 }, { lands: 2, probability: 0 }],
  });
  assert.equal(openingHitProbability(2, 1), 1);
  assert.equal(openingHitProbability(2, 0), 0);
  close(openingHitProbability(9_990_000, 1), 7 / 9_990_000);
  assert.deepEqual(consecutiveLandProbabilities(2, 2, { turns: 3 }).map(row => row.probability), [1, 1, 0]);
  assert.deepEqual(consecutiveLandProbabilities(18, 12).map(row => row.probability), [1, 1, 1, 1, 1]);
  assert.throws(() => openingLandStats(2, 3), RangeError);
  assert.throws(() => openingHitProbability(99, 1, 1.5), RangeError);
  assert.throws(() => consecutiveLandProbabilities(99, 36, { turns: 1001 }), RangeError);
});

test('the free London redraw improves the odds without reducing the hand size', () => {
  const stats = openingLandStats(99, 36);
  const keep = stats.distribution.filter(({ lands }) => [2, 3, 4].includes(lands))
    .reduce((total, row) => total + row.probability, 0);
  const free = mulliganLandStats(99, 36, { minimumHandSize: 7 });
  close(free.handSizes[0].probability, 1);
  assert.equal(free.handSizes.length, 1);
  const keptInRange = free.distribution.filter(({ lands }) => [2, 3, 4].includes(lands))
    .reduce((total, row) => total + row.probability, 0);
  close(keptInRange, 1 - (1 - keep) ** 2);

  const paid = mulliganLandStats(99, 36);
  close(paid.handSizes[1].probability, (1 - keep) ** 2);
  assert.ok(paid.turns[3].probability > free.turns[3].probability);
  assert.ok(paid.turns.every((row, index) => index === 0 || row.probability <= paid.turns[index - 1].probability));
});

test('a paid redraw accepts reachable land counts after bottoming, and only draws the bottomed card after the top', () => {
  assert.deepEqual(chooseMulliganLandCount(3, 7, 1, [2]), { lands: 2, acceptable: true });
  assert.deepEqual(chooseMulliganLandCount(3, 7, 1, [4]), { lands: 3, acceptable: false });
  const options = { keepLandCounts: [3], minimumHandSize: 6 };
  const paid = mulliganLandStats(7, 4, { ...options, turns: 5 });
  assert.deepEqual(paid.handSizes, [{ handSize: 7, probability: 0 }, { handSize: 6, probability: 1 }]);
  close(paid.distribution[3].probability, 1);
  assert.deepEqual(paid.turns.map(row => row.probability), [1, 1, 1, 1, 0]);
  const flooded = mulliganLandStats(7, 7, { keepLandCounts: [2, 3, 4], minimumHandSize: 5 });
  close(flooded.distribution[5].probability, 1);
});
