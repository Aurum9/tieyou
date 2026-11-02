import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchCards } from '../dist/lib/search.js';

// Acceptance against the shipped snapshot. Expected names and Oracle evidence
// below are hand-picked; no expectation is generated from a card's tags.
const dataDirectory = new URL('../dist/data/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, dataDirectory), 'utf8'));
const manifest = await readJson('manifest.json');
const shards = await Promise.all(manifest.shards.map(shard => readJson(shard.url)));
const cards = shards.flat();
const byName = new Map(cards.map(card => [card.name, card]));
const oracle = card => (card.faces?.length ? card.faces : [card]).map(face => face.oracleText || '').join('\n');

function knownCard(name) {
  const card = byName.get(name);
  assert.ok(card, `真实卡库中缺少固定验收样本：${name}`);
  return card;
}

function runQuery(query) {
  const result = searchCards(cards, query);
  assert.equal(result.error, null, `${query}: ${JSON.stringify(result.error)}`);
  return result;
}

test('真实验收加载 manifest 声明的全部卡牌分片', () => {
  assert.equal(cards.length, manifest.counts.cards);
  // Un-set variants can share names while having distinct Oracle identities.
  assert.equal(new Set(cards.map(card => card.id)).size, cards.length, '每个 Oracle 身份只载入一次');
  shards.forEach((shard, index) => assert.equal(shard.length, manifest.shards[index].count));
});

const tagSamples = [
  {
    tag: '抓牌',
    yes: [
      ['Divination', /Draw two cards\./],
      ['Harmonize', /Draw three cards\./],
      ['Sign in Blood', /Target player draws two cards/],
      ["Night's Whisper", /You draw two cards/],
      ['Opt', /Draw a card\./],
    ],
    no: [
      ['Sol Ring', /Add \{C\}\{C\}/, '只产生法术力'],
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '只提供临时身材加成'],
      ['Grizzly Bears', /^$/, '普通无异能生物'],
    ],
  },
  {
    tag: '加速',
    yes: [
      ['Sol Ring', /Add \{C\}\{C\}/],
      ['Arcane Signet', /Add one mana of any color in your commander's color identity/],
      ['Llanowar Elves', /Add \{G\}/],
      ['Birds of Paradise', /Add one mana of any color/],
      ['Rampant Growth', /basic land card, put that card onto the battlefield tapped/],
    ],
    no: [
      ['Divination', /^Draw two cards\.$/, '只抓牌'],
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '只加身材'],
      ['Counterspell', /^Counter target spell\.$/, '只反击咒语'],
    ],
  },
  {
    tag: '找地',
    yes: [
      ['Cultivate', /Search your library for up to two basic land cards/],
      ["Kodama's Reach", /Search your library for up to two basic land cards/],
      ['Farseek', /Search your library for a Plains, Island, Swamp, or Mountain card/],
      ["Nature's Lore", /Search your library for a Forest card/],
      ['Evolving Wilds', /Search your library for a basic land card/],
    ],
    no: [
      ['Sol Ring', /Add \{C\}\{C\}/, '产费神器没有搜寻牌库效果'],
      ['Llanowar Elves', /Add \{G\}/, '产费生物没有搜寻牌库效果'],
      ['Divination', /^Draw two cards\.$/, '抓牌没有搜寻地牌效果'],
    ],
  },
  {
    tag: '单体去除',
    yes: [
      ['Swords to Plowshares', /Exile target creature\./],
      ['Path to Exile', /Exile target creature\./],
      ['Doom Blade', /Destroy target nonblack creature\./],
      ['Murder', /^Destroy target creature\.$/],
      ['Terminate', /Destroy target creature\./],
    ],
    no: [
      ['Wrath of God', /Destroy all creatures\./, '清除所有生物'],
      ['Grizzly Bears', /^$/, '普通无异能生物'],
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '目标生物获得正向加成'],
    ],
  },
  {
    tag: '清场',
    yes: [
      ['Wrath of God', /Destroy all creatures\./],
      ['Damnation', /Destroy all creatures\./],
      ['Day of Judgment', /^Destroy all creatures\.$/],
      ['Blasphemous Act', /deals 13 damage to each creature\./],
      ['Supreme Verdict', /Destroy all creatures\./],
    ],
    no: [
      ['Swords to Plowshares', /Exile target creature\./, '只放逐目标生物'],
      ['Murder', /^Destroy target creature\.$/, '只消灭目标生物'],
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '只加身材'],
    ],
  },
  {
    tag: '反击',
    yes: [
      ['Counterspell', /^Counter target spell\.$/],
      ['Negate', /^Counter target noncreature spell\.$/],
      ['Swan Song', /Counter target enchantment, instant, or sorcery spell\./],
      ['Dispel', /^Counter target instant spell\.$/],
      ['Mana Leak', /Counter target spell unless its controller pays \{3\}/],
    ],
    no: [
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '只加身材'],
      ['Divination', /^Draw two cards\.$/, '只抓牌'],
      ['Swords to Plowshares', /Exile target creature\./, '处理战场上的目标生物'],
    ],
  },
  {
    tag: '坟场互动',
    yes: [
      ['Regrowth', /^Return target card from your graveyard to your hand\.$/],
      ['Reanimate', /Put target creature card from a graveyard onto the battlefield/],
      ['Rest in Peace', /exile all graveyards\./],
      ["Tormod's Crypt", /Exile target player's graveyard\./],
      ['Eternal Witness', /return target card from your graveyard to your hand\./],
    ],
    no: [
      ['Sol Ring', /Add \{C\}\{C\}/, '只产生法术力'],
      ['Divination', /^Draw two cards\.$/, '只抓牌'],
      ['Giant Growth', /gets \+3\/\+3 until end of turn/, '只加身材'],
    ],
  },
];

