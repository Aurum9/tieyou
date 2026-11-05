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
  dispatch(name) { const event = { preventDefault() {}, target: this }; for (const handler of this.events[name] || []) handler(event); }
  querySelectorAll(selector) { return all(this, node => selector.startsWith('.') && node.className.split(' ').includes(selector.slice(1))); }
  focus() { document.activeElement = this; }
  get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
}
function all(root, predicate) { return root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...all(node, predicate)]); }
function fixture({ loadCards, initiallyLoaded = false } = {}) {
  globalThis.document = { body: new Element('body'), activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, removeEventListener() {} };
  const values = new Map(); const storage = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); values.set(key, value); } };
  globalThis.localStorage = storage;
  const store = new DeckStore({ storage }); const first = store.create('甲卡组'), second = store.create('乙卡组');
  const cards = Array.from({ length: 12 }, (_, n) => ({ id: `elf-${n}`, name: `Elf ${n}`, zhName: `精灵${n}`, typeLine: 'Creature — Elf', colorIdentity: ['G'], versions: [{ id: `v-${n}`, set: 'abc', collectorNumber: String(n), lang: 'en' }] }));
  const container = new Element('main'); document.body.append(container); const notices = [], changes = [], navigation = [];
  let loads = 0;
  const ui = initDeckUI({ container, cards: initiallyLoaded ? cards : [], loadCards: async () => { loads++; return loadCards ? loadCards(cards) : cards; }, onNotify: (...args) => notices.push(args), onLibraryChange: () => changes.push(true), onOpenCatalog: params => navigation.push(params) });
  return { ui, container, cards, first, second, storage, notices, changes, navigation, get loads() { return loads; } };
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

test('quick add writes one main-deck card to the explicit target, keeps editor selection, and rejects missing targets', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  assert.equal(state.ui.quickAddCard(state.cards[0], null, state.second.id), true);
  assert.equal(state.ui.getSelectedDeckId(), state.first.id); assert.equal(state.ui.getDeck(state.first.id).entries.length, 0);
  const [entry] = state.ui.getDeck(state.second.id).entries;
  assert.equal(entry.zone, 'main'); assert.equal(entry.quantity, 1); assert.equal(entry.versionId, 'v-0'); assert.equal(state.changes.length, 1);
  assert.equal(state.ui.quickAddCard(state.cards[0], null, 'deleted-deck'), false);
  assert.equal(state.changes.length, 1); assert.equal(all(document.body, node => node.attributes.role === 'dialog').length, 0);
});

test('name suggestions offer autocomplete and add directly, preserving query through rerenders and advanced navigation', async () => {
  const state = fixture({ initiallyLoaded: true }); await state.ui.openDeck(state.first.id);
  let query = queryInput(state.container); query.value = 'Elf'; query.dispatch('change');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 8);
  const options = all(state.container, node => node.tagName === 'datalist')[0].children;
  assert.ok(options.some(option => option.value === 'Elf 0')); assert.ok(options.some(option => option.value === '精灵0'));
  button(state.container, '＋ 加入').dispatch('click');
  assert.equal(state.ui.getDeck(state.first.id).entries[0].zone, 'main');
  query = queryInput(state.container); assert.equal(query.value, 'Elf'); assert.equal(all(document.body, node => node.attributes.role === 'dialog').length, 0);
  all(state.container, node => node.className === 'deck-add-form')[0].dispatch('submit');
  assert.equal(all(state.container, node => node.className === 'deck-search-result').length, 12);
  button(state.container, '高级搜索 ↗').dispatch('click');
  assert.deepEqual(state.navigation, [{ deckId: state.first.id, query: 'Elf', restrictIdentity: false }]);
  state.ui.showLibrary(); await state.ui.openDeck(state.first.id); assert.equal(queryInput(state.container).value, 'Elf');
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
