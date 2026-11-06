import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildNameRanks } from '../server/catalog-db.js';

export async function readCatalogSource(sourcePath) {
  const directory = resolve(sourcePath);
  const source = await readFile(resolve(directory, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(source);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.shards) || !manifest.counts) throw new Error('卡库清单无效');
  const version = 'catalog-' + createHash('sha256').update('server-schema-3\n' + source).digest('hex').slice(0, 24);
  function inside(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('卡库文件地址无效');
    const path = resolve(directory, filename);
    if (!path.startsWith(directory + sep)) throw new Error('卡库文件必须位于数据目录内');
    return path;
  }
  const metadataBytes = await readFile(inside(manifest.searchMetadata.url));
  if (manifest.searchMetadata.sha256 && createHash('sha256').update(metadataBytes).digest('hex') !== manifest.searchMetadata.sha256) throw new Error('补充数据校验失败');
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  if (metadata.oracleDate !== manifest.snapshot.oracleDate || Object.keys(metadata.cards || {}).length !== manifest.counts.cards) throw new Error('补充数据与卡库不一致');
  const names = [], sets = new Map(), subtypes = new Set();
  for (const shard of manifest.shards) {
    const cards = JSON.parse(await readFile(inside(shard.url), 'utf8'));
    if (!Array.isArray(cards) || cards.length !== shard.count) throw new Error('卡库分片数量不一致');
    for (const card of cards) {
      const extra = metadata.cards[card.id];
      if (!extra || !Array.isArray(extra.faces) || extra.faces.length !== card.faces?.length || extra.faces.some((face, index) => face.name !== card.faces[index].name)) throw new Error('补充数据牌面与卡库不一致');
      names.push({ id: card.id, name: card.name, zhName: card.zhName });
      for (const printing of card.versions || []) if (printing.set && !sets.has(printing.set)) sets.set(printing.set, printing.setName || printing.set);
      for (const face of card.faces || []) for (const line of [face.typeLine, face.zhTypeLine]) {
        const suffix = String(line || '').split(/[—～]/).slice(1).join(' ');
        for (const subtype of suffix.match(/Time Lord|[^\s／/]+/g) || []) subtypes.add(subtype);
      }
    }
  }
  if (names.length !== manifest.counts.cards || new Set(names.map(card => card.id)).size !== names.length) throw new Error('卡库身份数量不一致');
  const nameRanks = buildNameRanks(names);
  const { shards, searchMetadata, ...publicManifest } = manifest;
  const meta = { ...publicManifest, searchMetadata: { oracleDate: searchMetadata.oracleDate, cards: searchMetadata.cards, rankedCards: searchMetadata.rankedCards }, sets: [...sets].sort((a, b) => a[0].localeCompare(b[0])).map(([code, name]) => ({ code, name })), subtypes: [...subtypes].sort((a, b) => a.localeCompare(b, 'zh-CN')) };
  async function* batches() {
    let cardCount = 0;
    for (let shardIndex = 0; shardIndex < manifest.shards.length; shardIndex++) {
      const shard = manifest.shards[shardIndex];
      const cards = JSON.parse(await readFile(inside(shard.url), 'utf8'));
      if (!Array.isArray(cards) || cards.length !== shard.count) throw new Error(`分片 ${shardIndex + 1} 数量不一致`);
      let rows = [], bytes = 0, batchIndex = 0;
      function createBatch(batchCards) {
        const subset = { cards: Object.fromEntries(batchCards.map(card => {
          if (!metadata.cards[card.id]) throw new Error('卡牌缺少检索补充信息');
          return [card.id, metadata.cards[card.id]];
        })) };
        const body = { action: 'batch', version, batchId: `${shardIndex}-${batchIndex++}`, cards: batchCards, metadata: subset, nameRanks: Object.fromEntries(batchCards.map(card => [card.id, nameRanks[card.id]])), meta };
        body.digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        return body;
      }
      for (const card of cards) {
        const rowBytes = Buffer.byteLength(JSON.stringify(card)) + Buffer.byteLength(JSON.stringify(metadata.cards[card.id] || {})) + 100;
        if (rowBytes > 1500000) throw new Error('单张卡牌数据超出导入限制');
        if (rows.length && (rows.length >= 250 || bytes + rowBytes > 1500000)) { yield createBatch(rows); rows = []; bytes = 0; }
        rows.push(card); bytes += rowBytes; cardCount++;
      }
      if (rows.length) yield createBatch(rows);
    }
    if (cardCount !== manifest.counts.cards) throw new Error('卡库总数与清单不一致');
  }
  return { version, manifest, batches, activation: { action: 'activate', version, expectedCards: manifest.counts.cards, expectedFaces: manifest.counts.faces, expectedVersions: manifest.counts.versions, meta } };
}
