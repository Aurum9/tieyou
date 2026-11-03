import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeckStore, STORAGE_KEY, createDeck, newId, defaultVersion, parseDeckText, exportDeckText, exportDeckBackup, parseDeckBackup, validateDeck, findCardCandidates, getCommanderIdentity } from '../dist/lib/decks.js';

function memoryStorage() {
  const values = new Map();
  return { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); values.set(key, value); } };
}
function card(id, name, extra = {}) {
  return { id, name, zhName: `中${name}`, aliases: [], typeLine: 'Artifact', oracleText: '', colorIdentity: [], legalities: { commander: 'legal' }, versions: [{ id: `${id}-v1`, set: 'abc', collectorNumber: id, lang: 'en' }, { id: `${id}-v2`, set: 'xyz', collectorNumber: id, lang: 'zhs' }], ...extra };
}
const commander = card('leader', 'Leaf Commander', { zhName: '森林统帅', typeLine: 'Legendary Creature — Elf', colorIdentity: ['G'] });
const ring = card('ring', 'Sol Ring', { zhName: '阳光戒' });
const forest = card('forest', 'Forest', { zhName: '树林', typeLine: 'Basic Land — Forest', colorIdentity: ['G'] });
const blue = card('blue', 'Blue Spell', { colorIdentity: ['U'], typeLine: 'Instant' });
const banned = card('banned', 'Banned Card', { legalities: { commander: 'banned' } });
const multi = card('multi', 'Front // Back', { zhName: '正面 // 背面', faces: [{ name: 'Front', zhName: '正面', typeLine: 'Legendary Creature — Human', oracleText: '' }, { name: 'Back', zhName: '背面', typeLine: 'Land', oracleText: '' }], typeLine: 'Legendary Creature // Land', colorIdentity: ['G'] });
const rats = card('rats', 'Many Rats', { oracleText: 'A deck can have any number of cards named Many Rats.' });
const nine = card('nine', 'Nine Things', { oracleText: 'A deck can have up to nine cards named Nine Things.' });
const cards = [commander, ring, forest, blue, banned, multi, rats, nine];
function entry(card, { quantity = 1, zone = 'main', versionId = card.versions[0].id, ...rest } = {}) { return { id: newId(), cardId: card.id, versionId, quantity, zone, categories: [], notes: '', ...rest }; }
function deck(entries) { return { ...createDeck('测试卡组'), entries }; }

test('commander search distinguishes unset, colorless and combined commander identities', () => {
  assert.equal(getCommanderIdentity(deck([entry(commander)]), cards), null);
  assert.deepEqual(getCommanderIdentity(deck([entry(ring, { zone: 'commander' })]), cards), []);
  const pair = deck([entry(commander, { zone: 'commander' }), entry(blue, { zone: 'commander' }), entry(banned, { zone: 'considering' })]);
  assert.deepEqual(getCommanderIdentity(pair, cards), ['U', 'G']);
  assert.equal(getCommanderIdentity(deck([entry(commander, { zone: 'commander', cardId: 'unknown' })]), cards), null);
});

test('commander search allows colorless identities and can be disabled without changing the deck', () => {
  const original = deck([entry(commander, { zone: 'commander' })]);
  const before = JSON.stringify(original);
  const identity = getCommanderIdentity(original, cards);
  const coloredIdentity = card('devoid', 'Devoid Match', { colorIdentity: ['U'], colors: [] });
  const pool = [ring, blue, forest, coloredIdentity];
  assert.deepEqual(findCardCandidates('Sol Ring', pool, { colorIdentity: identity }).map(row => row.id), ['ring']);
  assert.deepEqual(findCardCandidates('Blue Spell', pool, { colorIdentity: identity }), []);
  assert.deepEqual(findCardCandidates('Devoid Match', pool, { colorIdentity: identity }), []);
  assert.deepEqual(findCardCandidates('Blue Spell', pool, { colorIdentity: null }).map(row => row.id), ['blue']);
  assert.deepEqual(findCardCandidates('Forest', pool, { colorIdentity: [] }), []);
  assert.deepEqual(findCardCandidates('Sol Ring', pool, { colorIdentity: [] }).map(row => row.id), ['ring']);
  assert.equal(JSON.stringify(original), before);
});

