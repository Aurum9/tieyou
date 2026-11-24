import { validateGameRecord } from '../web/lib/scoreboard-model.js';

export function createScoreboardService(db, auth) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  return { async handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/scoreboard/records') return null;
    try {
      const account = await auth?.currentAccount(request);
      if (!account) return reply({ error: { message: '请先登录' } }, 401);
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      if (request.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return reply({ error: { message: '分页无效' } }, 400);
        const { results } = await db.prepare('SELECT record_json FROM scoreboard_games WHERE account_id=? ORDER BY started_at DESC, game_id DESC LIMIT 41 OFFSET ?').bind(account.id, offset).all();
        return reply({ username: account.username, records: results.slice(0, 40).map(r => JSON.parse(r.record_json)), more: results.length > 40 });
      }
      if (request.method !== 'POST') return reply({ error: { message: '不支持此操作' } }, 405);
      if (request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      if (request.headers.get('X-Tieyou-Scoreboard-Owner') !== encodeURIComponent(account.username)) return reply({ error: { message: '账号已改变，请重新打开页面' } }, 409);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return reply({ error: { message: '请求格式无效' } }, 415);
      const reader = request.body?.getReader(); let size = 0; const chunks = [];
      if (!reader) return reply({ error: { message: '记录为空' } }, 400);
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 24000) { await reader.cancel(); return reply({ error: { message: '记录过大' } }, 413); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      let record;
      try { record = validateGameRecord(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { return reply({ error: { message: error.message || '记录无效' } }, 400); }
      // Only the annotation may change after completion. Winner and players stay immutable.
      await db.prepare(`INSERT INTO scoreboard_games(account_id,game_id,started_at,record_json) VALUES(?,?,?,?)
        ON CONFLICT(account_id,game_id) DO UPDATE SET record_json=json_set(scoreboard_games.record_json,
          '$.note',json_extract(excluded.record_json,'$.note'),'$.noteUpdatedAt',json_extract(excluded.record_json,'$.noteUpdatedAt'))
        WHERE json_extract(excluded.record_json,'$.noteUpdatedAt')>coalesce(json_extract(scoreboard_games.record_json,'$.noteUpdatedAt'),json_extract(scoreboard_games.record_json,'$.endedAt'))`)
        .bind(account.id, record.id, record.startedAt, JSON.stringify(record)).run();
      const saved = await db.prepare('SELECT record_json FROM scoreboard_games WHERE account_id=? AND game_id=?').bind(account.id, record.id).first();
      return reply({ id: record.id, record: JSON.parse(saved.record_json) });
    } catch { return reply({ error: { message: '游戏记录暂时无法同步' } }, 503); }
  } };
}
