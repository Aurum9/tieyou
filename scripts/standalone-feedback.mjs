import { randomUUID } from 'node:crypto';

const imageLimit = 1024 * 1024;
const bodyLimit = 4400000;
const pageSize = 20;

class FeedbackError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function positiveInteger(value) {
  if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new FeedbackError(400, '分页或反馈编号无效');
  return Number(value);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new FeedbackError(415, '反馈请求格式无效');
  }
  if (Number(request.headers.get('Content-Length')) > bodyLimit) throw new FeedbackError(413, '截图过大，请减少截图后重试');
  const reader = request.body?.getReader();
  if (!reader) throw new FeedbackError(400, '请填写反馈内容');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        void reader.cancel().catch(() => {});
        throw new FeedbackError(413, '截图过大，请减少截图后重试');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new FeedbackError(400, '反馈请求格式无效');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FeedbackError(400, '反馈请求格式无效');
  return body;
}

function validateText(body, limit) {
  if (typeof body.text !== 'string' || !body.text.isWellFormed() || body.text.length > limit) {
    throw new FeedbackError(400, `文字最多 ${limit} 个字符`);
  }
  if (typeof body.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.requestId)) {
    throw new FeedbackError(400, '提交编号无效，请刷新后重试');
  }
  return body.text.trim();
}

function decodeImage(image) {
  if (!image || !['image/jpeg', 'image/png'].includes(image.type) || typeof image.data !== 'string' ||
      image.data.length > Math.ceil(imageLimit / 3) * 4 || /[^A-Za-z0-9+/=]/.test(image.data)) {
    throw new FeedbackError(400, '截图格式无效，请上传 JPG 或 PNG');
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) throw new FeedbackError(400, '截图编码无效');
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (bytes.length > imageLimit || !(image.type === 'image/jpeg' ? jpeg : png)) {
    throw new FeedbackError(400, '截图无效或超过 1 MB');
  }
  return { bytes, type: image.type };
}

function author(row) {
  return { id: row.author_id, username: row.username };
}

