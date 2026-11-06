import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchCards, parseQuery, validateSearch, extractSearchOptions } from '../dist/lib/search.js';

const face = (name, power, toughness, typeLine = 'Creature — Human', extra = {}) => ({ name, power, toughness, typeLine, zhTypeLine: typeLine.includes('Creature') ? '生物～人类' : '地', oracleText: '', zhText: '', ...extra });
const card = (id, faces, extra = {}) => ({ id, name: id, zhName: '', faces, legalities: { commander: 'legal' }, ...extra });
const cards = [
  card('small', [face('small', '1', '2')]),
  card('large', [face('large', '6', '7')]),
  card('negative', [face('negative', '-1', '4')]),
  card('variable', [face('variable', '*', '1+*')]),
  card('land', [face('land', null, null, 'Legendary Land')]),
  card('modal', [face('front', '1', '8'), face('back', '8', '1')]),
  card('creature-land', [face('creature front', '2', '2'), face('land back', null, null, 'Land')]),
];
function ids(query, rows = cards, sort = 'name') {
  const result = searchCards(rows, query, {}, sort);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.cards.map(row => row.id);
}

test('Chinese subtype names match complete types rather than longer unrelated subtype names', () => {
  const rows = [card('dragon', [face('Dragon', '5', '5', 'Creature — Dragon', { zhTypeLine: '生物～龙' })]), card('dinosaur', [face('Dinosaur', '5', '5', 'Creature — Dinosaur', { zhTypeLine: '生物～恐龙' })]), card('cat', [face('Cat', '1', '1', 'Creature — Cat', { zhTypeLine: '生物～猫' })]), card('mongoose', [face('Mongoose', '1', '1', 'Creature — Mongoose', { zhTypeLine: '生物～猫鼬' })])];
  assert.deepEqual(ids('t:龙', rows), ['dragon']); assert.deepEqual(ids('t:恐龙', rows), ['dinosaur']); assert.deepEqual(ids('t:猫', rows), ['cat']);
});

test('power/toughness ranges include signed numbers and reject missing or variable characteristics', () => {
  assert.deepEqual(ids('power>=-1 pow<=1 toughness>=2 tou<=4'), ['negative', 'small']);
  assert.deepEqual(ids('攻击力=-1 防御力:4'), ['negative']);
  assert.deepEqual(ids('pow<0'), ['negative']);
  assert.ok(!ids('pow>=-99 tou>=-99').includes('variable'));
  assert.ok(!ids('pow>=-99').includes('land'));
  assert.equal(ids('pow>=.5 pow<=1').includes('small'), true);
});

test('combined numeric characteristics must be present on one face', () => {
  assert.deepEqual(ids('pow>=5 tou>=5'), ['large']);
  assert.deepEqual(ids('pow>=8 tou<=1'), ['modal']);
  assert.equal(ids('(pow>=5 OR tou>=5) pow<=1').includes('modal'), true);
  assert.equal(ids('pow>=5 -tou>=5').includes('modal'), false);
  assert.equal(ids('-(pow>=5 tou>=5)').includes('modal'), true);
  assert.equal(ids('t:land pow>=1').includes('creature-land'), false);
  assert.equal(ids('t:creature pow>=1').includes('creature-land'), true);
});

test('stat queries preserve OR, printing correlation, and whole-card negation', () => {
  const versions = [card('printed', [face('printed', '3', '4')], { versions: [{ set: 'a', collectorNumber: '1' }, { set: 'b', collectorNumber: '2' }] })];
  assert.deepEqual(ids('set:a cn:2 pow>=1', versions), []);
  assert.deepEqual(ids('set:b cn:2 pow>=1', versions), ['printed']);
  assert.equal(ids('-pow>=8').includes('modal'), false);
  assert.equal(ids('pow>=8 OR name:small').includes('small'), true);
});

test('invalid bounds fail before downloading the card catalog', () => {
  for (const query of ['pow:two', 'power>=*', 'tou:Infinity', 'tou>=1e999']) {
    assert.match(validateSearch(query).message, /有限数字/, query);
  }
});

test('type queries accept supertypes and subtypes without matching unrelated English words', () => {
  const rows = [
    card('rat', [face('rat', '1', '1', 'Snow Creature — Rat')]),
    card('pirate', [face('pirate', '2', '2', 'Legendary Creature — Human Pirate')]),
    card('world', [face('world', null, null, 'World Enchantment')]),
  ];
  assert.deepEqual(ids('t:rat', rows), ['rat']);
  assert.deepEqual(ids('t:传奇 t:pirate', rows), ['pirate']);
  assert.deepEqual(ids('t:雪境', rows), ['rat']);
  assert.deepEqual(ids('t:世界', rows), ['world']);
  assert.deepEqual(ids('t:妖精', [card('elf', [face('elf', '1', '1', 'Creature — Elf', { zhTypeLine: '生物～精灵' })])]), ['elf']);
});

test('translated/untranslated checks every rules-bearing face, including blank rules', () => {
  const rows = [
    card('blank', [face('blank', null, null)]),
    card('complete', [face('a', '1', '1', 'Creature', { oracleText: 'Ability.', zhText: '异能。' })]),
    card('partial', [face('a', '1', '1', 'Creature', { oracleText: 'Ability.', zhText: '异能。' }), face('b', '2', '2', 'Creature', { oracleText: 'Other ability.', zhText: ' ' })]),
  ];
  assert.deepEqual(ids('is:translated', rows), ['blank', 'complete']);
  assert.deepEqual(ids('is:untranslated', rows), ['partial']);
  assert.deepEqual(ids('-is:untranslated', rows), ['blank', 'complete']);
  assert.match(validateSearch('is:made-up').message, /译文状态/);
});

