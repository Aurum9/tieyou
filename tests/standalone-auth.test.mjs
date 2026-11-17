import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createStandaloneAuth } from '../scripts/standalone-auth.mjs';

const httpsOrigin = 'https://example.test';
const credentials = { username: '牌手_A', password: ' deck password 🔑 ' };

function request(path, { base = httpsOrigin, origin = base, cookie, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  return new Request(new URL(path, base), {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function setup(t) {
  const db = openLocalD1();
  t.after(() => db.close());
  return { db, auth: await createStandaloneAuth(db) };
}

test('registers, stores digests, verifies sessions across adapter initialization, rotates tokens and logs out', async t => {
  const { db, auth } = await setup(t);
  const empty = await auth.handle(request('/api/auth/session'));
  assert.deepEqual(await empty.json(), { username: null });
  const register = await auth.handle(request('/api/auth/register', { body: credentials }));
  assert.equal(register.status, 201);
  assert.deepEqual(await register.json(), { username: '牌手_A' });
  const cookie = register.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-edh_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
  const pair = cookie.split(';')[0];
  const token = pair.split('=')[1];
  const session = await db.prepare('SELECT * FROM standalone_auth_sessions').first();
  assert.equal(session.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(session.token_hash, token);
  const row = await db.prepare('SELECT * FROM standalone_auth_accounts').first();
  assert.equal(row.password_hash.length, 64);
  assert.equal(row.salt.length, 32);
  assert.equal(JSON.stringify(row).includes(credentials.password), false);

  const reloaded = await createStandaloneAuth(db);
  const sessionRequest = request('/api/auth/session', { cookie: pair });
  const previousId = await reloaded.visitorId(sessionRequest);
  assert.equal(previousId, `standalone:${row.id}`);
  assert.deepEqual(await (await reloaded.handle(sessionRequest)).json(), { username: '牌手_A' });
  const duplicate = await reloaded.handle(request('/api/auth/register', { cookie: pair, body: { ...credentials, username: ' 牌手_ａ ' } }));
  assert.equal(duplicate.status, 409);
  assert.equal(await reloaded.visitorId(sessionRequest), previousId);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM standalone_auth_sessions').first()).count, 1);

  const login = await reloaded.handle(request('/api/auth/login', { cookie: pair, body: { ...credentials, username: '牌手_a' } }));
  assert.equal(login.status, 200);
  const rotatedPair = login.headers.get('Set-Cookie').split(';')[0];
  assert.notEqual(rotatedPair, pair);
  assert.equal(await reloaded.visitorId(sessionRequest), null);
  const rotatedRequest = request('/api/auth/session', { cookie: rotatedPair });
  assert.equal(await reloaded.visitorId(rotatedRequest), previousId);
  const logOut = await reloaded.handle(request('/api/auth/logout', { cookie: rotatedPair, body: {} }));
  assert.equal(logOut.status, 200);
  assert.deepEqual(await logOut.json(), { username: null });
  assert.match(logOut.headers.get('Set-Cookie'), /^__Host-edh_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(await reloaded.visitorId(rotatedRequest), null);
});

test('requires trusted origin, JSON and HTTPS except local development; invalid credentials look alike', async t => {
  const { auth } = await setup(t);
  assert.equal(await auth.handle(request('/api/catalog/search', { body: {} })), null);
  const wrongMethod = await auth.handle(request('/api/auth/login'));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'POST');
  for (const options of [
    { origin: 'https://wrong.test' }, { origin: null }, { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ]) {
    assert.equal((await auth.handle(request('/api/auth/register', { body: credentials, ...options }))).status, 403);
  }
  assert.equal((await auth.handle(request('/api/auth/register', { body: credentials, headers: { 'Content-Type': 'text/plain' } }))).status, 415);
  assert.equal((await auth.handle(request('/api/auth/register', { body: { ...credentials, ignored: 'x'.repeat(4200) } }))).status, 413);
  assert.equal((await auth.handle(request('/api/auth/register', { body: credentials, base: 'http://192.0.2.123' }))).status, 403);
  const local = { base: 'http://127.0.0.1:4173' };
  const registered = await auth.handle(request('/api/auth/register', { ...local, body: credentials }));
  const cookie = registered.headers.get('Set-Cookie');
  assert.match(cookie, /^edh_dev_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
  assert.equal(await auth.visitorId(request('/api/auth/session', { cookie: cookie.split(';')[0] })), null);
  const wrongPassword = await auth.handle(request('/api/auth/login', { body: { ...credentials, password: credentials.password.trim() } }));
  const missingAccount = await auth.handle(request('/api/auth/login', { body: { ...credentials, username: '陌生玩家' } }));
  assert.equal(wrongPassword.status, 401);
  assert.equal(missingAccount.status, 401);
  assert.deepEqual(await wrongPassword.json(), await missingAccount.json());
});

test('expired and ambiguous session cookies do not authenticate, and registration attempts are rate-limited per network', async t => {
  const { db, auth } = await setup(t);
  const firstClient = { clientAddress: '2001:db8::1' };
  const sameNetwork = { clientAddress: '2001:0db8:0:0:12::1' };
  const otherNetwork = { clientAddress: '2001:db8:1::1' };
  const registered = await auth.handle(request('/api/auth/register', { body: credentials }), firstClient);
  const cookie = registered.headers.get('Set-Cookie').split(';')[0];
  const another = `__Host-edh_session=${randomBytes(32).toString('base64url')}`;
  assert.equal(await auth.visitorId(request('/api/auth/session', { cookie: `${cookie}; ${another}` })), null);
  assert.ok(await auth.visitorId(request('/api/auth/session', { cookie })));
  await db.prepare('UPDATE standalone_auth_sessions SET expires_at = ?').bind(0).run();
  assert.equal(await auth.visitorId(request('/api/auth/session', { cookie })), null);

  for (let i = 0; i < 4; i++) {
    assert.equal((await auth.handle(request('/api/auth/register', { body: {} }), firstClient)).status, 400);
  }
  const limited = await auth.handle(request('/api/auth/register', { body: {} }), sameNetwork);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal((await auth.handle(request('/api/auth/register', { body: {} }), otherNetwork)).status, 400);
});

test('simultaneous registrations for a normalized username commit only one account and session', async t => {
  const { db, auth } = await setup(t);
  const responses = await Promise.all(['牌手_A', ' 牌手_ａ '].map(username =>
    auth.handle(request('/api/auth/register', { body: { ...credentials, username } }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const winner = responses.find(response => response.status === 201);
  const cookie = winner.headers.get('Set-Cookie').split(';')[0];
  assert.ok(await auth.visitorId(request('/api/auth/session', { cookie })));
  assert.equal((await db.prepare('SELECT count(*) AS count FROM standalone_auth_accounts').first()).count, 1);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM standalone_auth_sessions').first()).count, 1);
});
