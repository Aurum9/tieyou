import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteCatalog } from '../web/lib/remote-catalog.js';

const card = { id: 'oracle-a', name: 'Alpha', defaultVersionId: 'a-1', faces: [{ name: 'Alpha' }], versions: [{ id: 'a-1', set: 'tst', collectorNumber: '1' }] };
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) }; }
function client(handler) {
  const calls = [];
  const remote = createRemoteCatalog({ fetcher: async (url, options) => {
    const call = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
    return handler(call, calls.length);
  } });
  return { remote, calls };
}

test('remote searches request one page and keep the default legality and sorting explicit', async () => {
  const { remote, calls } = client(() => response({ cards: [card], total: 200, offset: 48, limit: 48, hasMore: true }));
  const result = await remote.search({ query: '精灵', offset: 48 });
  assert.equal(result.total, 200); assert.equal(result.cards.length, 1); assert.equal(result.hasMore, true);
  assert.deepEqual(calls[0].body, { query: '精灵', sort: 'name', commanderOnly: true, offset: 48, limit: 48 });
  assert.equal(calls[0].url, '/api/catalog/search'); assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(remote.cachedCards().length, 1);
});

test('a search summary does not satisfy deck core data and batch requests include selected printings', async () => {
  const { remote, calls } = client(call => response(call.url.endsWith('/search')
    ? { cards: [card], total: 1 }
    : { cards: [{ ...card, faces: [{ name: 'Alpha', oracleText: 'A deck can have any number of cards named Alpha.' }] }] }));
  await remote.search({ query: 'Alpha' });
  const [core] = await remote.getCards(['oracle-a', 'oracle-a'], { versions: [{ cardId: 'oracle-a', versionId: 'a-1' }] });
  assert.match(core.faces[0].oracleText, /any number/);
  assert.deepEqual(calls[1].body, { ids: ['oracle-a'], versions: [{ cardId: 'oracle-a', versionId: 'a-1' }] });
  await remote.getCards(['oracle-a']);
  assert.equal(calls.length, 2, 'core data is reused without another batch request');
});

test('additional selected printings are fetched without erasing earlier versions', async () => {
  const { remote, calls } = client((call, count) => response({ cards: [{ ...card, versions: count === 1 ? card.versions : [{ id: 'a-2', set: 'two', collectorNumber: '9' }] }] }));
  await remote.getCards(['oracle-a']);
  const [ready] = await remote.getCards(['oracle-a'], { versions: [{ cardId: 'oracle-a', versionId: 'a-2' }] });
  assert.deepEqual(ready.versions.map(version => version.id), ['a-1', 'a-2']);
  assert.equal(calls.length, 2);
});

test('complete details are deduplicated and later summaries preserve rules and full versions', async () => {
  const full = { ...card, versions: [...card.versions, { id: 'a-2' }], faces: [{ name: 'Alpha', oracleText: 'Draw a card.', zhText: '抓一张牌。' }] };
  const { remote, calls } = client(call => response(call.method === 'GET' ? { card: full } : { cards: [card], total: 1 }));
  const [first, second] = await Promise.all([remote.detail('oracle-a'), remote.detail('oracle-a')]);
  assert.equal(calls.length, 1); assert.deepEqual(first, second);
  await remote.search({ query: 'Alpha' });
  const ready = await remote.detail('oracle-a');
  assert.equal(calls.length, 2); assert.equal(ready.versionsComplete, true);
  assert.equal(ready.versions.length, 2); assert.equal(ready.faces[0].zhText, '抓一张牌。');
  await remote.getCards(['oracle-a']); assert.equal(calls.length, 2);
});

test('matching search versions stay attached to that result and do not leak into deck cache', async () => {
  const { remote } = client(() => response({ cards: [{ ...card, matchingVersions: [{ id: 'a-2' }], matchingVersionIds: ['a-2'] }], total: 1 }));
  const result = await remote.search({ query: 'set:two' });
  assert.deepEqual(result.cards[0].matchingVersions, [{ id: 'a-2' }]);
  assert.equal(remote.cachedCards()[0].matchingVersions, undefined);
  assert.equal(remote.cachedCards()[0].matchingVersionIds, undefined);
});

test('suggestions and text imports use service endpoints without requesting any static catalog shards', async () => {
  const { remote, calls } = client(call => response({ cards: [card], total: 1, ...(call.url.endsWith('/resolve') ? { rows: [{ status: 'ready', cardId: 'oracle-a' }] } : {}) }));
  await remote.suggest('Alpha', { colorIdentity: [], limit: 8 });
  const imported = await remote.resolveText('1 Alpha');
  assert.deepEqual(calls[0].body, { query: 'Alpha', colorIdentity: [], limit: 8 });
  assert.deepEqual(calls[1].body, { text: '1 Alpha' }); assert.equal(imported.rows[0].cardId, 'oracle-a');
  await remote.getCards(['oracle-a']); assert.equal(calls.length, 2, 'resolved import cards already include their core data');
  assert.ok(calls.every(call => call.url.startsWith('/api/catalog/')));
});

