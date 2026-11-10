const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const EMPTY_POOL = COLORS.map(() => 0);
const THRESHOLDS = [2, 3];
const sum = values => values.reduce((total, value) => total + value, 0);
const addMana = (pool, mana) => pool.map((amount, color) => amount + mana[color]);
const manaVector = symbols => COLORS.map(color => symbols.filter(symbol => symbol === color).length);

function seedRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleCopies(deckSize, count, random) {
  const shuffled = new Map();
  const sample = [];
  for (let i = 0; i < count; i++) {
    const target = i + Math.floor(random() * (deckSize - i));
    sample.push(shuffled.get(target) ?? target);
    shuffled.set(target, shuffled.get(i) ?? i);
  }
  return sample;
}

function prepareDeck(cards) {
  const unique = new Map();
  for (const { quantity, landOptions = [], ramp = null } of cards) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('卡牌数量须为非负整数');
    if (!quantity) continue;
    const key = JSON.stringify([landOptions, ramp]);
    const previous = unique.get(key);
    if (previous) previous.quantity += quantity;
    else unique.set(key, { quantity, landOptions, ramp });
  }

  let size = 0;
  const groups = [];
  let sourceId = 0;
  const source = (data, options) => ({
    ...data,
    key: String(sourceId++),
    mana: options.map(manaVector),
    yield: Math.max(0, ...options.map(option => option.length)),
  });
  for (const { quantity, landOptions, ramp } of unique.values()) {
    const firstCopy = size;
    size += quantity;
    const lands = landOptions.map(land => source({ ...land, isLand: true }, land.mana));
    const accelerator = ramp ? {
      ...source({ ...ramp, isLand: false }, ramp.mana || []),
      coloredCost: manaVector(ramp.cost),
      genericCost: ramp.cost.reduce((total, symbol) => total + (/^\d+$/.test(symbol) ? Number(symbol) : 0), 0),
    } : null;
    if (accelerator) accelerator.totalCost = accelerator.genericCost + sum(accelerator.coloredCost);
    groups.push({ index: groups.length, firstCopy, endCopy: size, lands, accelerator });
  }
  if (!Number.isSafeInteger(size)) throw new RangeError('牌库张数超出范围');

  function groupFor(copy) {
    let left = 0, right = groups.length - 1;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (copy < groups[middle].endCopy) right = middle;
      else left = middle + 1;
    }
    return groups[left].index;
  }

  const searches = new Map();
  function searchGroups(search) {
    const key = JSON.stringify(search);
    if (!searches.has(key)) {
      searches.set(key, groups.filter(({ lands: [front] }) =>
        front && front.front !== false && (!search.basicOnly || front.basic) &&
        (!search.types.length || search.types.some(type => front.types.includes(type)))));
    }
    return searches.get(key);
  }
  return { size, groups, groupFor, searchGroups };
}

function addSource(board, source, turn, forceTapped = false) {
  const otherLands = board.filter(card => card.isLand).length;
  const untapped = source.untapWithMaxOtherLands !== undefined && otherLands <= source.untapWithMaxOtherLands;
  const delayed = forceTapped || (source.tapped && !untapped) || source.delay;
  return [...board, { ...source, readyTurn: turn + (delayed ? 1 : 0) }];
}

function availableMana(state, turn) {
  let immediate = sum(state.pool), afterActivation = 0;
  for (const source of state.board) {
    if (source.readyTurn > turn) continue;
    if (source.activationCost) afterActivation += source.yield - source.activationCost;
    else immediate += source.yield;
  }
  return immediate ? immediate + afterActivation : 0;
}

function visitGenericPayments(pool, amount, color, visit) {
  if (amount === 0) return visit([...pool]);
  if (color === pool.length) return false;
  const original = pool[color];
  const availableAfter = sum(pool.slice(color + 1));
  const min = Math.max(0, amount - availableAfter);
  const max = Math.min(amount, original);
  for (let used = min; used <= max; used++) {
    pool[color] = original - used;
    if (visitGenericPayments(pool, amount - used, color + 1, visit)) return true;
  }
  pool[color] = original;
  return false;
}

