import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaytestSession, PLAYTEST_ZONES } from '../dist/lib/playtest.js';

const cards = [
  { id: 'land', name: 'Forest', zhName: '树林', typeLine: 'Basic Land — Forest', versions: [{ id: 'v-land' }] },
  { id: 'spell', name: 'Draw spell', zhName: '抓牌咒语', typeLine: 'Sorcery', versions: [{ id: 'v-spell' }] },
  { id: 'chief', name: 'Commander', zhName: '统帅', typeLine: 'Legendary Creature', versions: [{ id: 'v-chief' }] },
  { id: 'mdfc', name: 'Spell // Land', typeLine: 'Sorcery // Land', faces: [{ name: 'Spell', typeLine: 'Sorcery' }, { name: 'Land', typeLine: 'Land' }], versions: [{ id: 'v-mdfc' }] }
];
const entry = (cardId, quantity = 1, zone = 'main') => ({ id: `e-${cardId}-${zone}`, cardId, versionId: `v-${cardId}`, quantity, zone, categories: [], notes: '' });
const deck = () => ({ id: 'deck', name: '引擎测试', updatedAt: '2026-11-06', entries: [entry('land', 12), entry('spell', 8), entry('chief', 1, 'commander'), entry('mdfc', 1), entry('spell', 3, 'considering')] });
const make = (settings = {}) => new PlaytestSession(deck(), cards, settings, { random: () => 0.5 });
const playing = (settings = {}) => { const s = make(settings); s.dispatch({ type: 'keep' }); return s; };
const find = (s, cardId) => Object.values(s.state.pieces).find(p => p.cardId === cardId).id;
const moveHand = (s, id) => s.dispatch({ type: 'move', id, to: 'hand' });
function conserved(s, count = 22) { const state = s.state, ids = PLAYTEST_ZONES.flatMap(z => state.zones[z]); assert.equal(ids.length, count); assert.equal(new Set(ids).size, count); assert.equal(Object.keys(state.pieces).length, count); }

