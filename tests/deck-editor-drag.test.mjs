import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeckEditorDrag } from '../web/lib/deck-editor-drag.js';

function surface(parentNode = null) {
  const events = new Map();
  const classes = new Set();
  classes.remove = name => classes.delete(name);
  return {
    parentNode,
    style: {},
    classList: classes,
    children: [],
    attributes: {},
    offsetWidth: 76,
    offsetHeight: 106,
    append(child) { child.parentNode = this; this.children.push(child); },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect: () => ({ top: 100, bottom: 140, height: 40 }),
    addEventListener(type, handler) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(handler);
    },
    removeEventListener(type, handler) { events.get(type)?.delete(handler); },
    dispatch(type, properties = {}) {
      const event = {
        target: this, pointerId: 1, button: 0, clientX: 100, clientY: 110, detail: 1,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {},
        ...properties,
      };
      for (const handler of events.get(type) || []) handler(event);
      return event;
    },
  };
}

function fixture({ external = false } = {}) {
  const root = surface(external ? surface() : null);
  const inputRoot = root.parentNode || root;
  const doc = surface();
  const view = surface();
  view.innerHeight = 800;
  view.innerWidth = 400;
  view.scrollX = 0;
  view.scrollY = 500;
  view.scrollTo = ({ left, top }) => { view.scrollX = left; view.scrollY = top; };
  const frames = new Map();
  let nextFrame = 0;
  view.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  view.cancelAnimationFrame = id => frames.delete(id);
  const runFrame = () => {
    const current = [...frames.values()];
    frames.clear();
    for (const callback of current) callback();
  };
  doc.defaultView = view;
  doc.elementFromPoint = () => doc.hit;
  doc.body = surface();
  doc.createElement = tagName => ({ ...surface(), tagName });
  root.ownerDocument = doc;
  const grip = surface(root);
  const header = surface(root);
  const child = surface(header);
  const moves = [], adds = [], dragStates = [];
  const controller = createDeckEditorDrag(root, {
    inputRoot,
    onMove: (...args) => {
      assert.equal(root.classList.has('is-dragging'), false);
      moves.push(args);
    },
    onAdd: (...args) => {
      assert.equal(root.classList.has('is-dragging'), false);
      adds.push(args);
    },
    onDragChange: active => {
      assert.equal(root.classList.has('is-dragging'), active);
      dragStates.push(active);
    },
  });
  controller.registerHandle(grip, 'entry-1');
  controller.registerTarget(header, { category: '抓牌' });
  return { root, inputRoot, doc, view, grip, header, child, moves, adds, controller, runFrame, dragStates };
}

test('a short grip click stays usable, and dropping over a nested header button moves once', () => {
  const { root, doc, grip, header, child, moves, controller } = fixture();
  root.dispatch('pointerdown', { target: grip });
  doc.dispatch('pointermove', { clientX: 102 });
  doc.dispatch('pointerup');
  assert.equal(root.dispatch('click').defaultPrevented, false);
  assert.deepEqual(moves, []);

  root.dispatch('pointerdown', { target: grip, pointerType: 'touch' });
  doc.hit = child;
  doc.dispatch('pointermove', { clientX: 130, pointerType: 'touch' });
  assert.equal(root.classList.has('is-dragging'), true);
  assert.equal(header.classList.has('is-drag-over'), true);
  doc.dispatch('pointerup', { clientX: 130 });
  assert.deepEqual(moves, [['entry-1', { category: '抓牌' }]]);
  assert.equal(header.classList.size, 0);
  assert.equal(root.dispatch('click').defaultPrevented, true);
  controller.dispose();
});

