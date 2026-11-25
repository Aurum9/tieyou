import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posterData, flowPosterRows } from '../web/lib/deck-poster-model.js';
import { createPosterStore, validatePosterPNG, readLimitedBody } from '../scripts/deck-poster-store.mjs';
import { pngFixture } from './helpers/poster-png.mjs';

test('poster uses actual title, notes and commanders, merges main printings, and excludes private candidates', () => {
  const cards = [{ id: 'a', name: 'A', typeLine: 'Artifact', manaValue: 1 }, { id: 'b', name: 'B', typeLine: 'Legendary Creature — Human', manaValue: 2 }];
  const deck = { name: '牌表', description: '备注', entries: [{ cardId: 'a', quantity: 2, zone: 'main' }, { cardId: 'a', quantity: 3, zone: 'main' }, { cardId: 'b', quantity: 1, zone: 'commander' }, { cardId: 'b', quantity: 99, zone: 'considering' }] };
  const result = posterData(deck, cards);
  assert.equal(result.title, '牌表'); assert.equal(result.description, '备注'); assert.equal(result.commanders.length, 1);
  assert.deepEqual(result.rows.filter(row => row.kind === 'card').map(row => row.quantity), [5]);
  assert.throws(() => posterData(deck, []), /未载入/);
});
test('poster flow preserves every card and reserves the shorter final column for QR', () => {
  const heading = { kind: 'header', name: '生物' }, rows = [heading, ...Array.from({ length: 77 }, (_, i) => ({ kind: 'card', name: String(i), heading }))];
  const columns = flowPosterRows(rows, [30, 30, 23]);
  assert.ok(columns); assert.ok(columns[2].length <= 23);
  assert.deepEqual(columns.flat().filter(row => row.kind === 'card').map(row => row.name), rows.slice(1).map(row => row.name));
  assert.ok(columns.every(column => column.at(-1)?.kind !== 'header'));
  assert.equal(flowPosterRows(rows, [5, 5, 5]), null);
});
test('poster PNG storage checks dimensions, rejects broken images, and keeps opaque token paths', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tieyou-poster-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const store = createPosterStore(folder), token = 'x'.repeat(32), bytes = pngFixture();
  validatePosterPNG(bytes); assert.throws(() => validatePosterPNG(bytes.subarray(0, 80)), /不完整/);
  assert.throws(() => validatePosterPNG(pngFixture(100, 100)), /尺寸/);
  await store.save(token, bytes); assert.deepEqual(await store.read(token), bytes);
  await assert.rejects(store.read('../secret'), /链接/);
  await store.remove(token); assert.equal(await store.read(token), null);
  await assert.rejects(store.cardImage('https://127.0.0.1/private', 'art'), /来源/);
  await assert.rejects(store.cardImage('https://cards.scryfall.io@127.0.0.1/private', 'art'), /来源/);
  await assert.rejects(readLimitedBody(new Request('https://example.test', { method: 'POST', body: bytes }), 10), /过大/);
});
