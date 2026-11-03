import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCards, parseQuery } from '../dist/lib/search.js';

// Small independent catalogue: these fictional names avoid tying parser behavior to live Oracle changes.
function card(id, name, zhName, extra = {}) {
  const row = { id, name, zhName, aliases: [], manaValue: 0, colors: [], colorIdentity: [], typeLine: 'Artifact', zhTypeLine: '神器', oracleText: '', zhText: '', tags: [], rarity: 'rare', lang: 'en', legalities: { commander: 'legal' }, set: 'a', collectorNumber: '1', releasedAt: '2020-01-01', versions: [], ...extra };
  row.faces ||= [{ name: row.name, zhName: row.zhName, typeLine: row.typeLine, zhTypeLine: row.zhTypeLine, oracleText: row.oracleText, zhText: row.zhText }];
  return row;
}
const cards = [
  card('scholar', 'Grove Scholar', '林地学者', { aliases: ['旧译学者'], manaValue: 2, colors: ['G'], colorIdentity: ['G'], typeLine: 'Creature — Elf', zhTypeLine: '生物～精灵', oracleText: 'Draw a card.', zhText: '抓一张牌。', tags: ['draw'], versions: [{ id: 'v-a', set: 'a', collectorNumber: '12a', lang: 'en', rarity: 'rare' }, { id: 'v-b', set: 'b', collectorNumber: '21', lang: 'zhs', rarity: 'common' }] }),
  card('stone', 'Tidal Stone', '潮汐石', { manaValue: 1, oracleText: 'Add one mana.', zhText: '加一点法术力。', tags: ['ramp'], releasedAt: '2022-02-02' }),
  card('counter', 'Counter Thought', '反击思绪', { manaValue: 3, colors: ['U'], colorIdentity: ['U'], typeLine: 'Instant', zhTypeLine: '瞬间', oracleText: 'Counter target spell.', zhText: '反击目标咒语。', tags: ['counterspell'] }),
  card('banned', 'Broken Charm', '破损符咒', { manaValue: 8, colors: ['B'], colorIdentity: ['B'], legalities: { commander: 'banned' }, oracleText: 'Return a card from your graveyard.', zhText: '', tags: ['recursion'] }),
  card('modal', 'Morning // Evening', '晨光 // 夜幕', { manaValue: 4, colors: ['U'], colorIdentity: ['U', 'G'], faces: [{ name: 'Morning', zhName: '晨光', typeLine: 'Sorcery', zhTypeLine: '法术', oracleText: 'Draw two cards.', zhText: '抓两张牌。' }, { name: 'Evening', zhName: '夜幕', typeLine: 'Land', zhTypeLine: '地', oracleText: 'Add green mana.', zhText: '加绿色法术力。' }], tags: ['draw', 'ramp'] }),
];
const ids = (query, filters = {}, sort = 'name') => {
  const result = searchCards(cards, query, filters, sort);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.cards.map(card => card.id).sort();
};

const cases = [
  ['中文名称', '林地学者', ['scholar']], ['英文名称', 'Grove Scholar', ['scholar']],
  ['旧译别名', 'name:旧译学者', ['scholar']], ['短语', 'name:"Grove Scholar"', ['scholar']],
  ['中文规则', 'o:"抓一张牌"', ['scholar']], ['英文规则', 'o:"draw two cards"', ['modal']],
  ['中文类型', 't:生物', ['scholar']], ['英文类别', 't:instant', ['counter']],
  ['标识色子集', 'ci<=ug', ['counter', 'modal', 'scholar', 'stone']],
  ['颜色恰好', 'c=g', ['scholar']], ['无色', 'c:无色', ['stone']],
  ['法术力比较', 'mv<=2', ['scholar', 'stone']], ['数值恰好', 'mv:3', ['counter']],
  ['EDH合法', 'f:commander', ['counter', 'modal', 'scholar', 'stone']],
  ['功能中文', 'tag:抓牌', ['modal', 'scholar']], ['功能英文', 'tag:draw', ['modal', 'scholar']],
  ['坟场来源标签', 'tag:坟场互动', ['banned']], ['排除', '-tag:抓牌', ['banned', 'counter', 'stone']],
  ['隐式AND优先于OR', 'tag:抓牌 mv<=2 OR tag:反击', ['counter', 'scholar']],
  ['括号组合', '(tag:抓牌 OR tag:反击) mv<=3', ['counter', 'scholar']],
  ['多牌面背面名', 'name:夜幕', ['modal']], ['多牌面背面类型', 't:地', ['modal']],
  ['系列加编号', 'set:a cn:12a', ['scholar']], ['语言筛选', 'lang:zhs', ['scholar']],
  ['同一印刷关联', 'set:a cn:21', []], ['印刷稀有度关联', 'set:b r:common', ['scholar']],
  ['空结果', 'name:完全不存在的样本', []], ['中文字段名', '类型:生物 法术力值<=2', ['scholar']],
];
for (const [name, query, expected] of cases) test(name, () => assert.deepEqual(ids(query), expected));

