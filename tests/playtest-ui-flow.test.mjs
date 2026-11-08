import test from 'node:test';
import assert from 'node:assert/strict';
import { initPlaytestUI } from '../web/lib/playtest-ui.js';
import { DeckStore } from '../web/lib/decks.js';
import { PLAYTEST_STORAGE_PREFIX } from '../web/lib/playtest-storage.js';

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag; this.ownerDocument = ownerDocument; this.children = []; this.events = {}; this.attributes = {};
    this.className = ''; this.value = ''; this._text = ''; this.style = {}; this.scrollLeft = 0; this.scrollTop = 0;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => this.className.split(' ').includes(name)
    };
  }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get isConnected() { return this === this.ownerDocument?.body || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
  addEventListener(type, fn, options) { (this.events[type] ||= []).push({ fn, capture: options === true }); }
  removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(item => item.fn !== fn); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  dispatch(type, props = {}) {
    const event = { target: this, detail: 1, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 120, clientY: 120, ...props, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const { fn } of [...(this.events[type] || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) { fn(event); if (event.stopped) break; }
    return event;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const attribute = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attribute) return Object.hasOwn(this.attributes, attribute[1]) && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
      return this.tagName === part;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) { return all(this, node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.modal = true; }
  show() { this.open = true; this.modal = false; }
  close() { if (this.open) { this.open = false; this.dispatch('close'); } }
  getBoundingClientRect() { return { left: 100, top: 100, width: 100, height: 140, right: 200, bottom: 240 }; }
}
function all(root, predicate) { return root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...all(node, predicate)]); }
function button(root, text) { return all(root, node => node.tagName === 'button' && node.textContent === text)[0]; }
function byClass(root, cls) { return all(root, node => node.classList.contains(cls)); }
function labelled(root, label) { return all(root, node => node.getAttribute('aria-label') === label)[0]; }
function form(root, cls) { return byClass(root, cls).find(node => node.tagName === 'form'); }
const entry = (cardId, quantity = 1, zone = 'main') => ({ id: `e-${cardId}`, cardId, versionId: `v-${cardId}`, quantity, zone, categories: [], notes: '' });
const forestImage = 'https://example.com/forest.jpg';
const cardDefinitions = [
  { id: 'forest', name: 'Forest', zhName: '树林', typeLine: 'Basic Land — Forest', zhTypeLine: '基本地 — 树林', zhText: '{T}：加{G}。', versions: [{ id: 'v-forest', image: forestImage, set: 'tst', collectorNumber: '215' }] },
  { id: 'ring', name: 'Sol Ring', zhName: '阳光戒', typeLine: 'Artifact', tags: ['manarock'], versions: [{ id: 'v-ring' }] },
  { id: 'chief', name: 'Commander', zhName: '统帅', typeLine: 'Legendary Creature', versions: [{ id: 'v-chief' }] },
  { id: 'transform', name: 'Front // Back', layout: 'transform', typeLine: 'Creature', faces: [{ name: 'Front' }, { name: 'Back' }], versions: [{ id: 'v-transform' }] },
  { id: 'flip', name: 'Upright // Inverted', layout: 'flip', typeLine: 'Creature', faces: [{ name: 'Upright' }, { name: 'Inverted' }], versions: [{ id: 'v-flip' }] },
  { id: 'split', name: 'Left // Right', layout: 'split', typeLine: 'Instant', faces: [{ name: 'Left' }, { name: 'Right' }], versions: [{ id: 'v-split' }] }
];
function fixture({ entries = [entry('forest', 15), entry('chief', 1, 'commander')] } = {}) {
  const doc = new Element('document'); doc.ownerDocument = doc; doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  doc.elementFromPoint = () => doc.point;
  const scrolls = []; doc.defaultView = { innerWidth: 390, innerHeight: 844, scrollTo: value => scrolls.push(value) };
  globalThis.document = doc; globalThis.window = doc.defaultView;
  const map = new Map(), backend = { fail: false, getItem: key => map.get(key) ?? null, setItem(key, value) { if (this.fail) throw new Error('quota'); map.set(key, value); }, removeItem: key => map.delete(key) }; globalThis.localStorage = backend;
  const store = new DeckStore({ storage: backend }), draft = store.create('测试草稿'); draft.entries = entries; const deck = store.save(draft);
  const container = doc.createElement('main'); doc.body.append(container); const notices = [];
  const newUI = () => initPlaytestUI({ container, cards: cardDefinitions, onNotify: (...args) => notices.push(args) });
  const ui = newUI(); ui.open(deck); return { ui, newUI, container, deck, store, map, backend, notices, doc, scrolls };
}
function start(f) { form(f.container, 'pt-setup').dispatch('submit'); }
function keep(f) { button(f.container, '保留并开始').dispatch('click'); }
function saved(f) { return JSON.parse(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id)).state; }
function tile(f, id) { return all(f.container, n => n.getAttribute('data-piece-id') === id)[0]; }
function play(f, id) { byClass(tile(f, id), 'pt-card-hit')[0].dispatch('click'); }
function openCard(f, id) { const card = tile(f, id); assert.ok(card, `visible card ${id}`); byClass(card, 'pt-card-menu')[0].dispatch('click'); return byClass(f.container, 'pt-card-dialog')[0]; }
function move(f, id, destination) { openCard(f, id); labelled(f.container, '移动卡牌到').value = destination; form(f.container, 'pt-move-form').dispatch('submit'); }
function libraryMenu(f) { f.container.querySelector('[data-library-title]').dispatch('click'); return byClass(f.container, 'pt-library-options')[0]; }
function boardSlot(f, row, slot) { return byClass(f.container, 'pt-board-slot').find(n => n.getAttribute('data-row') === row && n.getAttribute('data-slot') === String(slot)); }
function drag(f, id, destination, x = 125) {
  const source = tile(f, id);
  assert.ok(source?.isConnected && destination?.isConnected);
  f.doc.point = destination;
  source.dispatch('pointerdown');
  f.doc.dispatch('pointermove', { clientX: x, clientY: 165 });
  assert.equal(f.doc.dispatch('pointerup', { clientX: x, clientY: 165 }).prevented, true);
  f.doc.point = null;
}
function assertConcise(root) {
  assert.doesNotMatch(root.textContent, /准备一场测试|独立快照|支持未完成的草稿|按自己的节奏试牌|这手牌，值得保留吗|当前无需沉底|自动再抓一张牌|撤销|重做|下地上限|本回合下地|请手动处理费用|每次调度重抓起手/);
}

