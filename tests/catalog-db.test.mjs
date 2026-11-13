import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { searchCards } from '../web/lib/search.js';
import { buildNameRanks, normalizeCatalogBatch, importCatalogBatch, activateCatalogVersion, createCatalogService, compileCatalogQuery } from '../server/catalog-db.js';

function card(id, name, zhName, extra = {}) {
  const result = { id, name, zhName, aliases: [], manaValue: 0, manaCost: '', colors: [], colorIdentity: [], typeLine: 'Artifact', zhTypeLine: '神器', oracleText: '', zhText: '', tags: [], rarity: 'rare', lang: 'en', legalities: { commander: 'legal' }, set: 'a', collectorNumber: '1', releasedAt: '2020-01-01', versions: [{ id: id + '-a', set: 'a', collectorNumber: '1', lang: 'en', rarity: 'rare' }], ...extra };
  result.faces ||= [{ name: result.name, zhName: result.zhName, typeLine: result.typeLine, zhTypeLine: result.zhTypeLine, oracleText: result.oracleText, zhText: result.zhText, power: result.power ?? null, toughness: result.toughness ?? null }];
  return result;
}
const face = (name, power, toughness, typeLine = 'Creature — Human', extra = {}) => ({ name, power, toughness, typeLine, zhTypeLine: typeLine.includes('Creature') ? '生物～人类' : '地', oracleText: '', zhText: '', ...extra });
const cards = [
  card('scholar', 'Grove Scholar', '林地学者', { aliases: ['旧译学者'], manaValue: 2, colors: ['G'], colorIdentity: ['G'], power: '1', toughness: '2', typeLine: 'Creature — Elf', zhTypeLine: '生物～精灵', oracleText: 'Draw a card.', zhText: '抓一张牌。', tags: ['draw', 'cycle-rav-shockland'], edhrecRank: 1, versions: [{ id: 'v-a', set: 'a', collectorNumber: '12a', lang: 'en', rarity: 'rare' }, { id: 'v-b', set: 'b', collectorNumber: '21', lang: 'zhs', rarity: 'common' }] }),
  card('stone', 'Tidal Stone', '潮汐石', { aliases: ['旧译学者候补', 'b/21'], manaValue: 1, oracleText: 'Add one mana.', zhText: '加一点法术力。', tags: ['ramp', 'cycle-rav-shockland'], edhrecRank: 2, releasedAt: '2022-02-02' }),
  card('counter', 'Counter Thought', '反击思绪', { manaValue: 3, colors: ['U'], colorIdentity: ['U'], typeLine: 'Instant', zhTypeLine: '瞬间', oracleText: 'Counter target spell.', zhText: '反击目标咒语。', tags: ['counterspell', 'cycle-rav-shockland'], edhrecRank: 3 }),
  card('banned', 'Broken Charm', '破损符咒', { manaValue: 8, colors: ['B'], colorIdentity: ['B'], legalities: { commander: 'banned' }, oracleText: 'Return a card from your graveyard.', zhText: '', tags: ['recursion', 'cycle-rav-shockland'], edhrecRank: 1 }),
  card('modal', 'Morning // Evening', '晨光 // 夜幕', { manaValue: 4, colors: ['U'], colorIdentity: ['U', 'G'], faces: [face('Morning', '1', '8', 'Creature — Human', { zhName: '晨光', oracleText: 'Draw two cards.', zhText: '抓两张牌。' }), face('Evening', '8', '1', 'Land', { zhName: '夜幕', oracleText: 'Add green mana.', zhText: '加绿色法术力。' })], tags: ['draw', 'ramp'] }),
  card('large', 'Large', '巨兽', { faces: [face('large', '6', '7')] }),
  card('negative', 'Negative', '负一', { faces: [face('negative', '-1', '4')] }),
  card('variable', 'Variable', '未定', { faces: [face('variable', '*', '1+*')] }),
  card('creature-land', 'Creature // Land', '生物与地', { faces: [face('front', '2', '2'), face('back', null, null, 'Land')] }),
  card('rat', 'Rat', '鼠', { faces: [face('rat', '1', '1', 'Snow Creature — Rat', { zhTypeLine: '雪境生物～鼠' })] }),
  card('pirate', 'Pirate', '海盗', { faces: [face('pirate', '2', '2', 'Legendary Creature — Human Pirate', { zhTypeLine: '传奇生物～人类 海盗' })] }),
  card('cat', 'Cat', '猫', { faces: [face('cat', '1', '1', 'Creature — Cat', { zhTypeLine: '生物～猫' })] }),
  card('mongoose', 'Mongoose', '猫鼬', { faces: [face('mongoose', '1', '1', 'Creature — Mongoose', { zhTypeLine: '生物～猫鼬' })] }),
  card('half', 'Half Girl', '半张', { manaValue: 0.5, colors: ['W'], colorIdentity: ['W'], faces: [face('half', '0.5', '0.5')], edhrecRank: 9 }),
  card('infiltrator', 'Benthic Infiltrator', '海底潜行客', { colors: [], colorIdentity: ['U'], manaValue: 3, edhrecRank: 1 }),
  card('oracle', 'Coiling Oracle', '盘绕先知', { colors: ['U', 'G'], colorIdentity: ['U', 'G'], manaValue: 2, edhrecRank: 9 }),
  card('ten', 'Card 10', '数字10', { edhrecRank: 0 }), card('two', 'Card 2', '数字2'),
  card('quoted', 'Name:literal', '引号牌', { aliases: ['ＬＩＴＥＲＡＬ', 'O’Connor'], oracleText: 'Mentions order:edhrec here.', zhText: '中文注记。', tags: ['card-draw'] }),
  card('reordered', 'Reordered', '乱序', { oracleText: 'abxxbc', zhText: '甲乙和乙丙', tags: ['spot-removal'] }),
  card('token-test', 'Assembly-Worker', '组装工人', { typeLine: 'Artifact Creature — Assembly-Worker', zhTypeLine: '神器生物～组装工人' }),
];

