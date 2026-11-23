import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createClientUsage, clientDay } from '../scripts/client-usage.mjs';
import { createClientReporter, clientHeaders } from '../web/lib/client-usage.js';

const id = 'c04af680-8822-4ea5-b95b-ec675099a34f';
const origin = 'https://example.test';
const request = (path, body, headers = {}) => new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'tieyou-client-usage-')), policyPath = join(folder, 'policy.json'), releasePath = join(folder, 'android.json');
  const db = openLocalD1(); let time = Date.parse('2026-11-24T10:00:00+08:00');
  await writeFile(releasePath, JSON.stringify({ versionName: '0.2.2' }));
  const service = await createClientUsage(db, { policyPath, releasePath, now: () => time });
  t.after(async () => { db.close(); assert.equal(dirname(folder), resolve(tmpdir())); await rm(folder, { recursive: true, force: true }); });
  return { db, service, policyPath, next: milliseconds => { time += milliseconds; } };
}

test('anonymous startup deduplicates devices, updates versions and preserves first seen across days', async t => {
  const { db, service, next } = await fixture(t);
  for (const version of ['0.2.2', '0.2.2', '0.2.3']) assert.equal((await service.handle(request('/api/client/heartbeat', { installId: id, version }), { clientAddress: 'test' })).status, 200);
  let rows = await db.prepare('SELECT * FROM client_usage_installations').all();
  assert.equal(rows.results.length, 1); assert.equal(rows.results[0].version_name, '0.2.3'); assert.notEqual(rows.results[0].install_key, id);
  const first = rows.results[0].first_seen;
  assert.equal((await db.prepare('SELECT * FROM client_usage_daily').all()).results.length, 1);
  next(86400000); await service.handle(request('/api/client/heartbeat', { installId: id, version: '0.2.3' }));
  assert.equal((await db.prepare('SELECT * FROM client_usage_daily').all()).results.length, 2);
  assert.equal((await db.prepare('SELECT * FROM client_usage_installations').first()).first_seen, first);
  assert.equal(clientDay(Date.parse('2026-11-24T16:01:00Z')), '2026-11-25');
});
test('startup rejects malformed, oversized and cross-origin data and exposes no statistics endpoint', async t => {
  const { service } = await fixture(t);
  for (const body of [null, [], {}, { installId: [id], version: '0.2.2' }, { installId: id, version: 'arbitrary' }]) assert.equal((await service.handle(request('/api/client/heartbeat', body))).status, 400);
  assert.equal((await service.handle(request('/api/client/heartbeat', { installId: id, version: '0.2.2' }, { origin: 'https://other.test' }))).status, 403);
  assert.equal((await service.handle(request('/api/client/heartbeat', { long: 'x'.repeat(2000) }))).status, 413);
  assert.equal(await service.handle(request('/api/client/stats')), null);
});
test('protocol gate is off by default, can be scheduled or rolled back, and preserves login and deck sync', async t => {
  const { service, policyPath, next } = await fixture(t);
  assert.equal(await service.handle(request('/api/catalog/search', { query: 'draw' })), null);
  await writeFile(policyPath, JSON.stringify({ minimumProtocol: 1, enforce: true, enforceAt: '2026-11-24T11:00:00+08:00' })); next(3000);
  assert.equal(await service.handle(request('/api/catalog/search', {})), null);
  next(3600000);
  const blocked = await service.handle(request('/api/catalog/search', {})); assert.equal(blocked.status, 426); assert.equal((await blocked.json()).error.code, 'CLIENT_UPGRADE_REQUIRED');
  assert.equal(await service.handle(request('/api/catalog/search', {}, { 'X-Tieyou-Protocol': '1' })), null);
  assert.equal(await service.handle(request('/api/auth/login', {})), null);
  assert.equal(await service.handle(request('/api/deck-library', {})), null);
  await writeFile(policyPath, '{broken'); next(3000); assert.equal(await service.handle(request('/api/catalog/search', {})), null);
});
test('download counters separate versions and ignore unrelated URLs', async t => {
  const { db, service } = await fixture(t);
  await service.recordDownload('/downloads/tieyou-android.apk', 100);
  await service.recordDownload('/downloads/tieyou-android-0.2.2.apk', 100);
  await service.recordDownload('/downloads/tieyou-web-test.zip', 9999);
  const rows = (await db.prepare('SELECT * FROM client_download_daily').all()).results;
  assert.equal(rows.length, 1); assert.equal(rows[0].responses, 2); assert.equal(rows[0].bytes, 200); assert.equal(rows[0].version_name, '0.2.2');
});
test('client sends at most once daily or after an upgrade, retries failure and respects opt out', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let time = Date.parse('2026-11-24T00:00:00Z'), calls = [], fail = false;
  const fetcher = async (url, options) => { calls.push({ url, options }); if (fail) throw new Error('offline'); return { ok: true }; };
  const reporter = createClientReporter({ storage, version: '0.2.2', now: () => time, uuid: () => id, fetcher });
  await reporter.report(); await reporter.report(); assert.equal(calls.length, 1); assert.equal(calls[0].options.credentials, 'omit');
  reporter.setEnabled(false); time += 86400000; await reporter.report(); assert.equal(calls.length, 1);
  reporter.setEnabled(true); fail = true; await reporter.report(); await reporter.report(); assert.equal(calls.length, 2);
  time += 300001; fail = false; await reporter.report(); assert.equal(calls.length, 3);
  const upgrade = createClientReporter({ storage, version: '0.2.3', now: () => time, fetcher }); await upgrade.report();
  assert.equal(JSON.parse(calls.at(-1).options.body).installId, id); assert.equal(calls.length, 4);
  assert.equal(clientHeaders()['X-Tieyou-Protocol'], '1');
});