test('setup contains only the first-turn draw toggle and concise settings', () => {
  const f = fixture(), checks = all(f.container, n => n.tagName === 'input' && n.type === 'checkbox');
  assert.equal(checks.length, 1); assert.equal(checks[0].parentNode.textContent, '先手抓牌'); assert.equal(checks[0].checked, true);
  assert.ok(button(f.container, '开始试牌')); assertConcise(f.container);
  checks[0].checked = false; start(f); keep(f); assert.equal(saved(f).zones.hand.length, 7); assert.equal(saved(f).settings.drawFirstTurn, false);
});

test('opening shows the hand first and hides all other game zones and controls', () => {
  const f = fixture(); start(f);
  assert.match(f.container.textContent, /手牌 · 7/); assert.equal(byClass(f.container, 'pt-opening-hand').length, 1); assert.equal(byClass(f.container, 'pt-hand-row')[0].children.length, 7);
  assert.equal(byClass(f.container, 'pt-table').length, 0); assert.equal(byClass(f.container, 'pt-controls').length, 0); assert.equal(all(f.container, n => n.getAttribute('data-drop-zone') !== null).length, 0);
  assert.equal(button(f.container, '保留并开始').disabled, false); assertConcise(f.container);
});

test('paid mulligans show bottom-selection progress and block keep until the required cards are selected', () => {
  const f = fixture(); start(f); button(f.container, '重新调度（免费）').dispatch('click'); button(f.container, '重新调度（沉底 1 张）').dispatch('click');
  assert.equal(button(f.container, '保留并开始').disabled, true); assert.equal(byClass(f.container, 'pt-bottom-progress')[0].textContent, '沉底 0/1');
  const first = saved(f).zones.hand[0]; byClass(tile(f, first), 'pt-card-hit')[0].dispatch('click');
  assert.equal(byClass(f.container, 'pt-bottom-progress')[0].textContent, '沉底 1/1'); assert.equal(button(f.container, '保留并开始').disabled, false);
  byClass(tile(f, first), 'pt-card-hit')[0].dispatch('click'); assert.equal(button(f.container, '保留并开始').disabled, true);
  byClass(tile(f, first), 'pt-card-hit')[0].dispatch('click'); keep(f);
  assert.equal(saved(f).zones.library.at(-1), first); assert.equal(saved(f).zones.hand.length, 7); assertConcise(f.container);
});

