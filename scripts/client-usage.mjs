import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const clientDay = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const downloadURL = 'https://sbwsz.cn/downloads/tieyou-android.apk';

export async function createClientUsage(db, { policyPath, releasePath, now = Date.now } = {}) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS client_usage_installations (
      install_key TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, version_name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_usage_daily (
      day TEXT NOT NULL, install_key TEXT NOT NULL, version_name TEXT NOT NULL, PRIMARY KEY(day,install_key)
    );
    CREATE TABLE IF NOT EXISTS client_download_daily (
      day TEXT NOT NULL, version_name TEXT NOT NULL, responses INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(day,version_name)
    );
    CREATE TABLE IF NOT EXISTS client_protocol_daily (
      day TEXT NOT NULL, protocol INTEGER NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(day,protocol)
    );
  `);
  let cachedPolicy, policyUntil = 0, cleanupDay;
  const limits = new Map();
  async function policy() {
    if (cachedPolicy && now() < policyUntil) return cachedPolicy;
    cachedPolicy = { minimumProtocol: 1, enforce: false, enforceAt: null };
    try {
      const raw = JSON.parse(await readFile(policyPath, 'utf8'));
      if (raw.minimumProtocol !== 1 || typeof raw.enforce !== 'boolean' || raw.enforceAt != null && !Number.isFinite(Date.parse(raw.enforceAt))) throw new Error('Invalid policy');
      cachedPolicy = { minimumProtocol: 1, enforce: raw.enforce, enforceAt: raw.enforceAt || null };
    } catch { /* An absent or malformed policy keeps legacy requests available. */ }
    policyUntil = now() + 2000;
    return cachedPolicy;
  }
  async function publicPolicy() {
    const rule = await policy();
    return { ...rule, active: rule.enforce && (!rule.enforceAt || Date.parse(rule.enforceAt) <= now()), downloadURL };
  }
  async function clean() {
    const day = clientDay(now()); if (cleanupDay === day) return;
    cleanupDay = day;
    await db.prepare('DELETE FROM client_usage_daily WHERE day < ?').bind(clientDay(now() - 90 * 86400000)).run();
  }
  async function heartbeat(request, address) {
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: { message: '请求来源无效' } }, 403);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: { message: '请求格式无效' } }, 415);
    const minute = Math.floor(now() / 60000), key = `${minute}:${address || 'unknown'}`;
    if (limits.size > 2000) for (const entry of limits.keys()) if (!entry.startsWith(`${minute}:`)) limits.delete(entry);
    if ((limits.get(key) || 0) >= 120 || limits.size >= 5000) return json({ error: { message: '请求过于频繁' } }, 429);
    limits.set(key, (limits.get(key) || 0) + 1);
    let body = '', size = 0;
    const reader = request.body?.getReader();
    if (!reader) return json({ error: { message: '请求无效' } }, 400);
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1024) { void reader.cancel().catch(() => {}); return json({ error: { message: '请求过大' } }, 413); }
      body += new TextDecoder().decode(value);
    }
    let value;
    try { value = JSON.parse(body); } catch { return json({ error: { message: '请求无效' } }, 400); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.installId !== 'string' || typeof value.version !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.installId) || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version)) return json({ error: { message: '客户端信息无效' } }, 400);
    const hash = createHash('sha256').update(value.installId.toLowerCase()).digest('hex'), time = now();
    await db.batch([
      db.prepare(`INSERT INTO client_usage_installations VALUES (?,?,?,?) ON CONFLICT(install_key) DO UPDATE SET last_seen=excluded.last_seen, version_name=excluded.version_name`).bind(hash, time, time, value.version),
      db.prepare(`INSERT INTO client_usage_daily VALUES (?,?,?) ON CONFLICT(day,install_key) DO UPDATE SET version_name=excluded.version_name`).bind(clientDay(time), hash, value.version),
    ]);
    await clean(); return json({ ok: true });
  }
  return {
    async handle(request, { clientAddress } = {}) {
      const path = new URL(request.url).pathname;
      if (path === '/api/client/policy' && request.method === 'GET') return json(await publicPolicy());
      if (path === '/api/client/heartbeat') return request.method === 'POST' ? heartbeat(request, clientAddress) : json({ error: { message: '请求方法无效' } }, 405);
      if (!path.startsWith('/api/catalog/') || path === '/api/catalog/import') return null;
      const protocol = request.headers.get('x-tieyou-protocol') === '1' ? 1 : 0;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientAddress)) {
        try { await db.prepare(`INSERT INTO client_protocol_daily VALUES (?,?,1) ON CONFLICT(day,protocol) DO UPDATE SET requests=requests+1`).bind(clientDay(now()), protocol).run(); } catch { /* Statistics must not make catalog queries fail. */ }
      }
      const rule = await publicPolicy();
      if (rule.active && protocol < rule.minimumProtocol) return json({ error: { code: 'CLIENT_UPGRADE_REQUIRED', message: '当前页面需要更新。网页版请刷新；App 新版下载：https://sbwsz.cn/downloads/tieyou-android.apk', downloadURL } }, 426);
      return null;
    },
    async recordDownload(path, bytes) {
      const match = path.match(/^\/downloads\/tieyou-android(?:-(\d+\.\d+\.\d+))?\.apk$/);
      if (!match) return;
      let version = match[1];
      if (!version) { try { version = JSON.parse(await readFile(releasePath, 'utf8')).versionName; } catch { version = 'unknown'; } }
      await db.prepare(`INSERT INTO client_download_daily VALUES (?,?,1,?) ON CONFLICT(day,version_name) DO UPDATE SET responses=responses+1, bytes=bytes+excluded.bytes`).bind(clientDay(now()), version, bytes).run();
    },
  };
}