test('moving headers update hover before release and Escape preserves the current scroll position', () => {
  const { root, doc, view, grip, header, child, moves, controller, runFrame, dragStates } = fixture();
  root.dispatch('pointerdown', { target: grip });
  doc.dispatch('pointermove', { clientX: 130 });
  assert.equal(header.classList.has('is-drag-over'), false);
  doc.hit = child;
  runFrame();
  assert.equal(header.classList.has('is-drag-over'), true);
  view.scrollY = 250;
  assert.equal(doc.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(view.scrollY, 250);
  assert.equal(root.classList.size, 0);
  assert.equal(header.classList.size, 0);
  doc.dispatch('pointerup');
  assert.deepEqual(moves, []);
  assert.deepEqual(dragStates, [true, false]);
  controller.dispose();
});

test('touch image taps and early swipes stay native, and a deliberate held drag can move the card', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, doc, child, moves, controller } = fixture();
  const image = surface(root);
  controller.registerHandle(image, 'image-1', { touchHold: true });
  const touch = { identifier: 5, clientX: 100, clientY: 110 };
  const moved = { ...touch, clientY: 140 };
  const start = () => {
    root.dispatch('pointerdown', { target: image, pointerType: 'touch' });
    root.dispatch('touchstart', { target: image, touches: [touch], changedTouches: [touch] });
  };

  start();
  assert.equal(doc.dispatch('touchend', { changedTouches: [touch] }).defaultPrevented, false);
  assert.equal(root.dispatch('click', { target: image }).defaultPrevented, false);

  start();
  assert.equal(doc.dispatch('touchmove', { changedTouches: [moved] }).defaultPrevented, false);
  t.mock.timers.tick(500);
  assert.equal(root.classList.has('is-dragging'), false);

  doc.hit = child;
  start();
  t.mock.timers.tick(500);
  assert.equal(root.classList.has('is-dragging'), true);
  doc.dispatch('touchend', { changedTouches: [touch] });
  assert.deepEqual(moves, []);

  start();
  t.mock.timers.tick(500);
  assert.equal(doc.dispatch('touchmove', { changedTouches: [moved] }).defaultPrevented, true);
  assert.equal(doc.dispatch('touchend', { changedTouches: [moved] }).defaultPrevented, true);
  assert.deepEqual(moves, [['image-1', { category: '抓牌' }]]);
  assert.equal(root.dispatch('click', { target: image }).defaultPrevented, true);
  controller.dispose();
});

test('external card drag shows a floating preview and sends the source to the add callback', () => {
  const { inputRoot, doc, child, adds, moves, controller, runFrame } = fixture({ external: true });
  const result = surface(inputRoot);
  const source = { cardId: 'new-card', versionId: 'v2' };
  const unregister = controller.registerExternalHandle(result, source, {
    preview: { name: '有名牌', image: 'https://example.com/card.jpg' },
  });
  const start = () => {
    inputRoot.dispatch('pointerdown', { target: result });
    doc.dispatch('pointermove', { clientX: 130 });
  };

  start();
  const [ghost] = doc.body.children;
  assert.equal(ghost.className, 'deck-editor-drag-ghost');
  assert.equal(ghost.attributes['aria-hidden'], 'true');
  assert.equal(ghost.children[0].textContent, '有名牌');
  assert.equal(ghost.children[1].src, 'https://example.com/card.jpg');
  ghost.children[1].dispatch('load');
  assert.equal(ghost.classList.has('has-image'), true);
  const firstPosition = ghost.style.transform;
  doc.hit = child;
  doc.dispatch('pointermove', { clientX: 180 });
  runFrame();
  assert.notEqual(ghost.style.transform, firstPosition);
  doc.dispatch('pointerup', { clientX: 180 });
  assert.deepEqual(adds, [[source, { category: '抓牌' }]]);
  assert.deepEqual(moves, []);
  assert.equal(doc.body.children.length, 0);

  start();
  assert.equal(doc.body.children.length, 1);
  unregister();
  assert.equal(doc.body.children.length, 0);
  assert.equal(result.style.touchAction, '');
  doc.dispatch('pointerup', { clientX: 180 });
  assert.equal(adds.length, 1);
  controller.dispose();
});
