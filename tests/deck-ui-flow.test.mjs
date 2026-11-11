import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckStore, parseDeckText, exportDeckBackup } from '../web/lib/decks.js';
import { initDeckUI } from '../web/lib/deck-ui.js';

// These flow tests exercise the UI callbacks without requiring a browser runtime.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.className = ''; this.value = ''; this._text = '';
    this.classList = {
      add: name => { this.className = [...new Set([...this.className.split(' '), name])].join(' ').trim(); },
      remove: name => { this.className = this.className.split(' ').filter(part => part !== name).join(' '); },
      toggle: (name, value) => { if (value) this.classList.add(name); else this.classList.remove(name); },
    };
  }
  set textContent(text) { this._text = String(text); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  dispatch(name) { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: this }; for (const handler of this.events[name] || []) handler(event); return event; }
  async dispatchAsync(name) { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: this }; for (const handler of this.events[name] || []) await handler(event); return event; }
  querySelectorAll(selector) { return all(this, node => selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))); }
  focus() { document.activeElement = this; }
  scrollIntoView(options) { this.scrolledIntoView = options; }
  get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
}
function all(root, predicate) { return root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...all(node, predicate)]); }
function fixture({ loadCards, initiallyLoaded = false, initialCards, prepareStore, providers = {} } = {}) {
  globalThis.document = { body: new Element('body'), activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
  const values = new Map(); const storage = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); values.set(key, value); } };
  globalThis.localStorage = storage;
  const store = new DeckStore({ storage }); const first = store.create('甲卡组'), second = store.create('乙卡组');
  const cards = initialCards || Array.from({ length: 12 }, (_, n) => ({ id: `elf-${n}`, name: `Elf ${n}`, zhName: `精灵${n}`, typeLine: 'Creature — Elf', colorIdentity: ['G'], versions: [{ id: `v-${n}`, set: 'abc', collectorNumber: String(n), lang: 'en' }] }));
  prepareStore?.(store, first, cards);
  const container = new Element('main'); document.body.append(container); const notices = [], changes = [], navigation = [], playtests = [];
  let loads = 0;
  const ui = initDeckUI({ container, cards: initiallyLoaded ? cards : [], loadCards: async () => { loads++; return loadCards ? loadCards(cards) : cards; }, onNotify: (...args) => notices.push(args), onLibraryChange: () => changes.push(true), onOpenCatalog: params => navigation.push(params), onPlaytest: deck => playtests.push(deck), ...providers });
  return { ui, container, cards, first, second, storage, notices, changes, navigation, playtests, get loads() { return loads; } };
}
function queryInput(container) { return all(container, node => node.attributes['aria-label'] === '搜索要加入的卡牌')[0]; }
function button(container, text) { return all(container, node => node.tagName === 'button' && node.textContent === text)[0]; }

test('deck library opens without card data and fetches it only when opening an editor', async () => {
  const state = fixture();
  assert.equal(state.loads, 0); assert.match(state.container.textContent, /卡组库/); assert.equal(state.ui.getSelectedDeckId(), null);
  assert.equal(await state.ui.openDeck(state.first.id), true);
  assert.equal(state.loads, 1); assert.equal(state.ui.getSelectedDeckId(), state.first.id);
  state.ui.setCards(state.cards); assert.equal(state.ui.getSelectedDeckId(), state.first.id);
  await state.ui.openDeck(state.second.id); assert.equal(state.loads, 1);
});

