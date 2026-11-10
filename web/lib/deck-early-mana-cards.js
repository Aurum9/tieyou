const COLORS = ['W', 'U', 'B', 'R', 'G'];
const BASIC_TYPES = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const TAGS = new Set(['ramp', 'mana ramp', 'acceleration', 'mana-producer', 'mana-rock', 'manarock', 'mana-dork', 'land-ramp', 'ritual', 'mana-egg', 'mana-dork-egg']);
const MANA_COUNTS = { one: 1, two: 2, three: 3 };
const MANA_SYMBOLS = /^(?:\{[WUBRGC]\})+$/;

function typesOf(face) {
  const [typeLine, subtypeLine = ''] = (face.typeLine || '').split(/[—–]/, 2);
  const types = Object.keys(BASIC_TYPES).filter(type => subtypeLine.trim().split(/\s+/).includes(type));
  return { typeLine, types, basic: /\bBasic\b/.test(typeLine), land: /\bLand\b/.test(typeLine) };
}

function manaOptions(clause, commanderColors) {
  const match = clause.match(/^(one|two|three) mana of any (?:one )?color( in your commander['’]s color identity)?$/i);
  if (match) {
    const colors = match[2] ? commanderColors : COLORS;
    return colors.map(color => Array(MANA_COUNTS[match[1].toLowerCase()]).fill(color));
  }
  const parts = clause.split(/,\s*(?:or\s+)?|\s+or\s+/);
  if (!parts.every(part => MANA_SYMBOLS.test(part))) return [];
  return parts.map(part => [...part.matchAll(/\{([WUBRGC])\}/g)].map(([, color]) => color));
}

function tapProduction(text, commanderColors, { sacrifice = false } = {}) {
  const options = [];
  for (const line of text.split('\n')) {
    const match = sacrifice
      ? line.match(/^\{T\}, Sacrifice this (?:artifact|creature|enchantment): Add ([^.]+)\.(.*)$/i)
      : line.match(/^\(?\{T\}(?:, Pay 1 life)?: Add ([^.]+)\.(.*)$/i);
    if (match && !/\b(?:if|instead)\b|\b(?:spend|activate)\b.*\bonly\b/i.test(match[2])) {
      options.push(...manaOptions(match[1], commanderColors));
    }
  }
  return options;
}

function landSearch(text) {
  const match = text.match(/^Search your library for an? (basic )?([^.]+?) card, (?:then )?put (?:it|that card) onto the battlefield( tapped)?, then shuffle\.(?: \([^)]*\))?$/i);
  if (!match) return null;
  const types = match[2] === 'land' ? [] : match[2].split(/,\s*(?:or\s+)?|\s+or\s+/);
  if (types.some(type => !Object.hasOwn(BASIC_TYPES, type))) return null;
  return { types, basicOnly: Boolean(match[1]), tapped: Boolean(match[3]) };
}

function landOption(face, index, commanderColors) {
  const text = face.oracleText || '';
  const { types, basic } = typesOf(face);
  if (/\bwhen you play another land, sacrifice this land\b|\bwhen this land enters, sacrifice\b|\bif this land would enter\b/i.test(text)) return null;
  const intrinsic = types.map(type => [BASIC_TYPES[type]]);
  const mana = [...new Map([...intrinsic, ...tapProduction(text, commanderColors)].map(bundle => [bundle.join(''), bundle])).values()];
  const fetchLine = text.split('\n').find(line => /^\{T\}, (?:Pay 1 life, )?Sacrifice this land: Search /i.test(line));
  const fetch = fetchLine ? landSearch(fetchLine.slice(fetchLine.indexOf(': ') + 2)) : null;
  if (!mana.length && !fetch) return null;
  const fastLand = text.match(/This land enters tapped unless you control (one|two|three) or fewer other lands\./i);
  const paysLife = /As this land enters, you may pay \d+ life\. If you don['’]t, it enters tapped\./i.test(text);
  const tapped = !paysLife && /\b(?:this land|it) enters (?:the battlefield )?tapped\b/i.test(text);
  const conditionalTap = tapped && !fastLand && /\bunless\b|\breveal\b|\bif you\b/i.test(text.split('\n').filter(line => /\benters\b/.test(line)).join(' '));
  return {
    mana, tapped, types, basic, front: index === 0,
    ...(fetch ? { fetch } : {}),
    ...(fastLand ? { untapWithMaxOtherLands: MANA_COUNTS[fastLand[1].toLowerCase()] } : {}),
    ...(conditionalTap ? { conditionalTap: true } : {}),
  };
}

function spellCost(manaCost) {
  if (!manaCost || !/^(?:\{(?:\d+|[WUBRGC])\})+$/.test(manaCost)) return null;
  return [...manaCost.matchAll(/\{(\d+|[WUBRGC])\}/g)].map(([, symbol]) => symbol);
}

function rampEffect(face, commanderColors) {
  const text = face.oracleText || '';
  const { typeLine } = typesOf(face);
  const guide = text.match(/^Exile this card from your hand: Add ([^.]+)\.$/im);
  if (guide) {
    const mana = manaOptions(guide[1], commanderColors);
    if (mana.length) return { kind: 'ritual', cost: [], mana };
  }
  const cost = spellCost(face.manaCost);
  if (!cost || /\b(?:as an additional cost to cast|if this [^.]+? would enter)\b|^Imprint\s+—/im.test(text)) return null;

  const searchLine = text.split('\n').find(line => /^(?:You may )?Search your library for |^Sacrifice this creature: Search your library for |^When this (?:creature|artifact|enchantment) enters, (?:you may )?search your library for /i.test(line));
  const search = searchLine ? landSearch(searchLine.slice(searchLine.search(/search your library/i))) : null;
  if (search && !/\bsacrifice (?:a|another|an untapped) land\b/i.test(text)) return { kind: 'land-ramp', cost, search };

  const host = text.match(/^Enchant (land|Plains|Island|Swamp|Mountain|Forest)$/im);
  const extra = text.match(/^Whenever enchanted (?:land|Plains|Island|Swamp|Mountain|Forest) is tapped for mana, its controller adds an additional ([^.]+)\./im);
  if (host && extra) {
    const fixedMana = /^As this Aura enters, choose a color\.$/im.test(text) && extra[1] === 'one mana of the chosen color';
    const mana = manaOptions(fixedMana ? 'one mana of any color' : extra[1], commanderColors);
    if (mana.length) return { kind: 'enchant', cost, mana, hostTypes: host[1] === 'land' ? [] : [host[1]], fixedMana };
  }

  if (/\b(?:Instant|Sorcery)\b/.test(typeLine)) {
    const ritual = text.match(/^Add ([^.,]+)(?:\. |\.$|\.\n|, then add \{[WUBRGC]\} for each)/i);
    if (ritual) {
      const mana = manaOptions(ritual[1], commanderColors);
      if (mana.length) return { kind: 'ritual', cost, mana };
    }
    if (/^Create a Treasure token[. ]/i.test(text)) return { kind: 'ritual', cost, mana: manaOptions('one mana of any color', commanderColors) };
    return null;
  }

  const delay = /\b(?:this [^.]+?|it) enters (?:the battlefield )?tapped\b/i.test(text)
    || (/\bCreature\b/.test(typeLine) && !/^Haste\b/im.test(text)) ? 1 : 0;
  const mana = tapProduction(text, commanderColors);
  const oneUse = /doesn['’]t untap during your untap step/i.test(text);
  if (mana.length) return { kind: oneUse ? 'egg' : 'permanent', cost, mana, delay };
  const paidTap = text.match(/^\{1\}, \{T\}: Add ([^.]+)\.$/im);
  const paidMana = paidTap ? manaOptions(paidTap[1], commanderColors).filter(bundle => bundle.length > 1) : [];
  if (paidMana.length) return { kind: 'permanent', cost, mana: paidMana, delay, activationCost: 1 };
  const sacrifice = tapProduction(text, commanderColors, { sacrifice: true });
  if (sacrifice.length) return { kind: 'egg', cost, mana: sacrifice, delay };
  return null;
}

export function classifyEarlyManaCard(card, { commanderColors = [], includeModalLands = true } = {}) {
  const available = [...new Set(commanderColors.filter(color => COLORS.includes(color)))];
  const faces = card.faces?.length ? card.faces : [card];
  const frontLand = typesOf(faces[0]).land;
  const landFaces = card.layout === 'modal_dfc' && (frontLand || includeModalLands) ? faces : faces.slice(0, 1);
  const landOptions = [];
  const excluded = {};
  for (const [index, face] of landFaces.entries()) {
    if (!typesOf(face).land) continue;
    const option = landOption(face, index, available);
    if (option) {
      landOptions.push(option);
      if (option.conditionalTap) excluded.land = '部分进场条件未建模';
    }
    else excluded.land = '产费或进场条件未建模';
  }
  const spell = (card.layout === 'modal_dfc' ? faces : faces.slice(0, 1)).find(face => !typesOf(face).land);
  const ramp = spell ? rampEffect(spell, available) : null;
  if (!ramp && spell && (card.tags || []).some(tag => TAGS.has(typeof tag === 'string' ? tag : tag?.slug || tag?.name))) {
    excluded.ramp = '加速条件未建模';
  }
  return { landOptions, ramp, excluded };
}
