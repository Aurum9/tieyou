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