test('deck checks disappear when clear and show a specific issue after the card count changes', async () => {
  const initialCards = [
    { id: 'commander', name: 'Commander', typeLine: 'Legendary Creature — Elf', colorIdentity: ['G'], legalities: { commander: 'legal' }, versions: [{ id: 'commander-v', set: 'abc', collectorNumber: '1' }] },
    { id: 'forest', name: 'Forest', typeLine: 'Basic Land — Forest', colorIdentity: ['G'], legalities: { commander: 'legal' }, versions: [{ id: 'forest-v', set: 'abc', collectorNumber: '2' }] },
  ];
  const state = fixture({ initiallyLoaded: true, initialCards, prepareStore(store, deck) {
    store.save({ ...deck, entries: [
      { id: 'commander-entry', cardId: 'commander', versionId: 'commander-v', quantity: 1, zone: 'commander', categories: [], notes: '' },
      { id: 'forest-entry', cardId: 'forest', versionId: 'forest-v', quantity: 99, zone: 'main', categories: [], notes: '' },
    ] });
  } });
  await state.ui.openDeck(state.first.id);
  assert.equal(all(state.container, node => node.className.split(' ').includes('deck-checks')).length, 0);
  const quantity = all(state.container, node => node.attributes['aria-label'] === '数量' && Number(node.value) === 99)[0];
  quantity.value = '98'; quantity.dispatch('change');
  const checks = all(state.container, node => node.className.split(' ').includes('deck-checks'));
  assert.equal(checks.length, 1);
  assert.match(checks[0].textContent, /正式卡组共 99 张，EDH 需要含统帅共 100 张/);
  assert.doesNotMatch(checks[0].textContent, /人工核对|未发现问题|草稿保存/);
});

test('card issues identify and highlight every affected printing and jump to the first row', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const initialCards = [
    { id: 'one', name: 'Spell', typeLine: 'Instant', versions: [{ id: 'one-v' }, { id: 'two-v' }] },
    { id: 'other', name: 'Other', typeLine: 'Creature', versions: [{ id: 'other-v' }] },
  ];
  const state = fixture({ initiallyLoaded: true, initialCards, prepareStore(store, deck) {
    store.save({ ...deck, entries: ['one-v', 'two-v', 'other-v'].map((versionId, i) => ({
      id: `entry-${i}`, cardId: i === 2 ? 'other' : 'one', versionId, quantity: 1, zone: 'main', categories: [], notes: '',
    })) });
  } });
  await state.ui.openDeck(state.first.id);
  const byClass = name => all(state.container, node => node.className.split(' ').includes(name));
  const duplicates = byClass('deck-entry').filter(row => row.textContent.includes('重复'));
  assert.equal(duplicates.length, 2);
  assert.equal(byClass('deck-entry-issue').every(badge => badge.textContent === '重复'), true);
  const jumps = byClass('deck-check-jump');
  assert.equal(jumps.length, 1);
  assert.match(jumps[0].textContent, /所有版本合计/);
  jumps[0].dispatch('click');
  assert.deepEqual(byClass('is-highlighted'), duplicates);
  assert.equal(document.activeElement, duplicates[0]);
  assert.deepEqual(duplicates[0].scrolledIntoView, { block: 'center' });
  t.mock.timers.tick(1800);
  assert.equal(byClass('is-highlighted').length, 0);
});

test('unsupported commander checks do not add generic manual-review disclaimers', async () => {
  const initialCards = [
    { id: 'a', name: 'Commander A', typeLine: 'Legendary Creature', colorIdentity: ['G'], versions: [{ id: 'a-v' }] },
    { id: 'b', name: 'Commander B', typeLine: 'Legendary Creature', colorIdentity: ['G'], versions: [{ id: 'b-v' }] },
    { id: 'forest', name: 'Forest', typeLine: 'Basic Land — Forest', colorIdentity: ['G'], versions: [{ id: 'forest-v' }] },
  ];
  const state = fixture({ initiallyLoaded: true, initialCards, prepareStore(store, deck) {
    store.save({ ...deck, entries: initialCards.map((card, i) => ({ id: card.id, cardId: card.id, versionId: card.versions[0].id, quantity: i === 2 ? 98 : 1, zone: i === 2 ? 'main' : 'commander', categories: [], notes: '' })) });
  } });
  await state.ui.openDeck(state.first.id);
  assert.equal(all(state.container, node => node.className.split(' ').includes('deck-checks')).length, 0);
  assert.doesNotMatch(state.container.textContent, /人工核对|未校验|未发现问题/);
});