test('打印条件返回匹配版本且不更改原卡库', () => {
  const result = searchCards(cards, 'set:b cn:21');
  assert.deepEqual(result.cards[0].matchingVersions.map(version => version.id), ['v-b']);
  assert.equal(cards[0].matchingVersions, undefined);
});
test('语法错误包含位置', () => {
  for (const query of ['(name:foo', 'name:', 'name:"foo', 'tag:draw AND', 'OR tag:draw', 'price<2', 'mv:two', 'ci<=purple', 'f:potato', 'name>foo', ')']) {
    const result = searchCards(cards, query);
    assert.ok(result.error, query); assert.equal(typeof result.error.position, 'number'); assert.deepEqual(result.cards, []);
  }
});
test('过深括号与超长查询得到可读错误', () => {
  assert.throws(() => parseQuery('('.repeat(25) + 'x' + ')'.repeat(25)), /嵌套/);
  assert.throws(() => parseQuery('x'.repeat(1025)), /1024/);
});
test('缺失译文筛选逐牌面检查', () => {
  assert.deepEqual(ids('', { translation: 'missing' }), ['banned']);
  const partial = card('partial', 'Partial', '未完整', { faces: [{ oracleText: 'One', zhText: '一' }, { oracleText: 'Two', zhText: '' }] });
  assert.equal(searchCards([partial], '', { translation: 'missing' }).total, 1);
});
test('颜色筛选默认匹配牌面颜色，包含任一所选色', () => assert.deepEqual(ids('', { colors: ['G'] }), ['scholar']));
test('无色按钮可单选及与其他色组合', () => {
  assert.deepEqual(ids('', { colors: ['C'] }), ['stone']);
  assert.deepEqual(ids('', { colors: ['C', 'G'] }), ['scholar', 'stone']);
  assert.deepEqual(ids('', { colors: ['U'], colorMode: 'colors' }), ['counter', 'modal']);
});
test('显式旧标识色模式保留子集语义', () => {
  assert.deepEqual(ids('', { colors: ['G'], colorMode: 'identity' }), ['scholar', 'stone']);
  assert.deepEqual(ids('', { colors: ['U'], colorMode: 'identity' }), ['counter', 'stone']);
});
test('视图筛选与查询共同生效', () => assert.deepEqual(ids('mv>=1', { commanderOnly: true, maxManaValue: 2, types: ['神器'] }), ['stone']));
test('排序法术力值与发布日期', () => {
  assert.equal(searchCards(cards, '', {}, 'mana-desc').cards[0].id, 'banned');
  assert.equal(searchCards(cards, '', {}, 'released').cards[0].id, 'stone');
});
test('没有标签数据时明确报错', () => assert.match(searchCards([card('empty', 'Empty', '空')], 'tag:抓牌').error.message, /尚未载入/));