const queries = [
  '', '林地学者', 'Grove Scholar', 'name:旧译学者', 'name:"Grove Scholar"', 'name="grove scholar"', 'o:"抓一张牌"', 'o:"draw two cards"', '抓牌', '抓',
  't:生物', 't:instant', 't:传奇', 't:雪境', 't:rat', 't:猫', 't:猫鼬', 't:"artifact creature"', 't:assembly-worker', 't=Artifact',
  'ci<=ug', 'c=g', 'c:无色', 'c>=ug', 'c<ug', 'c>g', 'c<=无色', 'ci=ub', 'ci<ub', 'ci>无色', 'c:白蓝',
  'mv<=2', 'mv:3', 'mv>=.5', 'f:commander', 'f:edh', 'tag:抓牌', 'tag:draw', 'tag:坟场互动', '-tag:抓牌',
  'tag:抓牌 mv<=2 OR tag:反击', '(tag:抓牌 OR tag:反击) mv<=3', 'name:夜幕', 't:地', 'set:a cn:12a', 'lang:zhs', 'set:a cn:21', 'set:b r:common',
  'set:a OR name:林地学者', '-set:a', 'NOT (set:a cn:12a)', 'set:b OR cn:1', '类型:生物 法术力值<=2',
  'power>=-1 pow<=1 toughness>=2 tou<=4', '攻击力=-1 防御力:4', 'pow<0', 'pow>=-99 tou>=-99', 'pow>=.5 pow<=1',
  'pow>=5 tou>=5', 'pow>=8 tou<=1', '(pow>=5 OR tou>=5) pow<=1', 'pow>=5 -tou>=5', '-(pow>=5 tou>=5)', 't:land pow>=1', 't:creature pow>=1', '-pow>=8', 'pow>=8 OR name:林地学者',
  'set:a cn:12a pow>=1', 'set:b cn:21 pow>=1', 'is:translated', 'is:untranslated', '-is:untranslated', '"order:edhrec"', 'o:"order:edhrec"', 'name:ＬＩＴＥＲＡＬ', 'name:"O’Connor"', 'o:abc', 'o:甲乙丙', `name:"' OR 1=1 --"`,
];
let db, service;
before(async () => {
  db = openLocalD1();
  const directory = new URL('../drizzle/', import.meta.url);
  for (const filename of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(filename, directory), 'utf8'));
  await importCatalogBatch(db, { version: 'fixture-v1', batchId: '0', cards, nameRanks: buildNameRanks(cards), meta: { counts: {}, sets: [{ code: 'a', name: 'A' }], subtypes: ['Cat'], shards: ['private'], searchMetadata: { url: 'private', rankedCards: 4, bytes: 999 } } });
  await activateCatalogVersion(db, { version: 'fixture-v1', expectedCards: cards.length, expectedFaces: cards.reduce((sum, card) => sum + card.faces.length, 0), expectedVersions: cards.reduce((sum, card) => sum + card.versions.length, 0) });
  service = createCatalogService(db);
});
after(() => db?.close());