test('quick add writes one main-deck card to the explicit target, keeps editor selection, and rejects missing targets', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  assert.equal(state.ui.quickAddCard(state.cards[0], null, state.second.id), true);
  assert.equal(state.ui.getSelectedDeckId(), state.first.id); assert.equal(state.ui.getDeck(state.first.id).entries.length, 0);
  const [entry] = state.ui.getDeck(state.second.id).entries;
  assert.equal(entry.zone, 'main'); assert.equal(entry.quantity, 1); assert.equal(entry.versionId, 'v-0'); assert.equal(state.changes.length, 1);
  assert.equal(state.ui.quickAddCard(state.cards[0], null, 'deleted-deck'), false);
  assert.equal(state.changes.length, 1); assert.equal(all(document.body, node => node.attributes.role === 'dialog').length, 0);
});

test('manual playtest entry receives the fresh selected deck without changing the library', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  state.ui.quickAddCard(state.cards[0], null, state.first.id);
  button(state.container, '手动测试 ↗').dispatch('click');
  assert.equal(state.playtests.length, 1); assert.equal(state.playtests[0].id, state.first.id); assert.equal(state.playtests[0].entries[0].quantity, 1);
  state.playtests[0].entries[0].quantity = 99;
  assert.equal(state.ui.getDeck(state.first.id).entries[0].quantity, 1); assert.equal(state.changes.length, 1);
});

test('live candidate rows replace the redundant submit button and dropdown, keeping direct add and advanced navigation', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  let query = queryInput(state.container); query.value = 'Elf'; query.dispatch('change');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 8);
  assert.equal(all(state.container, node => node.tagName === 'datalist').length, 0);
  assert.equal(query.attributes.list, undefined); assert.equal(button(state.container, '查找卡牌'), undefined);
  assert.match(state.container.textContent, /显示前 8 项 · 共 12 项匹配/);
  button(state.container, '＋ 加入').dispatch('click');
  assert.equal(state.ui.getDeck(state.first.id).entries[0].zone, 'main');
  query = queryInput(state.container); assert.equal(query.value, 'Elf'); assert.equal(all(document.body, node => node.attributes.role === 'dialog').length, 0);
  const submission = all(state.container, node => node.className === 'deck-add-form')[0].dispatch('submit');
  assert.equal(submission.defaultPrevented, true); assert.equal(query.value, 'Elf');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 8);
  button(state.container, '高级搜索 ↗').dispatch('click');
  assert.deepEqual(state.navigation, [{ deckId: state.first.id, query: 'Elf', restrictIdentity: false }]);
  state.ui.showLibrary(); await state.ui.openDeck(state.first.id); assert.equal(queryInput(state.container).value, 'Elf');
});

test('typing updates candidate rows after the debounce and still accepts Chinese names and printing codes', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  let query = queryInput(state.container); query.value = '精灵10'; query.dispatch('input');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 0);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 1);
  button(state.container, '＋ 加入').dispatch('click');
  assert.equal(state.ui.getDeck(state.first.id).entries[0].cardId, 'elf-10');
  query = queryInput(state.container); query.value = 'abc 2'; query.dispatch('change');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 1);
  button(state.container, '＋ 加入').dispatch('click');
  const printingEntry = state.ui.getDeck(state.first.id).entries.find(entry => entry.cardId === 'elf-2');
  assert.equal(printingEntry.versionId, 'v-2'); assert.equal(printingEntry.zone, 'main');
});

test('failed lazy load offers retry and does not open the editor with missing-card warnings', async () => {
  let attempts = 0;
  const state = fixture({ loadCards: cards => { if (++attempts === 1) throw new Error('network unavailable'); return cards; } });
  assert.equal(await state.ui.openDeck(state.first.id), false); assert.match(state.container.textContent, /network unavailable/);
  assert.ok(button(state.container, '重新加载')); assert.equal(queryInput(state.container), undefined);
  assert.equal(await state.ui.openDeck(state.first.id), true); assert.equal(state.loads, 2); assert.ok(queryInput(state.container));
});

