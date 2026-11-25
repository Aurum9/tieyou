import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTagSettings } from '../web/lib/tag-settings.js';
import { analyzeDeckRelated } from '../web/lib/deck-analysis-related.js';

const deck = { entries: [
  { id: 'main-a', cardId: 'a', zone: 'main', quantity: 2 },
  { id: 'main-a-other-printing', cardId: 'a', zone: 'main', quantity: 1 },
  { id: 'commander-b', cardId: 'b', zone: 'commander', quantity: 1 },
  { id: 'candidate-c', cardId: 'c', zone: 'considering', quantity: 12 },
] };

test('tag counts merge canonical slugs and aliases while retaining all contributing deck entries', () => {
  const cards = [
    { id: 'a', tags: ['mana rock', 'mana-rock', 'manarock', 'landfall', 'unknown-tag'] },
    { id: 'b', tags: ['manarock', { slug: 'combat-trick' }] },
    { id: 'c', tags: ['mana-rock', 'landfall', 'candidate-only'] },
  ];
  const tagVocabulary = [
    { slug: 'mana-rock', label: 'mana rock', aliases: ['mana rock', 'manarock'] },
    { slug: 'combat-trick', label: 'combat trick', aliases: [] },
  ];
  applyTagSettings({ revision: 1, overrides: Object.fromEntries(['mana-rock','landfall'].map(slug => [slug,{ label: slug === 'mana-rock' ? '法术力石' : '地落', visible:true,includeInAnalysis:true }])) });
  const { tags } = analyzeDeckRelated(deck, cards, { tagVocabulary });
  assert.deepEqual(tags[0], {
    slug: 'mana-rock', label: '法术力石', aliases: ['mana rock', 'manarock'],
    count: 4, entryIds: ['main-a', 'main-a-other-printing', 'commander-b'],
  });
  assert.equal(tags.find(tag => tag.slug === 'landfall').count, 3);
  assert.ok(!tags.some(tag => ['manarock', 'mana rock', 'candidate-only', 'unknown-tag', 'combat-trick'].includes(tag.slug)));
});

test('linked tokens are grouped by template and count source cards without counting candidate entries', () => {
  const bear = { id: 'bear', name: 'Bear', zhName: '熊', typeLine: 'Token Creature — Bear', power: '2', toughness: '2', image: 'https://cards.scryfall.io/bear.jpg' };
  const treasure = { id: 'treasure', name: 'Treasure', zhName: '珍宝', typeLine: 'Token Artifact — Treasure' };
  const tokenCatalog = {
    byCard: { a: ['bear', 'bear', 'missing'], b: ['bear', 'treasure'], c: ['candidate-token'] },
    tokens: { bear, treasure, 'candidate-token': { ...bear, id: 'candidate-token' } },
  };
  const { tokens } = analyzeDeckRelated(deck, [], { tokenCatalog });
  assert.deepEqual(tokens, [
    { id: 'bear', token: bear, label: '2/2 熊', count: 4, entryIds: ['main-a', 'main-a-other-printing', 'commander-b'] },
    { id: 'treasure', token: treasure, label: '珍宝', count: 1, entryIds: ['commander-b'] },
  ]);
});
