import test from 'node:test';
import assert from 'node:assert/strict';
import { CONDITION_FIELDS, createCondition, createGroup, buildConditionQuery, buildFilterQuery } from '../dist/lib/query-builder.js';
import { parseQuery, searchCards } from '../dist/lib/search.js';

function card(id, extra = {}) {
  return {
    id, name: id, zhName: '', aliases: [], colors: [], colorIdentity: [], manaValue: 0,
    oracleText: '', zhText: '', typeLine: 'Artifact', zhTypeLine: '神器',
    tags: [], set: 'a', collectorNumber: '1', lang: 'en', rarity: 'rare',
    legalities: { commander: 'legal' }, versions: [], ...extra,
  };
}
// Independent examples keep query construction separate from production tag assignments.
const cards = [
  card('scholar', { name: 'Grove Scholar', zhName: '林地学者', colors: ['G'], colorIdentity: ['G'], manaValue: 2, oracleText: 'Draw a card.', zhText: '抓一张牌。', typeLine: 'Creature — Elf', zhTypeLine: '生物～精灵', tags: ['draw'], versions: [{ id: 'v-a', set: 'a', collectorNumber: '12a', lang: 'en', rarity: 'rare' }, { id: 'v-b', set: 'b', collectorNumber: '21', lang: 'zhs', rarity: 'common' }] }),
  card('stone', { name: 'Tidal Stone', zhName: '潮汐石', manaValue: 0, oracleText: 'Add one mana.', zhText: '加一点法术力。', tags: ['ramp'] }),
  card('counter', { name: 'Counter Thought', zhName: '反击思绪', colors: ['U'], colorIdentity: ['U'], manaValue: 3, oracleText: 'Counter target spell.', zhText: '反击目标咒语。', typeLine: 'Instant', zhTypeLine: '瞬间', tags: ['counterspell'] }),
  card('modal', { name: 'Morning // Evening', colors: ['U'], colorIdentity: ['U', 'G'], manaValue: 4, tags: ['draw', 'ramp'] }),
  card('banned', { name: 'Broken Charm', manaValue: 0.5, colors: ['B'], colorIdentity: ['B'], legalities: { commander: 'banned' }, tags: ['recursion'] }),
  card('literal', { name: 'name: OR NOT (mv>=0) \\ "quoted"', oracleText: 'The word OR is literal. Draw a card: choose "yes" or "no". C:\\cards\\test' }),
];

function rule(field, value, op = ':', exclude = false) {
  return Object.assign(createCondition(field), { value, op, exclude });
}
function group(mode, ...children) {
  return Object.assign(createGroup(), { mode, children });
}
function built(model) {
  const result = buildConditionQuery(model);
  assert.equal(result.error, null, result.error);
  assert.doesNotThrow(() => parseQuery(result.query));
  return result;
}
function ids(model, suffix = '') {
  const result = searchCards(cards, `${built(model).query} ${suffix}`);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.cards.map(card => card.id).sort();
}

test('schema exposes every parser field and uniquely identifies conditions', () => {
  assert.deepEqual(CONDITION_FIELDS.map(field => field.value), ['name', 'o', 't', 'c', 'ci', 'mv', 'pow', 'tou', 'set', 'cn', 'r', 'lang', 'f', 'tag']);
  assert.equal(new Set(CONDITION_FIELDS.map(field => field.value)).size, 14);
  assert.equal(CONDITION_FIELDS.find(field => field.value === 'r').options.length, 6);
  for (const field of CONDITION_FIELDS) {
    assert.ok(['text', 'number', 'select', 'colors'].includes(field.input));
    assert.ok(field.operators.some(operator => operator.value === ':'));
  }
  const first = createCondition(), second = createGroup(), third = createCondition();
  assert.deepEqual({ ...first, id: 'id' }, { id: 'id', kind: 'rule', field: 'o', op: ':', value: '', exclude: false });
  assert.deepEqual({ ...second, id: 'id' }, { id: 'id', kind: 'group', mode: 'all', exclude: false, children: [] });
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
});

test('empty rules and groups produce no query while numeric zero remains active', () => {
  assert.deepEqual(built(group('any', rule('o', '  '), createGroup(), rule('mv', null))), { query: '', count: 0, error: null });
  const model = group('all', rule('mv', 0));
  assert.equal(built(model).count, 1);
  assert.deepEqual(ids(model), ['literal', 'stone']);
});

test('any group matches alternate functions and stays grouped beside another filter', () => {
  const model = group('any', rule('tag', '抓牌'), rule('tag', '反击'));
  assert.equal(built(model).count, 2);
  assert.deepEqual(ids(model), ['counter', 'modal', 'scholar']);
  assert.deepEqual(ids(model, 'AND mv<=2'), ['scholar']);
  const result = searchCards(cards, `mv<=2 AND ${built(model).query}`);
  assert.deepEqual(result.cards.map(card => card.id), ['scholar']);
});

