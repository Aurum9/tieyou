import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCatalogService, searchGrams } from '../server/catalog-db.js';
import { readCatalogManifest } from '../scripts/catalog-seed.mjs';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { publishLocalCatalog } from '../scripts/publish-local-catalog.mjs';

async function catalog(directory, name, expectedPrintings = 1) {
  const path = join(directory, name);
  await mkdir(path);
  const date = '2026-06-17';
  const card = {
    id: name, name, typeLine: 'Artifact', tags: ['mana-rock'],
    faces: [{ name, typeLine: 'Artifact', oracleText: 'Draw a card.' }],
    versions: [{ id: `${name}-1`, set: 'tst', collectorNumber: '1' }],
  };
  const manifest = {
    schemaVersion: 1, snapshot: { oracleDate: date }, counts: { cards: 1, faces: 1, versions: expectedPrintings },
    shards: [{ url: 'cards.json', count: 1 }], searchMetadata: { url: 'search.json', oracleDate: date, cards: 1, rankedCards: 0 },
    fixture: name,
  };
  await Promise.all([
    writeFile(join(path, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(path, 'search.json'), JSON.stringify({ oracleDate: date, cards: { [name]: { faces: [{ name }] } } })),
    writeFile(join(path, 'cards.json'), JSON.stringify([card])),
  ]);
  const { version } = await readCatalogManifest(path);
  return { path, name, version };
}

test('publication preserves online data across activation failure and prunes only obsolete snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edh-publish-'));
  const databaseFile = join(directory, 'catalog.sqlite');
  const db = openLocalD1(databaseFile);
  try {
    const migrations = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, migrations), 'utf8'));
    }
    await db.exec('CREATE TABLE unrelated_user_data(id TEXT PRIMARY KEY); INSERT INTO unrelated_user_data VALUES (\'keep\');');
    const [first, invalid, second, third] = await Promise.all([
      catalog(directory, 'Amber'), catalog(directory, 'Broken', 2), catalog(directory, 'Quartz'), catalog(directory, 'Jade'),
    ]);
    const service = createCatalogService(db);
    const find = async (fixture, pinned) => (await service.search({ q: `name:${fixture.name}` }, pinned)).cards.map(card => card.id);

    const initial = await publishLocalCatalog(first.path, databaseFile);
    assert.equal(initial.previousVersion, null);
    assert.deepEqual(initial.counts, { cards: 1, faces: 1, versions: 1, indexedCards: 1 });
    assert.deepEqual(await find(first), [first.name]);
    await assert.rejects(publishLocalCatalog(invalid.path, databaseFile), /versions 数量不一致/);
    assert.equal(await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first('active_version'), first.version);
    assert.deepEqual(await find(first), [first.name]);
    assert.deepEqual(await find(invalid), []);

    const next = await publishLocalCatalog(second.path, databaseFile);
    assert.equal(next.previousVersion, first.version);
    assert.deepEqual(next.pruned, [invalid.version]);
    assert.deepEqual(await find(second), [second.name]);
    assert.deepEqual(await find(first, first.version), [first.name]);

    const newest = await publishLocalCatalog(third.path, databaseFile);
    assert.deepEqual(newest.pruned, [first.version]);
    assert.deepEqual(await find(third), [third.name]);
    assert.deepEqual(await find(second, second.version), [second.name]);
    assert.deepEqual(await find(first, first.version), []);
    for (const table of ['catalog_cards', 'catalog_faces', 'catalog_printings', 'catalog_tags', 'catalog_types', 'catalog_batches', 'catalog_snapshots']) {
      assert.equal(await db.prepare(`SELECT count(*) AS total FROM ${table} WHERE version IN (?,?)`).bind(first.version, invalid.version).first('total'), 0, table);
    }
    const gram = searchGrams(first.name).split(' ').find(token => token.startsWith('g'));
    assert.equal(await db.prepare('SELECT count(*) AS total FROM catalog_fts WHERE catalog_fts MATCH ?').bind(`name_grams : ${gram}`).first('total'), 0);
    assert.equal(await db.prepare('SELECT id FROM unrelated_user_data').first('id'), 'keep');

    await rm(join(third.path, 'cards.json'));
    assert.equal((await publishLocalCatalog(third.path, databaseFile)).unchanged, true);
    const lock = new DatabaseSync(`${databaseFile}.catalog-publish-lock.sqlite`);
    try {
      lock.exec('BEGIN IMMEDIATE');
      await assert.rejects(publishLocalCatalog(third.path, databaseFile), /发布任务在运行/);
    } finally {
      lock.close();
    }
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
