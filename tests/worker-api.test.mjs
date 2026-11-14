import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWorker } from '../server/worker.js';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { importCatalogBatch, activateCatalogVersion } from '../server/catalog-db.js';

let db;
const worker = createWorker({ assets: { '/index.html': { body: '<!doctype html><title>牌库</title>', type: 'text/html; charset=utf-8' } } });
const card = { id: 'test-card', name: 'Test Stone', zhName: '试验石', manaValue: 1, colors: [], colorIdentity: [], typeLine: 'Artifact', zhTypeLine: '神器', oracleText: 'Draw a card.', zhText: '抓一张牌。', legalities: { commander: 'legal' }, faces: [{ name: 'Test Stone', typeLine: 'Artifact', zhTypeLine: '神器', oracleText: 'Draw a card.', zhText: '抓一张牌。' }], versions: [{ id: 'test-print', set: 'tst', collectorNumber: '1', lang: 'en' }] };
function request(path, body, extra = {}) {
  return worker.fetch(new Request('https://cards.test' + path, body == null ? extra : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(extra.headers || {}) }, body: JSON.stringify(body), ...extra }), { DB: db });
}
function signed(body) { return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }; }
const DECK_LIBRARY_ROUTE = '/api/deck-library';
const emptyLibrary = { version: 1, decks: [], trash: [] };