for (const query of queries) test('D1 SQLite matches the existing query language: ' + (query || '(all)'), async () => {
  const expected = searchCards(cards, query);
  const actual = await service.search({ q: query, limit: 100 });
  assert.equal(actual.error, null);
  assert.equal(actual.total, expected.total);
  assert.deepEqual(actual.cards.map(card => card.id), expected.cards.map(card => card.id));
  for (const card of expected.cards) {
    if (card.matchingVersions) assert.deepEqual(actual.cards.find(row => row.id === card.id).matchingVersionIds, card.matchingVersions.map(version => version.id));
  }
});

for (const sort of ['name', 'mana-asc', 'mana-desc', 'released', 'edhrec']) for (const direction of ['', 'dir:asc', 'dir:desc']) test(`D1 SQLite preserves ${sort} ${direction} and stable ties`, async () => {
  const expected = searchCards(cards, direction, {}, sort), actual = await service.search({ q: direction, sort, limit: 100 });
  assert.deepEqual(actual.cards.map(card => card.id), expected.cards.map(card => card.id));
});

test('SQLite paginates identity rows without printing duplicates and omits full rules', async () => {
  const expected = searchCards(cards, 'set:a OR set:b').cards.map(card => card.id);
  const page1 = await service.search({ q: 'set:a OR set:b', limit: 3 }), page2 = await service.search({ q: 'set:a OR set:b', offset: 3, limit: 3 });
  assert.equal(page1.total, expected.length); assert.equal(page1.hasMore, true);
  assert.deepEqual([...page1.cards, ...page2.cards].map(card => card.id), expected.slice(0, 6));
  assert.ok(page1.cards.every(card => card.versionsComplete === false && card.oracleText === undefined && card.faces.every(face => face.oracleText === undefined)));
});
test('batch only hydrates requested identities and explicitly requested printings', async () => {
  const result = await service.batch(['scholar', 'missing'], { versions: [{ cardId: 'scholar', versionId: 'v-b' }] });
  assert.equal(result.cards.length, 1); assert.equal(result.cards[0].oracleText, 'Draw a card.');
  assert.deepEqual(result.cards[0].versions.map(version => version.id), ['v-a', 'v-b']);
  assert.equal(result.cards[0].versionsComplete, false);
  assert.deepEqual(result.missingIds, ['missing']);
  const absentVersion = await service.batch(['scholar'], { versions: [{ cardId: 'scholar', versionId: 'not-a-real-printing' }] });
  assert.deepEqual(absentVersion.missingVersions, [{ cardId: 'scholar', versionId: 'not-a-real-printing' }]);
  const detail = await service.detail('scholar'); assert.equal(detail.card.versionsComplete, true); assert.equal(detail.card.versions.length, 2);
  assert.equal((await service.detail('missing')).card, null);
});
test('suggest prioritizes exact aliases, supports set/number, and limits commander colors before truncation', async () => {
  const exact = await service.suggest('旧译学者');
  assert.deepEqual(exact.cards.map(card => card.id), ['scholar']);
  assert.equal(exact.total, 1);
  assert.deepEqual((await service.suggest('旧译学者', ['U'])).cards.map(card => card.id), ['stone']);
  const printing = await service.suggest('b/21'); assert.equal(printing.cards[0].matchingVersions[0].id, 'v-b');
  assert.deepEqual((await service.suggest('b/21', ['U'])).cards.map(card => card.id), ['stone']);
  assert.deepEqual((await service.suggest('card 2')).cards.map(card => card.id), ['two']);
  assert.deepEqual((await service.suggest('Ｏ’ＣＯＮＮＯＲ')).cards.map(card => card.id), ['quoted']);
  assert.deepEqual((await service.suggest('猫')).cards.map(card => card.id), ['cat']);
  assert.deepEqual((await service.suggest('林地', ['U'])).cards, []);
  assert.ok((await service.suggest('a', [], 8)).cards.every(card => card.colorIdentity.length === 0));
});
test('partial suggestions retain full counts and hydrate only the returned page', async () => {
  const expected = await service.search({ q: 'name:a', limit: 2 });
  assert.ok(expected.total > 2);
  assert.deepEqual(await service.suggest('a', null, 2), expected);
  assert.equal((await service.suggest('very '.repeat(200) + 'unlikely')).total, 0);
});
test('OTag suggestions rank legal matches inside the chosen identity before limiting results', async () => {
  const query = 'otag:cycle-rav-shockland';
  const unscoped = await service.suggest(query);
  assert.deepEqual(unscoped.cards.map(card => card.id), ['scholar', 'stone', 'counter']);
  const scoped = await service.suggest('otag:电震圈', ['U'], 1);
  assert.deepEqual(scoped.cards.map(card => card.id), ['stone']);
  assert.equal(scoped.total, 2);
  assert.deepEqual(await service.suggest('电震圈', ['U'], 1), scoped);
  assert.deepEqual((await service.suggest(query, [])).cards.map(card => card.id), ['stone']);
});
test('text import resolves exact names and preserves original row errors and printings', async () => {
  const text = '[Commander]\n1 Grove Scholar (b) 21\n[Main]\n2 旧译学者\n1 Unknown\n1 Tidal Stone (nope) 9';
  const actual = await service.resolveText(text), expected = (await import('../web/lib/decks.js')).parseDeckText(text, cards);
  assert.deepEqual(actual.rows.map(row => ({ status: row.status, candidates: row.candidates, cardId: row.cardId, versionId: row.versionId })), expected.rows.map(row => ({ status: row.status, candidates: row.candidates, cardId: row.cardId, versionId: row.versionId })));
  assert.equal(actual.cards.length, 2); assert.ok(actual.cards.every(card => card.versionsComplete));
});
test('metadata response never leaks bulk shard or sidecar locations', async () => {
  const meta = await service.meta(); assert.equal(meta.shards, undefined); assert.equal(meta.searchMetadata.url, undefined); assert.equal(meta.searchMetadata.bytes, undefined);
  assert.equal(meta.searchMetadata.rankedCards, 4); assert.deepEqual(meta.sets, [{ code: 'a', name: 'A' }]);
});
test('query validation happens before SQL and pagination parameters are bounded', async () => {
  for (const query of ['(', 'name:', 'pow:two', 'mv:-1', 'c:purple', 'order:price', 'name>x']) assert.deepEqual((await service.search({ q: query })).error, searchCards(cards, query).error);
  assert.ok((await service.search({ limit: 101 })).error); assert.ok((await service.search({ offset: -1 })).error);
});
test('import is idempotent and failed activation cannot replace the active snapshot', async () => {
  assert.equal((await importCatalogBatch(db, { version: 'fixture-v1', batchId: '0', cards: [] })).imported, false);
  await assert.rejects(importCatalogBatch(db, { version: 'fixture-v1', batchId: 'other', cards, nameRanks: buildNameRanks(cards) }), /不能修改/);
  await importCatalogBatch(db, { version: 'fixture-v2', batchId: '0', cards: cards.slice(0, 1), nameRanks: buildNameRanks(cards), digest: 'first' });
  await assert.rejects(importCatalogBatch(db, { version: 'fixture-v2', batchId: '0', cards: cards.slice(0, 1), digest: 'changed' }), /不同的数据/);
  await assert.rejects(activateCatalogVersion(db, { version: 'fixture-v2', expectedCards: 2, expectedFaces: 1, expectedVersions: 2 }), /数量不一致/);
  assert.equal((await service.meta()).datasetVersion, 'fixture-v1');
});
test('JSON1 imports do not hit SQLite parameter limits for hundreds of tags', () => {
  const value = normalizeCatalogBatch([card('lots', 'Lots', '很多', { tags: Array.from({ length: 200 }, (_, i) => `tag-${i}`) })], { nameRanks: { lots: 0 } });
  assert.equal(value.tags.length, 200);
});
test('contentless FTS stays correct after SQLite compaction and snapshot changes', async () => {
  await db.exec('VACUUM');
  assert.deepEqual((await service.search({ q: 'name:林地学者' })).cards.map(card => card.id), ['scholar']);
  const version = 'snapshot-switch', changed = [card('scholar', 'Different scholar', '全新名字', { tags: ['draw'] })];
  await importCatalogBatch(db, { version, batchId: '0', cards: changed, nameRanks: buildNameRanks(changed) });
  await activateCatalogVersion(db, { version, expectedCards: 1, expectedFaces: 1, expectedVersions: 1 });
  assert.equal((await service.search({ q: 'name:林地学者' })).total, 0);
  assert.deepEqual((await service.search({ q: 'name:全新名字' })).cards.map(card => card.id), ['scholar']);
  assert.equal((await service.suggest('林地学者')).total, 0);
  assert.deepEqual((await service.suggest('全新名字')).cards.map(card => card.id), ['scholar']);
  await activateCatalogVersion(db, { version: 'fixture-v1', expectedCards: cards.length, expectedFaces: cards.reduce((n, card) => n + card.faces.length, 0), expectedVersions: cards.reduce((n, card) => n + card.versions.length, 0) });
});
test('FTS query plans perform one inverted-index candidate lookup rather than one per card', async () => {
  const compiled = compileCatalogQuery('name:林地学者');
  const plan = await db.prepare(`EXPLAIN QUERY PLAN ${compiled.prefix} SELECT c.id FROM catalog_cards c CROSS JOIN qp WHERE c.version=? AND ${compiled.predicate}`).bind(JSON.stringify(compiled.params), 'fixture-v1').all();
  assert.ok(plan.results.some(row => /VIRTUAL TABLE INDEX.*M/i.test(row.detail)));
  assert.ok(plan.results.every(row => !/CORRELATED LIST SUBQUERY/i.test(row.detail)));
});

test('default color searches count and page from a covering index without sorting or reading card JSON', async () => {
  const observed = [];
  const monitored = createCatalogService({ ...db, prepare(sql) {
    const statement = db.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...bindings) => {
        if (/SELECT (?:COUNT\(\*\)|c\.id) .*FROM catalog_cards c CROSS JOIN qp/.test(sql)) observed.push({ sql, bindings });
        return target.bind(...bindings);
      };
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    } });
  } });
  for (const q of ['ci<=ub', 'c:u']) await monitored.search({ q, commanderOnly: true });
  assert.equal(observed.length, 4);
  for (const { sql, bindings } of observed) {
    const plan = (await db.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...bindings).all()).results;
    assert.ok(plan.some(row => /SEARCH c USING COVERING INDEX catalog_cards_name.*version=/.test(row.detail)), JSON.stringify(plan));
    assert.ok(plan.every(row => !/SCAN c\b|TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
  }
});
