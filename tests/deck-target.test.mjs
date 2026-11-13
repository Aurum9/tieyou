import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeckTarget, catalogQueryFromDeckSearch, commanderScopeQuery } from '../web/lib/deck-target.js';
import { parseQuery, searchCards } from '../web/lib/search.js';

const card = (id, name, colorIdentity = [], versions = []) => ({
  id, name, zhName: '', aliases: [], colorIdentity, colors: [], manaValue: 0,
  typeLine: 'Artifact', oracleText: '', zhText: '', tags: [], versions,
});
const cards = [
  card('sol', 'Sol Ring', [], [{ id: 'sol-m21', set: 'm21', collectorNumber: '123a', lang: 'en' }]),
  card('literal', 'Sol Ring OR name:Other'),
  card('escaped', 'Quote " OR ci:r \\ End'),
  card('other', 'Other', ['R']),
  card('blue', 'Blue', ['U']),
  card('green', 'Green', ['G']),
  card('simic', 'Simic', ['U', 'G']),
];
function search(query) {
  const result = searchCards(cards, query);
  assert.equal(result.error, null);
  return result.cards.map(row => row.id).sort();
}

test('添加目标只按当前选择的 ID 匹配', () => {
  const decks = [{ id: 'first' }, { id: 'chosen' }];
  assert.equal(resolveDeckTarget(decks, 'chosen'), decks[1]);
  assert.equal(resolveDeckTarget(decks, null), null);
  assert.equal(resolveDeckTarget(decks, ''), null);
  assert.equal(resolveDeckTarget([], 'chosen'), null);
});
test('目标被删除后不回退到其他卡组', () => {
  assert.equal(resolveDeckTarget([{ id: 'other' }], 'deleted'), null);
  assert.equal(resolveDeckTarget(null, 'deleted'), null);
});
test('空的迷你搜索不生成全库查询条件', () => {
  assert.equal(catalogQueryFromDeckSearch('   '), '');
  assert.equal(catalogQueryFromDeckSearch(null), '');
});
test('英文双词牌名保持为字面名称', () => {
  assert.equal(catalogQueryFromDeckSearch(' Sol Ring ', ['sol']), 'name:"Sol Ring"');
  assert.deepEqual(search(catalogQueryFromDeckSearch('Sol Ring')), ['literal', 'sol']);
});
test('输入中的 OR 与字段符号不会注入高级条件', () => {
  const query = catalogQueryFromDeckSearch('Sol Ring OR name:Other');
  assert.equal(parseQuery(query).type, 'term');
  assert.deepEqual(search(query), ['literal']);
});
test('引号、反斜杠及括号保持字面值', () => {
  const query = catalogQueryFromDeckSearch('Quote " OR ci:r \\ End');
  assert.equal(parseQuery(query).value, 'quote " or ci:r \\ end');
  assert.deepEqual(search(query), ['escaped']);
  assert.equal(parseQuery(catalogQueryFromDeckSearch('(OR)')).value, '(or)');
});
test('已知系列和编号可用空格、冒号、斜线或井号分隔', () => {
  for (const text of ['M21 123a', 'm21:123a', 'm21 / 123a', 'm21#123a']) {
    const query = catalogQueryFromDeckSearch(text, new Set(['m21']));
    assert.equal(query, 'set:"m21" cn:"123a"');
    assert.deepEqual(search(query), ['sol']);
  }
});
test('功能标签转到高级卡查后仍是独立条件，按 EDHREC 排序', () => {
  assert.equal(catalogQueryFromDeckSearch('电震圈'), 'otag:"电震圈" order:edhrec');
  assert.equal(catalogQueryFromDeckSearch('cycle-rav-shockland'), 'otag:"cycle-rav-shockland" order:edhrec');
  assert.equal(catalogQueryFromDeckSearch('otag：电震圈'), 'otag:"电震圈" order:edhrec');
  assert.equal(catalogQueryFromDeckSearch('otag:"cycle-rav-shockland"'), 'otag:"cycle-rav-shockland" order:edhrec');
});
test('未知系列或非编号后缀继续按名称搜索', () => {
  assert.equal(catalogQueryFromDeckSearch('M21 123a'), 'name:"M21 123a"');
  assert.equal(catalogQueryFromDeckSearch('M21 Name', ['m21']), 'name:"M21 Name"');
  assert.equal(catalogQueryFromDeckSearch('M21 123 OR ci:r', ['m21']), 'name:"M21 123 OR ci:r"');
});
test('收藏编号保留数字后的字母、星号和连字符', () => {
  for (const collector of ['123★', '123*', '123a-2']) {
    assert.equal(catalogQueryFromDeckSearch(`m21 ${collector}`, ['m21']), `set:"m21" cn:"${collector}"`);
  }
});
test('没有主将时不添加标识色限制', () => {
  assert.equal(commanderScopeQuery(null), '');
  assert.equal(commanderScopeQuery(undefined), '');
});
test('主将标识色合并、去重并按 WUBRG 顺序输出', () => {
  const query = commanderScopeQuery(['G', 'u', 'G']);
  assert.equal(query, 'ci<=ug');
  assert.deepEqual(search(query), ['blue', 'escaped', 'green', 'literal', 'simic', 'sol']);
  assert.equal(commanderScopeQuery(new Set(['R', 'B', 'W'])), 'ci<=wbr');
});
test('无色主将只允许无色标识色卡牌', () => {
  const query = commanderScopeQuery([]);
  assert.equal(query, 'ci<=无色');
  assert.deepEqual(search(query), ['escaped', 'literal', 'sol']);
});