test('commander search filters before the fifty-candidate limit and preserves printing lookup', () => {
  const forbidden = Array.from({ length: 60 }, (_, n) => card(`blue-${n}`, `Shared Name ${n}`, { colorIdentity: ['U'] }));
  const allowed = card('allowed', 'Shared Name Eligible', { colorIdentity: ['G'] });
  const pool = [...forbidden, allowed];
  assert.equal(findCardCandidates('Shared Name', pool).length, 50);
  assert.deepEqual(findCardCandidates('Shared Name', pool, { colorIdentity: ['G'] }).map(row => row.id), ['allowed']);
  assert.deepEqual(findCardCandidates('xyz allowed', pool, { colorIdentity: ['G'] }).map(row => row.id), ['allowed']);
  assert.deepEqual(findCardCandidates('xyz allowed', pool, { colorIdentity: [] }), []);
  assert.deepEqual(findCardCandidates('Shared Name 0', pool, { exact: true }).map(row => row.id), ['blue-0']);
});

test('successful writes survive a new store and never persist full card records', () => {
  const storage = memoryStorage(); const first = new DeckStore({ storage }); const created = first.create('精灵');
  first.addCard(created.id, commander, commander.versions[0].id, 'commander');
  first.addCard(created.id, forest, forest.versions[0].id, 'main', 30);
  const loaded = new DeckStore({ storage }); assert.deepEqual(loaded.get(created.id), first.get(created.id));
  assert.equal(loaded.status.state, 'saved'); assert.equal(storage.getItem(STORAGE_KEY).includes('oracleText'), false);
});

test('default printing matches the visible representative card instead of arbitrary version order', () => {
  assert.equal(defaultVersion({ ...ring, defaultVersionId: 'ring-v2' }), 'ring-v2');
  assert.equal(defaultVersion({ ...ring, defaultVersionId: 'unknown', set: 'xyz', collectorNumber: 'ring', lang: 'zhs' }), 'ring-v2');
  assert.equal(defaultVersion({ ...ring, defaultVersionId: 'unknown' }), 'ring-v1');
});

test('storage failures cannot report saved or mutate the last durable state', () => {
  const storage = memoryStorage(); const store = new DeckStore({ storage }); const created = store.create('保留');
  const before = storage.getItem(STORAGE_KEY); storage.fail = true;
  assert.throws(() => store.addCard(created.id, ring), /保存失败/);
  assert.equal(store.status.state, 'error'); assert.equal(store.get(created.id).entries.length, 0); assert.equal(storage.getItem(STORAGE_KEY), before);
  storage.fail = false; store.addCard(created.id, ring); assert.equal(store.status.state, 'saved');
});

test('corrupted local data is reported without being overwritten on load', () => {
  const storage = memoryStorage(); storage.setItem(STORAGE_KEY, '{broken'); const store = new DeckStore({ storage });
  assert.equal(store.status.state, 'error'); assert.deepEqual(store.list(), []); assert.equal(storage.getItem(STORAGE_KEY), '{broken');
  assert.throws(() => store.create('不能覆盖'), /暂停写入/); assert.equal(storage.getItem(STORAGE_KEY), '{broken');
  const recoveryKey = store.rebuildAfterCorruption(); assert.equal(storage.getItem(recoveryKey), '{broken');
  store.create('重建后'); assert.equal(store.list().length, 1);
});

test('copy IDs are independent, deleted decks are restorable', () => {
  const store = new DeckStore({ storage: memoryStorage() }); const original = store.create('A'); store.addCard(original.id, ring);
  const copy = store.copy(original.id); assert.notEqual(copy.id, original.id); assert.notEqual(copy.entries[0].id, store.get(original.id).entries[0].id);
  copy.entries[0].quantity = 3; store.save(copy); assert.equal(store.get(original.id).entries[0].quantity, 1);
  store.remove(original.id); assert.equal(store.get(original.id), null); assert.equal(store.deleted().length, 1);
  store.restore(original.id); assert.equal(store.get(original.id).entries.length, 1); assert.equal(store.deleted().length, 0);
});

test('invalid quantities never enter durable state', () => {
  const store = new DeckStore({ storage: memoryStorage() }); const created = store.create('A');
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 1000, '2']) assert.throws(() => store.addCard(created.id, ring, undefined, 'main', quantity), /数量/);
  store.addCard(created.id, ring, undefined, 'main', 999);
  assert.throws(() => store.addCard(created.id, ring), /数量/); assert.equal(store.get(created.id).entries[0].quantity, 999);
});

