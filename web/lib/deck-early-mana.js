import { chooseMulliganLandCount, maximumMulliganAttempts } from './deck-probability.js';

const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const EMPTY_POOL = COLORS.map(() => 0);
const THRESHOLDS = [2, 3, 4];
const TRIAL_WORK_LIMIT = 30_000;
const TOTAL_WORK_LIMIT = 8_000_000;
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

function shuffledCopies(deckSize, random) {
  const shuffled = new Map();
  let position = 0;
  return () => {
    if (position === deckSize) return undefined;
    const target = position + Math.floor(random() * (deckSize - position));
    const copy = shuffled.get(target) ?? target;
    shuffled.set(target, shuffled.get(position) ?? position);
    shuffled.delete(position++);
    return copy;
  };
}

function prepareDeck(cards) {
  const unique = new Map();
  for (const { quantity, landOptions = [], ramp = null, isLandForMulligan = landOptions.length > 0 } of cards) {
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError('卡牌数量须为非负整数');
    if (!quantity) continue;
    const key = JSON.stringify([landOptions, ramp, isLandForMulligan]);
    const previous = unique.get(key);
    if (previous) previous.quantity += quantity;
    else unique.set(key, { quantity, landOptions, ramp, isLandForMulligan });
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
  for (const { quantity, landOptions, ramp, isLandForMulligan } of unique.values()) {
    const firstCopy = size;
    size += quantity;
    const lands = landOptions.map(land => source({ ...land, isLand: true }, land.mana));
    const accelerator = ramp ? {
      ...source({ ...ramp, isLand: false }, ramp.mana || []),
      coloredCost: manaVector(ramp.cost),
      genericCost: ramp.cost.reduce((total, symbol) => total + (/^\d+$/.test(symbol) ? Number(symbol) : 0), 0),
    } : null;
    if (accelerator) accelerator.totalCost = accelerator.genericCost + sum(accelerator.coloredCost);
    groups.push({ index: groups.length, firstCopy, endCopy: size, lands, accelerator, isLandForMulligan });
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

function continueSearch(work) {
  if (!work.remaining || !work.trialRemaining) {
    work.limited = true;
    return false;
  }
  work.remaining--;
  work.trialRemaining--;
  return true;
}

function visitGenericPayments(pool, amount, color, work, visit) {
  if (!continueSearch(work)) return true;
  if (amount === 0) return visit([...pool]);
  if (color === pool.length) return false;
  const original = pool[color];
  const availableAfter = sum(pool.slice(color + 1));
  const min = Math.max(0, amount - availableAfter);
  const max = Math.min(amount, original);
  for (let used = min; used <= max; used++) {
    pool[color] = original - used;
    if (visitGenericPayments(pool, amount - used, color + 1, work, visit)) return true;
  }
  pool[color] = original;
  return false;
}

function visitPayments(state, spell, turn, work, visit) {
  if (spell.totalCost === 0) return visit(state.pool, state.board);
  if (availableMana(state, turn) < spell.totalCost) return false;

  function activate(pool, board, index) {
    if (!continueSearch(work)) return true;
    const remainder = pool.map((amount, color) => amount - spell.coloredCost[color]);
    const canPay = remainder.every(amount => amount >= 0) && sum(remainder) >= spell.genericCost;
    if (canPay && visitGenericPayments(remainder, spell.genericCost, 0, work,
      rest => visit(rest, board.filter(Boolean)))) return true;

    for (let i = index; i < board.length; i++) {
      const source = board[i];
      if (source.readyTurn > turn || !source.yield) continue;
      const afterTap = [...board];
      afterTap[i] = source.kind === 'egg' ? null : { ...source, readyTurn: turn + 1 };
      if (visitGenericPayments([...pool], source.activationCost || 0, 0, work,
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

function visitLines(deck, state, turn, drawn, seen, work, evaluate) {
  if (!continueSearch(work)) return true;
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

  const visit = next => visitLines(deck, next, turn, drawn, seen, work, evaluate);
  for (const [index, source] of state.board.entries()) {
    if (!source.fetch || source.readyTurn > turn) continue;
    const board = state.board.filter((_, i) => i !== index);
    if (visitSearch(deck, state, board, source.fetch, turn, drawn, visit)) return true;
  }

  for (const [index, card] of state.hand.entries()) {
    if (index > 0 && card === state.hand[index - 1]) continue;
    const { lands, accelerator: spell } = deck.groups[card];
    if ((!lands.length || state.landPlayed) && !spell) continue;
    const hand = state.hand.filter((_, i) => i !== index);
    if (!state.landPlayed) {
      for (const land of lands) {
        if (visit({ ...state, hand, landPlayed: true, board: addSource(state.board, land, turn),
          established: state.established || land.yield > 1 })) return true;
      }
    }
    if (!spell) continue;
    if (visitPayments(state, spell, turn, work, (pool, board) => {
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

function chooseOpening(deck, handSize, mulligan, random) {
  const drawnCards = Math.min(deck.size, mulligan ? 7 : handSize);
  const attempts = mulligan ? maximumMulliganAttempts(drawnCards, mulligan.minimumHandSize) : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const nextCopy = shuffledCopies(deck.size, random);
    const opening = Array.from({ length: drawnCards }, nextCopy);
    if (!mulligan) return { opening, nextCopy, bottom: [] };
    const profiles = opening.map(copy => ({ copy, group: deck.groups[deck.groupFor(copy)] }));
    const drawnLands = profiles.filter(profile => profile.group.isLandForMulligan).length;
    const bottomCount = Math.max(0, attempt - 1);
    const result = chooseMulliganLandCount(drawnLands, drawnCards, bottomCount, mulligan.keepLandCounts);
    if (!result.acceptable && attempt + 1 < attempts) continue;

    let landsToBottom = drawnLands - result.lands;
    let otherCardsToBottom = bottomCount - landsToBottom;
    const bottom = [];
    // Keep accelerators when selecting among otherwise interchangeable bottom cards.
    profiles.reverse().sort((a, b) => Number(Boolean(a.group.accelerator)) - Number(Boolean(b.group.accelerator)));
    for (const { copy, group } of profiles) {
      if (group.isLandForMulligan && landsToBottom > 0) {
        bottom.push(copy);
        landsToBottom--;
      } else if (!group.isLandForMulligan && otherCardsToBottom > 0) {
        bottom.push(copy);
        otherCardsToBottom--;
      }
    }
    for (let i = bottom.length - 1; i > 0; i--) {
      const swap = Math.floor(random() * (i + 1));
      [bottom[i], bottom[swap]] = [bottom[swap], bottom[i]];
    }
    return { opening: opening.filter(copy => !bottom.includes(copy)), nextCopy, bottom };
  }
}

function libraryDraw(nextCopy, bottom = []) {
  const reserves = [];
  let exhausted = false;
  return (drawn, fetched) => {
    const inLibrary = copy => !drawn.has(copy) && !fetched.includes(copy);
    for (const candidate of reserves) if (inLibrary(candidate)) return candidate;
    while (!exhausted) {
      const candidate = nextCopy();
      if (candidate === undefined) exhausted = true;
      else {
        reserves.push(candidate);
        if (inLibrary(candidate)) return candidate;
      }
    }
    return bottom.find(inLibrary);
  };
}

function sampleResult(deck, handSize, drawFirstTurn, mulligan, random, work) {
  const { opening, nextCopy, bottom } = chooseOpening(deck, handSize, mulligan, random);
  const draw = libraryDraw(nextCopy, bottom);
  const drawAfterSearch = bottom.length ? libraryDraw(shuffledCopies(deck.size, random)) : draw;
  const contexts = THRESHOLDS.map(() => new Map());
  const available = THRESHOLDS.map(() => false), setup = [false, false];
  const useful = group => group.lands.length || group.accelerator;
  const openingHand = opening.map(deck.groupFor).filter(id => useful(deck.groups[id])).sort((a, b) => a - b);
  const start = { hand: openingHand, board: [], pool: EMPTY_POOL, fetched: [], landPlayed: false, established: false };
  const initial = { drawn: new Set(opening), key: '' };
  const complete = turn => available[turn - 1] && (turn > setup.length || setup[turn - 1]);
  const completeFrom = turn => THRESHOLDS.every((_, index) => index + 1 < turn || complete(index + 1));

  function exploreTurn(state, turn, previous) {
    if (completeFrom(turn)) return true;
    const copy = turn > 1 || drawFirstTurn
      ? (state.fetched.length ? drawAfterSearch : draw)(previous.drawn, state.fetched)
      : undefined;
    const key = copy === undefined ? previous.key : `${previous.key},${copy}`;
    const cache = contexts[turn - 1];
    if (!cache.has(key)) {
      const drawn = copy === undefined ? previous.drawn : new Set([...previous.drawn, copy]);
      cache.set(key, { key, drawn, seen: new Set() });
    }
    const context = cache.get(key);
    const id = copy === undefined ? undefined : deck.groupFor(copy);
    const hand = id !== undefined && useful(deck.groups[id]) ? [...state.hand, id].sort((a, b) => a - b) : state.hand;
    return visitLines(deck, { ...state, hand, pool: EMPTY_POOL, landPlayed: false }, turn, context.drawn, context.seen, work, line => {
      const index = turn - 1;
      const aboveBaseline = availableMana(line, turn) >= THRESHOLDS[index];
      available[index] ||= aboveBaseline;
      if (turn <= setup.length) {
        setup[index] ||= aboveBaseline || line.established;
        if (turn === 1) setup[1] ||= setup[0];
      }
      if (turn < THRESHOLDS.length) exploreTurn(line, turn + 1, context);
      return work.limited || completeFrom(turn);
    });
  }
  exploreTurn(start, 1, initial);
  return { available, setup };
}

export function earlyManaProbabilities(cards, { handSize = 7, drawFirstTurn = true, mulligan = null, trials = 3000, seed = 0x4D414E41 } = {}) {
  if (!Number.isSafeInteger(handSize) || handSize < 0 || handSize > 20 ||
      !Number.isSafeInteger(trials) || trials < 1 || trials > 20000) {
    throw new RangeError('起手张数或模拟次数超出范围');
  }
  if (mulligan && (![5, 6, 7].includes(mulligan.minimumHandSize) ||
      !Array.isArray(mulligan.keepLandCounts) || mulligan.keepLandCounts.some(count => ![1, 2, 3, 4, 5, 6].includes(count)))) {
    throw new RangeError('调度设置超出范围');
  }
  const deck = prepareDeck(cards);
  const random = seedRandom(seed);
  const successes = THRESHOLDS.map(() => 0);
  const setups = [0, 0];
  let processed = trials, limitedTrials = 0;
  if (deck.groups.some(group => group.accelerator || group.lands.some(land => land.yield >= 2))) {
    const work = { remaining: TOTAL_WORK_LIMIT };
    processed = 0;
    while (processed < trials && work.remaining > 0) {
      work.trialRemaining = TRIAL_WORK_LIMIT;
      work.limited = false;
      const { available, setup } = sampleResult(deck, handSize, drawFirstTurn, mulligan, random, work);
      processed++;
      if (work.limited) limitedTrials++;
      for (let index = 0; index < THRESHOLDS.length; index++) {
        if (available[index]) successes[index]++;
        if (setup[index]) setups[index]++;
      }
    }
  }
  return {
    trials: processed,
    limitedTrials,
    turns: THRESHOLDS.map((threshold, index) => ({
      turn: index + 1,
      threshold,
      probability: successes[index] / processed,
      ...(index < setups.length ? { setupProbability: setups[index] / processed } : {}),
    })),
  };
}
