import { createHash, randomBytes } from 'node:crypto';
import { readLimitedBody, validatePosterPNG, POSTER_LIMIT } from './deck-poster-store.mjs';

const tokenPattern = /^[A-Za-z0-9_-]{32}$/;
const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow' };
const reply = (body, status = 200) => Response.json(body, { status, headers });

export function publicDeck(deck) {
  return {
    name: deck.name, description: deck.description || '', updatedAt: deck.updatedAt,
    entries: deck.entries.filter(entry => ['main', 'commander'].includes(entry.zone)).map(entry => ({
      cardId: entry.cardId, versionId: entry.versionId, quantity: entry.quantity, zone: entry.zone,
    })),
  };
}

export function createDeckShareService(db, auth, { readIndex, posterStore } = {}) {
  async function findDeck(accountId, deckId) {
    const key = createHash('sha256').update('standalone:' + accountId).digest('hex');
    const row = await db.prepare('SELECT library_json FROM deck_libraries WHERE account=?').bind(key).first();
    return row ? JSON.parse(row.library_json).decks.find(deck => deck.id === deckId) : null;
  }
  return { async handle(request) {
    const url = new URL(request.url);
    const publicMatch = url.pathname.match(/^\/api\/shared-decks\/([A-Za-z0-9_-]+)(\/poster\.png)?$/);
    const pageMatch = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
    const ownerMatch = url.pathname.match(/^\/api\/deck-shares\/([^/]+)(?:\/(poster|art))?$/);
    if (!publicMatch && !pageMatch && !ownerMatch) return null;
    try {
      if (publicMatch || pageMatch) {
        if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: { message: '不支持此操作' } }, 405);
        const token = (publicMatch || pageMatch)[1];
        const row = tokenPattern.test(token) ? await db.prepare('SELECT account_id,deck_id FROM deck_shares WHERE token=?').bind(token).first() : null;
        const deck = row && await findDeck(row.account_id, row.deck_id);
        if (publicMatch?.[2]) {
          const bytes = deck && await posterStore?.read(token);
          if (!bytes) return reply({ error: { message: '分享图片不可用' } }, 404);
          const name = deck.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) + '.png';
          return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Content-Disposition': "attachment; filename=\"tieyou-deck.png\"; filename*=UTF-8''" + encodeURIComponent(name) } });
        }
        if (publicMatch) return deck ? reply({ deck: publicDeck(deck) }) : reply({ error: { message: '分享已关闭，或卡组已删除' } }, 404);
        // The app renders the same unavailable state on missing and revoked links.
        const title = deck ? deck.name + ' · 铁有卡组分享' : '分享不可用 · 铁有';
        const description = deck ? (deck.description || '查看这套万智牌 EDH 卡组的牌表和卡牌详情。').slice(0, 200) : '分享已关闭，或卡组已删除。';
        const index = (await readIndex()).replace(/<title>[^<]*<\/title>/, () => '<title>' + escapeHTML(title) + '</title>')
          .replace(/<meta name="description"[^>]*>/, () => '<meta name="description" content="' + escapeHTML(description) + '" />')
          .replace('<head>', () => '<head><base href="/" /><meta property="og:title" content="' + escapeHTML(title) + '" /><meta property="og:description" content="' + escapeHTML(description) + '" /><meta property="og:type" content="website" />');
        return new Response(request.method === 'HEAD' ? null : index, { status: deck ? 200 : 404, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
      }
      const account = await auth?.currentAccount(request);
      if (!account) return reply({ error: { message: '登录后才能分享卡组' } }, 401);
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      const deckId = decodeURIComponent(ownerMatch[1]);
      if (!deckId || deckId.length > 200) return reply({ error: { message: '卡组不存在' } }, 404);
      const deck = await findDeck(account.id, deckId);
      const action = ownerMatch[2];
      if (action === 'art') {
        if (request.method !== 'GET') return reply({ error: { message: '不支持此操作' } }, 405);
        const entry = deck?.entries.find(entry => entry.zone === 'commander' && entry.cardId === url.searchParams.get('card'));
        if (!entry || !posterStore) return reply({ error: { message: '卡图不可用' } }, 404);
        const kind = url.searchParams.get('kind') || 'card';
        if (!['card', 'art'].includes(kind)) return reply({ error: { message: '卡图类型无效' } }, 400);
        const version = await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first('active_version');
        const printing = await db.prepare('SELECT payload_json FROM catalog_printings WHERE version=? AND card_id=? AND id=?').bind(version, entry.cardId, entry.versionId).first();
        const card = await db.prepare('SELECT core_json FROM catalog_cards WHERE version=? AND id=?').bind(version, entry.cardId).first();
        const payload = printing ? JSON.parse(printing.payload_json) : {}, core = card ? JSON.parse(card.core_json) : {};
        const image = payload.faceImages?.[0] || payload.image || core.faces?.[0]?.image || core.image;
        if (!image) return reply({ error: { message: '卡图不可用' } }, 404);
        const bytes = await posterStore.cardImage(image, kind);
        return new Response(bytes, { headers: { ...headers, 'Content-Type': bytes[0] === 0xff ? 'image/jpeg' : 'image/png' } });
      }
      if (action && request.method !== 'POST') return reply({ error: { message: '不支持此操作' } }, 405);
      if (request.method === 'GET') {
        if (!deck) return reply({ error: { message: '请先将卡组同步到账号' } }, 404);
        const saved = await db.prepare('SELECT token FROM deck_shares WHERE account_id=? AND deck_id=?').bind(account.id, deckId).first();
        return reply({ username: account.username, url: saved ? url.origin + '/s/' + saved.token : null });
      }
      if (!['POST', 'DELETE'].includes(request.method)) return reply({ error: { message: '不支持此操作' } }, 405);
      if (request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      if (request.headers.get('X-Tieyou-Share-Owner') !== encodeURIComponent(account.username)) return reply({ error: { message: '账号已改变，请重新打开分享' } }, 409);
      if (action === 'poster') {
        if (!deck || !posterStore) return reply({ error: { message: '卡组不存在' } }, 404);
        const saved = await db.prepare('SELECT token FROM deck_shares WHERE account_id=? AND deck_id=?').bind(account.id, deckId).first();
        if (!saved) return reply({ error: { message: '请先开启分享' } }, 409);
        if (request.headers.get('Content-Type') !== 'image/png') return reply({ error: { message: '请上传 PNG 图片' } }, 415);
        try {
          const bytes = await readLimitedBody(request, POSTER_LIMIT); validatePosterPNG(bytes);
          await posterStore.save(saved.token, bytes);
        } catch (error) { return reply({ error: { message: error.message } }, error.message === '图片过大' ? 413 : 400); }
        return reply({ url: url.origin + '/api/shared-decks/' + saved.token + '/poster.png' });
      }
      if (request.method === 'DELETE') {
        const saved = await db.prepare('SELECT token FROM deck_shares WHERE account_id=? AND deck_id=?').bind(account.id, deckId).first();
        await db.prepare('DELETE FROM deck_shares WHERE account_id=? AND deck_id=?').bind(account.id, deckId).run();
        if (saved) await posterStore?.remove(saved.token);
        return reply({ url: null });
      }
      if (!deck) return reply({ error: { message: '请先将卡组同步到账号' } }, 404);
      await db.prepare('INSERT INTO deck_shares(account_id,deck_id,token,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,deck_id) DO NOTHING').bind(account.id, deckId, randomBytes(24).toString('base64url'), Date.now()).run();
      const saved = await db.prepare('SELECT token FROM deck_shares WHERE account_id=? AND deck_id=?').bind(account.id, deckId).first();
      return reply({ url: url.origin + '/s/' + saved.token });
    } catch { return reply({ error: { message: '分享暂时无法使用，请重试' } }, 503); }
  } };
}
