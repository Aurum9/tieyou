import { newId, STORAGE_KEY, validateDeckLibrary } from './decks.js';

const OWNER_KEY = `${STORAGE_KEY}.owner`;
const CACHE_PREFIX = `${STORAGE_KEY}.account.`;
const ROUTE = '/api/deck-library';
const emptyLibrary = () => ({ version: 1, decks: [], trash: [] });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function deviceDeckStorageKey() {
  try {
    if (globalThis.localStorage?.getItem(OWNER_KEY)) return `${STORAGE_KEY}.guest`;
  } catch { /* DeckStore reports unavailable storage. */ }
  return STORAGE_KEY;
}

function records(library) {
  return new Map([
    ...library.decks.map(deck => [deck.id, { deck }]),
    ...library.trash.map(item => [item.deck.id, item]),
  ]);
}

function conflictCopy(item) {
  const suffix = ' · 同步副本';
  return {
    ...item,
    deck: {
      ...item.deck,
      id: newId(),
      name: item.deck.name.slice(0, 200 - suffix.length) + suffix,
    },
  };
}

export function mergeDeckLibraries(base, local, remote) {
  const originals = records(base), ours = records(local), theirs = records(remote);
  const merged = emptyLibrary();
  function add(item) {
    if (!item) return;
    if (item.deletedAt) merged.trash.push(item);
    else merged.decks.push(item.deck);
  }
  for (const id of new Set([...theirs.keys(), ...ours.keys()])) {
    const original = originals.get(id), left = ours.get(id), right = theirs.get(id);
    if (same(left, right) || same(right, original)) add(left);
    else if (same(left, original)) add(right);
    else if (left?.deletedAt && right?.deletedAt && same(left.deck, right.deck)) add(right);
    else if (left?.deletedAt && right && !right.deletedAt) {
      add(left);
      add(conflictCopy(right));
    } else {
      add(right);
      if (left) add(conflictCopy(left));
    }
  }
  return merged;
}