test('nested negated groups retain the intended logical meaning', () => {
  const excluded = group('any', rule('tag', '反击'), rule('mv', 4));
  excluded.exclude = true;
  const model = group('all', group('any', rule('tag', '抓牌'), rule('tag', '反击')), excluded);
  assert.deepEqual(ids(model), ['scholar']);
  assert.deepEqual(ids(group('all', rule('tag', '抓牌', ':', true), rule('f', 'commander'))), ['counter', 'literal', 'stone']);
});

test('rule and group negation can cancel each other', () => {
  const model = group('all', rule('tag', '抓牌', ':', true));
  model.exclude = true;
  assert.deepEqual(ids(model), ['modal', 'scholar']);
});

test('series, collector number, rarity and language bind to the same printing', () => {
  assert.deepEqual(ids(group('all', rule('set', 'a'), rule('cn', '21'))), []);
  const model = group('all', rule('set', 'b'), rule('cn', '21'), rule('lang', 'zhs'), rule('r', 'common'));
  assert.deepEqual(ids(model), ['scholar']);
  const result = searchCards(cards, built(model).query);
  assert.deepEqual(result.cards[0].matchingVersions.map(version => version.id), ['v-b']);
  assert.deepEqual(ids(group('all', group('any', rule('set', 'b'), rule('set', 'c')), rule('lang', 'en'))), []);
});

test('Chinese phrases are preserved with text contains and exact matching', () => {
  assert.deepEqual(ids(group('all', rule('o', '抓一张牌'))), ['scholar']);
  assert.deepEqual(ids(group('all', rule('name', '林地学者', '='))), ['scholar']);
  assert.deepEqual(ids(group('all', rule('name', '林地', '='))), []);
  assert.deepEqual(ids(group('all', rule('t', '精灵'))), ['scholar']);
});

test('literal field syntax, operators, parentheses, quotes and backslashes cannot inject conditions', () => {
  const literalName = cards.find(card => card.id === 'literal').name;
  assert.deepEqual(ids(group('all', rule('name', literalName, '='))), ['literal']);
  assert.deepEqual(ids(group('all', rule('name', '" OR mv>=0 OR name:"'))), []);
  assert.deepEqual(ids(group('all', rule('o', 'C:\\cards\\test'))), ['literal']);
  assert.deepEqual(ids(group('all', rule('o', 'choose "yes" or "no"'))), ['literal']);
});

test('OR and colon within quoted text remain literal', () => {
  assert.deepEqual(ids(group('all', rule('o', 'OR is literal'))), ['literal']);
  assert.deepEqual(ids(group('all', rule('o', 'card: choose'))), ['literal']);
  assert.deepEqual(ids(group('all', rule('o', 'OR'))), ['literal']);
});

test('nonnegative integer and fractional comparisons support closed ranges', () => {
  assert.deepEqual(ids(group('all', rule('mv', '0.5', '>='), rule('mv', 2, '<='))), ['banned', 'scholar']);
  assert.deepEqual(ids(group('all', rule('mv', '.5'))), ['banned']);
  assert.deepEqual(ids(group('all', rule('mv', '2.'))), ['scholar']);
});

test('card color and color identity are distinct and colorless works', () => {
  assert.deepEqual(ids(group('all', rule('c', 'U', '='))), ['counter', 'modal']);
  assert.deepEqual(ids(group('all', rule('ci', 'U', '='))), ['counter']);
  assert.deepEqual(ids(group('all', rule('ci', 'UG', '<='))), ['counter', 'literal', 'modal', 'scholar', 'stone']);
  assert.deepEqual(ids(group('all', rule('c', 'C'))), ['literal', 'stone']);
  assert.match(built(group('all', rule('ci', 'C', '='))).query, /无色/);
});

test('color strict and inclusive set operators preserve their meanings', () => {
  assert.deepEqual(ids(group('all', rule('ci', 'ug', '>='))), ['modal']);
  assert.deepEqual(ids(group('all', rule('ci', 'U', '>'))), ['modal']);
  assert.deepEqual(ids(group('all', rule('ci', 'UG', '<'))), ['counter', 'literal', 'scholar', 'stone']);
});

test('numeric, choice, field and operator errors have readable messages', () => {
  const invalid = [
    [rule('mv', '-1'), /非负数字/], [rule('mv', 'Infinity'), /非负数字/],
    [rule('mv', '1e3'), /非负数字/], [rule('mv', '3 OR mv>=0'), /非负数字/],
    [rule('mv', '9'.repeat(400)), /非负数字/],
    [rule('c', 'CU'), /单独选择无色/], [rule('ci', '紫'), /请选择/],
    [rule('r', 'unobtainium'), /稀有度/], [rule('lang', 'xx'), /印刷语言/],
    [rule('f', 'modern'), /赛制合法性/], [rule('bad', 'x'), /字段无效/],
    [rule('name', 'x', '>='), /比较方式/], [rule('name', {}), /值无效/],
    [rule('o', '\u0000'), /控制字符/],
  ];
  for (const [condition, expected] of invalid) {
    const result = buildConditionQuery(group('all', condition));
    assert.match(result.error, expected);
    assert.equal(result.query, '');
  }
});

