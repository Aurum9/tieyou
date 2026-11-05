import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSearchIntent } from '../dist/lib/search-intent.js';

const defaults = () => ({
  query: '', error: null,
  filters: { colors: [], identities: [], types: [], minManaValue: '', maxManaValue: '', commanderOnly: true, translation: 'all' },
});

test('a blank page and the default EDH boundary do not start a search', () => {
  assert.equal(hasSearchIntent(), false);
  assert.equal(hasSearchIntent(' \n\t', defaults()), false);
  assert.equal(hasSearchIntent('', { ...defaults(), query: ' \n ' }), false);
});

test('turning the EDH legality boundary off alone does not start a search', () => {
  const visual = defaults();
  visual.filters.commanderOnly = false;
  assert.equal(hasSearchIntent('', visual), false);
});

test('color and identity relation choices need a selected color', () => {
  for (const relation of ['any', 'all', 'exact', 'within']) {
    const visual = defaults();
    visual.filters.colorRelation = relation;
    visual.filters.identityRelation = relation;
    assert.equal(hasSearchIntent('', visual), false);
  }
});

test('a nonblank main query starts a search, including invalid syntax for validation', () => {
  assert.equal(hasSearchIntent(' Sol Ring ', defaults()), true);
  assert.equal(hasSearchIntent('(', defaults()), true);
});

test('a visual query starts a search, including a tag condition', () => {
  assert.equal(hasSearchIntent('', { ...defaults(), query: 'tag:ramp' }), true);
});

test('a local validation error is visible even when no query was generated', () => {
  assert.equal(hasSearchIntent('', { ...defaults(), error: '请选择条件值' }), true);
});

for (const [field, value] of [['colors', ['U']], ['colors', ['C']], ['identities', ['G']], ['types', ['creature']]]) {
  test(`${field}: ${value} starts a search without main text`, () => {
    const visual = defaults();
    visual.filters[field] = value;
    assert.equal(hasSearchIntent('', visual), true);
  });
}

for (const field of ['minManaValue', 'maxManaValue']) {
  test(`${field} accepts zero as an explicit search boundary`, () => {
    for (const value of [0, '0', ' 0 ', 3, '2.5', '-1']) {
      const visual = defaults();
      visual.filters[field] = value;
      assert.equal(hasSearchIntent('', visual), true, String(value));
    }
  });

  test(`${field} blank values do not start a search`, () => {
    for (const value of ['', ' \n ', null, undefined]) {
      const visual = defaults();
      visual.filters[field] = value;
      assert.equal(hasSearchIntent('', visual), false, String(value));
    }
  });
}

test('a translation condition starts a search', () => {
  for (const translation of ['translated', 'missing']) {
    const visual = defaults();
    visual.filters.translation = translation;
    assert.equal(hasSearchIntent('', visual), true);
  }
});

test('intent checks leave the visual condition unchanged', () => {
  const visual = defaults();
  visual.filters.colors = ['U'];
  const original = structuredClone(visual);
  hasSearchIntent('', visual);
  assert.deepEqual(visual, original);
});
