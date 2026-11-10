const MAX_STEPS = 1000;
export const MULLIGAN_OPENING_HAND = 7;

function checkCount(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label}须为 0–${max} 的整数`);
  }
}

function openingSize(deckSize, matchingCards, handSize) {
  checkCount(deckSize, Number.MAX_SAFE_INTEGER, '牌库张数');
  checkCount(matchingCards, deckSize, '符合条件的牌张数');
  checkCount(handSize, MAX_STEPS, '起手张数');
  return Math.min(deckSize, handSize);
}

// Each state tracks the total lands seen, including any already played.
function draw(masses, remainingCards, landCount) {
  const next = new Array(masses.length + 1).fill(0);
  for (let landsSeen = 0; landsSeen < masses.length; landsSeen++) {
    const mass = masses[landsSeen];
    if (!mass) continue;
    const landsLeft = landCount - landsSeen;
    next[landsSeen] += mass * ((remainingCards - landsLeft) / remainingCards);
    next[landsSeen + 1] += mass * (landsLeft / remainingCards);
  }
  return next;
}

function openingMasses(deckSize, landCount, handSize) {
  let masses = [1];
  for (let drawn = 0; drawn < handSize; drawn++) {
    masses = draw(masses, deckSize - drawn, landCount);
  }
  return masses;
}

export function openingLandStats(deckSize, landCount, handSize = 7) {
  const size = openingSize(deckSize, landCount, handSize);
  const fewest = Math.max(0, size - (deckSize - landCount));
  const most = Math.min(size, landCount);
  const masses = fewest === most
    ? Array.from({ length: size + 1 }, (_, lands) => lands === most ? 1 : 0)
    : openingMasses(deckSize, landCount, size);
  return {
    handSize: size,
    expected: deckSize ? size * (landCount / deckSize) : 0,
    distribution: masses.map((probability, lands) => ({ lands, probability: Math.min(1, probability) })),
  };
}

export function openingHitProbability(deckSize, targetCopies, handSize = 7) {
  const size = openingSize(deckSize, targetCopies, handSize);
  if (size > deckSize - targetCopies) return 1;
  let miss = 1;
  let hit = 0;
  // Sum first-hit outcomes directly to preserve precision for rare targets.
  for (let drawn = 0; drawn < size && miss > 0; drawn++) {
    const remainingCards = deckSize - drawn;
    hit += miss * (targetCopies / remainingCards);
    miss *= (remainingCards - targetCopies) / remainingCards;
  }
  return Math.min(1, hit);
}

export function consecutiveLandProbabilities(deckSize, landCount, { handSize = 7, drawFirstTurn = true, turns = 5 } = {}) {
  const size = openingSize(deckSize, landCount, handSize);
  checkCount(turns, MAX_STEPS, '回合数');
  if (typeof drawFirstTurn !== 'boolean') throw new TypeError('首回合抓牌设置须为布尔值');
  let masses = openingMasses(deckSize, landCount, size);
  let drawn = size;
  let probability = 1;
  const results = [];
  for (let turn = 1; turn <= turns; turn++) {
    if ((turn > 1 || drawFirstTurn) && drawn < deckSize) {
      masses = draw(masses, deckSize - drawn, landCount);
      drawn++;
    }
    // Remove failed paths. A guaranteed land drop preserves the previous probability exactly.
    if (masses.slice(0, turn).some(mass => mass > 0)) {
      masses.fill(0, 0, turn);
      probability = Math.min(probability, masses.reduce((sum, mass) => sum + mass, 0));
    }
    results.push({ turn, probability });
  }
  return results;
}

export function maximumMulliganAttempts(drawnCards, minimumHandSize) {
  return 2 + Math.max(0, drawnCards - minimumHandSize);
}

export function chooseMulliganLandCount(drawnLands, drawnCards, bottomCount, keepLandCounts) {
  const fewest = Math.max(0, drawnLands - bottomCount);
  const most = Math.min(drawnLands, drawnCards - bottomCount);
  const closest = Math.max(fewest, Math.min(3, most));
  let accepted = null;
  for (let lands = most; lands >= fewest; lands--) {
    if (keepLandCounts.includes(lands) && (accepted === null || Math.abs(lands - 3) < Math.abs(accepted - 3))) {
      accepted = lands;
    }
  }
  return { lands: accepted ?? closest, acceptable: accepted !== null };
}

export function mulliganLandStats(deckSize, landCount, {
  keepLandCounts = [2, 3, 4], minimumHandSize = 6, drawFirstTurn = true, turns = 5,
} = {}) {
  const drawnCards = openingSize(deckSize, landCount, MULLIGAN_OPENING_HAND);
  checkCount(turns, MAX_STEPS, '回合数');
  if (![5, 6, 7].includes(minimumHandSize)) throw new RangeError('最低保留张数须为 5、6 或 7');
  if (!Array.isArray(keepLandCounts) || keepLandCounts.some(count => ![1, 2, 3, 4, 5, 6].includes(count))) {
    throw new RangeError('保留地牌张数须在 1–6 之间');
  }
  if (typeof drawFirstTurn !== 'boolean') throw new TypeError('首回合抓牌设置须为布尔值');

  const opening = openingMasses(deckSize, landCount, drawnCards);
  const distribution = Array.from({ length: drawnCards + 1 }, (_, lands) => ({ lands, probability: 0 }));
  const results = Array.from({ length: turns }, (_, index) => ({ turn: index + 1, probability: 0 }));
  const handSizes = new Map();
  const topSize = deckSize - drawnCards;
  const attempts = maximumMulliganAttempts(drawnCards, minimumHandSize);
  let remaining = 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const bottomCount = Math.max(0, attempt - 1);
    const handSize = drawnCards - bottomCount;
    let retry = 0;
    const keptHandSize = handSizes.get(handSize) ?? { handSize, probability: 0 };
    handSizes.set(handSize, keptHandSize);
    for (const [drawnLands, probability] of opening.entries()) {
      const weight = probability * remaining;
      if (!weight) continue;
      const { lands, acceptable } = chooseMulliganLandCount(drawnLands, drawnCards, bottomCount, keepLandCounts);
      if (!acceptable && attempt < attempts - 1) {
        retry += weight;
        continue;
      }
      distribution[lands].probability += weight;
      keptHandSize.probability += weight;

      // The random cards above the bottomed hand contain none of the seven just seen.
      const topAndHandLands = landCount - drawnLands + lands;
      let masses = Array(lands + 1).fill(0);
      masses[lands] = weight;
      let drawn = 0;
      for (const result of results) {
        if ((result.turn > 1 || drawFirstTurn) && drawn < topSize + bottomCount) {
          masses = drawn < topSize
            ? draw(masses, topSize - drawn, topAndHandLands)
            : draw(masses, topSize + bottomCount - drawn, landCount);
          drawn++;
        }
        masses.fill(0, 0, result.turn);
        const success = masses.reduce((sum, mass) => sum + mass, 0);
        if (!success) break;
        result.probability += success;
      }
    }
    remaining = retry;
  }
  return {
    distribution,
    handSizes: [...handSizes.values()],
    expected: distribution.reduce((sum, row) => sum + row.lands * row.probability, 0),
    turns: results.map(row => ({ ...row, probability: Math.min(1, row.probability) })),
  };
}