test('storage failure leaves the persisted card count and selected editor intact', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id); state.storage.fail = true;
  assert.equal(state.ui.quickAddCard(state.cards[0], null, state.first.id), false);
  assert.equal(state.ui.getDeck(state.first.id).entries.length, 0); assert.equal(state.ui.getSelectedDeckId(), state.first.id); assert.equal(state.changes.length, 0);
  assert.match(state.notices.at(-1)[0], /保存失败/);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function importSource() { return all(document.body, node => node.attributes['aria-label'] === '导入内容')[0]; }

test('remote editor hydration asks for each selected deck and accepts an empty deck without bulk loading', async () => {
  const calls = [];
  const state = fixture({ providers: { loadDeckCards: async deck => { calls.push(deck); return []; } } });
  await state.ui.openDeck(state.first.id); await state.ui.openDeck(state.second.id);
  assert.deepEqual(calls.map(deck => deck.id), [state.first.id, state.second.id]);
  assert.ok(calls.every(deck => deck.entries.length === 0)); assert.equal(state.loads, 0);
  assert.equal(state.ui.getSelectedDeckId(), state.second.id); assert.ok(queryInput(state.container));
});

test('remote mini-search aborts stale requests and keeps the current results after direct add', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred(), second = deferred(), searches = [], batches = [];
  let state;
  state = fixture({ providers: {
    loadDeckCards: async () => [],
    findCandidates: (query, options) => { searches.push({ query, options }); return searches.length === 1 ? first.promise : second.promise; },
    loadCardsByIds: async (ids, options) => { batches.push({ ids, options }); return [state.cards[1]]; },
  } });
  await state.ui.openDeck(state.first.id);
  const query = queryInput(state.container); query.value = 'Elf 0'; query.dispatch('change'); await settle();
  query.value = 'Elf 1'; query.dispatch('change'); await settle();
  assert.equal(searches[0].options.signal.aborted, true);
  const form = all(state.container, node => node.className === 'deck-add-form')[0];
  query.dispatch('change'); form.dispatch('submit'); await settle();
  assert.equal(searches.length, 2);
  second.resolve({ cards: [state.cards[1]], total: 1 }); await settle();
  first.resolve({ cards: [state.cards[0]], total: 1 }); await settle();
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 1);
  assert.ok(button(state.container, '精灵1')); assert.equal(button(state.container, '精灵0'), undefined);
  await button(state.container, '＋ 加入').dispatchAsync('click');
  t.mock.timers.tick(300); await settle();
  assert.equal(searches.length, 2); assert.ok(button(state.container, '精灵1'));
  assert.deepEqual(batches, [{ ids: ['elf-1'], options: { versions: [{ cardId: 'elf-1', versionId: 'v-1' }] } }]);
  assert.equal(state.ui.getDeck(state.first.id).entries[0].cardId, 'elf-1');
  assert.equal(state.ui.getDeck(state.first.id).entries[0].zone, 'main'); assert.equal(state.loads, 0);
});

test('remote mini-search waits for typing to settle, skips one ASCII character on blur, and offers retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const state = fixture({ providers: { loadDeckCards: async () => [], findCandidates: (text, { signal }) => {
    const request = deferred(); calls.push({ text, signal, ...request }); return request.promise;
  } } });
  await state.ui.openDeck(state.first.id);
  let query = queryInput(state.container);
  query.value = 'f'; query.dispatch('input'); query.dispatch('change');
  t.mock.timers.tick(300); await settle();
  assert.equal(calls.length, 0);
  all(state.container, node => node.className === 'deck-add-form')[0].dispatch('submit'); await settle();
  assert.equal(calls[0].text, 'f');
  state.ui.render();
  assert.equal(calls[0].signal.aborted, true);
  t.mock.timers.tick(300); await settle();
  assert.equal(calls.length, 1);

  query = queryInput(state.container);
  query.value = 'fi'; query.dispatch('input'); t.mock.timers.tick(200);
  query.value = '精'; query.dispatch('input'); query.dispatch('change');
  t.mock.timers.tick(299); await settle();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(calls.map(call => call.text), ['f', '精']);
  calls[1].reject(new Error('服务暂忙')); await settle();
  assert.match(state.container.textContent, /服务暂忙/);
  button(state.container, '重试搜索').dispatch('click'); await settle();
  assert.equal(calls[2].text, '精');
  button(state.container, '高级搜索 ↗').dispatch('click');
  assert.equal(calls[2].signal.aborted, true);
});

