import { attachSearchMetadata } from './catalog-metadata.js';
let activeLoad;

export function loadCatalog({ onProgress = () => {}, force = false } = {}) {
  if (force) activeLoad = undefined;
  if (!activeLoad) activeLoad = load(onProgress).catch(error => { activeLoad = undefined; throw error; });
  return activeLoad;
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`卡库资源读取失败（HTTP ${response.status}）`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function load(onProgress) {
  const manifestURL = new URL('../data/manifest.json', import.meta.url);
  onProgress({ phase: 'manifest', loaded: 0, total: 0, cardsLoaded: 0 });
  const manifest = await fetchJSON(manifestURL);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.shards) || !manifest.shards.length) throw new Error('卡库清单格式不受支持');
  const results = new Array(manifest.shards.length);
  const metadataURL = manifest.searchMetadata?.url ? new URL(manifest.searchMetadata.url, manifestURL) : null;
  if (metadataURL && (metadataURL.origin !== manifestURL.origin || !metadataURL.pathname.startsWith(new URL('.', manifestURL).pathname))) throw new Error('检索数据地址无效');
  if (metadataURL) metadataURL.searchParams.set('v', manifest.searchMetadata.sha256 || manifest.updatedAt || '1');
  let cursor = 0, loaded = 0, cardsLoaded = 0;
  async function worker() {
    while (cursor < manifest.shards.length) {
      const index = cursor++;
      const shard = manifest.shards[index];
      const url = new URL(shard.url, manifestURL);
      if (url.origin !== manifestURL.origin || !url.pathname.startsWith(new URL('.', manifestURL).pathname)) throw new Error('卡库分片地址无效');
      url.searchParams.set('v', manifest.updatedAt || '1');
      const rows = await fetchJSON(url);
      if (!Array.isArray(rows) || rows.some(card => !card.id || !card.name || !Array.isArray(card.faces))) throw new Error(`卡库分片 ${index + 1} 格式错误`);
      if (shard.count != null && shard.count !== rows.length) throw new Error(`卡库分片 ${index + 1} 数量不一致`);
      results[index] = rows;
      loaded++; cardsLoaded += rows.length;
      onProgress({ phase: 'cards', loaded, total: manifest.shards.length, cardsLoaded });
    }
  }
  const [metadata] = await Promise.all([metadataURL ? fetchJSON(metadataURL) : null, Promise.all(Array.from({ length: Math.min(3, manifest.shards.length) }, worker))]);
  let cards = results.flat();
  if (new Set(cards.map(card => card.id)).size !== cards.length) throw new Error('卡库存在重复身份，请重新生成数据');
  if (manifest.counts?.cards != null && cards.length !== manifest.counts.cards) throw new Error('卡库总数与清单不一致');
  if (metadata) cards = attachSearchMetadata(cards, metadata, manifest);
  return { cards, manifest };
}
