import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckStore, STORAGE_KEY, createDeck } from '../web/lib/decks.js';
import { createDeckSync, deviceDeckStorageKey, mergeDeckLibraries } from '../web/lib/deck-sync.js';

const library = (...decks) => ({ version: 1, decks, trash: [] });
function memory() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

function server() {
  const account = 'a'.repeat(64);
  let revision = 0, data = library();
  const serverState = {
    offline: false,
    fetch: async (_url, request) => {
      if (serverState.offline) throw new Error('离线');
      if (request.method === 'PUT') {
        const next = JSON.parse(request.body);
        assert.equal(next.account, account);
        if (next.revision !== revision) {
          return Response.json({ account, revision, library: data, error: { code: 'REVISION_CONFLICT' } }, { status: 409 });
        }
        data = next.library;
        revision++;
      }
      return Response.json({ account, revision, library: data });
    },
  };
  return serverState;
}

test('merges independent edits and preserves the other version when edits conflict', () => {
  const a = createDeck('A'), b = createDeck('B');
  const base = library(a, b);
  const remote = library({ ...a, name: '远端 A' }, { ...b, name: '远端 B' });
  const local = library({ ...a, name: '本地 A' }, b, createDeck('C'));
  const merged = mergeDeckLibraries(base, local, remote);
  assert.deepEqual(merged.decks.map(deck => deck.name), ['远端 A', '本地 A · 同步副本', '远端 B', 'C']);
  assert.equal(merged.decks[0].id, a.id);
  assert.notEqual(merged.decks[1].id, a.id);
  const removed = { ...library(b), trash: [{ deck: a, deletedAt: a.updatedAt }] };
  const editedWhileDeleted = mergeDeckLibraries(base, removed, remote);
  assert.deepEqual(editedWhileDeleted.trash.map(item => item.deck.id), [a.id]);
  assert.deepEqual(editedWhileDeleted.decks.map(deck => deck.name), ['远端 A · 同步副本', '远端 B']);
});

test('migrates browser decks, syncs to a second device, and resends local edits after an offline reload', async () => {
  const cloud = server();
  const first = memory(), second = memory();
  let store = new DeckStore({ storage: first });
  const original = store.create('浏览器里的旧卡组');
  const originalRaw = first.getItem(STORAGE_KEY);
  let client = createDeckSync(store, { fetcher: cloud.fetch });
  const secondStore = new DeckStore({ storage: second });
  const secondClient = createDeckSync(secondStore, { fetcher: cloud.fetch });
  try {
    await client.start();
    assert.equal(client.status.state, 'saved');
    assert.equal(first.getItem(STORAGE_KEY), originalRaw);
    await secondClient.start();
    assert.equal(secondStore.get(original.id).name, original.name);

    cloud.offline = true;
    store.save({ ...store.get(original.id), name: '本机离线修改' });
    await client.sync();
    assert.equal(client.status.state, 'error');
    client.dispose();
    cloud.offline = false;
    secondStore.save({ ...secondStore.get(original.id), name: '第二台设备修改' });
    await secondClient.sync();

    const savedStorage = globalThis.localStorage;
    let key;
    try { globalThis.localStorage = first; key = deviceDeckStorageKey(); }
    finally { globalThis.localStorage = savedStorage; }
    store = new DeckStore({ storage: first, key });
    client = createDeckSync(store, { fetcher: cloud.fetch });
    await client.start();
    assert.deepEqual(store.list().map(deck => deck.name), ['第二台设备修改', '本机离线修改 · 同步副本']);
    await secondClient.sync();
    assert.deepEqual(secondStore.list(), store.list());
  } finally {
    client.dispose();
    secondClient.dispose();
  }
});
