import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDeckMana } from '../web/lib/deck-analysis.js';

const spell = (id, manaValue, manaCost, colors, extra = {}) => ({ id, manaValue, manaCost, colors, typeLine: 'Sorcery', ...extra });
const land = (id, oracleText, producedMana = [], typeLine = 'Land') => ({ id, typeLine, oracleText, producedMana });
const entry = (cardId, quantity = 1, zone = 'main', id = cardId) => ({ id, cardId, quantity, zone });
const amounts = groups => Object.fromEntries(groups.map(group => [group.key, group.count]));

test('analysis weights copies, places spells in exclusive color stacks, and counts printed color symbols', () => {
  const cards = [
    spell('hybrid', 1, '{G/W}', ['G', 'W']),
    spell('phyrexian', 3, '{1}{B/P}{B/P}', ['B']),
    spell('split', 4, '{1}{R}', ['R', 'U'], { layout: 'split', faces: [{ manaCost: '{1}{R}' }, { manaCost: '{1}{U}' }] }),
    spell('modal', 7, '{4}{U}{U}{U}', ['U'], { layout: 'modal_dfc', producedMana: ['U'], faces: [{ typeLine: 'Sorcery' }, { typeLine: 'Land' }] }),
    spell('ring', 1, '{1}', [], { typeLine: 'Artifact', producedMana: ['C'] }),
    spell('devoid', 2, '{1}{C}', [], { colorIdentity: ['R'] }),
    spell('commander', 2, '{2/W}{G/U/P}', ['W', 'G', 'U']),
    land('island', '', [], 'Basic Land — Island'),
  ];
  const deck = { entries: [
    entry('hybrid', 2), entry('hybrid', 1, 'main', 'hybrid-another-printing'), entry('phyrexian', 2),
    entry('split'), entry('modal'), entry('ring'), entry('devoid'), entry('commander', 1, 'commander'),
    entry('island', 4), entry('ring', 100, 'considering', 'not-counted'),
  ] };
  const result = analyzeDeckMana(deck, cards);
  assert.deepEqual(result.counts, { main: 13, commander: 1, lands: 4, spells: 10, unknown: 0 });
  assert.deepEqual(amounts(result.curve.bins), { 0: 0, 1: 4, 2: 2, 3: 2, 4: 1, 5: 0, 6: 0, '7+': 1 });
  assert.deepEqual(amounts(result.curve.colors), { W: 0, U: 1, B: 2, R: 0, G: 0, M: 5, C: 2 });
  assert.deepEqual(result.curve.bins[1].colors.find(group => group.key === 'M').entryIds, ['hybrid', 'hybrid-another-printing']);
  assert.equal(result.curve.totalManaValue, 25);
  assert.equal(result.curve.averageManaValue, 2.5);
  assert.deepEqual(amounts(result.demand), { W: 4, U: 5, B: 4, R: 1, G: 4, C: 1 });
  assert.deepEqual(result.lands.modal.entryIds, ['modal']);
  assert.deepEqual(result.lands.accelerators.entryIds, ['ring']);
});

test('land production distinguishes straightforward, restricted, fetch, and optional land faces', () => {
  const cards = [
    spell('partner-w', 2, '{1}{W}', ['W'], { colorIdentity: ['W'] }),
    spell('partner-u', 2, '{1}{U}', ['U'], { colorIdentity: ['U'] }),
    land('basics', '({T}: Add {U}.)', ['U'], 'Basic Land — Island'),
    land('dual', '({T}: Add {W} or {U}.)\nAs this land enters, you may pay 2 life. If you don’t, it enters tapped.', ['W', 'U'], 'Land — Plains Island'),
    land('tower', "{T}: Add one mana of any color in your commander's color identity.", ['B', 'G', 'R', 'U', 'W']),
    land('cavern', '{T}: Add {C}.\n{T}: Add one mana of any color. Spend this mana only to cast a creature spell of the chosen type.', ['B', 'C', 'G', 'R', 'U', 'W']),
    land('filter', '{T}: Add {C}.\n{5}, {T}: Add five mana in any combination of colors.', ['B', 'C', 'G', 'R', 'U', 'W']),
    land('pool', '{T}: Add one mana of any type that a land you control could produce.', ['B', 'G', 'R', 'U', 'W']),
    land('fetch', '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield, then shuffle.'),
    land('verge', '{T}: Add {C}.\n{2}, {T}, Sacrifice this land: Search your library for a Forest card and a Plains card, put them onto the battlefield tapped, then shuffle.', ['C']),
    land('copy', 'You may have this land enter tapped as a copy of any land on the battlefield.'),
    land('passage', 'As this land enters, choose a basic land type.\nThis land is the chosen type.'),
    land('urza', "{T}: Add {C}. If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead.", ['C']),
    land('maze', '{T}: Untap target attacking creature.'),
    { ...land('pathway', '', ['G', 'W']), layout: 'modal_dfc', faces: [land('green-face', '{T}: Add {G}.'), land('white-face', '{T}: Add {W}.')] },
    { ...land('land-spell', '', ['R']), layout: 'modal_dfc', faces: [land('land-face', '{T}: Add {R}.'), { typeLine: 'Instant', manaCost: '{1}{R}' }] },
    spell('ramp', 2, '{1}{G}', ['G'], { tags: ['land-ramp'] }),
  ];
  const deck = { entries: cards.map(card => entry(card.id, card.id === 'basics' ? 3 : 1, card.id.startsWith('partner-') ? 'commander' : 'main')) };
  const result = analyzeDeckMana(deck, cards);
  assert.equal(result.counts.lands, 16);
  assert.deepEqual(amounts(result.lands.colors), { W: 3, U: 5, B: 0, R: 0, G: 1, C: 4 });
  assert.equal(result.lands.direct.count, 10);
  assert.deepEqual(result.lands.conditional.entryIds, ['cavern', 'filter', 'pool', 'copy', 'passage']);
  assert.deepEqual(result.lands.fetch.entryIds, ['fetch', 'verge']);
  assert.deepEqual(result.lands.modal.entryIds, ['land-spell']);
  assert.deepEqual(result.lands.other.entryIds, ['maze']);
  assert.deepEqual(result.lands.accelerators.entryIds, ['ramp']);
  assert.deepEqual(result.lands.colors.find(group => group.key === 'U').entryIds, ['basics', 'dual', 'tower']);
});

test('analysis reports missing cards and leaves the nonland average blank for an all-land list', () => {
  const cards = [land('tower', "{T}: Add one mana of any color in your commander's color identity.", ['B', 'G', 'R', 'U', 'W'])];
  const result = analyzeDeckMana({ entries: [entry('tower', 2), entry('unknown', 3)] }, cards);
  assert.deepEqual(result.counts, { main: 5, commander: 0, lands: 2, spells: 0, unknown: 3 });
  assert.deepEqual(result.missing, ['unknown']);
  assert.equal(result.curve.averageManaValue, null);
  assert.equal(result.lands.direct.count, 0);
  assert.equal(result.lands.conditional.count, 2);
});