function visitPayments(state, spell, turn, visit) {
  if (spell.totalCost === 0) return visit(state.pool, state.board);
  if (availableMana(state, turn) < spell.totalCost) return false;

  function activate(pool, board, index) {
    const remainder = pool.map((amount, color) => amount - spell.coloredCost[color]);
    const canPay = remainder.every(amount => amount >= 0) && sum(remainder) >= spell.genericCost;
    if (canPay && visitGenericPayments(remainder, spell.genericCost, 0,
      rest => visit(rest, board.filter(Boolean)))) return true;

    for (let i = index; i < board.length; i++) {
      const source = board[i];
      if (source.readyTurn > turn || !source.yield) continue;
      const afterTap = [...board];
      afterTap[i] = source.kind === 'egg' ? null : { ...source, readyTurn: turn + 1 };
      if (visitGenericPayments([...pool], source.activationCost || 0, 0,
        rest => source.mana.some(mana => activate(addMana(rest, mana), afterTap, i + 1)))) return true;
    }
    return false;
  }
  const board = [...state.board].sort((a, b) => (a.activationCost || 0) - (b.activationCost || 0));
  return activate(state.pool, board, 0);
}

function enchantLand(board, spell, visit) {
  for (const [index, land] of board.entries()) {
    if (!land.isLand || !land.yield || (spell.hostTypes?.length && !spell.hostTypes.some(type => land.types.includes(type)))) continue;
    const addedOptions = spell.fixedMana ? spell.mana.map(mana => [mana]) : [spell.mana];
    for (const [option, alternatives] of addedOptions.entries()) {
      const enchanted = [...board];
      enchanted[index] = {
        ...land,
        key: `${land.key}+${spell.key}.${option}`,
        mana: land.mana.flatMap(base => alternatives.map(extra => addMana(base, extra))),
        yield: land.yield + Math.max(...alternatives.map(sum)),
      };
      if (visit(enchanted)) return true;
    }
  }
  return false;
}

function visitSearch(deck, state, board, search, turn, drawn, visit) {
  for (const { firstCopy, endCopy, lands: [land] } of deck.searchGroups(search)) {
    let copy = firstCopy;
    while (copy < endCopy && (drawn.has(copy) || state.fetched.includes(copy))) copy++;
    if (copy === endCopy) continue;
    if (visit({
      ...state,
      fetched: [...state.fetched, copy],
      board: addSource(board, land, turn, search.tapped),
      established: state.established || land.yield > 1,
    })) return true;
  }
  return false;
}

function visitLines(deck, state, turn, drawn, seen, evaluate) {
  const key = [
    state.hand.join(','),
    state.board.map(source => `${source.key}@${source.readyTurn}`).sort().join(','),
    state.pool.join(','),
    state.landPlayed ? 1 : 0,
    state.established ? 1 : 0,
    [...state.fetched].sort((a, b) => a - b).join(','),
  ].join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  if (evaluate(state)) return true;

  const visit = next => visitLines(deck, next, turn, drawn, seen, evaluate);
  for (const [index, source] of state.board.entries()) {
    if (!source.fetch || source.readyTurn > turn) continue;
    const board = state.board.filter((_, i) => i !== index);
    if (visitSearch(deck, state, board, source.fetch, turn, drawn, visit)) return true;
  }

  for (const [index, card] of state.hand.entries()) {
    if (index > 0 && card === state.hand[index - 1]) continue;
    const { lands, accelerator: spell } = deck.groups[card];
    const hand = state.hand.filter((_, i) => i !== index);
    if (!state.landPlayed) {
      for (const land of lands) {
        if (visit({ ...state, hand, landPlayed: true, board: addSource(state.board, land, turn),
          established: state.established || land.yield > 1 })) return true;
      }
    }
    if (!spell) continue;
    if (visitPayments(state, spell, turn, (pool, board) => {
      const next = { ...state, hand, pool, board };
      if (spell.kind === 'ritual') {
        return spell.mana.some(mana => visit({ ...next, pool: addMana(pool, mana) }));
      }
      if (spell.kind === 'land-ramp') {
        return visitSearch(deck, { ...next, established: true }, board, spell.search, turn, drawn, visit);
      }
      if (spell.kind === 'enchant') {
        return enchantLand(board, spell, enchanted => visit({ ...next, board: enchanted, established: true }));
      }
      return visit({
        ...next,
        board: addSource(board, spell, turn),
        established: next.established || spell.kind === 'permanent',
      });
    })) return true;
  }
  return false;
}

