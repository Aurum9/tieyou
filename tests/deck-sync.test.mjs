import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckStore, STORAGE_KEY, createDeck } from '../web/lib/decks.js';
import { createDeckSync, deviceDeckStorageKey, mergeDeckLibraries } from '../web/lib/deck-sync.js';

const library = (...decks) => ({ version: 1, decks, trash: [] });
function memory() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

function server(account = 'a'.repeat(64)) {
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

test('login automatically claims device guest decks even when the account already has an empty cache', async () => {
  const storage = memory(), cloud = server(), account = 'a'.repeat(64);
  const source = createDeck('未登录时组的牌'), privateDeck = createDeck('另一账号的私有卡组');
  storage.setItem(STORAGE_KEY + '.owner', 'b'.repeat(64));
  storage.setItem(STORAGE_KEY, JSON.stringify(library(privateDeck)));
  storage.setItem(STORAGE_KEY + '.guest', JSON.stringify(library(source)));
  storage.setItem(STORAGE_KEY + '.account.' + account, JSON.stringify({ account, revision: 0, library: library(), local: library() }));
  let store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' });
  let client = createDeckSync(store, { fetcher: cloud.fetch });
  try {
    await client.start(); assert.equal(client.status.state, 'saved'); assert.deepEqual(store.list().map(d => d.name), [source.name]);
    const other = new DeckStore({ storage: memory() }), peer = createDeckSync(other, { fetcher: cloud.fetch });
    await peer.start(); assert.deepEqual(other.list(), store.list()); peer.dispose();
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY + '.guest')).decks[0].name, source.name);
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).decks[0].name, privateDeck.name);
    store.save({ ...store.get(source.id), name: '账号内继续编辑' }); await client.sync(); client.dispose();
    store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' }); client = createDeckSync(store, { fetcher: cloud.fetch });
    await client.start(); assert.deepEqual(store.list().map(d => d.name), ['账号内继续编辑']);
    const secondAccount = server('c'.repeat(64)), secondStore = new DeckStore({ storage, key: STORAGE_KEY + '.guest' });
    const secondClient = createDeckSync(secondStore, { fetcher: secondAccount.fetch });
    await secondClient.start(); assert.deepEqual(secondStore.list(), []); secondClient.dispose();
  } finally { client.dispose(); }
});

test('automatic guest sync keeps conflicting cloud edits and never re-imports stale originals after deletion', async () => {
  const cloud = server(), account = 'a'.repeat(64), storage = memory();
  const source = createDeck('设备版本'), remote = { ...source, name: '云端版本' };
  await cloud.fetch('', { method: 'PUT', body: JSON.stringify({ account, revision: 0, library: library(remote) }) });
  storage.setItem(STORAGE_KEY + '.owner', 'b'.repeat(64)); storage.setItem(STORAGE_KEY + '.guest', JSON.stringify(library(source)));
  let store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' }), client = createDeckSync(store, { fetcher: cloud.fetch });
  try {
    await client.start(); assert.equal(store.list().length, 2); assert.ok(store.list().some(d => d.name === '云端版本')); assert.ok(store.list().some(d => d.name === '设备版本 · 同步副本'));
    store.commit(library()); await client.sync(); client.dispose();
    store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' }); client = createDeckSync(store, { fetcher: cloud.fetch });
    await client.start(); assert.deepEqual(store.list(), []);
  } finally { client.dispose(); }
});

test('a cache write failure preserves device decks and permits a later automatic retry', async () => {
  const base = memory(), cloud = server(), source = createDeck('不能丢失的设备卡组');
  base.setItem(STORAGE_KEY + '.owner', 'b'.repeat(64)); base.setItem(STORAGE_KEY + '.guest', JSON.stringify(library(source)));
  let full = true;
  const storage = { getItem: base.getItem, setItem(key, value) { if (full && key.includes('.account.')) throw new Error('空间不足'); base.setItem(key, value); } };
  let store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' }), client = createDeckSync(store, { fetcher: cloud.fetch });
  try {
    await client.start(); assert.equal(client.status.state, 'error'); assert.equal(JSON.parse(base.getItem(STORAGE_KEY + '.guest')).decks[0].id, source.id); client.dispose();
    full = false; store = new DeckStore({ storage, key: STORAGE_KEY + '.guest' }); client = createDeckSync(store, { fetcher: cloud.fetch });
    await client.start(); assert.equal(client.status.state, 'saved'); assert.equal(store.list()[0].id, source.id);
  } finally { client.dispose(); }
});
