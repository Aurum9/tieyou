const MAX_STEPS = 1000;

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
