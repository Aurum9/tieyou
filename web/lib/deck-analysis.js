const COLORS = ['W', 'U', 'B', 'R', 'G'];
const MANA_COLORS = [...COLORS, 'C'];
const SPELL_COLORS = [...COLORS, 'M', 'C'];
const BASIC_TYPES = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const RAMP_TAGS = new Set(['acceleration', 'ramp', 'mana ramp', 'land-ramp', 'mana-producer', 'mana-rock', 'manarock', 'mana-dork']);
const LAND_TUTOR = /\bsearch your library for\b[^.\n]*\b(?:land|Plains|Island|Swamp|Mountain|Forest|Desert|Gate|Locus) cards?\b/i;
const TAP_MANA = /^\(?\{T\}:\s*Add ([^.]+)\.(.*)$/i;
const ADD_MANA = /\badd\s+(?:\{[WUBRGC]\}|(?:\w+\s+)?mana\b)/i;

const bucket = key => ({ key, count: 0, entryIds: [] });
const buckets = keys => Object.fromEntries(keys.map(key => [key, bucket(key)]));
const isLand = face => /\bLand\b/.test((face.typeLine || '').split(/[—–]/, 1)[0]);
const tagsOf = card => (card.tags || []).map(tag => typeof tag === 'string' ? tag : tag.slug || tag.name);

function add(group, entry, count = entry.quantity) {
  group.count += count;
  group.entryIds.push(entry.id);
}

function costSymbols(card, faces) {
  const costs = (card.layout === 'split' ? faces : faces.slice(0, 1))
    .map(face => face.manaCost ?? card.manaCost ?? '');
  const amounts = Object.fromEntries(MANA_COLORS.map(color => [color, 0]));
  for (const match of costs.join('').matchAll(/\{([^{}]+)\}/g)) {
    for (const part of new Set(match[1].split('/'))) if (Object.hasOwn(amounts, part)) amounts[part]++;
  }
  return amounts;
}

function manaClause(clause, commanderColors) {
  if (/^\w+ mana of any color in your commander['’]s color identity$/i.test(clause)) return commanderColors?.length ? commanderColors : null;
  if (/^\w+ mana (?:of any (?:one )?color|in any combination of colors)$/i.test(clause)) return COLORS;
  if (!clause.replace(/\{[WUBRGC]\}|\bor\b|[\s,]/g, '')) return [...clause.matchAll(/\{([WUBRGC])\}/g)].map(match => match[1]);
  return null;
}

function directMana(clause, remainder, commanderColors) {
  if (/(?:spend|activate)\b.*\bonly\b/i.test(remainder)) return null;
  const colors = manaClause(clause, commanderColors);
  if (!colors || !/\b(?:if|instead)\b/i.test(remainder)) return colors;
  // An ability like Urza's Tower can change the amount without changing its color.
  const replacement = remainder.match(/\badd ([^.]+?) instead\./i);
  const alternate = replacement ? manaClause(replacement[1], commanderColors) : null;
  return alternate && colors.every(color => alternate.includes(color)) && alternate.every(color => colors.includes(color)) ? colors : null;
}

function landSources(card, faces, commanderColors) {
  const colors = new Set();
  let conditional = false;
  const text = faces.map(face => face.oracleText ?? card.oracleText ?? '').join('\n');
  for (const face of faces) {
    const subtypes = face.typeLine?.split(/[—–]/)[1]?.trim().split(/\s+/) || [];
    for (const type of subtypes) if (Object.hasOwn(BASIC_TYPES, type)) colors.add(BASIC_TYPES[type]);
  }
  for (const line of text.split('\n')) {
    if (!ADD_MANA.test(line)) continue;
    const match = line.trim().match(TAP_MANA);
    const direct = match ? directMana(match[1], match[2], commanderColors) : null;
    if (direct) for (const color of direct) colors.add(color);
    else conditional = true;
  }
  if (!colors.size && (card.producedMana || []).some(color => MANA_COLORS.includes(color))) conditional = true;
  if (/\b(?:copy of (?:any|target|a) land|(?:choose|gains?) (?:a|each) basic land type)\b/i.test(text)) conditional = true;
  const fetch = tagsOf(card).includes('fetchland') || LAND_TUTOR.test(text);
  return { colors, conditional, fetch };
}

export function analyzeDeckMana(deck, cards) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const active = deck.entries.filter(entry => entry.zone === 'main' || entry.zone === 'commander');
  const commanders = active.filter(entry => entry.zone === 'commander').map(entry => byId.get(entry.cardId));
  const commanderColors = commanders.length && commanders.every(card => Array.isArray(card?.colorIdentity))
    ? [...new Set(commanders.flatMap(card => card.colorIdentity))].filter(color => COLORS.includes(color)) : null;
  const bins = Array.from({ length: 8 }, (_, index) => ({ ...bucket(index === 7 ? '7+' : String(index)), colors: Object.values(buckets(SPELL_COLORS)) }));
  const colors = buckets(SPELL_COLORS), demand = buckets(MANA_COLORS), landColors = buckets(MANA_COLORS);
  const lands = { ...buckets(['direct', 'conditional', 'fetch', 'modal', 'other', 'accelerators']), colors: Object.values(landColors) };
  const counts = { main: 0, commander: 0, lands: 0, spells: 0, unknown: 0 };
  const missing = [];
  let totalManaValue = 0;

  for (const entry of active) {
    counts[entry.zone] += entry.quantity;
    const card = byId.get(entry.cardId);
    if (!card) { counts.unknown += entry.quantity; missing.push(entry.id); continue; }
    const faces = card.faces?.length ? card.faces : [card];
    const frontLand = isLand(faces[0]);
    const landFaces = faces.filter(isLand);
    const modalLand = card.layout === 'modal_dfc' && landFaces.length > 0 && landFaces.length < faces.length;
    if (modalLand) add(lands.modal, entry);

    if (frontLand) {
      counts.lands += entry.quantity;
      if (modalLand) continue;
      const sources = landSources(card, card.layout === 'modal_dfc' ? landFaces : faces.slice(0, 1), commanderColors);
      if (sources.colors.size) add(lands.direct, entry);
      for (const color of sources.colors) add(landColors[color], entry);
      if (sources.conditional) add(lands.conditional, entry);
      if (sources.fetch) add(lands.fetch, entry);
      if (!sources.colors.size && !sources.conditional && !sources.fetch) add(lands.other, entry);
      continue;
    }

    counts.spells += entry.quantity;
    const manaValue = Math.max(0, Number(card.manaValue) || 0);
    totalManaValue += manaValue * entry.quantity;
    const bin = bins[Math.min(7, Math.floor(manaValue))];
    const actualColors = [...new Set(card.colors || [])].filter(color => COLORS.includes(color));
    const color = actualColors.length > 1 ? 'M' : actualColors[0] || 'C';
    add(bin, entry);
    add(bin.colors.find(group => group.key === color), entry);
    add(colors[color], entry);
    for (const [symbol, amount] of Object.entries(costSymbols(card, faces))) if (amount) add(demand[symbol], entry, amount * entry.quantity);
    if (tagsOf(card).some(tag => RAMP_TAGS.has(tag)) || (!modalLand && card.producedMana?.length)) add(lands.accelerators, entry);
  }

  return {
    counts,
    curve: { totalManaValue, averageManaValue: counts.spells ? totalManaValue / counts.spells : null, bins, colors: Object.values(colors) },
    demand: Object.values(demand), lands, missing,
  };
}
