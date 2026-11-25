import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createStandaloneAuth } from '../scripts/standalone-auth.mjs';
import { createTagAdminService } from '../scripts/standalone-tag-admin.mjs';
import { applyTagOverrides, applyTagAliases, visibleTagLabel, localizedTagSlugs, DEFAULT_TAG_NAMES } from '../web/lib/tag-names.js';
import { searchCards } from '../web/lib/search.js';

const origin = 'https://example.test';
async function setup(t, local = false) {
  const db = openLocalD1(); t.after(() => { db.close(); applyTagOverrides({}); applyTagAliases({}); });
  const auth = await createStandaloneAuth(db);
  await db.exec(await readFile(new URL('../drizzle/0006_tag_settings.sql', import.meta.url), 'utf8'));
  await db.exec("CREATE TABLE catalog_state(id INTEGER,active_version TEXT); INSERT INTO catalog_state VALUES(1,'snapshot'); CREATE TABLE catalog_tags(version TEXT,card_id TEXT,slug TEXT); INSERT INTO catalog_tags VALUES('snapshot','card-a','ramp'),('snapshot','card-b','ramp'),('snapshot','card-a','extra-tag'),('snapshot','card-c','tag-a'),('snapshot','card-c','tag alias');");
  const cookies = [];
  for (const username of ['黄金九', '其他玩家']) {
    const response = await auth.handle(new Request(origin + '/api/auth/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'tag-admin-test-password' }) }));
    assert.equal(response.status, 201); cookies.push(response.headers.get('Set-Cookie').split(';')[0]);
  }
  const readVocabulary = async () => [{ slug: 'ramp', label: 'ramp', parentSlugs: [], aliases: ['mana ramp'], description: 'Mana acceleration.' }, { slug: 'tag-a', label: 'Tag A', parentSlugs: ['ramp'], aliases: ['tag alias'], description: 'Original explanation.' }, { slug: 'tag-b', label: 'Tag B', parentSlugs: ['ramp', 'tag-a'], aliases: [] }];
  const service = await createTagAdminService(db, auth, { local, readVocabulary });
  const request = (path, { who, method = 'GET', body, headers = {} } = {}) => new Request(origin + path, { method, headers: { Origin: origin, ...(who === undefined ? {} : { Cookie: cookies[who] }), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { db, auth, service, request, readVocabulary };
}
test('only the authenticated 黄金九 account can manage public deployment; client identity and loopback URLs do not bypass it', async t => {
  const { service, request } = await setup(t);
  assert.equal((await (await service.handle(request('/api/admin/tags/access'))).json()).allowed, false);
  assert.equal((await service.handle(request('/api/admin/tags'))).status, 403);
  assert.equal((await service.handle(request('/api/admin/tags', { who: 1, headers: { 'oai-authenticated-user-id': encodeURIComponent('黄金九'), 'X-Admin': encodeURIComponent('黄金九') } }))).status, 403);
  assert.equal((await (await service.handle(request('/api/admin/tags/access', { who: 0 }))).json()).allowed, true);
  assert.equal((await service.handle(request('/api/admin/tags', { who: 0 }))).status, 200);
  assert.equal((await service.handle(new Request('http://127.0.0.1/api/admin/tags'))).status, 403);
  assert.equal((await service.handle(request('/api/tag-settings'))).status, 200);
});
test('local development permits logged-out editing, preserves hierarchy and counts, and saves across service restarts', async t => {
  const { db, auth, service, request, readVocabulary } = await setup(t, true);
  const all = await (await service.handle(request('/api/admin/tags'))).json();
  assert.deepEqual(all.rows.find(row => row.slug === 'tag-b').parentSlugs, ['ramp', 'tag-a']);
  assert.equal(all.rows.find(row => row.slug === 'ramp').cardCount, 2);
  assert.ok(all.rows.some(row => row.slug === 'extra-tag'));
  assert.equal(all.rows.find(row => row.slug === 'tag-a').cardCount, 1); assert.ok(!all.rows.some(row => row.slug === 'tag alias'));
  const response = await service.handle(request('/api/admin/tags', { method: 'PUT', body: { revision: 0, changes: [{ slug: 'tag-a', label: '手工译名', visible: true }, { slug: 'ramp', label: '法术力加速', visible: false }] } }));
  assert.equal(response.status, 200); assert.equal(visibleTagLabel('tag-a'), '手工译名'); assert.equal(visibleTagLabel('ramp'), '');
  assert.deepEqual(localizedTagSlugs('手工译名'), ['tag-a']); assert.equal(visibleTagLabel('tag alias'), '手工译名');
  assert.equal(searchCards([{id:'alias-card',name:'Alias',tags:['tag alias'],legalities:{commander:'legal'}}], 'otag:手工译名').cards.length, 1); assert.ok(localizedTagSlugs('法术力加速').includes('ramp'));
  const restarted = await createTagAdminService(db, auth, { local: true, readVocabulary });
  const saved = await (await restarted.handle(request('/api/tag-settings'))).json(); assert.equal(saved.revision, 1); assert.equal(saved.overrides['tag-a'].label, '手工译名');
  assert.equal(saved.overrides.ramp.visible, false);
});
test('stale saves never partly overwrite other tags; malformed, unknown and cross-site changes are rejected', async t => {
  const { service, request } = await setup(t);
  const put = (revision, changes, headers) => service.handle(request('/api/admin/tags', { who: 0, method: 'PUT', body: { revision, changes }, headers }));
  assert.equal((await put(0, [{ slug: 'tag-a', label: '甲', visible: true }])).status, 200);
  assert.equal((await put(0, [{ slug: 'tag-b', label: '不应写入', visible: true }])).status, 409);
  const saved = await (await service.handle(request('/api/tag-settings'))).json(); assert.equal(saved.overrides['tag-b'], undefined);
  for (const change of [{ slug: 'unknown', label: '甲', visible: true }, { slug: 'tag-b', label: '', visible: true }, { slug: 'tag-b', label: 'x'.repeat(101), visible: false }, { slug: 'tag-b', label: '甲\n乙', visible: false }]) assert.equal((await put(1, [change])).status, 400);
  assert.equal((await put(1, [{ slug: 'tag-b', label: '甲', visible: true }], { Origin: 'https://other.test' })).status, 403);
  assert.equal((await service.handle(request('/api/admin/tags', { who: 1, method: 'PUT', body: { revision: 1, changes: [{ slug: 'ramp', label: '伪造', visible: true }] } }))).status, 403);
});
test('renaming and hiding change all public labels without breaking explicit English tags or Chinese search aliases', () => {
  const original = DEFAULT_TAG_NAMES.ramp;
  try {
    applyTagOverrides({ ramp: { label: '新加速译名', visible: true } }); assert.equal(visibleTagLabel('ramp'), '新加速译名');
    assert.ok(localizedTagSlugs(original).includes('ramp')); assert.ok(localizedTagSlugs('新加速译名').includes('ramp'));
    applyTagOverrides({ ramp: { label: '新加速译名', visible: false } }); assert.equal(visibleTagLabel('ramp'), '');
    const cards = [{ id: 'a', name: 'Mana', typeLine: 'Artifact', tags: ['ramp'], manaValue: 1, colorIdentity: [], legalities: { commander: 'legal' } }];
    assert.equal(searchCards(cards, 'otag:ramp').cards.length, 1);
    assert.equal(searchCards(cards, 'otag:新加速译名').cards.length, 1);
  } finally { applyTagOverrides({}); }
});
