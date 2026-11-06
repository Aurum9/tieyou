import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSearchMetadata } from '../dist/lib/catalog-metadata.js';

function fixture() {
  const oracleDate = '2026-11-02T10:02:00.811+00:00';
  return {
    cards: [
      { id: 'alpha', name: 'Alpha', zhName: '甲', oracle: 'English rules', zhOracle: '中文规则', faces: [{ name: 'Alpha', zhName: '甲', zhOracle: '甲面中文规则' }], versions: [{ id: 'alpha-zh', lang: 'zhs', zhOracle: '中文印刷规则' }] },
      { id: 'beta', name: 'Beta // Back', zhName: '乙 // 背面', faces: [{ name: 'Beta', zhName: '乙' }, { name: 'Back', zhName: '背面' }], tags: ['draw'] }
    ],
    metadata: { schemaVersion: 1, oracleDate, cards: {
      alpha: { edhrecRank: 12, faces: [{ name: 'Alpha', power: '1+*', toughness: '-1' }] },
      beta: { edhrecRank: null, faces: [{ name: 'Beta', power: '0', toughness: '.5' }, { name: 'Back', power: null, toughness: null }] }
    } },
    manifest: { schemaVersion: 1, snapshot: { oracleDate }, counts: { cards: 2 }, searchMetadata: { url: 'search-metadata.json', oracleDate, cards: 2, rankedCards: 1, bytes: 1234 } }
  };
}
function attach({ cards, metadata, manifest }) { return attachSearchMetadata(cards, metadata, manifest); }

test('search metadata creates new cards/faces and retains every existing Chinese and printing field', () => {
  const source = fixture(), before = structuredClone(source);
  const result = attach(source);
  assert.deepEqual(source, before);
  assert.notEqual(result, source.cards); assert.notEqual(result[0], source.cards[0]); assert.notEqual(result[0].faces[0], source.cards[0].faces[0]);
  assert.equal(result[0].versions, source.cards[0].versions); assert.equal(result[1].tags, source.cards[1].tags);
  assert.equal(result[0].edhrecRank, 12); assert.equal(result[1].edhrecRank, null);
  assert.equal(result[0].faces[0].power, '1+*'); assert.equal(result[0].faces[0].toughness, '-1');
  assert.equal(result[0].zhOracle, '中文规则'); assert.equal(result[0].faces[0].zhOracle, '甲面中文规则');
  assert.equal(result[0].versions[0].zhOracle, '中文印刷规则'); assert.equal(result[1].faces[1].power, null);
});

test('all cards must be covered exactly once with no missing, extra, or duplicate identity', () => {
  const changes = [
    state => { delete state.metadata.cards.alpha; },
    state => { state.metadata.cards.extra = structuredClone(state.metadata.cards.alpha); },
    state => { state.metadata.cards.extra = state.metadata.cards.alpha; delete state.metadata.cards.alpha; },
    state => { state.cards[1].id = 'alpha'; },
    state => { state.manifest.searchMetadata.cards = 3; },
    state => { state.manifest.counts.cards = 3; }
  ];
  for (const change of changes) { const state = fixture(); change(state); assert.throws(() => attach(state), /数量|覆盖|重复/); }
});

test('the supported schema and both manifest snapshot dates must match', () => {
  const changes = [
    state => { state.metadata.schemaVersion = 2; },
    state => { state.manifest.schemaVersion = 2; },
    state => { state.metadata.oracleDate = '2026-11-03'; },
    state => { state.manifest.snapshot.oracleDate = '2026-11-03'; },
    state => { state.manifest.searchMetadata.oracleDate = '2026-11-03'; },
    state => { state.metadata.oracleDate = state.manifest.snapshot.oracleDate = state.manifest.searchMetadata.oracleDate = 'not-a-date'; },
    state => { state.manifest.searchMetadata.bytes = 0; },
    state => { state.manifest.searchMetadata.url = ''; }
  ];
  for (const change of changes) { const state = fixture(); change(state); assert.throws(() => attach(state), /格式|日期/); }
});

test('every face must retain the catalog name, order, and count', () => {
  const changes = [
    state => { state.metadata.cards.beta.faces.reverse(); },
    state => { state.metadata.cards.beta.faces.pop(); },
    state => { state.metadata.cards.alpha.faces[0].name = 'different'; },
    state => { state.metadata.cards.alpha.faces = []; }
  ];
  for (const change of changes) { const state = fixture(); change(state); assert.throws(() => attach(state), /牌面/); }
});

test('EDHREC rank must be null or a positive safe integer and its count must match the manifest', () => {
  for (const invalid of [undefined, 0, -1, 1.5, '1', {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const state = fixture(); state.metadata.cards.alpha.edhrecRank = invalid;
    assert.throws(() => attach(state), /EDHREC/);
  }
  for (const invalid of [-1, 0, 2, 3, '1', 1.5]) {
    const state = fixture(); state.manifest.searchMetadata.rankedCards = invalid;
    assert.throws(() => attach(state), /EDHREC/);
  }
});

test('printed characteristic strings and null remain unchanged without coercing expressions', () => {
  for (const value of [null, '*', '*1+*', '1+*', '*+1', '-1', '0', '.5', '2.5', '+2', '1/2', '½', '*²', '∞', '?', 'X', '1d4+1', '2^X', 'Infinity']) {
    const state = fixture(); state.metadata.cards.alpha.faces[0].power = value;
    assert.equal(attach(state)[0].faces[0].power, value);
  }
  for (const value of [undefined, {}, [], 1, true, '', ' ', '3\n', '\u0000', '1'.repeat(65)]) {
    const state = fixture(); state.metadata.cards.alpha.faces[0].toughness = value;
    assert.throws(() => attach(state), /攻击力或防御力/);
  }
});

test('a late invalid entry leaves already-validated cards and the sidecar completely unchanged', () => {
  const state = fixture(); state.cards[0].edhrecRank = 777; state.cards[0].faces[0].power = '9';
  state.metadata.cards.beta.faces[1].toughness = { invalid: true };
  const before = structuredClone(state);
  assert.throws(() => attach(state), /攻击力或防御力/);
  assert.deepEqual(state, before);
});