for (const { tag, yes, no } of tagSamples) {
  // Search the complete catalogue once per tag; each fixture gets its own test.
  const resultIds = new Set(runQuery(`tag:${tag}`).cards.map(card => card.id));
  for (const [expected, samples] of [[true, yes], [false, no]]) {
    for (const [name, evidence, reason] of samples) {
      test(`真实功能 ${tag}：${expected ? '命中' : '排除'} ${name}`, () => {
        const card = knownCard(name);
        assert.match(oracle(card), evidence, `固定样本规则已变化：${name}`);
        assert.equal(
          resultIds.has(card.id), expected,
          `tag:${tag} / ${name}${reason ? `（${reason}）` : ''}\n英文规则：${oracle(card)}`,
        );
      });
    }
  }
}

const avacyn = 'Archangel Avacyn // Avacyn, the Purifier';
const delver = 'Delver of Secrets // Insectile Aberration';
const fixedQueries = [
  ['英文完整名称', 'name="Sol Ring"', ['Sol Ring']],
  ['中文完整名称使用同一身份', '名称=阳光戒', ['Sol Ring']],
  ['英文规则', 'name=Divination o:"Draw two cards."', ['Divination']],
  ['中文规则', '名称=卜卦 规则:"抓两张牌"', ['Divination']],
  ['英文背面名称', 'name="Insectile Aberration"', [delver]],
  ['中文背面名称', '名称=昆虫变体', [delver]],
  ['正面名称与英文背面规则', 'name="Archangel Avacyn" o:"deals 3 damage to each other creature"', [avacyn]],
  ['正面名称与中文背面规则', '名称=大天使艾维欣 规则:"向每个其他生物和每位对手各造成3点伤害"', [avacyn]],
  ['系列编号语言命中同一印刷', 'set:cmm cn:703 lang:en', ['Sol Ring']],
  ['中文印刷字段别名', '名称=阳光戒 系列:cmm 编号:703 语言:en', ['Sol Ring']],
  ['系列与编号不能跨印刷拼接', 'name="Sol Ring" set:cmm cn:263 lang:en', []],
  ['同一印刷不能借用其他语言', 'name="Sol Ring" set:cmm cn:703 lang:ja', []],
  ['无色神器', 'name="Sol Ring" c:无色', ['Sol Ring']],
  ['带有红色费用的无色牌', 'name="Bomat Courier" c:无色', ['Bomat Courier']],
  ['无色牌仍可具有有色标识色', 'name="Bomat Courier" ci:无色', []],
  ['背面颜色计入标识色', 'name="Archangel Avacyn" c=w ci=rw', [avacyn]],
  ['白色正面不能绕过红白标识色', 'name="Archangel Avacyn" ci=w', []],
  ['显式 AND 优先于 OR', 'name="Sol Ring" OR name="Counterspell" AND mv>=3', ['Sol Ring']],
  ['括号调整优先级', '(name="Sol Ring" OR name="Counterspell") AND mv>=3', []],
  ['隐式 AND 优先于 OR', 'name="Sol Ring" OR name="Counterspell" mv>=2', ['Sol Ring', 'Counterspell']],
];

for (const [label, query, expectedNames] of fixedQueries) {
  test(`真实固定查询：${label}`, () => {
    const expectedIds = expectedNames.map(name => knownCard(name).id).sort();
    const actualIds = runQuery(query).cards.map(card => card.id).sort();
    assert.deepEqual(actualIds, expectedIds, query);
  });
}

test('中英文名称返回同一 Oracle 身份', () => {
  assert.equal(runQuery('name="Sol Ring"').cards[0].id, runQuery('名称=阳光戒').cards[0].id);
});

test('匹配版本精确指向 CMM 703 英文版，原始卡库没有附加筛选状态', () => {
  const [card] = runQuery('set:cmm cn:703 lang:en').cards;
  assert.deepEqual(card.matchingVersions.map(version => version.id), ['7454e0cc-98c2-48a1-b2c9-49908d2aedcc']);
  assert.equal(knownCard('Sol Ring').matchingVersions, undefined);
  assert.ok(knownCard('Sol Ring').versions.some(version => version.set === 'c21' && version.collectorNumber === '263'));
  assert.ok(knownCard('Sol Ring').versions.some(version => version.set === 'cmm' && version.collectorNumber === '703'));
});

const invalidQueries = [
  ['未闭合引号', 'name:"Sol Ring', /引号/],
  ['未闭合括号', '(name="Sol Ring" OR name="Counterspell"', /括号/],
  ['缺少字段值', 'name:', /缺少查询值/],
  ['不支持的字段', 'price<2', /不支持字段/],
  ['非法数值', 'mv:two', /非负数字/],
  ['非法颜色', 'ci=purple', /颜色/],
  ['缺少逻辑运算右侧', 'name="Sol Ring" AND', /不完整/],
];
for (const [label, query, message] of invalidQueries) {
  test(`真实卡库错误查询：${label}`, () => {
    const result = searchCards(cards, query);
    assert.ok(result.error, query);
    assert.match(result.error.message, message);
    assert.ok(Number.isInteger(result.error.position));
    assert.deepEqual(result.cards, []);
    assert.equal(result.total, 0);
  });
}