test('opening snapshot separates commander and excludes candidates, creating distinct copies', () => {
  const source = deck(), before = structuredClone(source), s = new PlaytestSession(source, cards, {}, { random: () => 0.5 });
  assert.equal(s.state.zones.hand.length, 7); assert.equal(s.state.zones.library.length, 14); assert.equal(s.state.zones.command.length, 1); conserved(s);
  assert.equal(s.state.deck.entries.some(e => e.zone === 'considering'), false); assert.deepEqual(source, before);
  source.entries[0].quantity = 99; const view = s.state; view.zones.hand.length = 0; view.pieces = {}; assert.equal(s.state.zones.hand.length, 7); assert.equal(s.state.deck.entries[0].quantity, 12);
});
test('default multiplayer settings keep seven and draw one at the first turn', () => { const s = playing(); assert.equal(s.state.turn, 1); assert.equal(s.state.phase, 'playing'); assert.equal(s.state.life, 40); assert.equal(s.state.zones.hand.length, 8); });
test('first free mulligan, then London paid mulligans require exact ordered bottom selection', () => {
  const s = make(); s.dispatch({ type: 'mulligan' }); assert.equal(s.state.bottomRequired, 0); s.dispatch({ type: 'mulligan' }); s.dispatch({ type: 'mulligan' }); assert.equal(s.state.bottomRequired, 2);
  const before = s.state; assert.throws(() => s.dispatch({ type: 'keep', bottomIds: [before.zones.hand[0], before.zones.hand[0]] }), /恰好/); assert.deepEqual(s.state, before);
  const bottom = before.zones.hand.slice(0, 2); s.dispatch({ type: 'keep', bottomIds: bottom }); assert.deepEqual(s.state.zones.library.slice(-2), bottom); assert.equal(s.state.zones.hand.length, 6); conserved(s);
});
test('paid mulligans can keep zero cards, then stop; first-turn draw can be disabled', () => {
  const s = make({ openingHandSize: 2, freeMulligans: 0, drawFirstTurn: false }); s.dispatch({ type: 'mulligan' }); s.dispatch({ type: 'mulligan' }); assert.equal(s.state.bottomRequired, 2);
  const before = s.state; assert.throws(() => s.dispatch({ type: 'mulligan' }), /无法继续/); assert.deepEqual(s.state, before);
  s.dispatch({ type: 'keep', bottomIds: s.state.zones.hand }); assert.equal(s.state.zones.hand.length, 0);
});
test('opening actions are gated and invalid keep operations are atomic', () => { const s = make(), before = s.state; for (const a of [{ type: 'draw' }, { type: 'nextTurn' }, { type: 'life', delta: -1 }, { type: 'keep', bottomIds: ['foreign'] }]) assert.throws(() => s.dispatch(a)); assert.deepEqual(s.state, before); assert.equal(s.canUndo, false); });
test('short draft draws only available cards and exhausted draw is logged', () => {
  const source = { ...deck(), entries: [entry('land', 2)] }, s = new PlaytestSession(source, cards);
  assert.equal(s.state.zones.hand.length, 2); s.dispatch({ type: 'keep' }); s.dispatch({ type: 'draw', count: 5 }); assert.equal(s.state.zones.hand.length, 2); assert.match(s.state.log.at(-1).text, /原计划 5/); conserved(s, 2);
});
test('missing card definitions, missing printing, empty library and invalid quantities reject clearly', () => {
  for (const entries of [[entry('missing')], [{ ...entry('land'), versionId: 'bad' }], [entry('chief', 1, 'commander')], [entry('land', 0)], [entry('land', 1.5)], [entry('land', 999), entry('spell', 2)]]) assert.throws(() => new PlaytestSession({ ...deck(), entries }, cards));
});
test('land play enforces turn allowance; explicit override and next turn reset work', () => {
  const s = playing(), lands = Object.values(s.state.pieces).filter(p => p.cardId === 'land').slice(0, 3).map(p => p.id); lands.forEach(id => moveHand(s, id));
  s.dispatch({ type: 'playLand', id: lands[0] }); assert.equal(s.state.landsPlayed, 1); const before = s.state; assert.throws(() => s.dispatch({ type: 'playLand', id: lands[1] }), /下地上限/); assert.deepEqual(s.state, before);
  s.dispatch({ type: 'setLandLimit', value: 2 }); s.dispatch({ type: 'playLand', id: lands[1] }); s.dispatch({ type: 'nextTurn' }); assert.equal(s.state.landLimit, 1); assert.equal(s.state.landsPlayed, 0); s.dispatch({ type: 'playLand', id: lands[2] }); conserved(s);
});
test('MDFC land plays using selected face, then returns to its front face in hand', () => {
  const s = playing(), id = find(s, 'mdfc'); moveHand(s, id); assert.throws(() => s.dispatch({ type: 'playLand', id }), /当前牌面为地/);
  s.dispatch({ type: 'flip', id }); s.dispatch({ type: 'playLand', id }); assert.equal(s.state.pieces[id].face, 1); moveHand(s, id); assert.equal(s.state.pieces[id].face, 0);
});
test('cast parks hand and commander cards on stack; manual resolution clears counters and tap', () => {
  const s = playing(), spell = find(s, 'spell'), chief = find(s, 'chief'); moveHand(s, spell); s.dispatch({ type: 'cast', id: spell }); s.dispatch({ type: 'cast', id: chief }); assert.deepEqual(s.state.zones.stack, [spell, chief]);
  s.dispatch({ type: 'move', id: chief, to: 'battlefield' }); s.dispatch({ type: 'tap', id: chief }); s.dispatch({ type: 'counter', id: chief, name: '+1/+1', delta: 3 }); s.dispatch({ type: 'move', id: chief, to: 'graveyard' }); assert.equal(s.state.pieces[chief].tapped, false); assert.deepEqual(s.state.pieces[chief].counters, {}); conserved(s);
});
test('turn options control draw and untap, and all normal card actions can be undone exactly', () => {
  const s = playing({ drawEachTurn: false, untapEachTurn: false }), id = find(s, 'chief'); s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'tap', id }); const before = s.state;
  s.dispatch({ type: 'nextTurn' }); assert.equal(s.state.pieces[id].tapped, true); assert.equal(s.state.zones.hand.length, before.zones.hand.length); s.undo(); assert.deepEqual(s.state, before); s.redo(); assert.equal(s.state.turn, 2);
  const normal = playing(), cid = find(normal, 'chief'); normal.dispatch({ type: 'move', id: cid, to: 'battlefield' }); normal.dispatch({ type: 'tap', id: cid }); const handSize = normal.state.zones.hand.length; normal.dispatch({ type: 'nextTurn' }); assert.equal(normal.state.pieces[cid].tapped, false); assert.equal(normal.state.zones.hand.length, handSize + 1);
});
test('undo and redo restore exact shuffled library order and alternate action drops redo', () => { const s = playing(), before = s.state; s.dispatch({ type: 'shuffle' }); const after = s.state; assert.notDeepEqual(after.zones.library, before.zones.library); s.undo(); assert.deepEqual(s.state, before); s.redo(); assert.deepEqual(s.state, after); s.undo(); s.dispatch({ type: 'life', delta: -2 }); assert.equal(s.canRedo, false); });
test('library search movement top/bottom positions conserve instances', () => { const s = playing(), id = s.state.zones.library[3]; s.dispatch({ type: 'move', id, to: 'library', position: 'top' }); assert.equal(s.state.zones.library[0], id); s.dispatch({ type: 'draw', count: 1 }); assert.equal(s.state.zones.hand.at(-1), id); s.dispatch({ type: 'move', id, to: 'library', position: 'bottom' }); assert.equal(s.state.zones.library.at(-1), id); conserved(s); });
test('counter validation forbids negatives and prototype keys; zero removes a counter', () => { const s = playing(), id = find(s, 'chief'); s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'counter', id, name: '+1/+1', delta: 1 }); const before = s.state; for (const action of [{ type: 'counter', id, name: '+1/+1', delta: -2 }, { type: 'counter', id, name: '__proto__', delta: 1 }]) assert.throws(() => s.dispatch(action)); assert.deepEqual(s.state, before); s.dispatch({ type: 'counter', id, name: '+1/+1', delta: -1 }); assert.deepEqual(s.state.pieces[id].counters, {}); });
test('tokens have independent states, may be removed and undo restores them; originals cannot be removed', () => { const s = playing(); s.dispatch({ type: 'token', name: '士兵', power: '1', toughness: '1', quantity: 2 }); const [a, b] = s.state.zones.battlefield; s.dispatch({ type: 'tap', id: a }); assert.equal(s.state.pieces[b].tapped, false); const before = s.state; assert.throws(() => s.dispatch({ type: 'removeToken', id: find(s, 'chief') })); assert.deepEqual(s.state, before); s.dispatch({ type: 'removeToken', id: a }); assert.equal(s.state.pieces[a], undefined); s.undo(); assert.deepEqual(s.state, before); conserved(s, 24); });
test('unrecognized, malformed and out-of-bounds actions preserve state and history', () => { const s = playing(), id = find(s, 'chief'), before = s.state; for (const a of [null, { type: 'bogus', id }, { type: 'draw', count: -1 }, { type: 'life', delta: NaN }, { type: 'move', id, to: 'nowhere' }, { type: 'tap', id }, { type: 'flip', id }, { type: 'token', name: '', quantity: 1 }]) assert.throws(() => s.dispatch(a)); assert.deepEqual(s.state, before); });
test('export/restore preserves zones, life, current snapshot, undo and redo without sharing references', () => { const s = playing(); s.dispatch({ type: 'life', delta: -5 }); s.dispatch({ type: 'draw', count: 2 }); s.undo(); const data = s.export(), restored = PlaytestSession.restore(data, cards); assert.deepEqual(restored.state, s.state); assert.equal(restored.canRedo, true); restored.redo(); s.redo(); assert.deepEqual(restored.state, s.state); data.state.life = 1; assert.notEqual(restored.state.life, 1); });
test('restore rejects duplicate, lost or foreign cards, unsupported format, broken settings and mismatched history', () => {
  const base = playing().export();
  const mutations = [d => { d.version = 9; }, d => { d.state.zones.hand.push(d.state.zones.hand[0]); }, d => { d.state.zones.hand.pop(); }, d => { d.state.pieces[d.state.zones.hand[0]].cardId = 'foreign'; }, d => { d.state.settings.freeMulligans = -1; }, d => { d.state.turn = 0; }, d => { d.past[0].sessionId = 'different'; }];
  for (const mutate of mutations) { const bad = structuredClone(base); mutate(bad); assert.throws(() => PlaytestSession.restore(bad, cards)); }
});
test('long sessions bound logs and persisted history while retaining valid progress', () => { const s = playing(); for (let i = 0; i < 110; i++) s.dispatch({ type: 'life', delta: -1 }); const data = s.export(); assert.equal(data.state.log.length, 100); assert.equal(data.past.length, 12); assert.ok(JSON.stringify(data).length < 1500000); assert.deepEqual(PlaytestSession.restore(data, cards).state, s.state); });
test('invalid random source cannot partially mutate a shuffle', () => { const s = new PlaytestSession(deck(), cards, {}, { random: () => 0.5 }); s.dispatch({ type: 'keep' }); const before = s.state; const restored = PlaytestSession.restore(s.export(), cards, { random: () => 1 }); assert.throws(() => restored.dispatch({ type: 'shuffle' }), /随机数/); assert.deepEqual(restored.state, before); });
