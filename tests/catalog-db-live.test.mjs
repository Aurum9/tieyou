import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { attachSearchMetadata } from '../web/lib/catalog-metadata.js';
import { searchCards } from '../web/lib/search.js';
import { compileCatalogQuery, createCatalogService } from '../server/catalog-db.js';

// Explicitly enabled after a local full seed: CATALOG_TEST_DB=.local/catalog.sqlite.
const databasePath = process.env.CATALOG_TEST_DB;
let db, service, cards, snapshot;
before(async () => {
  if (!databasePath) return;
  const directory = new URL('../web/data/', import.meta.url), manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const original = [];
  for (const shard of manifest.shards) original.push(...JSON.parse(await readFile(new URL(shard.url, directory), 'utf8')));
  cards = attachSearchMetadata(original, JSON.parse(await readFile(new URL(manifest.searchMetadata.url, directory), 'utf8')), manifest);
  db = openLocalD1(databasePath); service = createCatalogService(db); snapshot = (await service.meta()).datasetVersion;
});
after(() => db?.close());

for (const query of [
  'ci<=ub', 'ci<=g', 'name:阳光戒', 'name:岛', 'o:抓牌', 'o:抓一张牌', 'tag:抓牌', 'tag:反击',
  't:生物 pow>=3 tou>=3', 't:猫', 't:rat', 't:传奇 t:精灵', 'set:m21 r:rare', 'set:lea cn:230',
  '(set:lea OR set:m21) -r:common', 'ci<=ub t:生物 order:edhrec', '-pow>=8 t:地', 'pow>=8 tou<=1',
  'is:translated', 'is:untranslated', 'name:"Who // What"', 'c=无色 ci>=u', 'mv<=.5 order:released',
  'tag:找地 OR (tag:加速 mv<=2)', '-(t:传奇 OR t:基本) mv>=3 mv<=4 order:mv dir:desc',
]) test('full frozen catalog SQL differential: ' + query, { skip: !databasePath }, async t => {
  const expected = searchCards(cards, query, { commanderOnly: true });
  assert.equal(expected.error, null);
  const compiled = compileCatalogQuery(query, { commanderOnly: true }), started = Date.now();
  const found = await db.prepare(`${compiled.prefix} SELECT c.id FROM catalog_cards c CROSS JOIN qp WHERE c.version=? AND ${compiled.predicate} ORDER BY ${compiled.orderBy}`).bind(JSON.stringify(compiled.params), snapshot).all();
  assert.deepEqual(found.results.map(row => row.id), expected.cards.map(card => card.id));
  const result = await service.search({ q: query, commanderOnly: true });
  assert.equal(result.total, expected.total); assert.deepEqual(result.cards.map(card => card.id), expected.cards.slice(0, 48).map(card => card.id));
  if (query === 'ci<=ub') assert.equal(result.total, 12_708);
  if (query === 'ci<=g') assert.equal(result.total, 7_420);
  for (const card of result.cards) {
    const expectedCard = expected.cards.find(row => row.id === card.id);
    if (expectedCard.matchingVersions) assert.deepEqual(card.matchingVersionIds, expectedCard.matchingVersions.map(version => version.id));
  }
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(bytes < 100_000, `48-card response should stay below 100 KB; got ${bytes}`);
  t.diagnostic(JSON.stringify({ query, total: result.total, bytes, sqlAndApiMs: Date.now() - started }));
});
