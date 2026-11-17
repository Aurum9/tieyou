import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { activateCatalogVersion, importCatalogBatch, searchGrams } from '../server/catalog-db.js';
import { readCatalogManifest, readCatalogSource } from './catalog-seed.mjs';
import { openLocalD1 } from './local-d1.mjs';

const pruneChunkSize = 250;
const relatedTables = ['catalog_faces', 'catalog_printings', 'catalog_tags', 'catalog_types'];

function lockPublisher(databaseFile) {
  // Separate SQLite lock so account writes and catalog searches can use the live database.
  const lock = new DatabaseSync(`${databaseFile}.catalog-publish-lock.sqlite`);
  try {
    lock.exec('BEGIN IMMEDIATE');
    return lock;
  } catch (error) {
    lock.close();
    if ([5, 6].includes(error.errcode)) throw new Error('该数据库已有卡库发布任务在运行', { cause: error });
    throw error;
  }
}

async function pruneSnapshot(db, version) {
  const marked = await db.prepare(`
    UPDATE catalog_snapshots SET status='pruning'
    WHERE version=? AND status IN ('loading','retired','pruning')
      AND NOT EXISTS (SELECT 1 FROM catalog_state WHERE active_version=?)
  `).bind(version, version).run();
  if (!marked.meta.changes) return false;

  for (;;) {
    const { results } = await db.prepare(`
      SELECT rowid AS index_row_id, id, name_text, oracle_text, type_text
      FROM catalog_cards WHERE version=? LIMIT ?
    `).bind(version, pruneChunkSize).all();
    if (!results.length) break;
    const cardIds = JSON.stringify(results.map(row => row.id));
    const indexRows = JSON.stringify(results.map(row => ({
      rowId: row.index_row_id,
      name: searchGrams(row.name_text),
      oracle: searchGrams(row.oracle_text),
      type: searchGrams(row.type_text),
    })));
    // Contentless FTS5 needs the same tokens supplied when each row was indexed.
    await db.batch([
      db.prepare(`
        INSERT INTO catalog_fts(catalog_fts,rowid,name_grams,oracle_grams,type_grams)
        SELECT 'delete',json_extract(value,'$.rowId'),json_extract(value,'$.name'),
          json_extract(value,'$.oracle'),json_extract(value,'$.type') FROM json_each(?)
      `).bind(indexRows),
      ...relatedTables.map(table => db.prepare(`
        DELETE FROM ${table} WHERE version=? AND card_id IN (SELECT value FROM json_each(?))
      `).bind(version, cardIds)),
      db.prepare('DELETE FROM catalog_cards WHERE version=? AND id IN (SELECT value FROM json_each(?))').bind(version, cardIds),
    ]);
  }

  await db.batch([
    db.prepare('DELETE FROM catalog_batches WHERE version=?').bind(version),
    db.prepare("DELETE FROM catalog_snapshots WHERE version=? AND status='pruning'").bind(version),
  ]);
  return true;
}

export async function publishLocalCatalog(sourceDirectory, sqliteFile) {
  const databaseFile = await realpath(sqliteFile);
  if (!(await stat(databaseFile)).isFile()) throw new Error('卡库数据库路径必须指向现有 SQLite 文件');
  const lock = lockPublisher(databaseFile);
  try {
    const db = openLocalD1(databaseFile);
    try {
      const { version, manifest } = await readCatalogManifest(sourceDirectory);
      const previousVersion = await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first('active_version');
      const pruned = [];
      if (version === previousVersion) {
        const counts = { ...manifest.counts, indexedCards: manifest.counts.cards };
        return { version, previousVersion, unchanged: true, pruned, counts };
      }

      const source = await readCatalogSource(sourceDirectory);
      if (source.version !== version) throw new Error('卡库清单在发布期间变更');
      const status = await db.prepare('SELECT status FROM catalog_snapshots WHERE version=?').bind(version).first('status');
      // An interrupted cleanup must finish before batch IDs for this version can be reused.
      if (status === 'pruning') await pruneSnapshot(db, version);
      for await (const batch of source.batches()) await importCatalogBatch(db, batch);
      const { counts } = await activateCatalogVersion(db, source.activation);
      const result = { version, previousVersion, unchanged: false, pruned, counts };

      try {
        const { results } = await db.prepare(`
          SELECT version FROM catalog_snapshots
          WHERE version<>? AND version IS NOT ? AND status IN ('loading','retired','pruning')
          ORDER BY version
        `).bind(version, previousVersion).all();
        // Existing requests can finish using the immediately previous release.
        for (const snapshot of results) {
          if (await pruneSnapshot(db, snapshot.version)) pruned.push(snapshot.version);
        }
      } catch (error) {
        result.cleanupError = error.message;
      }
      return result;
    } finally {
      db.close();
    }
  } finally {
    lock.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw new Error('用法：node scripts/publish-local-catalog.mjs <source-dir> <existing-sqlite-file>');
    console.log(JSON.stringify(await publishLocalCatalog(...args)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