test('metadata is shared, failed metadata is retryable, and empty decks need no request', async () => {
  const { remote, calls } = client((call, count) => count === 1 ? response({ error: { message: '准备中', code: 'CATALOG_NOT_READY' } }, 503) : response({ counts: { cards: 33708 }, sets: [], subtypes: [] }));
  await assert.rejects(remote.meta(), error => error.code === 'CATALOG_NOT_READY' && error.status === 503);
  const [a, b] = await Promise.all([remote.meta(), remote.meta()]);
  assert.deepEqual(a, b); assert.equal(calls.length, 2);
  assert.deepEqual(await remote.getCards([]), []); assert.equal(calls.length, 2);
});

test('service query errors retain source position and network failures never fall back to bulk data', async () => {
  const invalid = client(() => response({ error: { message: '条件缺失', code: 'INVALID_QUERY', rawPosition: 3 } }, 400));
  await assert.rejects(invalid.remote.search({ query: 'mv:' }), error => error.message === '条件缺失' && error.position === 3);
  const calls = [];
  const offline = createRemoteCatalog({ fetcher: async url => { calls.push(url); throw new TypeError('Offline'); } });
  await assert.rejects(offline.search({ query: 'Elf' }), /暂时无法连接/);
  assert.deepEqual(calls, ['/api/catalog/search']);
});

test('request cancellation is propagated to the fetcher and preserved as AbortError', async () => {
  const controller = new AbortController(); controller.abort();
  const remote = createRemoteCatalog({ fetcher: async (url, options) => { assert.equal(options.signal, controller.signal); throw new DOMException('Aborted', 'AbortError'); } });
  await assert.rejects(remote.search({ query: 'Elf', signal: controller.signal }), error => error.name === 'AbortError');
});

test('unknown card identities remain explicit errors even when a search summary was previously cached', async () => {
  const { remote } = client(call => response(call.url.endsWith('/search') ? { cards: [card], total: 1 } : { cards: [] }));
  await remote.search({ query: 'Alpha' });
  await assert.rejects(remote.getCards(['oracle-a', 'removed-card']), error => {
    assert.equal(error.code, 'CARD_NOT_FOUND');
    assert.deepEqual(error.missingIds, ['oracle-a', 'removed-card']);
    return true;
  });
  assert.equal(remote.cachedCards()[0].id, 'oracle-a', 'an unsuccessful lookup does not erase the cached summary');
});

test('missing selected printings produce an error rather than silently replacing them with the default', async () => {
  const { remote } = client(() => response({ cards: [card] }));
  await assert.rejects(remote.getCards(['oracle-a'], { versions: [{ cardId: 'oracle-a', versionId: 'removed-printing' }] }), error => {
    assert.equal(error.code, 'VERSION_NOT_FOUND');
    assert.deepEqual(error.missingVersions, [{ cardId: 'oracle-a', versionId: 'removed-printing' }]);
    assert.match(error.message, /Alpha \/ removed-printing/); return true;
  });
  assert.deepEqual(remote.cachedCards()[0].versions, card.versions);
});

test('large backups are split into service-sized batches while keeping identity order and deduplicating references', async () => {
  const ids = Array.from({ length: 1250 }, (_, i) => `oracle-${i}`);
  const versions = ids.map((cardId, i) => ({ cardId, versionId: `printing-${i}` }));
  const { remote, calls } = client(call => response({ cards: call.body.ids.map(id => ({ id, name: id, versions: call.body.versions.filter(version => version.cardId === id).map(version => ({ id: version.versionId })) })) }));
  const result = await remote.getCards([...ids, ids[0]], { versions: [...versions, versions[0]] });
  assert.deepEqual(result.map(row => row.id), ids);
  assert.deepEqual(calls.map(call => call.body.ids.length), [500, 500, 250]);
  assert.ok(calls.every(call => call.body.versions.length <= 500));
  assert.equal(calls.flatMap(call => call.body.versions).length, 1250);
});

test('one identity with more than 500 requested printings is split without losing any version', async () => {
  const versions = Array.from({ length: 1001 }, (_, i) => ({ cardId: card.id, versionId: `printing-${i}` }));
  const { remote, calls } = client(call => response({ cards: [{ ...card, versions: [...card.versions, ...call.body.versions.map(version => ({ id: version.versionId }))] }] }));
  const [ready] = await remote.getCards([card.id], { versions });
  assert.deepEqual(calls.map(call => call.body.versions.length), [500, 500, 1]);
  assert.ok(calls.every(call => call.body.ids.length === 1));
  assert.ok(versions.every(selected => ready.versions.some(version => version.id === selected.versionId)));
});

test('a failed batch preserves successful data and retries only identities that still need core data', async () => {
  const ids = Array.from({ length: 1100 }, (_, i) => `oracle-${i}`);
  const { remote, calls } = client((call, count) => count === 2
    ? response({ error: { code: 'CATALOG_NOT_READY', message: '稍后重试' } }, 503)
    : response({ cards: call.body.ids.map(id => ({ id, name: id, versions: [] })) }));
  await assert.rejects(remote.getCards(ids), error => error.code === 'CATALOG_NOT_READY' && error.status === 503);
  assert.equal(remote.cachedCards().length, 500);
  const result = await remote.getCards(ids);
  assert.equal(result.length, 1100); assert.equal(calls.length, 4);
  assert.equal(calls[2].body.ids[0], 'oracle-500'); assert.equal(calls[3].body.ids[0], 'oracle-1000');
});