test('JSON backup is lossless, restores safely as a new independent deck', () => {
  const original = deck([entry(commander, { zone: 'commander' }), entry(ring, { versionId: 'ring-v2', categories: ['加速', '核心'], notes: '一份备注\n第二行' }), entry(blue, { zone: 'considering' })]);
  original.description = '说明'; const text = exportDeckBackup([original]);
  assert.deepEqual(parseDeckBackup(text, cards).decks, [original]);
  const store = new DeckStore({ storage: memoryStorage() }); const existing = store.create('保留');
  const [restored] = store.importBackup(text, { cards });
  assert.notEqual(restored.id, original.id); assert.notEqual(restored.entries[0].id, original.entries[0].id);
  assert.deepEqual(restored.entries.map(({ id, ...entry }) => entry), original.entries.map(({ id, ...entry }) => entry));
  assert.equal(restored.description, original.description); assert.ok(store.get(existing.id));
});

test('a bad record in a multi-deck backup prevents all imports atomically', () => {
  const storage = memoryStorage(); const store = new DeckStore({ storage }); const existing = store.create('保留'); const before = storage.getItem(STORAGE_KEY);
  const good = deck([entry(ring)]); const bad = deck([entry(forest)]); bad.entries[0].quantity = 0;
  const text = JSON.stringify({ format: 'edh-deck-library', version: 1, decks: [good, bad] });
  assert.throws(() => store.importBackup(text, { cards }), /数量/); assert.equal(storage.getItem(STORAGE_KEY), before); assert.deepEqual(store.list(), [existing]);
  assert.throws(() => store.importBackup('{broken', { cards }), /JSON/); assert.deepEqual(store.list(), [existing]);
});

test('missing identity, mismatched printing and unsupported backup versions are explicit errors', () => {
  for (const change of [entry(ring, { cardId: 'unknown' }), entry(ring, { versionId: forest.versions[0].id })]) {
    const text = exportDeckBackup([deck([change])]); assert.throws(() => parseDeckBackup(text, cards), /缺失/);
  }
  assert.throws(() => parseDeckBackup('{"format":"edh-deck-library","version":2,"decks":[]}'), /不支持/);
});

test('backup persistence failure leaves existing library intact', () => {
  const storage = memoryStorage(); const store = new DeckStore({ storage }); const original = store.create('原卡组'); const before = storage.getItem(STORAGE_KEY); storage.fail = true;
  assert.throws(() => store.importBackup(exportDeckBackup([deck([entry(ring)])]), { cards }), /保存失败/);
  assert.equal(storage.getItem(STORAGE_KEY), before); assert.deepEqual(store.list(), [original]);
});

test('text import resolves Chinese/English names, zones and printing; export reimports them', () => {
  const parsed = parseDeckText('[Commander]\n1 森林统帅\n[Main]\n1 Sol Ring (XYZ) ring\n36x 树林\n[Considering]\n1 背面', cards);
  assert.equal(parsed.errors.length, 0); assert.deepEqual(parsed.entries.map(item => [item.cardId, item.zone, item.quantity]), [['leader', 'commander', 1], ['ring', 'main', 1], ['forest', 'main', 36], ['multi', 'considering', 1]]);
  assert.equal(parsed.entries[1].versionId, 'ring-v2');
  const roundtrip = parseDeckText(exportDeckText(deck(parsed.entries), cards), cards);
  assert.equal(roundtrip.errors.length, 0);
  assert.deepEqual(roundtrip.entries.map(({ id, ...entry }) => entry), parsed.entries.map(({ id, ...entry }) => entry));
});

test('text parsing preserves source line numbers and never silently skips unresolved lines', () => {
  const parsed = parseDeckText('# 备注\n\n0 Sol Ring\n1 Unknown Card\n1 Sol Ring (NOPE) 9\n1.5 Forest\n2 森林统帅', cards);
  assert.deepEqual(parsed.errors.map(row => [row.line, row.status]), [[3, 'error'], [4, 'unknown'], [5, 'version-missing'], [6, 'error']]);
  assert.equal(parsed.entries.length, 1); assert.equal(parsed.entries[0].quantity, 2);
  const ambiguous = [...cards, card('other-ring', 'Other Name', { zhName: ring.zhName })];
  assert.equal(parseDeckText('1 阳光戒', ambiguous).rows[0].status, 'ambiguous');
});

