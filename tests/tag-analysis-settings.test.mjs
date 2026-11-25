import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTagSettings, tagIncludedInAnalysis, getTagDescription } from '../web/lib/tag-settings.js';
import { visibleTagLabel, TAG_NAMES } from '../web/lib/tag-names.js';
import { searchCards } from '../web/lib/search.js';
import { analyzeDeckRelated } from '../web/lib/deck-analysis-related.js';

test('analysis exclusion leaves tag display, Chinese/English searches and explanations available', () => {
  const cards = [{ id: 'card', name: 'Example', manaValue: 1, typeLine: 'Artifact', legalities: { commander: 'legal' }, tags: ['ramp', 'mana ramp', 'draw'] }];
  const deck = { entries: [{ id: 'entry', cardId: 'card', zone: 'main', quantity: 2 }] };
  const vocabulary = [{ slug: 'ramp', aliases: ['mana ramp'] }, { slug: 'draw', aliases: [] }];
  const aliases = { ramp: ['mana ramp'], draw: [] };
  applyTagSettings({ revision: 1, aliases, overrides: { ramp: { label: '加速', visible: true, descriptionZh: '增加可用法术力。', includeInAnalysis: false } } });
  assert.equal(visibleTagLabel('mana ramp'), '加速'); assert.equal(TAG_NAMES.ramp, '加速');
  assert.equal(tagIncludedInAnalysis('mana ramp'), false); assert.equal(getTagDescription('ramp'), '增加可用法术力。');
  assert.equal(searchCards(cards, 'otag:ramp').cards.length, 1); assert.equal(searchCards(cards, 'otag:加速').cards.length, 1);
  assert.deepEqual(analyzeDeckRelated(deck, cards, { tagVocabulary: vocabulary }).tags.map(row => row.slug), ['draw']);
  applyTagSettings({ revision: 2, aliases, overrides: { ramp: { label: '加速', visible: true, includeInAnalysis: true } } });
  assert.equal(analyzeDeckRelated(deck, cards, { tagVocabulary: vocabulary }).tags.find(row => row.slug === 'ramp').count, 2);
  applyTagSettings({ revision: 3, aliases, overrides: { ramp: { label: '加速', visible: true } } });
  assert.equal(tagIncludedInAnalysis('ramp'), true, 'Existing settings remain included by default');
});