test('up to sixteen active conditions are allowed and empty rules do not use the limit', () => {
  const model = group('all', ...Array.from({ length: 16 }, () => rule('mv', 0)), ...Array.from({ length: 8 }, () => rule('o', '')));
  assert.equal(built(model).count, 16);
  model.children.push(rule('mv', 0));
  assert.match(buildConditionQuery(model).error, /16/);
});

test('six group levels are accepted and the seventh is rejected', () => {
  let model = group('all', rule('mv', 0));
  for (let index = 0; index < 5; index++) model = group('all', model);
  assert.deepEqual(ids(model), ['literal', 'stone']);
  assert.match(buildConditionQuery(group('all', model)).error, /6 层/);
});

test('query length respects the current parser limit after escaping', () => {
  const long = group('all', rule('name', 'x'.repeat(1015)));
  assert.equal(built(long).query.length, 1024);
  assert.match(buildConditionQuery(group('all', rule('name', 'x'.repeat(1016)))).error, /1024/);
  assert.match(buildConditionQuery(group('all', rule('o', '\\'.repeat(512)))).error, /1024/);
});

test('invalid group settings and circular references are handled without throwing', () => {
  assert.match(buildConditionQuery(null).error, /条件组/);
  const invalid = group('bad', rule('o', 'x'));
  assert.match(buildConditionQuery(invalid).error, /设置无效/);
  const cycle = createGroup(); cycle.children.push(cycle);
  assert.match(buildConditionQuery(cycle).error, /循环/);
  assert.match(buildConditionQuery(group('all', { kind: 'invalid' })).error, /结构无效/);
});

test('visual filters serialize every selected field into one executable query', () => {
  const result = buildFilterQuery({
    colors: ['U', 'G'], colorRelation: 'any', identities: ['U', 'G'], identityRelation: 'within',
    types: ['Creature', 'Artifact'], supertypes: ['Legendary'], subtype: '妖精',
    minManaValue: 0, maxManaValue: 4, minPower: -1, maxPower: 3, minToughness: '0.5', maxToughness: 6,
    commanderOnly: true, translation: 'translated',
  });
  assert.equal(result.error, null);
  assert.equal(result.query, '(c:u OR c:g) AND ci<=ug AND (t:"creature" OR t:"artifact") AND (t:"legendary") AND t:"妖精" AND mv>=0 AND mv<=4 AND pow>=-1 AND pow<=3 AND tou>=0.5 AND tou<=6 AND f:commander AND is:translated');
  assert.equal(result.count, 13); assert.equal(result.explicitCount, 12);
  assert.doesNotThrow(() => parseQuery(result.query));
});

test('visual color relations preserve any, all, exact, within and colorless semantics', () => {
  const expected = { any: '(c:u OR c:g)', all: 'c>=ug', exact: 'c=ug', within: 'c<=ug' };
  for (const [colorRelation, query] of Object.entries(expected)) assert.equal(buildFilterQuery({ colors: ['U', 'G'], colorRelation }).query, query);
  assert.equal(buildFilterQuery({ identities: ['C'] }).query, 'ci=无色');
  assert.match(buildFilterQuery({ colors: ['C', 'U'] }).error, /无色/);
});

test('visual default legality remains visible without counting as an explicit search', () => {
  assert.deepEqual(buildFilterQuery({ commanderOnly: true }), { query: 'f:commander', error: null, count: 1, explicitCount: 0 });
  assert.deepEqual(buildFilterQuery({}), { query: '', error: null, count: 0, explicitCount: 0 });
  assert.equal(buildFilterQuery({ translation: 'missing' }).query, 'is:untranslated');
});

test('visual stat ranges preserve zero, negatives and decimals while rejecting nonnumeric or inverted bounds', () => {
  assert.equal(buildFilterQuery({ minPower: '-.5', maxPower: 0, minToughness: -1, maxToughness: '2.' }).query, 'pow>=-.5 AND pow<=0 AND tou>=-1 AND tou<=2.');
  for (const [filters, expected] of [
    [{ minPower: 4, maxPower: 2 }, /力量下限/], [{ minToughness: 2, maxToughness: -1 }, /防御力下限/],
    [{ minManaValue: -1 }, /非负/], [{ minManaValue: 4, maxManaValue: 2 }, /法术力值下限/],
    [{ minPower: '*' }, /力量需要填写数字/], [{ maxToughness: '1e2' }, /防御力需要填写数字/],
  ]) assert.match(buildFilterQuery(filters).error, expected);
});

test('visual subtype text is quoted and cannot inject additional query conditions', () => {
  const result = buildFilterQuery({ subtype: 'Elf" OR mv>=0 OR t:"Dragon' });
  const ast = parseQuery(result.query);
  assert.equal(ast.type, 'term');
  assert.equal(ast.value, 'elf" or mv>=0 or t:"dragon');
});

test('more-condition stat fields accept signed numbers and exclude query injection', () => {
  assert.equal(built(group('all', rule('pow', -1, '>='), rule('tou', '.5', '<='))).query, '(pow>="-1" AND tou<=".5")');
  assert.match(buildConditionQuery(group('all', rule('pow', '*'))).error, /力量请输入数字/);
  assert.match(buildConditionQuery(group('all', rule('tou', '1 OR mv>=0'))).error, /防御力请输入数字/);
});