test('changing query text invalidates an in-flight candidate response during the debounce interval', async () => {
  const pending = deferred();
  const state = fixture({ providers: { loadDeckCards: async () => [], findCandidates: () => pending.promise } });
  await state.ui.openDeck(state.first.id);
  const query = queryInput(state.container); query.value = 'Elf'; query.dispatch('change'); await settle();
  query.value = ''; query.dispatch('input'); pending.resolve({ cards: [state.cards[0]], total: 1 }); await settle();
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 0);
});

test('remote text import opens immediately and resolves only the submitted text before committing', async () => {
  const resolved = [];
  let state;
  state = fixture({ providers: {
    loadDeckCards: async () => [],
    resolveDeckText: async text => { resolved.push(text); return { ...parseDeckText(text, state.cards), cards: [state.cards[2]] }; },
  } });
  await button(state.container, '导入牌表').dispatchAsync('click');
  assert.ok(importSource()); assert.equal(state.loads, 0); assert.equal(resolved.length, 0);
  importSource().value = '[Main]\n2 精灵2';
  await button(document.body, '检查并预览').dispatchAsync('click');
  assert.deepEqual(resolved, ['[Main]\n2 精灵2']); assert.equal(button(document.body, '确认新增导入').disabled, false);
  button(document.body, '确认新增导入').dispatch('click');
  const imported = state.ui.listDecks().find(deck => deck.name === '导入的卡组');
  assert.equal(imported.entries[0].cardId, 'elf-2'); assert.equal(imported.entries[0].quantity, 2); assert.equal(state.loads, 0);
});

test('import pins ambiguities above other unresolved lines and folds matched rows without choosing for the user', async () => {
  const initialCards = [
    { id: 'a', name: 'First', zhName: '重名', versions: [{ id: 'a-v' }] },
    { id: 'b', name: 'Second', zhName: '重名', versions: [{ id: 'b-v' }] },
    { id: 'c', name: 'Ready', zhName: '已匹配牌', versions: [{ id: 'c-v' }] },
  ];
  const state = fixture({ initialCards, providers: {
    resolveDeckText: async text => ({ ...parseDeckText(text, initialCards), cards: initialCards }),
  } });
  await button(state.container, '导入牌表').dispatchAsync('click');
  importSource().value = '1 已匹配牌\n1 不存在\n2 重名';
  await button(document.body, '检查并预览').dispatchAsync('click');
  const [preview] = all(document.body, node => node.className === 'deck-import-preview');
  const directRows = () => preview.children.filter(node => node.className.includes('deck-import-row'));
  assert.deepEqual(directRows().map(row => row.children[0].textContent.match(/第 \d 行/)[0]), ['第 3 行', '第 2 行']);
  const completed = () => preview.children.find(node => node.tagName === 'details');
  assert.equal(completed().open, false);
  assert.equal(completed().children[0].textContent, '已匹配 1 行');
  const [choice] = all(preview, node => node.attributes['aria-label'] === '解决第 3 行牌名歧义');
  assert.equal(choice.value, '');
  assert.equal(button(document.body, '确认新增导入').disabled, true);
  choice.value = 'b'; choice.dispatch('change');
  assert.equal(directRows().length, 1);
  assert.equal(completed().children[0].textContent, '已匹配 2 行');
  const [skip] = all(directRows()[0], node => node.type === 'checkbox');
  skip.checked = true; skip.dispatch('change');
  assert.equal(button(document.body, '确认新增导入').disabled, false);
  button(document.body, '确认新增导入').dispatch('click');
  assert.deepEqual(state.ui.listDecks().find(deck => deck.name === '导入的卡组').entries.map(entry => [entry.cardId, entry.quantity]), [['c', 1], ['b', 2]]);
});

