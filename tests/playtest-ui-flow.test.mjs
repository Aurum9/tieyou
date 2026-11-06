import test from 'node:test';
import assert from 'node:assert/strict';
import { initPlaytestUI } from '../dist/lib/playtest-ui.js';
import { DeckStore } from '../dist/lib/decks.js';
import { PLAYTEST_STORAGE_PREFIX } from '../dist/lib/playtest-storage.js';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.className = ''; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
  setAttribute(key, value) { this.attributes[key] = value; }
  dispatch(type) { for (const fn of this.events[type] || []) fn({ preventDefault() {}, target: this }); }
  querySelector(selector) { return all(this, n => n.className.split(' ').includes(selector.slice(1)))[0]; }
}
function all(root, predicate) { return root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...all(node, predicate)]); }
function button(root, text) { return all(root, node => node.tagName === 'button' && node.textContent === text)[0]; }
function fixture() {
  globalThis.document = { createElement: tag => new Element(tag) }; globalThis.window = { matchMedia: () => ({ matches: false }) };
  const map = new Map(), backend = { fail: false, getItem: key => map.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('quota'); map.set(key, value); }, removeItem: key => map.delete(key) }; globalThis.localStorage = backend;
  const store = new DeckStore({ storage: backend }), draft = store.create('测试草稿');
  draft.entries = [{ id: 'e', cardId: 'forest', versionId: 'v', quantity: 15, zone: 'main', categories: [], notes: '' }]; const deck = store.save(draft);
  const cards = [{ id: 'forest', name: 'Forest', zhName: '树林', typeLine: 'Basic Land — Forest', versions: [{ id: 'v' }] }];
  const container = new Element('main'), notices = [], inspections = [];
  const newUI = () => initPlaytestUI({ container, cards, onNotify: (...args) => notices.push(args), onInspect: (...args) => inspections.push(args) });
  const ui = newUI(); ui.open(deck); return { ui, newUI, container, deck, store, map, backend, notices, inspections };
}
function start(f) { all(f.container, n => n.tagName === 'form' && n.className === 'pt-setup')[0].dispatch('submit'); }
test('playtest UI starts a snapshot and all play actions leave original durable deck unchanged', () => {
  const f = fixture(), before = f.map.get('edh.deck-library.v1'); start(f); assert.match(f.container.textContent, /手牌 · 7/); button(f.container, '保留并开始').dispatch('click'); assert.match(f.container.textContent, /手牌 · 8/);
  all(f.container, n => n.className.split(' ').includes('pt-card'))[0].dispatch('click'); button(f.container, '下地').dispatch('click'); button(f.container, '横置').dispatch('click'); button(f.container, '应用指示物').dispatch('click'); button(f.container, '下一回合 →').dispatch('click');
  assert.match(f.container.textContent, /第 2 回合/); assert.match(f.container.textContent, /本回合下地 0\/1/); assert.equal(f.map.get('edh.deck-library.v1'), before); assert.equal(f.store.get(f.deck.id).entries[0].quantity, 15);
});
test('paid mulligan UI blocks keep until bottom selection; saved progress resumes with life and turn', () => {
  const f = fixture(); start(f); button(f.container, '重新调度（免费）').dispatch('click'); button(f.container, '重新调度（需沉底 1 张）').dispatch('click'); assert.equal(button(f.container, '保留并开始').disabled, true);
  all(f.container, n => n.className.split(' ').includes('pt-card'))[0].dispatch('click'); assert.equal(button(f.container, '保留并开始').disabled, false); button(f.container, '保留并开始').dispatch('click'); button(f.container, '-5').dispatch('click'); button(f.container, '下一回合 →').dispatch('click');
  const next = f.newUI(); next.open(f.deck); assert.ok(button(f.container, '继续上次测试')); button(f.container, '继续上次测试').dispatch('click'); assert.match(f.container.textContent, /第 2 回合/); assert.equal(JSON.parse(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id)).state.life, 35);
});
test('quota failure stays visible, keeps current session and supports retry without a false saved status', () => { const f = fixture(); f.backend.fail = true; start(f); assert.match(f.container.textContent, /保存失败/); assert.equal(f.map.has(PLAYTEST_STORAGE_PREFIX + f.deck.id), false); assert.ok(button(f.container, '重试保存')); f.backend.fail = false; button(f.container, '重试保存').dispatch('click'); assert.match(f.container.textContent, /已保存在此浏览器/); assert.ok(f.map.has(PLAYTEST_STORAGE_PREFIX + f.deck.id)); });
test('corrupt progress blocks overwrite until explicitly selected and never changes the original deck', () => { const f = fixture(), before = f.map.get('edh.deck-library.v1'); f.map.set(PLAYTEST_STORAGE_PREFIX + f.deck.id, '{bad'); const ui = f.newUI(); ui.open(f.deck); assert.match(f.container.textContent, /旧测试进度暂时无法恢复/); assert.equal(button(f.container, '按当前牌表新建测试').disabled, true); start(f); assert.equal(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id), '{bad'); const overwrite = all(f.container, n => n.className === 'pt-check').at(-1).children[0]; overwrite.checked = true; overwrite.dispatch('change'); start(f); assert.match(f.container.textContent, /手牌 · 7/); assert.equal(f.map.get('edh.deck-library.v1'), before); });
test('resuming after a deck edit retains the original test snapshot while a new test uses the edited deck', () => { const f = fixture(); start(f); const edited = structuredClone(f.deck); edited.entries[0].quantity = 3; const ui = f.newUI(); ui.open(edited); button(f.container, '继续上次测试').dispatch('click'); assert.match(f.container.textContent, /手牌 · 7/); button(f.container, '重开 \/ 设置').dispatch('click'); start(f); assert.match(f.container.textContent, /手牌 · 3/); });