test('playing shows battlefield above hand and four side piles; menu movement leaves the source deck unchanged', () => {
  const f = fixture(), before = f.map.get('edh.deck-library.v1'); start(f); keep(f);
  const table = byClass(f.container, 'pt-table')[0]; assert.equal(table.children[0].getAttribute('data-drop-zone'), 'battlefield');
  assert.equal(byClass(f.container, 'pt-hand').length, 1);
  assert.equal(byClass(f.container, 'pt-hand-column')[0].children[1].className, 'pt-controls');
  assert.equal(all(table.children[0], node => node.getAttribute('data-hand-scroll') !== null).length, 1);
  assert.deepEqual(byClass(f.container, 'pt-zone-pile').map(n => n.getAttribute('data-drop-zone')), ['library-top', 'graveyard', 'exile', 'command']);
  const id = saved(f).zones.hand[0]; play(f, id); assert.ok(saved(f).zones.battlefield.includes(id));
  assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  move(f, id, 'graveyard'); assert.ok(saved(f).zones.graveyard.includes(id)); assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  assert.equal(f.map.get('edh.deck-library.v1'), before); assert.equal(f.store.get(f.deck.id).entries[0].quantity, 15); assertConcise(f.container);
});

test('battlefield click toggles tap directly; the corner menu changes counters and exposes details', () => {
  const f = fixture(); start(f); keep(f); const id = saved(f).zones.hand[0]; move(f, id, 'battlefield');
  byClass(tile(f, id), 'pt-card-hit')[0].dispatch('click'); assert.equal(saved(f).pieces[id].tapped, true); assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  byClass(tile(f, id), 'pt-card-hit')[0].dispatch('click'); assert.equal(saved(f).pieces[id].tapped, false);
  const dialog = openCard(f, id); assert.equal(dialog.open, true); assert.equal(dialog.modal, true); assert.equal(labelled(dialog, '减少指示物').disabled, true);
  labelled(dialog, '增加指示物').dispatch('click'); assert.equal(saved(f).pieces[id].counters['+1/+1'], 1); assert.equal(labelled(f.container, '减少指示物').disabled, false);
  labelled(f.container, '减少指示物').dispatch('click'); assert.deepEqual(saved(f).pieces[id].counters, {});
  const name = labelled(f.container, '指示物名称'); name.value = '充电'; name.dispatch('input'); labelled(f.container, '增加指示物').dispatch('click'); assert.equal(saved(f).pieces[id].counters['充电'], 1);
  const currentDialog = byClass(f.container, 'pt-card-dialog')[0];
  assert.equal(button(currentDialog, '查看详情'), undefined);
  assert.equal(byClass(currentDialog, 'pt-preview-image')[0].querySelector('img').src, forestImage);
  assert.equal(byClass(currentDialog, 'pt-preview-text')[0].textContent, '{T}：加{G}。');
  button(currentDialog, '关闭').dispatch('click'); assert.equal(byClass(f.container, 'pt-dialog').length, 0);
});

