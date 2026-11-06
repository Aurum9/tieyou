import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckStore } from '../dist/lib/decks.js';
import { initDeckUI } from '../dist/lib/deck-ui.js';

// These flow tests exercise the UI callbacks without requiring a browser runtime.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.className = ''; this.value = ''; this._text = ''; this.classList = { toggle: () => {} }; }
  set textContent(text) { this._text = String(text); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  dispatch(name) { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: this }; for (const handler of this.events[name] || []) handler(event); return event; }
  querySelectorAll(selector) { return all(this, node => selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))); }
  focus() { document.activeElement = this; }
  get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
}
function all(root, predicate) { return root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...all(node, predicate)]); }
function fixture({ loadCards, initiallyLoaded = false, initialCards, prepareStore } = {}) {
  globalThis.document = { body: new Element('body'), activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
  const values = new Map(); const storage = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); values.set(key, value); } };
  globalThis.localStorage = storage;
  const store = new DeckStore({ storage }); const first = store.create('甲卡组'), second = store.create('乙卡组');
  const cards = initialCards || Array.from({ length: 12 }, (_, n) => ({ id: `elf-${n}`, name: `Elf ${n}`, zhName: `精灵${n}`, typeLine: 'Creature — Elf', colorIdentity: ['G'], versions: [{ id: `v-${n}`, set: 'abc', collectorNumber: String(n), lang: 'en' }] }));
  prepareStore?.(store, first, cards);
  const container = new Element('main'); document.body.append(container); const notices = [], changes = [], navigation = [], playtests = [];
  let loads = 0;
  const ui = initDeckUI({ container, cards: initiallyLoaded ? cards : [], loadCards: async () => { loads++; return loadCards ? loadCards(cards) : cards; }, onNotify: (...args) => notices.push(args), onLibraryChange: () => changes.push(true), onOpenCatalog: params => navigation.push(params), onPlaytest: deck => playtests.push(deck) });
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