test('lookup supports face names and explicit set/collector number without treating faces as separate entities', () => {
  assert.deepEqual(findCardCandidates('背面', cards).map(card => card.id), ['multi']);
  assert.deepEqual(findCardCandidates('xyz ring', cards).map(card => card.id), ['ring']);
  const result = validateDeck(deck([entry(multi), entry(forest, { quantity: 99 })]), cards);
  assert.equal(result.count, 100); assert.equal(result.issues.some(issue => issue.code === 'duplicate'), false);
});

test('singleton checks combine different printings and commander/main sections', () => {
  const result = validateDeck(deck([entry(commander, { zone: 'commander' }), entry(commander, { versionId: 'leader-v2' }), entry(ring), entry(ring, { versionId: 'ring-v2' })]), cards);
  const duplicateIssues = result.issues.filter(issue => issue.code === 'duplicate'); assert.equal(duplicateIssues.length, 2);
  assert.equal(duplicateIssues[0].entryIds.length, 2);
});

test('repeat exceptions apply to basic lands, any number cards, and numeric caps', () => {
  const result = validateDeck(deck([entry(commander, { zone: 'commander' }), entry(forest, { quantity: 70 }), entry(rats, { quantity: 20 }), entry(nine, { quantity: 10 })]), cards);
  const duplicates = result.issues.filter(issue => issue.code === 'duplicate'); assert.equal(duplicates.length, 1); assert.match(duplicates[0].message, /9 张/);
});

test('candidate cards are excluded; color identity and legality are checked against selected commanders', () => {
  const result = validateDeck(deck([entry(commander, { zone: 'commander' }), entry(forest, { quantity: 98 }), entry(banned), entry(blue, { zone: 'considering', quantity: 20 })]), cards);
  assert.equal(result.count, 100); assert.equal(result.consideringCount, 20); assert.equal(result.issues.some(issue => issue.code === 'color-identity'), false);
  assert.equal(result.issues.some(issue => issue.code === 'banned'), true);
  const offColor = validateDeck(deck([entry(commander, { zone: 'commander' }), entry(blue)]), cards); assert.equal(offColor.issues.some(issue => issue.code === 'color-identity'), true);
});

test('multi-commander combinations and unknown ordinary eligibility remain unverified', () => {
  const result = validateDeck(deck([entry(commander, { zone: 'commander' }), entry(blue, { zone: 'commander' }), entry(forest, { quantity: 98 })]), cards);
  assert.deepEqual(result.colorIdentity, ['G', 'U']);
  assert.equal(result.issues.some(issue => issue.code === 'commander-combination'), true);
  assert.equal(result.issues.some(issue => issue.code === 'commander-eligibility'), true);
  assert.equal(result.status, 'basic-checks-only');
});

test('real frozen card snapshot supports 100-card validation and complete JSON/text roundtrips', () => {
  const dataDir = new URL('../dist/data/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dataDir), 'utf8'));
  const snapshot = manifest.shards.flatMap(shard => JSON.parse(readFileSync(new URL(shard.url, dataDir), 'utf8')));
  const leader = snapshot.find(card => /Legendary.*Creature/.test(card.typeLine) && card.legalities.commander === 'legal' && card.colorIdentity.includes('G'));
  const land = snapshot.find(card => card.name === 'Forest');
  const artifact = snapshot.find(card => card.name === 'Sol Ring');
  assert.ok(leader && land && artifact, 'required real snapshot fixtures exist');
  const original = deck([entry(leader, { zone: 'commander' }), entry(land, { quantity: 98 }), entry(artifact)]);
  const stats = validateDeck(original, snapshot); assert.equal(stats.count, 100); assert.equal(stats.issues.length, 0);
  assert.deepEqual(parseDeckBackup(exportDeckBackup([original]), snapshot).decks, [original]);
  const textRoundtrip = parseDeckText(exportDeckText(original, snapshot), snapshot);
  assert.equal(textRoundtrip.errors.length, 0);
  assert.deepEqual(textRoundtrip.entries.map(({ id, ...item }) => item), original.entries.map(({ id, ...item }) => item));
});