export function createFeedbackService(db, auth) {
  async function postById(id) {
    const row = await db.prepare(`SELECT p.*, a.username,
      (SELECT count(*) FROM feedback_replies r WHERE r.post_id=p.id) AS reply_count
      FROM feedback_posts p JOIN standalone_auth_accounts a ON a.id=p.author_id WHERE p.id=?`).bind(id).first();
    if (!row) throw new FeedbackError(404, '这条反馈不存在');
    const images = await db.prepare('SELECT id FROM feedback_images WHERE post_id=? ORDER BY position').bind(id).all();
    return { id: row.id, text: row.body, author: author(row), createdAt: row.created_at, replyCount: row.reply_count,
      images: images.results.map(image => ({ url: '/api/feedback/images/' + image.id })) };
  }

  async function checkRate(table, account, limit) {
    const recent = await db.prepare(`SELECT count(*) AS count FROM ${table} WHERE author_id=? AND created_at>?`)
      .bind(account.id, Date.now() - 3600000).first();
    if (recent.count >= limit) throw new FeedbackError(429, '提交过于频繁，请稍后再试');
  }

  return {
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/feedback' && !url.pathname.startsWith('/api/feedback/')) return null;
      try {
        const account = await auth?.currentAccount(request);
        if (!account) throw new FeedbackError(401, '登录后可发布和查看反馈');
        if (request.headers.get('Sec-Fetch-Site') === 'cross-site' ||
            request.headers.get('Origin') && request.headers.get('Origin') !== url.origin ||
            request.method === 'POST' && request.headers.get('Origin') !== url.origin) {
          throw new FeedbackError(403, '不允许跨站请求');
        }
        const imageMatch = url.pathname.match(/^\/api\/feedback\/images\/([a-f0-9-]{36})$/);
        if (imageMatch && ['GET', 'HEAD'].includes(request.method)) {
          const row = await db.prepare('SELECT media_type, bytes FROM feedback_images WHERE id=?').bind(imageMatch[1]).first();
          if (!row) throw new FeedbackError(404, '截图不存在');
          return new Response(request.method === 'HEAD' ? null : row.bytes, { headers: {
            'Content-Type': row.media_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin'
          } });
        }
        if (url.pathname === '/api/feedback' && request.method === 'GET') {
          const before = url.searchParams.has('before') ? positiveInteger(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
          const rows = await db.prepare('SELECT id FROM feedback_posts WHERE id<? ORDER BY id DESC LIMIT ?').bind(before, pageSize + 1).all();
          const posts = await Promise.all(rows.results.slice(0, pageSize).map(row => postById(row.id)));
          return json({ viewer: account, posts, nextBefore: rows.results.length > pageSize ? posts.at(-1).id : null });
        }
        if (url.pathname === '/api/feedback' && request.method === 'POST') {
          const body = await readBody(request);
          const text = validateText(body, 5000);
          if (!Array.isArray(body.images) || body.images.length > 3 || !text && !body.images.length) {
            throw new FeedbackError(400, '请填写文字或添加截图，每条最多 3 张截图');
          }
          const images = body.images.map(decodeImage);
          const existing = await db.prepare('SELECT id FROM feedback_posts WHERE author_id=? AND request_id=?').bind(account.id, body.requestId).first();
          if (existing) return json({ post: await postById(existing.id) });
          await checkRate('feedback_posts', account, 20);
          const writes = [db.prepare('INSERT INTO feedback_posts(author_id, body, request_id, created_at) VALUES (?,?,?,?)')
            .bind(account.id, text, body.requestId, Date.now())];
          for (const [position, image] of images.entries()) {
            writes.push(db.prepare(`INSERT INTO feedback_images(id, post_id, media_type, bytes, position)
              VALUES (?,(SELECT id FROM feedback_posts WHERE author_id=? AND request_id=?),?,?,?)`)
              .bind(randomUUID(), account.id, body.requestId, image.type, image.bytes, position));
          }
          try {
            await db.batch(writes);
          } catch (error) {
            const retry = await db.prepare('SELECT id FROM feedback_posts WHERE author_id=? AND request_id=?').bind(account.id, body.requestId).first();
            if (retry) return json({ post: await postById(retry.id) });
            throw error;
          }
          const saved = await db.prepare('SELECT id FROM feedback_posts WHERE author_id=? AND request_id=?').bind(account.id, body.requestId).first();
          return json({ post: await postById(saved.id) }, 201);
        }
        const repliesMatch = url.pathname.match(/^\/api\/feedback\/([1-9]\d{0,14})\/replies$/);
        if (repliesMatch) {
          const postId = positiveInteger(repliesMatch[1]);
          if (!await db.prepare('SELECT id FROM feedback_posts WHERE id=?').bind(postId).first()) throw new FeedbackError(404, '这条反馈不存在');
          if (request.method === 'GET') {
            const after = url.searchParams.has('after') ? positiveInteger(url.searchParams.get('after')) : 0;
            const rows = await db.prepare(`SELECT r.*, a.username FROM feedback_replies r JOIN standalone_auth_accounts a ON a.id=r.author_id
              WHERE post_id=? AND r.id>? ORDER BY r.id LIMIT 31`).bind(postId, after).all();
            const replies = rows.results.slice(0, 30).map(row => ({ id: row.id, text: row.body, author: author(row), createdAt: row.created_at }));
            return json({ replies, nextAfter: rows.results.length > 30 ? replies.at(-1).id : null });
          }
          if (request.method === 'POST') {
            const body = await readBody(request);
            const text = validateText(body, 2000);
            if (!text) throw new FeedbackError(400, '请填写回复');
            const existing = await db.prepare('SELECT id, post_id FROM feedback_replies WHERE author_id=? AND request_id=?').bind(account.id, body.requestId).first();
            if (existing && existing.post_id !== postId) throw new FeedbackError(409, '回复编号已使用，请重试');
            if (!existing) {
              await checkRate('feedback_replies', account, 100);
              await db.prepare(`INSERT INTO feedback_replies(post_id,author_id,body,request_id,created_at)
                VALUES (?,?,?,?,?) ON CONFLICT(author_id,request_id) DO NOTHING`).bind(postId, account.id, text, body.requestId, Date.now()).run();
            }
            const row = await db.prepare('SELECT * FROM feedback_replies WHERE author_id=? AND request_id=?').bind(account.id, body.requestId).first();
            if (row.post_id !== postId) throw new FeedbackError(409, '回复编号已使用，请重试');
            return json({ reply: { id: row.id, text: row.body, author: { id: account.id, username: account.username }, createdAt: row.created_at } }, existing ? 200 : 201);
          }
        }
        throw new FeedbackError(405, '请求方式或地址无效');
      } catch (error) {
        return json({ error: { message: error.status ? error.message : '反馈服务暂时不可用，请重试' } }, error.status || 500);
      }
    }
  };
}