test('counter actions keep keyboard focus across redraws and closing returns to the rebuilt card menu', () => {
  const f = fixture(); start(f); keep(f); const id = saved(f).zones.hand[0]; move(f, id, 'battlefield');
  const origin = byClass(tile(f, id), 'pt-card-menu')[0]; origin.focus(); openCard(f, id);
  let plus = labelled(f.container, '增加指示物'); plus.focus(); plus.dispatch('click');
  assert.equal(saved(f).pieces[id].counters['+1/+1'], 1); assert.equal(plus.isConnected, false); assert.equal(f.doc.activeElement, labelled(f.container, '增加指示物')); assert.equal(f.doc.activeElement.isConnected, true);
  f.doc.activeElement.dispatch('click'); assert.equal(saved(f).pieces[id].counters['+1/+1'], 2); assert.equal(f.doc.activeElement, labelled(f.container, '增加指示物'));
  const minus = labelled(f.container, '减少指示物'); minus.focus(); minus.dispatch('click');
  assert.equal(saved(f).pieces[id].counters['+1/+1'], 1); assert.equal(f.doc.activeElement, labelled(f.container, '减少指示物'));
  f.doc.activeElement.dispatch('click'); assert.deepEqual(saved(f).pieces[id].counters, {}); assert.equal(labelled(f.container, '减少指示物').disabled, true); assert.equal(f.doc.activeElement, labelled(f.container, '增加指示物'));
  button(f.container, '关闭').dispatch('click'); const rebuilt = byClass(tile(f, id), 'pt-card-menu')[0];
  assert.equal(origin.isConnected, false); assert.notEqual(rebuilt, origin); assert.equal(f.doc.activeElement, rebuilt); assert.equal(rebuilt.isConnected, true);
});

test('transform cards have a transform action, flip cards have inversion, and split cards have neither', () => {
  const f = fixture({ entries: ['transform', 'flip', 'split'].map(id => entry(id)) }); start(f); keep(f);
  const state = saved(f), idFor = cardId => Object.values(state.pieces).find(p => p.cardId === cardId).id;
  openCard(f, idFor('transform')); assert.ok(button(f.container, '转化')); assert.equal(button(f.container, '倒转'), undefined);
  button(f.container, '转化').dispatch('click'); assert.equal(saved(f).pieces[idFor('transform')].face, 1); button(f.container, '关闭').dispatch('click');
  openCard(f, idFor('flip')); assert.ok(button(f.container, '倒转')); assert.equal(button(f.container, '转化'), undefined);
  button(f.container, '倒转').dispatch('click'); assert.equal(saved(f).pieces[idFor('flip')].inverted, true); assert.equal(saved(f).pieces[idFor('flip')].face, 0); button(f.container, '关闭').dispatch('click');
  openCard(f, idFor('split')); assert.equal(button(f.container, '转化'), undefined); assert.equal(button(f.container, '倒转'), undefined);
});

test('saved play resumes with life and turn while a new test uses the edited deck', () => {
  const f = fixture(); start(f); keep(f); button(f.container, '-5').dispatch('click'); button(f.container, '下一回合').dispatch('click');
  const edited = structuredClone(f.deck); edited.entries[0].quantity = 3; const ui = f.newUI(); ui.open(edited);
  assert.ok(button(f.container, '继续试牌')); button(f.container, '继续试牌').dispatch('click'); assert.match(f.container.textContent, /第 2 回合/); assert.equal(saved(f).life, 35); assert.equal(saved(f).deck.entries[0].quantity, 15);
  button(f.container, '设置').dispatch('click'); assert.ok(button(f.container, '重新开始')); start(f); assert.match(f.container.textContent, /手牌 · 3/); assert.equal(saved(f).deck.entries[0].quantity, 3);
});