function deckLibraryRequest(visitor, { body, headers = {}, method } = {}) {
  const auth = visitor ? { 'oai-authenticated-user-id': visitor } : {};
  return worker.fetch(new Request('https://cards.test' + DECK_LIBRARY_ROUTE, {
    method: method ?? (body === undefined ? 'GET' : 'PUT'),
    headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { DB: db });
}

function sampleLibrary(name) {
  const timestamp = '2026-11-14T00:00:00.000Z';
  const deck = id => ({ id, name, createdAt: timestamp, updatedAt: timestamp, description: '', customCategories: ['抓牌'], entries: [
    { id: 'entry-1', cardId: card.id, versionId: card.versions[0].id, quantity: 1, zone: 'main', categories: ['抓牌'], notes: '备注' },
  ] });
  return { version: 1, decks: [deck('deck-1')], trash: [{ deck: deck('trash-1'), deletedAt: timestamp }] };
}
before(async () => {
  db = openLocalD1();
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
  await importCatalogBatch(db, { version: 'api-test', batchId: '1', cards: [card], nameRanks: { 'test-card': 0 }, meta: { counts: {}, snapshot: {}, sets: [], subtypes: [] } });
  await activateCatalogVersion(db, { version: 'api-test', expectedCards: 1, expectedFaces: 1, expectedVersions: 1 });
});
after(() => db.close());

test('worker serves the frontend without exposing bulk card assets', async () => {
  const home = await request('/');
  assert.equal(home.status, 200); assert.match(home.headers.get('Content-Type'), /text\/html/);
  assert.match(await home.text(), /牌库/);
  for (const path of ['/data/catalog-000.json', '/data/search-metadata.json', '/data/manifest.json']) assert.equal((await request(path)).status, 404);
  assert.equal((await request('/', null, { method: 'DELETE' })).status, 405);
});
test('worker returns bounded search results and full detail at separate endpoints', async () => {
  const search = await request('/api/catalog/search', { query: 'name:试验', limit: 1 });
  assert.equal(search.status, 200);
  const found = await search.json(); assert.equal(found.total, 1); assert.equal(found.cards[0].id, card.id); assert.equal(found.cards[0].versionsComplete, false);
  const detail = await (await request('/api/catalog/cards/test-card')).json();
  assert.equal(detail.card.id, card.id); assert.equal(detail.card.versionsComplete, true);
  assert.equal((await request('/api/catalog/cards/missing')).status, 404);
  const batch = await (await request('/api/catalog/cards', { ids: ['test-card', 'missing'] })).json();
  assert.equal(batch.cards.length, 1);
});
test('worker rejects invalid pagination, identity and oversized card batches', async () => {
  for (const body of [{ limit: 101 }, { offset: -1 }, { limit: 1.5 }]) assert.equal((await request('/api/catalog/search', body)).status, 400);
  assert.equal((await request('/api/catalog/suggest', { query: '石', colorIdentity: ['X'] })).status, 400);
  assert.equal((await request('/api/catalog/cards', { ids: Array(501).fill('test-card') })).status, 400);
});
test('worker returns a retryable card-catalog error when D1 is overloaded', async t => {
  t.mock.method(console, 'error', () => {});
  const DB = { prepare() { throw new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'); } };
  const response = await worker.fetch(new Request('https://cards.test/api/catalog/suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'flubs' }),
  }), { DB });
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).error, { code: 'CATALOG_BUSY', message: '卡库暂时繁忙，请重试' });
});
test('maintenance rejects cross-origin, invalid JSON and oversized payloads', async () => {
  const body = { action: 'batch', version: 'blocked' };
  assert.equal((await request('/api/catalog/import', body, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.test' } })).status, 403);
  assert.equal((await request('/api/catalog/import', body, { headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const plain = new Request('https://cards.test/api/catalog/import', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal((await worker.fetch(plain, { DB: db })).status, 415);
  const malformed = new Request('https://cards.test/api/catalog/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await worker.fetch(malformed, { DB: db })).status, 400);
  const large = new Request('https://cards.test/api/catalog/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(2 * 1024 * 1024) }) });
  assert.equal((await worker.fetch(large, { DB: db })).status, 413);
});
test('maintenance validates digests, is retry safe and activates only a complete snapshot', async () => {
  const body = { action: 'batch', version: 'api-next', batchId: '0', cards: [card], nameRanks: { 'test-card': 0 }, meta: { sets: [], subtypes: [] } };
  assert.equal((await request('/api/catalog/import', { ...signed(body), digest: '0'.repeat(64) })).status, 400);
  const first = await request('/api/catalog/import', signed(body)); assert.equal(first.status, 200); assert.equal((await first.json()).imported, true);
  const retry = await request('/api/catalog/import', signed(body)); assert.equal(retry.status, 200); assert.equal((await retry.json()).imported, false);
  const failed = await request('/api/catalog/import', { action: 'activate', version: 'api-next', expectedCards: 2, expectedFaces: 1, expectedVersions: 1 });
  assert.equal(failed.status, 400);
  assert.equal((await (await request('/api/catalog/meta')).json()).datasetVersion, 'api-test');
  assert.equal((await request('/api/catalog/import', { action: 'activate', version: 'api-next', expectedCards: 1, expectedFaces: 1, expectedVersions: 1 })).status, 200);
  assert.equal((await (await request('/api/catalog/meta')).json()).datasetVersion, 'api-next');
});

test('deck libraries derive their account from the authenticated visitor and isolate another account', async () => {
  const noVisitor = await deckLibraryRequest(null, { headers: { 'OAI-Sites-Authorization': 'Bearer example' } });
  assert.equal(noVisitor.status, 401);
  assert.equal((await noVisitor.json()).error.code, 'SIGN_IN_REQUIRED');

  const visitor = 'isolated-visitor-one';
  const response = await deckLibraryRequest(visitor);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  const initial = await response.json();
  assert.deepEqual(initial, { account: createHash('sha256').update(visitor).digest('hex'), revision: 0, library: emptyLibrary });

  const ownLibrary = sampleLibrary('第一位访客的套牌');
  const save = await deckLibraryRequest(visitor, { body: { ...initial, library: ownLibrary } });
  assert.equal(save.status, 200);
  assert.deepEqual(await save.json(), { ...initial, revision: 1, library: ownLibrary });

  const otherVisitor = 'isolated-visitor-two';
  const other = await (await deckLibraryRequest(otherVisitor)).json();
  assert.deepEqual(other, { account: createHash('sha256').update(otherVisitor).digest('hex'), revision: 0, library: emptyLibrary });
  const wrongAccount = await deckLibraryRequest(otherVisitor, { body: { ...initial, revision: 1, library: sampleLibrary('越权写入') } });
  assert.equal(wrongAccount.status, 409);
  assert.deepEqual(await wrongAccount.json(), { error: { code: 'ACCOUNT_CHANGED', message: '登录账户已切换，请重新同步' } });
  assert.deepEqual(await (await deckLibraryRequest(visitor)).json(), { ...initial, revision: 1, library: ownLibrary });
  assert.deepEqual(await (await deckLibraryRequest(otherVisitor)).json(), other);
});

test('deck library compare-and-swap accepts one writer for each revision and returns the winner to the loser', async () => {
  const visitor = 'concurrent-visitor';
  const { account } = await (await deckLibraryRequest(visitor)).json();
  for (const revision of [0, 1]) {
    const writers = ['甲', '乙'].map(name => ({ account, revision, library: sampleLibrary(`${name}的套牌 ${revision}`) }));
    const results = await Promise.all(writers.map(body => deckLibraryRequest(visitor, { body })));
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    const winnerIndex = results.findIndex(response => response.status === 200);
    const committed = { ...writers[winnerIndex], revision: revision + 1 };
    assert.deepEqual(await results[winnerIndex].json(), committed);
    assert.deepEqual(await results[1 - winnerIndex].json(), { ...committed, error: { code: 'REVISION_CONFLICT', message: '云端卡组已更新' } });
    assert.deepEqual(await (await deckLibraryRequest(visitor)).json(), committed);
  }
});

test('deck library rejects cross-origin writes, invalid snapshots and bodies exceeding 1.5 MiB', async () => {
  const visitor = 'validation-visitor';
  const initial = await (await deckLibraryRequest(visitor)).json();
  for (const headers of [{ Origin: 'https://other.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await deckLibraryRequest(visitor, { body: initial, headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CROSS_ORIGIN');
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER, null]) {
    const response = await deckLibraryRequest(visitor, { body: { ...initial, revision } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_PARAMETER');
  }
  const invalid = sampleLibrary('重复卡组 ID');
  invalid.trash[0].deck.id = invalid.decks[0].id;
  const malformed = await deckLibraryRequest(visitor, { body: { ...initial, library: invalid } });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_DECK_LIBRARY');

  const oversized = await deckLibraryRequest(visitor, { body: { ...initial, padding: '大'.repeat(512 * 1024) } });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'BODY_TOO_LARGE');
  assert.deepEqual(await (await deckLibraryRequest(visitor)).json(), initial);
});
