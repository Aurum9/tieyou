import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const passwordOptions = { N: 2 ** 15, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
const keyBytes = 32;
const sessionSeconds = 30 * 24 * 60 * 60;
const rateWindow = 15 * 60 * 1000;
const maxRateBuckets = 4096;
const maxPasswordJobs = 2;
const bodyLimit = 4096;
const authRoutes = new Map([
  ['/api/auth/session', 'GET'],
  ['/api/auth/register', 'POST'],
  ['/api/auth/login', 'POST'],
  ['/api/auth/logout', 'POST'],
]);

class AuthError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function clientError(code, message) {
  return new AuthError(400, code, message);
}

function invalidCredentials() {
  return new AuthError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new AuthError(415, 'JSON_REQUIRED', '请使用 JSON 请求');
  }
  const tooLarge = () => new AuthError(413, 'BODY_TOO_LARGE', '请求内容过大');
  if (Number(request.headers.get('Content-Length')) > bodyLimit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw clientError('INVALID_JSON', '请求需要一个 JSON 对象');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
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
    throw clientError('INVALID_JSON', 'JSON 格式无效');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw clientError('INVALID_JSON', '请求需要一个 JSON 对象');
  return body;
}

function transport(url) {
  if (url.protocol === 'https:') return { name: '__Host-edh_session', secure: '; Secure' };
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { name: 'edh_dev_session', secure: '' };
  }
  return null;
}

function sessionCookie(cookie, token, maxAge) {
  return `${cookie.name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${cookie.secure}`;
}

function sessionDigest(request, cookie) {
  const prefix = `${cookie.name}=`;
  let token = null;
  for (const value of (request.headers.get('Cookie') || '').split(';')) {
    const pair = value.trim();
    if (!pair.startsWith(prefix)) continue;
    if (token !== null) return null;
    token = pair.slice(prefix.length);
  }
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : null;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function makeSession() {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: hashToken(token), expiresAt: Date.now() + sessionSeconds * 1000 };
}

function normalizedCredentials(body, registration) {
  const username = typeof body.username === 'string' ? body.username.normalize('NFKC').trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) {
    if (!registration) throw invalidCredentials();
    throw clientError('INVALID_USERNAME', '用户名须为 3–32 个文字、数字、下划线或连字符');
  }
  const passwordLength = [...password].length;
  if (passwordLength < 8 || passwordLength > 128 || !password.isWellFormed()) {
    if (!registration) throw invalidCredentials();
    throw clientError('INVALID_PASSWORD', '密码须为 8–128 个字符');
  }
  return { username, key: username.toLowerCase().normalize('NFKC'), password };
}

function rateError(retryMs) {
  return new AuthError(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试', {
    'Retry-After': String(Math.max(1, Math.ceil(retryMs / 1000))),
  });
}