test('quota errors remain visible and retry saves the same live session without a redundant success message', () => {
  const f = fixture(); f.backend.fail = true; start(f); assert.match(f.container.textContent, /保存失败/); assert.equal(f.map.has(PLAYTEST_STORAGE_PREFIX + f.deck.id), false); assert.ok(button(f.container, '重试保存'));
  f.backend.fail = false; button(f.container, '重试保存').dispatch('click'); assert.equal(byClass(f.container, 'pt-save-error').length, 0); assert.ok(f.map.has(PLAYTEST_STORAGE_PREFIX + f.deck.id)); assert.equal(saved(f).zones.hand.length, 7); assert.doesNotMatch(f.container.textContent, /已保存在此浏览器/);
});

test('corrupt progress blocks overwrite until explicitly selected and never changes the original deck', () => {
  const f = fixture(), before = f.map.get('edh.deck-library.v1'); f.map.set(PLAYTEST_STORAGE_PREFIX + f.deck.id, '{bad'); const ui = f.newUI(); ui.open(f.deck);
  assert.match(f.container.textContent, /旧测试进度无法恢复/); assert.equal(button(f.container, '重新开始').disabled, true); start(f); assert.equal(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id), '{bad');
  const overwrite = byClass(f.container, 'pt-check').find(n => n.textContent === '覆盖旧测试进度').children[0]; overwrite.checked = true; overwrite.dispatch('change'); assert.equal(button(f.container, '重新开始').disabled, false); start(f);
  assert.match(f.container.textContent, /手牌 · 7/); assert.equal(f.map.get('edh.deck-library.v1'), before);
});

test('zone trays use non-modal dialogs and closeOverlays closes them without changing progress', () => {
  const f = fixture(); start(f); keep(f); const before = f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id);
  button(f.container, '坟场 0').dispatch('click'); let dialog = byClass(f.container, 'pt-dialog')[0]; assert.equal(dialog.modal, false); assert.match(dialog.textContent, /0 张/);
  f.ui.closeOverlays(); assert.equal(dialog.isConnected, false); assert.equal(dialog.open, false); assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  const options = libraryMenu(f); assert.equal(options.modal, false); assert.equal(labelled(options, '搜索测试牌库'), undefined);
  button(options, '搜寻卡牌').dispatch('click');
  dialog = byClass(f.container, 'pt-zone-dialog')[0]; assert.equal(dialog.modal, false);
  const search = labelled(dialog, '搜索测试牌库');
  search.value = 'tst #215'; search.dispatch('input'); assert.equal(byClass(dialog, 'pt-card').length, saved(f).zones.library.length);
  search.value = 'missing'; search.dispatch('input'); assert.match(dialog.textContent, /无匹配卡牌/);
  dialog.dispatch('cancel'); assert.equal(byClass(f.container, 'pt-dialog').length, 0); assert.equal(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id), before);
});

test('zone trays expose every card beyond the hundredth entry and can move the last one', () => {
  const f = fixture({ entries: [entry('forest', 150)] }); start(f); keep(f); const library = saved(f).zones.library;
  assert.ok(library.length > 100); button(libraryMenu(f), '查看所有牌').dispatch('click');
  const tray = byClass(f.container, 'pt-zone-dialog')[0], cards = byClass(tray, 'pt-card');
  assert.equal(cards.length, library.length); assert.deepEqual(cards.map(n => n.getAttribute('data-piece-id')), library);
  const last = library.at(-1); move(f, last, 'hand'); assert.ok(saved(f).zones.hand.includes(last)); assert.equal(saved(f).zones.library.includes(last), false);
});