test('JSON import hydrates referenced identities and exact printings before validating the backup', async () => {
  const calls = [];
  let state;
  state = fixture({ providers: {
    resolveDeckText: async () => { throw new Error('JSON must not resolve names'); },
    loadCardsByIds: async (ids, options) => { calls.push({ ids, options }); return [state.cards[3]]; },
  } });
  await button(state.container, '导入牌表').dispatchAsync('click');
  const format = all(document.body, node => node.tagName === 'select' && node.children.some(option => option.value === 'json'))[0];
  format.value = 'json'; format.dispatch('change');
  const imported = { ...state.first, entries: [{ id: 'old-entry', cardId: 'elf-3', versionId: 'v-3', quantity: 1, zone: 'main', categories: [], notes: '' }] };
  importSource().value = exportDeckBackup([imported]);
  await button(document.body, '检查并预览').dispatchAsync('click');
  assert.deepEqual(calls, [{ ids: ['elf-3'], options: { versions: [{ cardId: 'elf-3', versionId: 'v-3' }] } }]);
  assert.equal(button(document.body, '确认新增导入').disabled, false);
  button(document.body, '确认新增导入').dispatch('click');
  const created = state.ui.listDecks().find(deck => deck.id !== state.first.id && deck.id !== state.second.id);
  assert.equal(created.entries[0].versionId, 'v-3'); assert.notEqual(created.entries[0].id, 'old-entry'); assert.equal(state.loads, 0);
});

test('editing import text while resolution is pending keeps the stale preview from becoming importable', async () => {
  const pending = deferred();
  const state = fixture({ providers: { resolveDeckText: () => pending.promise } });
  await button(state.container, '导入牌表').dispatchAsync('click');
  const source = importSource(); source.value = '1 Elf 0';
  const checking = button(document.body, '检查并预览').dispatchAsync('click');
  source.value = '1 Elf 1'; source.dispatch('input');
  pending.resolve({ ...parseDeckText('1 Elf 0', state.cards), cards: [state.cards[0]] }); await checking;
  assert.equal(button(document.body, '确认新增导入').disabled, true);
  assert.equal(all(document.body, node => node.className.includes('deck-import-row')).length, 0);
});

test('printing options load full details on focus while keeping the stored version until an explicit selection', async () => {
  let state; const details = [];
  state = fixture({ prepareStore(store, deck, cards) { store.addCard(deck.id, cards[0]); }, providers: {
    loadDeckCards: async () => [state.cards[0]],
    loadCardDetails: async id => { details.push(id); return { ...state.cards[0], versions: [...state.cards[0].versions, { id: 'extra', set: 'xyz', collectorNumber: '8' }], versionsComplete: true }; },
  } });
  await state.ui.openDeck(state.first.id);
  const printing = all(state.container, node => node.attributes['aria-label'] === '印刷版本')[0];
  assert.ok(printing.children.some(option => option.value === '__load_versions__'));
  await printing.dispatchAsync('focus');
  assert.deepEqual(details, ['elf-0']); assert.equal(printing.value, 'v-0');
  assert.ok(printing.children.some(option => option.value === 'extra')); assert.equal(state.ui.getDeck(state.first.id).entries[0].versionId, 'v-0');
  printing.value = 'extra'; printing.dispatch('change');
  assert.equal(state.ui.getDeck(state.first.id).entries[0].versionId, 'extra'); assert.equal(state.loads, 0);
});

test('the target chooser fetches only that card details so all printing choices remain available', async () => {
  let state; const details = [];
  state = fixture({ providers: { loadCardDetails: async id => {
    details.push(id); return { ...state.cards[0], versions: [...state.cards[0].versions, { id: 'extra', set: 'xyz', collectorNumber: '9' }], versionsComplete: true };
  } } });
  const pending = state.ui.addCard(state.cards[0]); await settle();
  assert.deepEqual(details, ['elf-0']); assert.equal(state.loads, 0);
  const chooser = all(document.body, node => node.tagName === 'select' && node.children.some(option => option.value === 'extra'))[0];
  assert.ok(chooser); assert.equal(chooser.value, 'v-0');
  button(document.body, '关闭').dispatch('click'); assert.equal(await pending, false);
});
