import { clientHeaders } from './client-usage.js';
import { showClientUpgrade } from './client-upgrade.js';
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

function waitForRetry(delay, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Same-origin card service. The browser caches only cards that it has requested. */
export function createRemoteCatalog({ fetcher = globalThis.fetch, baseURL = '/api/catalog', offlineStorage } = {}) {
  const cache = new Map(), levels = new Map(), details = new Map();
  let metadataPromise;

  function canUseOffline(error) {
    return offlineStorage && (error.code === 'CATALOG_NETWORK' || RETRYABLE_STATUSES.has(error.status));
  }
  const cardKey = id => 'card:' + id;

  async function saveOfflineCards(cards) {
    if (offlineStorage && cards.length) {
      await offlineStorage.write(cards.map(card => [cardKey(card.id), card])).catch(() => {});
    }
  }

  function remember(card, level = 0) {
    if (!card || typeof card.id !== 'string') throw new Error('卡牌服务返回的数据格式不正确');
    const previous = cache.get(card.id);
    const versions = new Map((previous?.versions || []).map(version => [version.id, version]));
    for (const version of card.versions || []) versions.set(version.id, { ...versions.get(version.id), ...version });
    const merged = { ...previous, ...card, versions: [...versions.values()], versionsComplete: Boolean(previous?.versionsComplete || card.versionsComplete) };
    if (card.faces) merged.faces = card.faces.map((face, index) => ({ ...previous?.faces?.[index], ...face }));
    // A printing matched by one search must not become the default for later deck operations.
    delete merged.matchingVersions;
    delete merged.matchingVersionIds;
    // Prices can reflect printing filters from this search only.
    delete merged.usdPrice;
    delete merged.cnyPrice;
    cache.set(card.id, merged);
    levels.set(card.id, Math.max(levels.get(card.id) || 0, level));
    return { ...merged, ...(card.matchingVersions ? { matchingVersions: card.matchingVersions } : {}), ...(card.matchingVersionIds ? { matchingVersionIds: card.matchingVersionIds } : {}),
      ...(Object.hasOwn(card, 'usdPrice') ? { usdPrice: card.usdPrice } : {}),
      ...(Object.hasOwn(card, 'cnyPrice') ? { cnyPrice: card.cnyPrice } : {}),
    };
  }
  function rememberList(cards, level = 0) {
    if (!Array.isArray(cards)) throw new Error('卡牌服务返回的数据格式不正确');
    return cards.map(card => remember(card, level));
  }
  async function request(path, { body, signal } = {}) {
    signal?.throwIfAborted();
    let response;
    try {
      const requestSignal = signal || (offlineStorage ? AbortSignal.timeout(10000) : undefined);
      response = await fetcher(baseURL + path, { method: body === undefined ? 'GET' : 'POST', headers: clientHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(requestSignal ? { signal: requestSignal } : {}) });
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      const networkError = new Error('卡牌服务暂时无法连接，请重试。', { cause: error });
      networkError.code = 'CATALOG_NETWORK';
      throw networkError;
    }
    let payload;
    try { payload = await response.json(); }
    catch (error) {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      const invalidResponse = new Error('卡牌服务返回的数据无法读取，请重试。', { cause: error });
      invalidResponse.status = response.status;
      throw invalidResponse;
    }
    signal?.throwIfAborted();
    if (!response.ok || payload?.error) {
      const info = payload?.error;
      const error = new Error((typeof info === 'string' ? info : info?.message) || `卡牌服务请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.code = info?.code ?? (response.ok && path === '/search' ? 'INVALID_QUERY' : undefined);
      error.position = info?.position ?? info?.rawPosition;
      if (error.code === 'CLIENT_UPGRADE_REQUIRED') showClientUpgrade();
      throw error;
    }
    return payload;
  }
  async function requestLookup(path, options) {
    try {
      return await request(path, options);
    } catch (error) {
      if (error.code !== 'CATALOG_NETWORK' && !RETRYABLE_STATUSES.has(error.status)) throw error;
      const delay = error.code === 'CATALOG_BUSY' ? 1600 + Math.random() * 400 : 350;
      await waitForRetry(delay, options.signal);
      return request(path, options);
    }
  }
  function meta() {
    if (offlineStorage) {
      if (!metadataPromise) metadataPromise = request('/meta').then(async data => {
        await offlineStorage.write([['meta', data]]).catch(() => {});
        return data;
      }).catch(async error => {
        metadataPromise = undefined;
        if (!canUseOffline(error)) throw error;
        const [cached] = await offlineStorage.read(['meta']).catch(() => []);
        if (!cached) throw error;
        return cached;
      });
      return metadataPromise;
    }
    metadataPromise ||= request('/meta').catch(error => { metadataPromise = undefined; throw error; });
    return metadataPromise;
  }
  async function search({ query = '', sort = 'name', commanderOnly = true, offset = 0, limit = 48, signal } = {}) {
    const result = await requestLookup('/search', { body: { query, sort, commanderOnly, offset, limit }, signal });
    return { ...result, cards: rememberList(result.cards) };
  }
  async function getCards(ids, { versions = [], signal, allowMissing = false } = {}) {
    const wanted = [...new Set(ids || [])];
    const wantedSet = new Set(wanted), selected = new Map();
    for (const item of versions) {
      if (!wantedSet.has(item.cardId)) continue;
      const choices = selected.get(item.cardId) || new Map(); choices.set(item.versionId, item); selected.set(item.cardId, choices);
    }
    const missing = wanted.filter(id => (levels.get(id) || 0) < 1 || [...(selected.get(id)?.keys() || [])].some(versionId => !cache.get(id).versions.some(version => version.id === versionId)));
    let batchIds = [], batchVersions = [];
    const sendBatch = async () => {
      if (!batchIds.length) return;
      try {
        const result = await request('/cards', { body: { ids: batchIds, versions: batchVersions }, signal });
        rememberList(result.cards, 1);
      } catch (error) {
        if (!canUseOffline(error)) throw error;
        const saved = await offlineStorage.read(batchIds.map(cardKey)).catch(() => []);
        signal?.throwIfAborted();
        rememberList(saved.filter(card => card && (levels.get(card.id) || 0) < 2), 1);
      }
      batchIds = [];
      batchVersions = [];
    };
    for (const id of missing) {
      const choices = [...(selected.get(id)?.values() || [])];
      if (choices.length > 500) {
        await sendBatch();
        for (let start = 0; start < choices.length; start += 500) {
          batchIds = [id]; batchVersions = choices.slice(start, start + 500); await sendBatch();
        }
      } else {
        if (batchIds.length === 500 || batchVersions.length + choices.length > 500) await sendBatch();
        batchIds.push(id); batchVersions.push(...choices);
      }
    }
    await sendBatch();
    await saveOfflineCards(wanted.filter(id => (levels.get(id) || 0) >= 1).map(id => cache.get(id)));
    if (allowMissing) return wanted.flatMap(id => cache.has(id) ? [cache.get(id)] : []);
    const missingIds = wanted.filter(id => !cache.has(id) || (levels.get(id) || 0) < 1);
    if (missingIds.length) {
      const error = new Error('卡库中未找到卡牌：' + missingIds.slice(0, 3).join('、') + (missingIds.length > 3 ? ` 等 ${missingIds.length} 张` : ''));
      error.code = 'CARD_NOT_FOUND'; error.missingIds = missingIds; throw error;
    }
    const missingVersions = [...selected.values()].flatMap(choices => [...choices.values()]).filter(item => !cache.get(item.cardId).versions.some(version => version.id === item.versionId));
    if (missingVersions.length) {
      const labels = missingVersions.slice(0, 3).map(item => (cache.get(item.cardId).zhName || cache.get(item.cardId).name || item.cardId) + ' / ' + item.versionId);
      const error = new Error('卡库中未找到所选印刷版本：' + labels.join('、') + (missingVersions.length > 3 ? ` 等 ${missingVersions.length} 个` : ''));
      error.code = 'VERSION_NOT_FOUND'; error.missingVersions = missingVersions; throw error;
    }
    return wanted.map(id => cache.get(id));
  }
  function detail(id) {
    const known = cache.get(id);
    if (known?.versionsComplete) return Promise.resolve(known);
    if (!details.has(id)) details.set(id, request('/cards/' + encodeURIComponent(id)).then(async result => {
      const card = remember({ ...result.card, versionsComplete: true }, 2);
      await saveOfflineCards([card]);
      return card;
    }).catch(async error => {
      if (!canUseOffline(error)) throw error;
      const [saved] = await offlineStorage.read([cardKey(id)]).catch(() => []);
      if (saved) return remember(saved, saved.versionsComplete ? 2 : 1);
      if ((levels.get(id) || 0) >= 1) return cache.get(id);
      throw error;
    }).finally(() => details.delete(id)));
    return details.get(id);
  }
  async function suggest(query, { colorIdentity = null, limit = 8, signal } = {}) {
    const result = await requestLookup('/suggest', { body: { query, colorIdentity, limit }, signal });
    return { ...result, cards: rememberList(result.cards) };
  }
  async function resolveText(text) {
    const result = await request('/resolve', { body: { text } });
    const cards = rememberList(result.cards, 1);
    await saveOfflineCards(cards);
    return { ...result, cards };
  }
  return { search, meta, getCards, detail, suggest, resolveText, cachedCards: () => [...cache.values()] };
}
