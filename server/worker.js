import { createCatalogService, importCatalogBatch, activateCatalogVersion } from './catalog-db.js';
import { validateDeckLibrary } from '../web/lib/decks.js';
import { createBracketEstimator, normalizeBracketDeck } from './bracket-estimator.js';

const JSON_LIMIT = 2 * 1024 * 1024;
const DECK_LIBRARY_LIMIT = 1536 * 1024;
const DECK_LIBRARY_PATH = '/api/deck-library';
const ID_LIMIT = 500;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
  });
}

async function readJSON(request, limit = JSON_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'JSON_REQUIRED', '请使用 JSON 请求');
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', '请求内容不能为空');
  const parts = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let cursor = 0;
  for (const part of parts) { buffer.set(part, cursor); cursor += part.length; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'JSON 格式无效'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'INVALID_JSON', '请求需要一个 JSON 对象');
  return data;
}

function integer(value, fallback, minimum, maximum) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new HttpError(400, 'INVALID_PARAMETER', '分页参数无效');
  return value;
}

function text(value, name, max = 1024) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'INVALID_PARAMETER', `${name}格式无效`);
  return value;
}

function rejectCrossOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || origin && origin !== url.origin) throw new HttpError(403, 'CROSS_ORIGIN', '不允许跨站请求');
}