function sampleResult(deck, handSize, drawFirstTurn, random) {
  const openingCount = Math.min(deck.size, handSize + (drawFirstTurn ? 1 : 0));
  // A turn-one search can remove one card per spell and one per land drop.
  const sample = sampleCopies(deck.size, Math.min(deck.size, openingCount * 2 + 2), random);
  const opening = sample.slice(0, openingCount);
  const drawn = new Set(opening);
  const reserves = sample.slice(openingCount);
  const hand = opening.map(deck.groupFor).sort((a, b) => a - b);
  const start = { hand, board: [], pool: EMPTY_POOL, fetched: [], landPlayed: false, established: false };
  const secondSeen = new Map();
  const available = [false, false], setup = [false, false];

  function record(state, turn) {
    const index = turn - 1;
    const aboveBaseline = availableMana(state, turn) >= THRESHOLDS[index];
    available[index] ||= aboveBaseline;
    setup[index] ||= aboveBaseline || state.established;
    return available[index] && setup[index];
  }

  visitLines(deck, start, 1, drawn, new Set(), state => {
    const firstDone = record(state, 1);
    setup[1] ||= setup[0];
    if (!available[1] || !setup[1]) {
      const copy = reserves.find(candidate => !state.fetched.includes(candidate));
      const nextHand = copy === undefined ? state.hand : [...state.hand, deck.groupFor(copy)].sort((a, b) => a - b);
      if (!secondSeen.has(copy)) secondSeen.set(copy, { seen: new Set(), drawn: new Set([...opening, copy]) });
      const context = secondSeen.get(copy);
      visitLines(deck, { ...state, hand: nextHand, pool: EMPTY_POOL, landPlayed: false }, 2,
        context.drawn, context.seen, line => record(line, 2));
    }
    return firstDone && available[1] && setup[1];
  });
  return { available, setup };
}

export function earlyManaProbabilities(cards, { handSize = 7, drawFirstTurn = true, trials = 3000, seed = 0x4D414E41 } = {}) {
  if (!Number.isSafeInteger(handSize) || handSize < 0 || handSize > 20 ||
      !Number.isSafeInteger(trials) || trials < 1 || trials > 20000) {
    throw new RangeError('起手张数或模拟次数超出范围');
  }
  const deck = prepareDeck(cards);
  const random = seedRandom(seed);
  const successes = THRESHOLDS.map(() => 0);
  const setups = THRESHOLDS.map(() => 0);
  if (deck.groups.some(group => group.accelerator || group.lands.some(land => land.yield >= 2))) {
    for (let trial = 0; trial < trials; trial++) {
      const { available, setup } = sampleResult(deck, handSize, drawFirstTurn, random);
      for (let index = 0; index < THRESHOLDS.length; index++) {
        if (available[index]) successes[index]++;
        if (setup[index]) setups[index]++;
      }
    }
  }
  return {
    trials,
    turns: THRESHOLDS.map((threshold, index) => ({
      turn: index + 1,
      threshold,
      probability: successes[index] / trials,
      setupProbability: setups[index] / trials,
    })),
  };
}