test('clicking the card back draws and the optional top display follows the current library', () => {
  const f = fixture(); start(f); keep(f);
  const [first, second] = saved(f).zones.library;
  const back = labelled(f.container, '抓一张牌');
  assert.ok(back && !back.classList.contains('is-revealed'));
  back.dispatch('click'); assert.equal(saved(f).zones.hand.at(-1), first);
  assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  const menu = libraryMenu(f), reveal = all(menu, n => n.tagName === 'input' && n.type === 'checkbox')[0];
  assert.equal(reveal.checked, false);
  reveal.checked = true; reveal.dispatch('change');
  assert.equal(saved(f).showLibraryTop, true);
  button(f.container, '关闭').dispatch('click');
  const faceUp = labelled(f.container, '抓一张牌：树林');
  assert.equal(faceUp.classList.contains('is-revealed'), true);
  faceUp.dispatch('click'); assert.equal(saved(f).zones.hand.at(-1), second);
  assert.ok(labelled(f.container, '抓一张牌：树林'));
});

test('dragging the library back or revealed top moves just that card', () => {
  const f = fixture(); start(f); keep(f);
  const { library, hand } = saved(f).zones;
  const [first, second, ...rest] = library;
  const back = labelled(f.container, '抓一张牌');
  drag(f, first, f.container.querySelector('[data-drop-zone="graveyard"]'));
  back.dispatch('click');
  assert.deepEqual(saved(f).zones.graveyard, [first]);
  assert.deepEqual(saved(f).zones.hand, hand);
  const reveal = libraryMenu(f).querySelector('input');
  reveal.checked = true; reveal.dispatch('change');
  button(f.container, '关闭').dispatch('click');
  assert.ok(labelled(f.container, '抓一张牌：树林'));
  drag(f, second, f.container.querySelector('[data-drop-zone="exile"]'));
  assert.deepEqual(saved(f).zones.exile, [second]);
  assert.deepEqual(saved(f).zones.library, rest);
});

test('dragging reorders the hand and swaps or frees fixed battlefield slots', () => {
  const f = fixture({ entries: [entry('forest', 3), entry('ring'), entry('transform')] }); start(f); keep(f);
  const [first, second, ...rest] = saved(f).zones.hand;
  drag(f, second, tile(f, first));
  assert.deepEqual(saved(f).zones.hand, [second, first, ...rest]);
  assert.deepEqual(byClass(f.container, 'pt-hand-row')[0].children.map(n => n.getAttribute('data-piece-id')), [second, first, ...rest]);

  const byCardId = cardId => Object.values(saved(f).pieces).filter(p => p.cardId === cardId).map(p => p.id);
  const [land, anotherLand] = byCardId('forest'), [ring] = byCardId('ring'), [creature] = byCardId('transform');
  play(f, land); play(f, ring); play(f, creature);
  assert.equal(tile(f, land).parentNode, boardSlot(f, 'lower', 0));
  assert.equal(tile(f, ring).parentNode, boardSlot(f, 'lower', 1));
  assert.equal(tile(f, creature).parentNode, boardSlot(f, 'upper', 0));
  play(f, land);
  assert.ok(Number(tile(f, land).parentNode.style.zIndex) > Number(tile(f, ring).parentNode.style.zIndex));
  drag(f, land, byClass(tile(f, ring), 'pt-card-hit')[0]);
  assert.equal(tile(f, land).parentNode, boardSlot(f, 'lower', 1));
  assert.equal(tile(f, ring).parentNode, boardSlot(f, 'lower', 0));
  assert.equal(saved(f).pieces[land].tapped, true);
  drag(f, ring, boardSlot(f, 'upper', 2));
  assert.equal(tile(f, ring).parentNode, boardSlot(f, 'upper', 2));
  assert.ok(boardSlot(f, 'lower', 0).classList.contains('is-empty'));
  assert.equal(tile(f, land).parentNode, boardSlot(f, 'lower', 1));
  play(f, anotherLand);
  assert.equal(tile(f, anotherLand).parentNode, boardSlot(f, 'lower', 0));
});