function readSnapshot(data) {
  if (typeof data?.account !== 'string' || !/^[a-f0-9]{64}$/.test(data.account)
    || !Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('云端卡组响应无效');
  return { account: data.account, revision: data.revision, library: validateDeckLibrary(data.library) };
}

export function createDeckSync(store, {
  onStatusChange, onLibraryChange, canPull = () => true, fetcher = globalThis.fetch,
} = {}) {
  let status = { state: 'loading', message: '正在读取云端卡组…' };
  let checkpoint, active, timer, started = false, disposed = false, accountChanged = false, signedOut = false;
  let retryDelay = 1000;
  const storage = store.storage;

  function show(state, message) {
    status = { state, message };
    onStatusChange?.(status);
  }

  function persist(next) {
    storage?.setItem(CACHE_PREFIX + next.account, JSON.stringify(next));
    checkpoint = next;
  }

  function apply(snapshot, library) {
    const previous = store.state;
    persist({ ...snapshot, local: library });
    if (!same(previous, library)) {
      store.replaceFromSync(library);
      onLibraryChange?.(previous, store.state);
    }
  }

  function cached(account) {
    const key = CACHE_PREFIX + account;
    const raw = storage?.getItem(key);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      const snapshot = readSnapshot(data);
      if (snapshot.account !== account) throw new Error('账号不匹配');
      return { ...snapshot, local: validateDeckLibrary(data.local) };
    } catch {
      storage.setItem(`${key}.recovery-${Date.now()}`, raw);
      return null;
    }
  }

  function bind(snapshot) {
    const { account } = snapshot;
    const existing = cached(account);
    const owner = storage?.getItem(OWNER_KEY);
    let library;
    if (existing) {
      library = mergeDeckLibraries(existing.library, existing.local, snapshot.library);
    } else {
      let legacy = emptyLibrary();
      if (storage && (!owner || owner === account)) {
        if (!owner) storage.setItem(OWNER_KEY, account);
        if (store.key === STORAGE_KEY && !store.loadBlocked) legacy = store.state;
        else {
          const raw = storage.getItem(STORAGE_KEY);
          if (raw) {
            try { legacy = validateDeckLibrary(JSON.parse(raw)); }
            catch { /* The device's original file stays available through local recovery. */ }
          }
        }
      }
      library = mergeDeckLibraries(emptyLibrary(), legacy, snapshot.library);
    }
    apply(snapshot, library);
    store.setSyncStorage(local => persist({ ...checkpoint, local }));
  }

  async function request(method, body) {
    const response = await fetcher(ROUTE, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 404) return { signedOut: true };
    const data = await response.json();
    if (response.ok) return { snapshot: readSnapshot(data) };
    if (response.status === 409 && data.error?.code === 'REVISION_CONFLICT') {
      return { snapshot: readSnapshot(data), conflict: true };
    }
    if (data.error?.code === 'ACCOUNT_CHANGED') return { changed: true };
    const error = new Error(data.error?.message || '网络暂时不可用');
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }

  function schedule(delay = 350) {
    clearTimeout(timer);
    if (!disposed && !accountChanged) timer = setTimeout(() => { void sync(false); }, delay);
  }

  function checkAccount(result) {
    if (result.signedOut && !checkpoint) {
      signedOut = true;
      show('local', '保存在此浏览器');
      return false;
    }
    if (result.signedOut || result.changed || (checkpoint && result.snapshot.account !== checkpoint.account)) {
      accountChanged = true;
      show('error', '登录状态已更改，请刷新页面');
      return false;
    }
    return true;
  }

  async function exchange(pull) {
    if (store.loadBlocked) {
      show('local', '请先处理本地卡组恢复');
      return;
    }
    if (!checkpoint || pull && same(checkpoint.library, store.state)) {
      const result = await request('GET');
      if (disposed || !checkAccount(result)) return;
      signedOut = false;
      const snapshot = result.snapshot;
      if (!checkpoint) bind(snapshot);
      else if (snapshot.revision !== checkpoint.revision) {
        apply(snapshot, mergeDeckLibraries(checkpoint.library, store.state, snapshot.library));
      }
    }
    for (let attempt = 0; !disposed && !same(checkpoint.library, store.state); attempt++) {
      if (attempt >= 5) throw new Error('云端卡组正在更新');
      const { account, revision, library: base } = checkpoint;
      const sent = store.state;
      const result = await request('PUT', { account, revision, library: sent });
      if (disposed || !checkAccount(result)) return;
      const snapshot = result.snapshot;
      const current = store.state;
      // A reply lost after a successful PUT can present the sent data as a conflict.
      const mergeBase = !result.conflict || same(sent, snapshot.library) ? sent : base;
      apply(snapshot, mergeDeckLibraries(mergeBase, current, snapshot.library));
    }
    if (!disposed) show('saved', '卡组已同步');
  }

  function sync(pull = true) {
    if (disposed) return Promise.resolve();
    if (accountChanged) {
      if (pull) globalThis.location?.reload();
      return Promise.resolve();
    }
    if (active) return active;
    clearTimeout(timer);
    show('syncing', '正在同步卡组…');
    active = exchange(pull).then(() => { retryDelay = 1000; }).catch(error => {
      if (disposed) return;
      show('error', `卡组同步失败：${error.message}`);
      if (error.retryable !== false) {
        schedule(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
    }).finally(() => { active = null; });
    return active;
  }

  function onCommit() {
    if (disposed || accountChanged || signedOut) return;
    show('syncing', '有卡组待同步');
    schedule();
  }
  function syncOnReturn() {
    if (globalThis.document?.hidden || accountChanged) return;
    if (!checkpoint || !same(checkpoint.library, store.state)) void sync(false);
    else if (canPull()) void sync();
  }
  return {
    get status() { return status; },
    get canEdit() { return !accountChanged && (store.key === STORAGE_KEY || Boolean(checkpoint) || signedOut); },
    start() {
      if (started) return active;
      started = true;
      store.onCommit = onCommit;
      globalThis.window?.addEventListener('online', syncOnReturn);
      globalThis.window?.addEventListener('focus', syncOnReturn);
      globalThis.document?.addEventListener('visibilitychange', syncOnReturn);
      return sync();
    },
    sync,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      if (store.onCommit === onCommit) store.onCommit = undefined;
      globalThis.window?.removeEventListener('online', syncOnReturn);
      globalThis.window?.removeEventListener('focus', syncOnReturn);
      globalThis.document?.removeEventListener('visibilitychange', syncOnReturn);
    },
  };
}
