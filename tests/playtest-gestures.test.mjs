import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCardGestures } from '../dist/lib/playtest-gestures.js';

class Node {
  constructor({ dropZone, hand = false, menu = false } = {}) {
    this.events = new Map(); this.style = {}; this.classes = new Set(); this.dataset = dropZone ? { dropZone } : {}; this.hand = hand; this.menu = menu; this.scrollLeft = 100; this.children = [];
    this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)) };
  }
  addEventListener(type, fn, options) { const listeners = this.events.get(type) || []; listeners.push({ fn, capture: options === true }); this.events.set(type, listeners); }
  removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(item => item.fn !== fn)); }
  dispatch(type, props = {}) {
    const event = { target: this, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 120, clientY: 120, detail: 1, ...props, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const { fn } of [...(this.events.get(type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) { fn(event); if (event.stopped) break; }
    return event;
  }
  closest(selector) { if (selector === '[data-drop-zone]') return this.dataset.dropZone ? this : this.parent?.closest(selector); if (selector === '[data-hand-scroll]') return this.hand ? this : this.parent?.closest(selector); if (selector === '.pt-card-menu, [data-gesture-ignore]') return this.menu ? this : null; return null; }
  getBoundingClientRect() { return { left: 100, top: 100, width: 100, height: 140, right: 200, bottom: 240 }; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
  cloneNode() { return new Node(); }
  append(node) { this.children.push(node); node.parent = this; }
  remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute() {}
  removeAttribute() {}
  querySelectorAll() { return []; }
}
function fixture({ axis = 'free', zone = 'hand' } = {}) {
  const doc = new Node(), body = new Node(), card = new Node(), hand = new Node({ hand: true }), drop = new Node({ dropZone: 'battlefield' }), calls = [], menus = [];
  card.ownerDocument = doc; card.parent = hand; doc.body = body; doc.defaultView = { innerWidth: 390, innerHeight: 844 }; doc.point = drop; doc.elementFromPoint = () => doc.point;
  const cleanup = attachCardGestures(card, { id: 'piece-1', zone, axis, onDrop: (...args) => calls.push(args), onMenu: () => menus.push(true) });
  const pointer = (type, props) => (type === 'pointerdown' ? card : doc).dispatch(type, props);
  return { doc, body, card, hand, drop, calls, menus, cleanup, pointer };
}
test('short click remains a normal card click; desktop dragging drops once and suppresses tap', () => {
  const f = fixture(); let taps = 0; f.card.addEventListener('click', () => taps++);
  f.pointer('pointerdown'); f.pointer('pointerup'); f.card.dispatch('click'); assert.equal(taps, 1);
  f.pointer('pointerdown'); f.pointer('pointermove', { clientX: 170 }); assert.ok(f.card.classes.has('pt-card-dragging')); assert.ok(f.drop.classes.has('pt-drop-active')); assert.equal(f.body.children.length, 1);
  f.pointer('pointerup', { clientX: 170 }); f.card.dispatch('click'); assert.equal(taps, 1); assert.deepEqual(f.calls, [['piece-1', 'battlefield']]); assert.equal(f.body.children.length, 0); assert.equal(f.drop.classes.size, 0);
  f.pointer('pointerdown'); f.pointer('pointerup'); f.card.dispatch('click'); assert.equal(taps, 2); f.cleanup();
});
test('touch horizontal hand swipes scroll without moving a card; vertical swipes drag', () => {
  const f = fixture({ axis: 'horizontal' });
  f.pointer('pointerdown', { pointerType: 'touch' }); f.pointer('pointermove', { clientX: 80, clientY: 122 }); assert.equal(f.hand.scrollLeft, 140); assert.equal(f.body.children.length, 0);
  f.pointer('pointerup', { clientX: 80 }); assert.deepEqual(f.calls, []); assert.equal(f.card.dispatch('click').prevented, true);
  f.pointer('pointerdown', { pointerType: 'touch' }); f.pointer('pointermove', { clientX: 122, clientY: 80 }); assert.ok(f.card.classes.has('pt-card-dragging')); f.pointer('pointerup', { clientX: 122, clientY: 80 }); assert.equal(f.calls.length, 1); f.cleanup();
});
test('holding opens the menu on release and suppresses tap; moving after hold can drag horizontally', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ axis: 'horizontal' });
  f.pointer('pointerdown', { pointerType: 'touch' }); t.mock.timers.tick(550); assert.ok(f.card.classes.has('pt-card-held')); assert.equal(f.menus.length, 0);
  f.pointer('pointerup'); assert.equal(f.menus.length, 1); assert.equal(f.card.dispatch('click').prevented, true);
  f.pointer('pointerdown', { pointerType: 'touch' }); t.mock.timers.tick(550); f.pointer('pointermove', { clientX: 180 }); assert.ok(f.card.classes.has('pt-card-dragging')); assert.equal(f.hand.scrollLeft, 100); f.pointer('pointerup', { clientX: 180 }); assert.equal(f.calls.length, 1); assert.equal(f.menus.length, 1); f.cleanup();
});
test('cancel, Escape, outside-window release and invalid destinations never move cards', () => {
  for (const reason of ['cancel', 'escape', 'outside', 'empty', 'same']) {
    const f = fixture(); f.pointer('pointerdown'); f.pointer('pointermove', { clientY: 190 });
    if (reason === 'cancel') f.pointer('pointercancel');
    else if (reason === 'escape') f.doc.dispatch('keydown', { key: 'Escape' });
    else { if (reason === 'empty') f.doc.point = null; if (reason === 'same') f.doc.point = new Node({ dropZone: 'hand' }); f.pointer('pointerup', { clientX: reason === 'outside' ? -10 : 150 }); }
    assert.equal(f.calls.length, 0, reason); assert.equal(f.body.children.length, 0, reason); assert.equal(f.card.classes.size, 0, reason); assert.equal(f.drop.classes.size, 0, reason); f.cleanup();
  }
});
test('right-click opens the menu, corner buttons do not start a card gesture, and cleanup releases listeners', () => {
  const f = fixture(); assert.equal(f.card.dispatch('contextmenu').prevented, true); assert.equal(f.menus.length, 1);
  const menu = new Node({ menu: true }); f.pointer('pointerdown', { target: menu }); f.pointer('pointermove', { clientY: 190 }); f.pointer('pointerup'); assert.equal(f.calls.length, 0); assert.equal(f.body.children.length, 0);
  f.pointer('pointerdown'); f.pointer('pointermove', { clientY: 190 }); f.cleanup(); assert.equal(f.body.children.length, 0); assert.equal(f.card.classes.size, 0); assert.equal(f.doc.events.get('pointermove').length, 0); assert.equal(f.card.events.get('pointerdown').length, 0); assert.equal(f.card.style.touchAction, '');
});
test('touch context menu is deferred until release and library-top is a valid drop', () => {
  const f = fixture(); f.pointer('pointerdown', { pointerType: 'touch' }); f.card.dispatch('contextmenu'); assert.equal(f.menus.length, 0); f.pointer('pointerup'); assert.equal(f.menus.length, 1);
  f.doc.point = new Node({ dropZone: 'library-top' }); f.pointer('pointerdown'); f.pointer('pointermove', { clientY: 190 }); f.pointer('pointerup'); assert.deepEqual(f.calls, [['piece-1', 'library-top']]); f.cleanup();
});
test('a new pointer interaction on the corner menu is usable even when a browser omitted the post-drag click', () => {
  const f = fixture(); f.pointer('pointerdown'); f.pointer('pointermove', { clientY: 190 }); f.pointer('pointerup');
  const menu = new Node({ menu: true }); f.pointer('pointerdown', { target: menu }); assert.equal(f.card.dispatch('click', { target: menu }).prevented, false); f.cleanup();
});
test('dragging near viewport or hand edges scrolls and cleanup cancels the animation', () => {
  const f = fixture(), frames = new Map(), scrolls = []; let sequence = 0;
  Object.assign(f.doc.defaultView, { requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); }, scrollBy: (x, y) => scrolls.push([x, y]) });
  const nextFrame = () => { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); };
  f.pointer('pointerdown'); f.pointer('pointermove', { clientY: 10 }); nextFrame(); assert.ok(scrolls[0][1] < 0);
  f.doc.point = f.hand; f.pointer('pointermove', { clientX: 190, clientY: 110 }); nextFrame(); assert.ok(f.hand.scrollLeft > 100);
  f.cleanup(); assert.equal(frames.size, 0); assert.equal(f.body.children.length, 0); assert.equal(f.card.captured, null);
});