test('peek drag reorders only the selected cards and supports all five destinations', () => {
  const f = fixture(); start(f); keep(f);
  const [a, b, c, d, e, ...unseen] = saved(f).zones.library;
  const menu = libraryMenu(f);
  labelled(menu, '查看前几张牌').value = '5'; form(menu, 'pt-library-peek-form').dispatch('submit');
  const visible = () => byClass(byClass(f.container, 'pt-peek-list')[0], 'pt-card').map(n => n.getAttribute('data-piece-id'));
  assert.deepEqual(visible(), [a, b, c, d, e]);
  drag(f, a, tile(f, c), 175);
  assert.deepEqual(visible(), [b, c, a, d, e]);
  assert.deepEqual(saved(f).zones.library, [b, c, a, d, e, ...unseen]);

  drag(f, e, byClass(f.container, 'pt-peek-bottom')[0]);
  drag(f, a, tile(f, d), 175);
  drag(f, e, byClass(f.container, 'pt-peek-list')[0]);
  assert.deepEqual(visible(), [b, c, d, a, e]);
  assert.deepEqual(saved(f).zones.library, [b, c, d, a, e, ...unseen]);
  drag(f, a, tile(f, d));

  drag(f, b, f.container.querySelector('[data-drop-zone="graveyard"]'));
  assert.deepEqual(visible(), [c, a, d, e]);
  drag(f, c, f.container.querySelector('[data-drop-zone="hand"]'));
  drag(f, a, boardSlot(f, 'lower', 2));
  drag(f, d, f.container.querySelector('[data-drop-zone="exile"]'));
  assert.deepEqual(visible(), [e]);
  drag(f, e, f.container.querySelector('[data-drop-zone="library-bottom"]'));
  assert.deepEqual(visible(), []);
  assert.equal(tile(f, e).parentNode, byClass(f.container, 'pt-peek-bottom')[0]);
  const { zones, battlefieldPositions } = saved(f);
  assert.equal(zones.graveyard.at(-1), b);
  assert.equal(zones.hand.at(-1), c);
  assert.deepEqual(battlefieldPositions[a], { row: 'lower', slot: 2 });
  assert.equal(zones.exile.at(-1), d);
  assert.deepEqual(zones.library, [...unseen, e]);
  drag(f, e, byClass(f.container, 'pt-peek-list')[0]);
  assert.deepEqual(visible(), [e]);
  assert.deepEqual(saved(f).zones.library, [e, ...unseen]);
  drag(f, e, byClass(f.container, 'pt-peek-bottom')[0]);
  drag(f, e, f.container.querySelector('[data-drop-zone="hand"]'));
  assert.equal(saved(f).zones.hand.at(-1), e);
  assert.deepEqual(saved(f).zones.library, unseen);
});

test('commander pile plays a single remaining card or opens a choice for partners', () => {
  const f = fixture({ entries: [entry('chief', 1, 'commander'), entry('transform', 1, 'commander'), entry('forest')] });
  start(f); keep(f);
  const [first, second] = saved(f).zones.command;
  play(f, second);
  const tray = byClass(f.container, 'pt-zone-dialog')[0];
  assert.deepEqual(byClass(tray, 'pt-card').map(n => n.getAttribute('data-piece-id')), [first, second]);
  byClass(tray, 'pt-card-hit')[1].dispatch('click');
  assert.deepEqual(saved(f).zones.command, [first]);
  assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  play(f, first);
  assert.deepEqual(saved(f).zones.command, []);
  assert.deepEqual(saved(f).zones.battlefield, [second, first]);
});

