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

function fixture() {
  const root = surface();
  const doc = surface();
  const view = surface();
  view.innerHeight = 800;
  view.innerWidth = 400;
  view.scrollX = 0;
  view.scrollY = 500;
  view.scrollTo = ({ left, top }) => { view.scrollX = left; view.scrollY = top; };
  doc.defaultView = view;
  doc.elementFromPoint = () => doc.hit;
  root.ownerDocument = doc;
  const grip = surface(root);
  const header = surface(root);
  const child = surface(header);
  const moves = [];
  const controller = createDeckEditorDrag(root, { onMove: (...args) => {
    assert.equal(root.classList.has('is-dragging'), false);
    moves.push(args);
  } });
  controller.registerHandle(grip, 'entry-1');
  controller.registerTarget(header, { category: '抓牌' });
  return { root, doc, view, grip, header, child, moves, controller };
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

test('escaping an active drag restores scroll and prevents a late drop', () => {
  const { root, doc, view, grip, header, child, moves, controller } = fixture();
  root.dispatch('pointerdown', { target: grip });
  doc.hit = child;
  doc.dispatch('pointermove', { clientX: 130 });
  view.scrollY = 250;
  assert.equal(doc.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(view.scrollY, 500);
  assert.equal(root.classList.size, 0);
  assert.equal(header.classList.size, 0);
  doc.dispatch('pointerup');
  assert.deepEqual(moves, []);
  controller.dispose();
});
