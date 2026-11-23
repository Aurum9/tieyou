import test from 'node:test';
import assert from 'node:assert/strict';
import { battlefieldPoint, battlefieldExtent, snappedBattlefieldPoint, snappedBattlefieldPixels, handCardGap } from '../web/lib/playtest-layout.js';
import { PlaytestSession } from '../web/lib/playtest.js';

test('hand spacing uses free room first, overlaps only as needed and retains a visible edge', () => {
  assert.equal(handCardGap(600, 100, 5), 6);
  assert.equal(handCardGap(400, 100, 5), -25);
  assert.equal(handCardGap(100, 100, 20), -25);
  assert.equal(handCardGap(350, 100, 6), -25);
});
test('default banks stay independent and adding cards extends the surface without wrapping existing cards', () => {
  const upper = { row: 'upper', slot: 0 }, lower = { row: 'lower', slot: 0 };
  const first = battlefieldExtent(320, 140, 100, 140, [upper, lower]);
  const top = battlefieldPoint(upper, 320, first.bankHeight, 100, 140), bottom = battlefieldPoint(lower, 320, first.bankHeight, 100, 140);
  assert.equal(top.x, bottom.x); assert.ok(bottom.y >= top.y + 140 + 8);
  const more = battlefieldExtent(320, 140, 100, 140, [upper, lower, { row: 'upper', slot: 4 }]);
  assert.ok(more.width > 320); assert.equal(more.bankHeight, first.bankHeight);
  assert.deepEqual(battlefieldPoint(lower, 320, more.bankHeight, 100, 140), bottom);
  const manual = snappedBattlefieldPixels(430, 198);
  assert.deepEqual(battlefieldPoint(manual, 320, first.bankHeight, 100, 140), battlefieldPoint(manual, 800, more.bankHeight + 100, 100, 140));
});
test('free positions snap to six pixel increments, stay inside the canvas and scale on rotation', () => {
  const position = snappedBattlefieldPoint(101, 77, 400, 400, 100, 140);
  const point = battlefieldPoint(position, 400, 400, 100, 140);
  assert.ok(Math.abs(point.x - 104) < 1); assert.ok(Math.abs(point.y - 80) < 1);
  assert.deepEqual(snappedBattlefieldPoint(-100, 900, 400, 400, 100, 140), { x: 0, y: 1000 });
  assert.equal(battlefieldPoint({ x: 1000, y: 1000 }, 250, 250, 100, 140).x, 130);
  assert.ok(battlefieldPoint({ row: 'upper', slot: 0 }, 400, 400, 100, 140).y < battlefieldPoint({ row: 'lower', slot: 0 }, 400, 400, 100, 140).y);
});
test('free battlefield coordinates permit overlap, persist and reject partial or invalid coordinates atomically', () => {
  const cards = [{ id: 'card', name: 'Forest', typeLine: 'Land', versions: [{ id: 'v' }] }];
  const deck = { id: 'd', name: 'd', entries: [{ id: 'e', cardId: 'card', versionId: 'v', quantity: 10, zone: 'main' }] };
  const s = new PlaytestSession(deck, cards, { drawFirstTurn: false }); s.dispatch({ type: 'keep' });
  const [a, b] = s.state.zones.hand;
  s.dispatch({ type: 'move', id: a, to: 'battlefield', x: 400, y: 600 });
  s.dispatch({ type: 'tap', id: a }); s.dispatch({ type: 'move', id: b, to: 'battlefield', x: 400, y: 600 });
  const before = s.state;
  assert.equal(before.battlefieldPositions[a].x, before.battlefieldPositions[b].x);
  assert.equal(before.pieces[a].tapped, true);
  assert.throws(() => s.dispatch({ type: 'move', id: a, to: 'battlefield', x: 1 }));
  assert.throws(() => s.dispatch({ type: 'move', id: a, to: 'battlefield', x: 1001, y: 0 }));
  assert.deepEqual(s.state, before); assert.deepEqual(PlaytestSession.restore(s.export(), cards).state, before);
  const malformed = structuredClone(s.export()); malformed.state.battlefieldPositions[a].y = -1;
  assert.throws(() => PlaytestSession.restore(malformed, cards));
  s.dispatch({ type: 'roll', sides: 20, count: 3 });
  assert.ok(s.state.lastRoll.values.every(value => value >= 1 && value <= 20));
  assert.deepEqual(PlaytestSession.restore(s.export(), cards).state.lastRoll, s.state.lastRoll);
  s.dispatch({ type: 'move', id: a, to: 'battlefield', pixelX: 600, pixelY: 242 });
  assert.deepEqual(PlaytestSession.restore(s.export(), cards).state, s.state);
  const pixels = s.state;
  assert.throws(() => s.dispatch({ type: 'move', id: a, to: 'battlefield', pixelX: 600 }));
  assert.throws(() => s.dispatch({ type: 'move', id: a, to: 'battlefield', pixelX: -6, pixelY: 10 }));
  assert.deepEqual(s.state, pixels);
});