test('ordering metadata leaves nested card expressions and original quoted text intact', () => {
  const input = '((name:"foo OR bar" OR name:🦊) AND f:commander) order:edhrec dir:desc';
  const result = extractSearchOptions(input);
  assert.equal(result.query, '((name:"foo OR bar" OR name:🦊) AND f:commander)');
  assert.equal(result.sort, 'edhrec');
  assert.equal(result.descending, true);
  assert.equal(extractSearchOptions('order:mv AND dir:desc AND pow>=2').query, 'pow>=2');
  assert.equal(extractSearchOptions('pow>=2 AND order:mv AND tou>=2').query.replace(/\s+/g, ' '), 'pow>=2 AND tou>=2');
  assert.equal(extractSearchOptions('order:cmc dir:desc').sort, 'mana-desc');
  assert.equal(extractSearchOptions('order:mv dir:asc', 'mana-desc').sort, 'mana-asc');
  assert.equal(extractSearchOptions('order:released').descending, true);
});

test('fully quoted syntax-like phrases remain literal search text, including ordering words', () => {
  const rows = [
    card('literal', [face('literal', '1', '1', 'Creature', { oracleText: 'Mentions order:edhrec here.' })], { edhrecRank: 50 }),
    card('other', [face('other', '2', '2')], { edhrecRank: 1 }),
  ];
  assert.equal(extractSearchOptions('"order:edhrec"').query, '"order:edhrec"');
  assert.equal(extractSearchOptions('"order:edhrec"').hasOrder, false);
  assert.deepEqual(ids('"order:edhrec"', rows), ['literal']);
  assert.deepEqual(ids('o:"order:edhrec"', rows), ['literal']);
  assert.equal(extractSearchOptions('o:"order:edhrec"').hasOrder, false);
  assert.equal(parseQuery('"name:Elf"').field, 'all');
  assert.equal(parseQuery('name:"Elf"').field, 'name');
  assert.equal(extractSearchOptions('"order:edhrec" order:name').sort, 'name');
  assert.deepEqual(ids('"order:edhrec" order:name', rows), ['literal']);
});

test('ordering rejects duplicates, unknown options, negation, and nested metadata', () => {
  for (const query of ['order:name order:edhrec', 'dir:asc dir:desc', 'order:price', 'dir:up', '-order:edhrec', 'NOT order:edhrec', '(name:x order:edhrec)']) {
    assert.ok(validateSearch(query), query);
    assert.ok(searchCards(cards, query).error, query);
  }
  assert.ok(validateSearch('name:x OR order:edhrec'));
});

test('EDHREC ordering uses lower ranks first with unranked entries last and deterministic ties', () => {
  const ranked = [
    card('z', [face('z', null, null)], { edhrecRank: 8 }),
    card('missing', [face('missing', null, null)]),
    card('a', [face('a', null, null)], { edhrecRank: 8 }),
    card('first', [face('first', null, null)], { edhrecRank: 1 }),
    card('zero', [face('zero', null, null)], { edhrecRank: 0 }),
  ];
  assert.deepEqual(ids('', ranked, 'edhrec'), ['first', 'a', 'z', 'missing', 'zero']);
  assert.deepEqual(ids('order:edhrec', ranked), ['first', 'a', 'z', 'missing', 'zero']);
  assert.deepEqual(ids('order:edhrec dir:desc', ranked), ['a', 'z', 'first', 'missing', 'zero']);
  assert.deepEqual(ids('order:name dir:desc', ranked), ['zero', 'z', 'missing', 'first', 'a']);
});

test('new search sidecar covers exactly the frozen catalog without altering translated shards', async () => {
  const dataURL = new URL('../dist/data/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dataURL), 'utf8'));
  const metadata = JSON.parse(await readFile(new URL(manifest.searchMetadata.url, dataURL), 'utf8'));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.oracleDate, manifest.snapshot.oracleDate);
  assert.equal(Object.keys(metadata.cards).length, manifest.counts.cards);
  assert.equal(Object.values(metadata.cards).filter(row => row.edhrecRank !== null).length, manifest.searchMetadata.rankedCards);
  const catalogIds = new Set();
  for (const shard of manifest.shards) {
    const rows = JSON.parse(await readFile(new URL(shard.url, dataURL), 'utf8'));
    for (const row of rows) {
      catalogIds.add(row.id);
      const extra = metadata.cards[row.id];
      assert.ok(extra, row.id);
      assert.deepEqual(extra.faces.map(face => face.name), row.faces.map(face => face.name));
      assert.equal(extra.edhrecRank === null || Number.isInteger(extra.edhrecRank) && extra.edhrecRank > 0, true);
      for (const face of extra.faces) {
        assert.equal(face.power === null || typeof face.power === 'string', true);
        assert.equal(face.toughness === null || typeof face.toughness === 'string', true);
      }
    }
  }
  assert.equal(catalogIds.size, Object.keys(metadata.cards).length);
});
