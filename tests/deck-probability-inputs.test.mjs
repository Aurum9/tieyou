import test from 'node:test';
import assert from 'node:assert/strict';
import { getDeckProbabilityInputs } from '../web/lib/deck-probability-inputs.js';

const entry = (cardId, quantity, zone = 'main', versionId = cardId) => ({ cardId, quantity, zone, versionId });

test('probability inputs use the opening library and combine printings of each card', () => {
  const cards = [
    { id: 'forest', name: 'Forest', zhName: '树林', typeLine: 'Basic Land — Forest' },
    { id: 'spell', name: 'Sol Ring', zhName: '阳光戒', typeLine: 'Artifact', aliases: ['太阳戒'] },
    { id: 'commander', name: 'Commander', typeLine: 'Legendary Creature' },
  ];
  const deck = { entries: [
    entry('forest', 4, 'main', 'forest-printing-a'),
    entry('forest', 8, 'main', 'forest-printing-b'),
    entry('spell', 1),
    entry('spell', 5, 'considering'),
    entry('commander', 1, 'commander'),
    entry('missing', 2),
  ] };
  assert.deepEqual(getDeckProbabilityInputs(deck, cards), {
    deckSize: 15,
    landCount: 12,
    modalLandCount: 0,
    unknownCount: 2,
    targets: [
      { id: 'forest', name: '树林', aliases: ['Forest'], count: 12 },
      { id: 'spell', name: '阳光戒', aliases: ['Sol Ring', '太阳戒'], count: 1 },
    ],
  });
});

test('only modal cards with a nonland front and a land back add to optional lands', () => {
  const land = { typeLine: 'Land' };
  const sorcery = { typeLine: 'Sorcery — Land' };
  const cards = [
    { id: 'modal', name: 'Turntimber Symbiosis // Turntimber, Serpentine Wood', zhName: '枝旋共生 // 蛇木枝旋林', layout: 'modal_dfc', faces: [
      { ...sorcery, name: 'Turntimber Symbiosis' },
      { ...land, name: 'Turntimber, Serpentine Wood', zhName: '蛇木枝旋林' },
    ] },
    { id: 'pathway', name: 'Pathway', layout: 'modal_dfc', faces: [land, land] },
    { id: 'land-spell', name: 'Land Spell', layout: 'modal_dfc', faces: [land, sorcery] },
    { id: 'transform', name: 'Transform', layout: 'transform', faces: [sorcery, land] },
  ];
  const result = getDeckProbabilityInputs({ entries: cards.map(card => entry(card.id, 2)) }, cards);
  assert.equal(result.deckSize, 8);
  assert.equal(result.landCount, 4);
  assert.equal(result.modalLandCount, 2);
  assert.deepEqual(result.targets.find(card => card.id === 'modal').aliases, [
    'Turntimber Symbiosis // Turntimber, Serpentine Wood',
    'Turntimber Symbiosis',
    'Turntimber, Serpentine Wood',
    '蛇木枝旋林',
  ]);
});