async function sha256(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readDeckLibrary(db, account) {
  const row = await db.prepare('SELECT revision, library_json FROM deck_libraries WHERE account = ?').bind(account).first();
  if (!row) return { account, revision: 0, library: { version: 1, decks: [], trash: [] } };
  return { account, revision: row.revision, library: JSON.parse(row.library_json) };
}

async function deckLibraryResponse(request, url, db) {
  // Sites dispatch injects this server-side identity. Its service bearer has no visitor ID.
  const visitorId = request.headers.get('oai-authenticated-user-id');
  if (!visitorId) throw new HttpError(401, 'SIGN_IN_REQUIRED', '请先登录');
  if (!['GET', 'PUT'].includes(request.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方式无效');
  if (!db) throw new HttpError(503, 'DECK_LIBRARY_NOT_READY', '云端卡组暂时不可用');
  const account = await sha256(visitorId);
  if (request.method === 'GET') return json(await readDeckLibrary(db, account));
  rejectCrossOrigin(request, url);
  const body = await readJSON(request, DECK_LIBRARY_LIMIT);
  if (typeof body.account !== 'string' || !/^[a-f0-9]{64}$/.test(body.account)) {
    throw new HttpError(400, 'INVALID_PARAMETER', '账户标识无效');
  }
  if (body.account !== account) throw new HttpError(409, 'ACCOUNT_CHANGED', '登录账户已切换，请重新同步');
  const { revision } = body;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new HttpError(400, 'INVALID_PARAMETER', '同步版本无效');
  }
  let library;
  try { library = validateDeckLibrary(body.library); }
  catch (error) { throw new HttpError(400, 'INVALID_DECK_LIBRARY', error.message); }
  const libraryJson = JSON.stringify(library);
  if (new TextEncoder().encode(libraryJson).byteLength > DECK_LIBRARY_LIMIT) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
  }
  const nextRevision = revision + 1;
  const statement = revision === 0
    ? db.prepare('INSERT INTO deck_libraries (account, revision, library_json) VALUES (?, ?, ?) ON CONFLICT(account) DO NOTHING')
      .bind(account, nextRevision, libraryJson)
    : db.prepare('UPDATE deck_libraries SET revision = ?, library_json = ? WHERE account = ? AND revision = ?')
      .bind(nextRevision, libraryJson, account, revision);
  const result = await statement.run();
  if (result.meta.changes === 1) return json({ account, revision: nextRevision, library });
  const latest = await readDeckLibrary(db, account);
  return json({ ...latest, error: { code: 'REVISION_CONFLICT', message: '云端卡组已更新' } }, 409);
}

/** The deployed Site remains owner-private. Sites dispatch authenticates all requests,
 * including service requests, before this Worker runs. Import is a maintenance API;
 * no credential or import action is included in browser code. */
export function createWorker({ assets = {}, serveAsset, estimateBracket = createBracketEstimator() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      try {
        if (!url.pathname.startsWith('/api/')) {
          if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
          let pathname;
          try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
          if (pathname === '/') pathname = '/index.html';
          if (serveAsset) return await serveAsset(pathname, request);
          const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : null;
          if (!asset) return new Response('未找到页面', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
          return new Response(request.method === 'HEAD' ? null : asset.body, {
            headers: { 'Content-Type': asset.type, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', 'ETag': asset.etag || '' }
          });
        }
        if (url.pathname === DECK_LIBRARY_PATH) return await deckLibraryResponse(request, url, env?.DB);
        if (url.pathname === '/api/deck/bracket') {
          if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方式无效');
          rejectCrossOrigin(request, url);
          const body = await readJSON(request, 64 * 1024);
          let deck;
          try { deck = normalizeBracketDeck(body); }
          catch (error) { throw new HttpError(400, 'INVALID_PARAMETER', error.message); }
          try { return json(await estimateBracket(deck)); }
          catch { return json({ error: 'Commander Spellbook 暂不可用' }, 502); }
        }
        if (!env?.DB) throw new HttpError(503, 'CATALOG_NOT_READY', '卡库暂时不可用');
        const service = createCatalogService(env.DB);
        if (url.pathname === '/api/catalog/meta' && request.method === 'GET') return json(await service.meta());
        const detailMatch = url.pathname.match(/^\/api\/catalog\/cards\/([^/]+)$/);
        if (detailMatch && request.method === 'GET') {
          const result = await service.detail(decodeURIComponent(detailMatch[1]));
          const card = result?.card ?? null;
          if (!card) throw new HttpError(404, 'CARD_NOT_FOUND', '未找到这张卡牌');
          return json({ card });
        }
        const routes = new Set(['/api/catalog/search', '/api/catalog/cards', '/api/catalog/suggest', '/api/catalog/resolve', '/api/catalog/import']);
        if (!routes.has(url.pathname)) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
        if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方式无效');
        rejectCrossOrigin(request, url);
        const body = await readJSON(request);
        if (url.pathname === '/api/catalog/search') {
          const result = await service.search({ q: text(body.query ?? body.q, '搜索条件'), sort: text(body.sort, '排序', 32) || 'name', commanderOnly: body.commanderOnly === true, offset: integer(body.offset, 0, 0, 1000000), limit: integer(body.limit, 48, 1, 100) });
          return json(result);
        }
        if (url.pathname === '/api/catalog/cards') {
          if (!Array.isArray(body.ids) || body.ids.length > ID_LIMIT || body.ids.some(id => typeof id !== 'string' || id.length > 80)) throw new HttpError(400, 'INVALID_PARAMETER', '卡牌身份列表无效');
          if (body.versions != null && (!Array.isArray(body.versions) || body.versions.length > ID_LIMIT || body.versions.some(row => !row || typeof row.cardId !== 'string' || typeof row.versionId !== 'string' || row.cardId.length > 80 || row.versionId.length > 100))) throw new HttpError(400, 'INVALID_PARAMETER', '印刷版本列表无效');
          const result = await service.batch(body.ids, { versions: body.versions || [] });
          return json(Array.isArray(result) ? { cards: result } : result);
        }
        if (url.pathname === '/api/catalog/suggest') {
          const identity = body.colorIdentity ?? null;
          if (identity != null && (!Array.isArray(identity) || identity.some(color => !['W','U','B','R','G'].includes(color)))) throw new HttpError(400, 'INVALID_PARAMETER', '标识色无效');
          const result = await service.suggest(text(body.query ?? body.q, '卡牌名称'), identity, integer(body.limit, 8, 1, 20));
          return json(Array.isArray(result) ? { cards: result, total: result.length } : result);
        }
        if (url.pathname === '/api/catalog/resolve') return json(await service.resolveText(text(body.text, '牌表', 500000)));
        if (body.action === 'activate') return json(await activateCatalogVersion(env.DB, body));
        if (body.action !== 'batch') throw new HttpError(400, 'INVALID_PARAMETER', '导入操作无效');
        const { digest, ...payload } = body;
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new HttpError(400, 'INVALID_DIGEST', '导入批次缺少校验值');
        const actualDigest = await sha256(JSON.stringify(payload));
        if (digest !== actualDigest) throw new HttpError(400, 'INVALID_DIGEST', '导入批次校验失败');
        return json(await importCatalogBatch(env.DB, body));
      } catch (error) {
        const preparing = error.code === 'CATALOG_NOT_READY' || error.message === '卡库正在准备，请稍后重试';
        const overloaded = /\bD1 DB is overloaded\b/i.test(error.message || '');
        const importRejected = url.pathname === '/api/catalog/import' && /^(卡库|每批|导入|印刷|已启用|该批次)/.test(error.message || '');
        const status = error.status || (error instanceof URIError ? 400 : preparing || overloaded ? 503 : error.name === 'QueryError' || importRejected ? 400 : 500);
        const deckRoute = url.pathname === DECK_LIBRARY_PATH;
        if (status >= 500) console.error(JSON.stringify({ route: url.pathname, message: deckRoute ? error.name : error.message }));
        const serviceName = deckRoute ? '云端卡组' : '卡库';
        const message = overloaded ? `${serviceName}暂时繁忙，请重试` : status < 500 || preparing || error.code === 'DECK_LIBRARY_NOT_READY' ? error.message : `${serviceName}请求暂时未完成，请重试`;
        const code = overloaded ? (deckRoute ? 'DECK_LIBRARY_BUSY' : 'CATALOG_BUSY') : error.code || (preparing ? 'CATALOG_NOT_READY' : error.name === 'QueryError' ? 'INVALID_QUERY' : 'SERVER_ERROR');
        return json({ error: { code, message, ...(Number.isInteger(error.position) ? { position: error.position } : {}) } }, status);
      }
    }
  };
}