test('token shortcuts prefer battlefield, then hand and graveyard, and select without creating', async t => {
  const f = fixture({ entries: [entry('forest'), entry('ring'), entry('transform'), entry('chief', 1, 'commander')] });
  const template = (id, zhName, creature = false) => ({
    id, name: id, zhName, typeLine: creature ? 'Token Creature — Bear' : 'Token Artifact',
    ...(creature ? { power: '2', toughness: '2' } : {}),
  });
  const tokens = Object.fromEntries([
    { ...template('treasure', '珍宝'), image: forestImage, zhText: '牺牲此衍生物。' },
    template('bear', '熊', true), template('clue', '线索'), template('food', '食品'), template('elephant', '象'),
    ...Array.from({ length: 13 }, (_, i) => template(`extra-${i}`, `额外 ${i}`)),
  ].map(token => [token.id, token]));
  const byCard = {
    ring: ['treasure', 'bear'], transform: ['bear', 'clue'],
    forest: ['food', ...Object.keys(tokens).filter(id => id.startsWith('extra-'))], chief: ['elephant'],
  };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: 1, tokens, byCard }) }));
  start(f); keep(f);
  const ids = Object.fromEntries(Object.values(saved(f).pieces).map(piece => [piece.cardId, piece.id]));
  play(f, ids.ring);
  move(f, ids.forest, 'graveyard');
  button(f.container, '＋ 衍生物').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  const picker = form(f.container, 'pt-token-picker');
  const shortcuts = byClass(picker, 'pt-token-quick')[0].children;
  const select = labelled(picker, '选择衍生物');
  assert.equal(shortcuts.length, 15);
  assert.deepEqual(shortcuts.slice(0, 4).map(node => node.textContent), ['珍宝', '2/2 熊', '线索', '食品']);
  assert.ok(select.children.some(option => option.value === 'elephant'));
  assert.ok(!shortcuts.some(node => node.value === 'elephant'));
  shortcuts[0].dispatch('click');
  assert.equal(select.value, 'treasure');
  assert.deepEqual(saved(f).zones.battlefield, [ids.ring]);
  labelled(picker, '衍生物数量').value = '2';
  picker.dispatch('submit');
  const spawned = Object.values(saved(f).pieces).filter(piece => piece.token);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].image, forestImage);
  const detail = openCard(f, spawned[0].id);
  assert.equal(byClass(detail, 'pt-preview-text')[0].textContent, '牺牲此衍生物。');
});

test('Escape closes a non-modal zone tray while an active drag gets the first chance to cancel', () => {
  const f = fixture(); start(f); keep(f); button(f.container, '坟场 0').dispatch('click'); const dialog = byClass(f.container, 'pt-dialog')[0];
  f.doc.body.classList.add('pt-drag-active'); assert.equal(f.doc.dispatch('keydown', { key: 'Escape' }).prevented, false); assert.equal(dialog.open, true);
  f.doc.body.classList.remove('pt-drag-active'); assert.equal(f.doc.dispatch('keydown', { key: 'Escape' }).prevented, true); assert.equal(dialog.open, false); assert.equal(byClass(f.container, 'pt-dialog').length, 0);
  f.ui.destroy(); assert.equal(f.doc.events.keydown.length, 0);
});

test('closeOverlays restores focus and destroy removes dialogs, gestures and pending pointer listeners', () => {
  const f = fixture(); start(f); keep(f); const id = saved(f).zones.hand[0], menu = byClass(tile(f, id), 'pt-card-menu')[0]; menu.focus(); menu.dispatch('click'); const dialog = byClass(f.container, 'pt-dialog')[0];
  f.ui.closeOverlays(); assert.equal(f.doc.activeElement, menu); assert.equal(dialog.isConnected, false);
  const card = tile(f, id); card.dispatch('pointerdown'); assert.equal(f.doc.events.pointermove.length, 1); openCard(f, id); const activeDialog = byClass(f.container, 'pt-dialog')[0]; const before = f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id);
  f.ui.destroy(); assert.equal(activeDialog.isConnected, false); assert.equal(activeDialog.open, false); assert.equal(f.container.children.length, 0); assert.equal(f.doc.events.pointermove.length, 0); assert.equal(f.doc.events.keydown.length, 0); assert.equal(card.events.pointerdown.length, 0); assert.equal(card.style.touchAction, ''); assert.equal(f.map.get(PLAYTEST_STORAGE_PREFIX + f.deck.id), before);
});