function rateLimiter() {
  const buckets = new Map();
  let nextPrune = 0;
  return {
    take(key, limit) {
      const now = Date.now();
      if (now >= nextPrune) {
        for (const [id, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(id);
        nextPrune = now + 60 * 1000;
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.expiresAt <= now) {
        if (!bucket && buckets.size >= maxRateBuckets) throw rateError(rateWindow);
        buckets.set(key, { count: 1, expiresAt: now + rateWindow });
      } else {
        if (bucket.count >= limit) throw rateError(bucket.expiresAt - now);
        bucket.count++;
      }
    },
    clear(key) { buckets.delete(key); },
  };
}

function clientBucket(address) {
  if (typeof address !== 'string') return 'unknown';
  const ipVersion = isIP(address);
  if (ipVersion === 4) return address;
  if (ipVersion !== 6) return 'unknown';

  // Canonicalize IPv6, then group by /64 to avoid a separate budget for each suffix.
  const canonical = new URL(`http://[${address.split('%')[0]}]`).hostname.slice(1, -1);
  if (canonical.startsWith('::ffff:')) return canonical;
  const [prefix, suffix] = canonical.split('::');
  const groups = prefix ? prefix.split(':') : [];
  if (suffix !== undefined) {
    const tail = suffix ? suffix.split(':') : [];
    groups.push(...Array(8 - groups.length - tail.length).fill('0'), ...tail);
  }
  return groups.slice(0, 4).join(':');
}

export async function createStandaloneAuth(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS standalone_auth_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS standalone_auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES standalone_auth_accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS standalone_auth_session_expiry ON standalone_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS standalone_auth_session_account ON standalone_auth_sessions(account_id);
  `);
  const limits = rateLimiter();
  const dummySalt = randomBytes(16);
  const dummyHash = randomBytes(keyBytes);
  let passwordJobs = 0;
  let nextSessionCleanup = 0;

  async function passwordKey(password, salt) {
    if (passwordJobs >= maxPasswordJobs) throw rateError(1000);
    passwordJobs++;
    try {
      return await deriveKey(password, salt, keyBytes, passwordOptions);
    } finally {
      passwordJobs--;
    }
  }

  async function cleanupSessions() {
    const now = Date.now();
    if (now < nextSessionCleanup) return;
    await db.prepare('DELETE FROM standalone_auth_sessions WHERE expires_at <= ?').bind(now).run();
    nextSessionCleanup = now + 60 * 60 * 1000;
  }

  async function findSession(request, cookie) {
    const digest = cookie && sessionDigest(request, cookie);
    if (!digest) return null;
    return db.prepare(`
      SELECT a.id, a.username FROM standalone_auth_sessions AS s
      JOIN standalone_auth_accounts AS a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).bind(digest, Date.now()).first();
  }

  function sessionWrites(session, accountId, previous) {
    const writes = [db.prepare(`
      INSERT INTO standalone_auth_sessions (token_hash, account_id, expires_at)
      SELECT ?, id, ? FROM standalone_auth_accounts WHERE id = ?
    `).bind(session.digest, session.expiresAt, accountId)];
    if (previous) writes.push(db.prepare(`
      DELETE FROM standalone_auth_sessions WHERE token_hash = ?
      AND EXISTS (SELECT 1 FROM standalone_auth_sessions WHERE token_hash = ?)
    `).bind(previous, session.digest));
    return writes;
  }

  return {
    async currentAccount(request) {
      return findSession(request, transport(new URL(request.url)));
    },
    async visitorId(request) {
      const account = await findSession(request, transport(new URL(request.url)));
      return account ? `standalone:${account.id}` : null;
    },
    async handle(request, { clientAddress } = {}) {
      const url = new URL(request.url);
      const method = authRoutes.get(url.pathname);
      if (!method) return null;

      try {
        if (request.method !== method) throw new AuthError(405, 'METHOD_NOT_ALLOWED', '请求方式无效', { Allow: method });
        const cookie = transport(url);
        if (!cookie) throw new AuthError(403, 'HTTPS_REQUIRED', '请通过 HTTPS 登录');
        const crossSite = request.headers.get('Sec-Fetch-Site') === 'cross-site';
        if (crossSite || (method === 'POST' && request.headers.get('Origin') !== url.origin)) {
          throw new AuthError(403, 'CROSS_ORIGIN', '不允许跨站请求');
        }
        if (method === 'GET') {
          const account = await findSession(request, cookie);
          return json({ username: account?.username ?? null });
        }

        const registration = url.pathname === '/api/auth/register';
        const previous = sessionDigest(request, cookie);
        if (url.pathname === '/api/auth/logout') {
          await readBody(request);
          if (previous) await db.prepare('DELETE FROM standalone_auth_sessions WHERE token_hash = ?').bind(previous).run();
          return json({ username: null }, 200, { 'Set-Cookie': sessionCookie(cookie, '', 0) });
        }

        limits.take(`${registration ? 'register' : 'login'}-client:${clientBucket(clientAddress)}`, registration ? 5 : 40);
        const { username, key, password } = normalizedCredentials(await readBody(request), registration);
        const session = makeSession();
        if (registration) {
          const id = randomUUID();
          const salt = randomBytes(16);
          const passwordHash = await passwordKey(password, salt);
          await cleanupSessions();
          const [accountWrite] = await db.batch([
            db.prepare(`
              INSERT INTO standalone_auth_accounts (id, username, username_key, salt, password_hash)
              VALUES (?, ?, ?, ?, ?) ON CONFLICT(username_key) DO NOTHING
            `).bind(id, username, key, salt.toString('hex'), passwordHash.toString('hex')),
            ...sessionWrites(session, id, previous),
          ]);
          if (!accountWrite.meta.changes) throw new AuthError(409, 'USERNAME_TAKEN', '该用户名已被使用');
          return json({ username }, 201, { 'Set-Cookie': sessionCookie(cookie, session.token, sessionSeconds) });
        }

        const loginBucket = `account:${key}`;
        limits.take(loginBucket, 10);
        const account = await db.prepare('SELECT id, username, salt, password_hash FROM standalone_auth_accounts WHERE username_key = ?').bind(key).first();
        const salt = account ? Buffer.from(account.salt, 'hex') : dummySalt;
        const expected = account ? Buffer.from(account.password_hash, 'hex') : dummyHash;
        const actual = await passwordKey(password, salt);
        if (!timingSafeEqual(expected, actual) || !account) throw invalidCredentials();
        await cleanupSessions();
        await db.batch(sessionWrites(session, account.id, previous));
        limits.clear(loginBucket);
        return json({ username: account.username }, 200, { 'Set-Cookie': sessionCookie(cookie, session.token, sessionSeconds) });
      } catch (error) {
        if (error instanceof AuthError) return json({ error: { code: error.code, message: error.message } }, error.status, error.headers);
        return json({ error: { code: 'AUTH_UNAVAILABLE', message: '登录服务暂时不可用' } }, 500);
      }
    },
  };
}