// Independent real-card facts exercise color versus identity and unrestricted numeric ranges.
const filterCards = [
  card('infiltrator', 'Benthic Infiltrator', '海底潜行客', { colors: [], colorIdentity: ['U'], manaValue: 3 }),
  card('oracle', 'Coiling Oracle', '盘绕先知', { colors: ['U', 'G'], colorIdentity: ['U', 'G'], manaValue: 2 }),
  card('elves', 'Llanowar Elves', '罗堰妖精', { colors: ['G'], colorIdentity: ['G'], manaValue: 1 }),
  card('ponder', 'Ponder', '沉思', { colors: ['U'], colorIdentity: ['U'], manaValue: 1 }),
  card('ring', 'Sol Ring', '阳光戒', { manaValue: 1 }),
  card('memnite', 'Memnite', '膜生兽', { manaValue: 0 }),
  card('girl', 'Little Girl', '', { colors: ['W'], colorIdentity: ['W'], manaValue: 0.5 }),
  card('draco', 'Draco', '德拉库', { manaValue: 16 }),
];
const filteredIds = filters => {
  const result = searchCards(filterCards, '', filters);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.cards.map(row => row.id).sort();
};
test('空颜色与空标识色不施加限制', () => {
  assert.equal(filteredIds({ colors: [], identities: [] }).length, filterCards.length);
});
test('无色有蓝色标识的牌只匹配无色牌面及蓝色标识', () => {
  assert.deepEqual(filteredIds({ colors: ['C'], identities: ['U'], identityRelation: 'exact' }), ['infiltrator']);
  assert.deepEqual(filteredIds({ colors: ['U'], colorRelation: 'exact' }), ['ponder']);
});
test('颜色关系支持任一、全部、恰好及限定范围', () => {
  assert.deepEqual(filteredIds({ colors: ['U', 'G'] }), ['elves', 'oracle', 'ponder']);
  assert.deepEqual(filteredIds({ colors: ['U', 'G'], colorRelation: 'all' }), ['oracle']);
  assert.deepEqual(filteredIds({ colors: ['G'], colorRelation: 'all' }), ['elves', 'oracle']);
  assert.deepEqual(filteredIds({ colors: ['G'], colorRelation: 'exact' }), ['elves']);
  assert.deepEqual(filteredIds({ colors: ['G'], colorRelation: 'within' }), ['draco', 'elves', 'infiltrator', 'memnite', 'ring']);
});
test('标识色独立筛选且默认限定范围包含无色标识', () => {
  assert.deepEqual(filteredIds({ identities: ['U'] }), ['draco', 'infiltrator', 'memnite', 'ponder', 'ring']);
  assert.deepEqual(filteredIds({ identities: ['U'], identityRelation: 'any' }), ['infiltrator', 'oracle', 'ponder']);
  assert.deepEqual(filteredIds({ identities: ['U', 'G'], identityRelation: 'all' }), ['oracle']);
  assert.deepEqual(filteredIds({ identities: ['G'], identityRelation: 'exact' }), ['elves']);
  assert.deepEqual(filteredIds({ colors: ['G'], identities: ['G'] }), ['elves']);
});
test('无色在任一关系可并集选择，限定范围自然包含无色', () => {
  assert.deepEqual(filteredIds({ colors: ['C', 'G'] }), ['draco', 'elves', 'infiltrator', 'memnite', 'oracle', 'ring']);
  assert.deepEqual(filteredIds({ identities: ['C'], identityRelation: 'all' }), ['draco', 'memnite', 'ring']);
  assert.deepEqual(filteredIds({ colors: ['C'], colorRelation: 'exact' }), ['draco', 'infiltrator', 'memnite', 'ring']);
  assert.deepEqual(filteredIds({ identities: ['C', 'G'], identityRelation: 'within' }), ['draco', 'elves', 'memnite', 'ring']);
});
test('无色混合彩色的全部或恰好关系给出可读错误', () => {
  for (const relation of ['all', 'exact']) {
    assert.match(searchCards(filterCards, '', { colors: ['C', 'G'], colorRelation: relation }).error.message, /无色/);
    assert.match(searchCards(filterCards, '', { identities: ['C', 'G'], identityRelation: relation }).error.message, /无色/);
  }
});
test('法术力上下限含边界、零及小数', () => {
  assert.deepEqual(filteredIds({ minManaValue: 0, maxManaValue: 0 }), ['memnite']);
  assert.deepEqual(filteredIds({ minManaValue: 0.5, maxManaValue: 1 }), ['elves', 'girl', 'ponder', 'ring']);
  assert.deepEqual(filteredIds({ minManaValue: '0.5', maxManaValue: '0.5' }), ['girl']);
});
test('法术力上限可以留空且不限制为十一以下', () => {
  assert.deepEqual(filteredIds({ minManaValue: 12, maxManaValue: null }), ['draco']);
  assert.deepEqual(filteredIds({ maxManaValue: 16 }), filteredIds({}));
  assert.deepEqual(filteredIds({ minManaValue: '', maxManaValue: '' }), filteredIds({}));
});
test('无效法术力上下限给出可读错误，空卡库仍校验', () => {
  for (const bound of ['minManaValue', 'maxManaValue']) {
    for (const invalid of [-1, NaN, Infinity, -Infinity, 'bad', true, {}]) {
      const result = searchCards([], '', { [bound]: invalid });
      assert.match(result.error?.message || '', /法术力值.*非负有限数字/, `${bound}: ${String(invalid)}`);
      assert.deepEqual(result.cards, []);
    }
  }
  assert.match(searchCards(filterCards, '', { minManaValue: 3, maxManaValue: 2 }).error.message, /下限不能大于上限/);
});
test('无效颜色筛选参数给出查询错误', () => {
  assert.match(searchCards([], '', { colors: ['purple'] }).error.message, /颜色使用/);
  assert.match(searchCards([], '', { identities: ['U'], identityRelation: 'unknown' }).error.message, /匹配方式无效/);
});
