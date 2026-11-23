import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlaytestSession, PLAYTEST_ZONES } from '../web/lib/playtest.js';

const cards = [
  { id: 'land', name: 'Forest', zhName: '树林', typeLine: 'Basic Land — Forest', versions: [{ id: 'v-land' }] },
  { id: 'spell', name: 'Draw spell', zhName: '抓牌咒语', typeLine: 'Sorcery', versions: [{ id: 'v-spell' }] },
  { id: 'chief', name: 'Commander', zhName: '统帅', typeLine: 'Legendary Creature', versions: [{ id: 'v-chief' }] },
  { id: 'mdfc', name: 'Spell // Land', typeLine: 'Sorcery // Land', layout: 'modal_dfc', faces: [{ name: 'Spell', typeLine: 'Sorcery' }, { name: 'Land', typeLine: 'Land' }], versions: [{ id: 'v-mdfc' }] },
  { id: 'flip', name: 'Flip creature', typeLine: 'Creature', layout: 'flip', faces: [{ name: 'Flip creature', typeLine: 'Creature' }, { name: 'Inverted creature', typeLine: 'Legendary Creature' }], versions: [{ id: 'v-flip' }] }
];
const entry = (cardId, quantity = 1, zone = 'main') => ({ id: `e-${cardId}-${zone}`, cardId, versionId: `v-${cardId}`, quantity, zone, categories: [], notes: '' });
const deck = () => ({ id: 'deck', name: '引擎测试', updatedAt: '2026-11-06', entries: [entry('land', 12), entry('spell', 8), entry('chief', 1, 'commander'), entry('mdfc', 1), entry('spell', 3, 'considering')] });
const make = (settings = {}) => new PlaytestSession(deck(), cards, settings, { random: () => 0.5 });
const playing = (settings = {}) => { const s = make(settings); s.dispatch({ type: 'keep' }); return s; };
const find = (s, cardId) => Object.values(s.state.pieces).find(p => p.cardId === cardId).id;
const moveHand = (s, id) => s.dispatch({ type: 'move', id, to: 'hand' });
test('batch movement preserves selected order at library top and is atomic on invalid IDs', () => {
  const s = playing(), ids = s.state.zones.hand.slice(0, 3), remainder = [...s.state.zones.library];
  const before = s.state;
  assert.throws(() => s.dispatch({ type: 'batchMove', from: 'hand', to: 'library', ids: [...ids, 'missing'], position: 'top' }));
  assert.deepEqual(s.state, before);
  assert.throws(() => s.dispatch({ type: 'batchMove', from: 'hand', to: 'library', ids: [ids[0], ids[0]] }));
  s.dispatch({ type: 'batchMove', from: 'hand', to: 'library', ids, position: 'top' });
  assert.deepEqual(s.state.zones.library, [...ids, ...remainder]); conserved(s);
});

test('batch battlefield entry allocates distinct slots and untapAll preserves counters and positions', () => {
  const s = playing(), ids = s.state.zones.hand.slice(0, 3);
  s.dispatch({ type: 'batchMove', from: 'hand', to: 'battlefield', ids });
  const positions = s.state.battlefieldPositions;
  assert.equal(new Set(ids.map(id => JSON.stringify(positions[id]))).size, ids.length);
  for (const id of ids) s.dispatch({ type: 'tap', id });
  s.dispatch({ type: 'counter', id: ids[0], name: '+1/+1', delta: 2 });
  s.dispatch({ type: 'untapAll' });
  assert.ok(ids.every(id => !s.state.pieces[id].tapped));
  assert.equal(s.state.pieces[ids[0]].counters['+1/+1'], 2); assert.deepEqual(s.state.battlefieldPositions, positions);
  s.dispatch({ type: 'batchMove', from: 'battlefield', to: 'graveyard', ids });
  assert.deepEqual(s.state.battlefieldPositions, {}); assert.deepEqual(s.state.pieces[ids[0]].counters, {}); conserved(s);
});

test('random discard samples without replacement, rejects excess and never modifies the deck', () => {
  const s = playing(), before = s.state, count = 3;
  assert.throws(() => s.dispatch({ type: 'randomDiscard', count: before.zones.hand.length + 1 }));
  assert.deepEqual(s.state, before);
  s.dispatch({ type: 'randomDiscard', count });
  assert.equal(s.state.zones.graveyard.length, count); assert.equal(s.state.zones.hand.length, before.zones.hand.length - count);
  assert.ok(s.state.zones.graveyard.every(id => before.zones.hand.includes(id)));
  assert.deepEqual(s.state.deck, before.deck); conserved(s);
});

test('shuffle-in batch keeps all cards, supports persistence and rejects invalid destinations', () => {
  const s = playing(), ids = s.state.zones.hand, library = s.state.zones.library;
  assert.throws(() => s.dispatch({ type: 'batchMove', from: 'hand', to: 'hand', ids }));
  assert.throws(() => s.dispatch({ type: 'batchMove', from: 'hand', to: 'graveyard', ids, position: 'shuffle' }));
  s.dispatch({ type: 'batchMove', from: 'hand', to: 'library', ids, position: 'shuffle' });
  assert.equal(s.state.zones.hand.length, 0); assert.deepEqual(new Set(s.state.zones.library), new Set([...ids, ...library]));
  assert.deepEqual(PlaytestSession.restore(s.export(), cards).state, s.state); conserved(s);
});
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
test('land play has no turn allowance, including sessions with the old zero limit', () => {
  const s = playing(), lands = Object.values(s.state.pieces).filter(p => p.cardId === 'land').slice(0, 3).map(p => p.id); lands.forEach(id => moveHand(s, id));
  s.dispatch({ type: 'setLandLimit', value: 0 });
  for (const id of lands) s.dispatch({ type: 'playLand', id });
  assert.equal(s.state.landsPlayed, 3); assert.ok(lands.every(id => s.state.zones.battlefield.includes(id))); conserved(s);
});
test('MDFC land plays using selected face, then returns to its front face in hand', () => {
  const s = playing(), id = find(s, 'mdfc'); moveHand(s, id); assert.throws(() => s.dispatch({ type: 'playLand', id }), /当前牌面为地/);
  s.dispatch({ type: 'flip', id }); s.dispatch({ type: 'playLand', id }); assert.equal(s.state.pieces[id].face, 1); moveHand(s, id); assert.equal(s.state.pieces[id].face, 0);
});
test('flip-card inversion is independent of tapping and double-faced card selection', () => {
  const s = new PlaytestSession({ ...deck(), entries: [...deck().entries, entry('flip')] }, cards, {}, { random: () => 0.5 });
  s.dispatch({ type: 'keep' }); const id = find(s, 'flip'), mdfc = find(s, 'mdfc');
  s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'invert', id }); s.dispatch({ type: 'tap', id });
  assert.equal(s.state.pieces[id].inverted, true); assert.equal(s.state.pieces[id].tapped, true); assert.equal(s.state.pieces[id].face, 0);
  s.dispatch({ type: 'flip', id: mdfc }); assert.equal(s.state.pieces[mdfc].face, 1); assert.equal(s.state.pieces[mdfc].inverted, false);
  const saved = PlaytestSession.restore(s.export(), cards); assert.deepEqual(saved.state, s.state);
  s.dispatch({ type: 'invert', id }); assert.equal(s.state.pieces[id].inverted, false); assert.equal(s.state.pieces[id].tapped, true);
  s.dispatch({ type: 'invert', id }); s.dispatch({ type: 'move', id, to: 'battlefield' }); assert.equal(s.state.pieces[id].inverted, true);
  s.dispatch({ type: 'move', id, to: 'hand' }); assert.equal(s.state.pieces[id].inverted, false); assert.equal(s.state.pieces[id].tapped, false); conserved(s, 23);
});
test('inversion rejects ordinary cards and tokens without changing the session', () => {
  const s = playing(); s.dispatch({ type: 'token', name: '士兵' }); const token = s.state.zones.battlefield.at(-1), before = s.state;
  for (const id of [find(s, 'chief'), find(s, 'mdfc'), token]) assert.throws(() => s.dispatch({ type: 'invert', id }), /无法倒转/);
  assert.deepEqual(s.state, before);
});
test('cast parks hand and commander cards on stack; manual resolution clears counters and tap', () => {
  const s = playing(), spell = find(s, 'spell'), chief = find(s, 'chief'); moveHand(s, spell); s.dispatch({ type: 'cast', id: spell }); s.dispatch({ type: 'cast', id: chief }); assert.deepEqual(s.state.zones.stack, [spell, chief]);
  s.dispatch({ type: 'move', id: chief, to: 'battlefield' }); s.dispatch({ type: 'tap', id: chief }); s.dispatch({ type: 'counter', id: chief, name: '+1/+1', delta: 3 }); s.dispatch({ type: 'move', id: chief, to: 'graveyard' }); assert.equal(s.state.pieces[chief].tapped, false); assert.deepEqual(s.state.pieces[chief].counters, {}); conserved(s);
});
test('each later turn always draws and untaps, even when passed legacy false options', () => {
  const s = playing({ drawEachTurn: false, untapEachTurn: false }), id = find(s, 'chief'); s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'tap', id }); const before = s.state;
  s.dispatch({ type: 'nextTurn' }); assert.equal(s.state.pieces[id].tapped, false); assert.equal(s.state.zones.hand.length, before.zones.hand.length + 1); s.undo(); assert.deepEqual(s.state, before); s.redo(); assert.equal(s.state.turn, 2);
  const normal = playing(), cid = find(normal, 'chief'); normal.dispatch({ type: 'move', id: cid, to: 'battlefield' }); normal.dispatch({ type: 'tap', id: cid }); const handSize = normal.state.zones.hand.length; normal.dispatch({ type: 'nextTurn' }); assert.equal(normal.state.pieces[cid].tapped, false); assert.equal(normal.state.zones.hand.length, handSize + 1);
});
test('undo and redo restore exact shuffled library order and alternate action drops redo', () => { const s = playing(), before = s.state; s.dispatch({ type: 'shuffle' }); const after = s.state; assert.notDeepEqual(after.zones.library, before.zones.library); s.undo(); assert.deepEqual(s.state, before); s.redo(); assert.deepEqual(s.state, after); s.undo(); s.dispatch({ type: 'life', delta: -2 }); assert.equal(s.canRedo, false); });
test('library search movement top/bottom positions conserve instances', () => { const s = playing(), id = s.state.zones.library[3]; s.dispatch({ type: 'move', id, to: 'library', position: 'top' }); assert.equal(s.state.zones.library[0], id); s.dispatch({ type: 'draw', count: 1 }); assert.equal(s.state.zones.hand.at(-1), id); s.dispatch({ type: 'move', id, to: 'library', position: 'bottom' }); assert.equal(s.state.zones.library.at(-1), id); conserved(s); });
test('manual movement accepts every zone and clears battlefield state across zones', () => {
  const s = playing(), id = find(s, 'chief');
  s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'tap', id }); s.dispatch({ type: 'counter', id, name: '+1/+1', delta: 2 });
  for (const to of ['command', 'hand', 'battlefield', 'exile', 'graveyard', 'stack', 'library']) {
    s.dispatch({ type: 'move', id, to }); assert.ok(s.state.zones[to].includes(id)); assert.equal(s.state.pieces[id].tapped, false); assert.deepEqual(s.state.pieces[id].counters, {}); conserved(s);
  }
});
test('counter validation forbids negatives and prototype keys; zero removes a counter', () => { const s = playing(), id = find(s, 'chief'); s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'counter', id, name: '+1/+1', delta: 1 }); const before = s.state; for (const action of [{ type: 'counter', id, name: '+1/+1', delta: -2 }, { type: 'counter', id, name: '__proto__', delta: 1 }]) assert.throws(() => s.dispatch(action)); assert.deepEqual(s.state, before); s.dispatch({ type: 'counter', id, name: '+1/+1', delta: -1 }); assert.deepEqual(s.state.pieces[id].counters, {}); });
test('tokens have independent states, may be removed and undo restores them; originals cannot be removed', () => { const s = playing(); s.dispatch({ type: 'token', name: '士兵', power: '1', toughness: '1', quantity: 2 }); const [a, b] = s.state.zones.battlefield; s.dispatch({ type: 'tap', id: a }); assert.equal(s.state.pieces[b].tapped, false); const before = s.state; assert.throws(() => s.dispatch({ type: 'removeToken', id: find(s, 'chief') })); assert.deepEqual(s.state, before); s.dispatch({ type: 'removeToken', id: a }); assert.equal(s.state.pieces[a], undefined); s.undo(); assert.deepEqual(s.state, before); conserved(s, 24); });
test('template tokens retain their rules, image and stats in progress independently of the source index', () => {
  const s = playing();
  const template = { id: 'soldier', printingId: 't-print', name: 'Soldier', zhName: '士兵', typeLine: 'Token Creature — Soldier',
    zhTypeLine: '衍生生物～士兵', oracleText: 'Vigilance', zhText: '警戒', translationSource: 'MTGZH', image: 'https://example.com/token.jpg',
    power: '2', toughness: '2', colors: ['W'] };
  s.dispatch({ type: 'token', template, quantity: 2 });
  const [a, b] = s.state.zones.battlefield;
  template.zhText = '其他规则'; template.colors[0] = 'B';
  s.dispatch({ type: 'counter', id: a, name: '+1/+1', delta: 1 });
  const restored = PlaytestSession.restore(s.export(), cards);
  assert.deepEqual(restored.state, s.state);
  const piece = restored.state.pieces[a];
  assert.equal(piece.name, '士兵'); assert.equal(piece.tokenName, 'Soldier'); assert.equal(piece.tokenTemplateId, 'soldier');
  assert.equal(piece.cardId, null); assert.equal(piece.printingId, 't-print'); assert.equal(piece.zhText, '警戒');
  assert.equal(piece.image, 'https://example.com/token.jpg'); assert.equal(piece.power, '2'); assert.deepEqual(piece.colors, ['W']);
  assert.deepEqual(restored.state.pieces[b].counters, {});
  assert.throws(() => s.dispatch({ type: 'token', template: { ...template, image: 'javascript:alert(1)' } }), /牌图地址/);
  const corrupt = s.export(); corrupt.state.pieces[a].face = 1;
  assert.throws(() => PlaytestSession.restore(corrupt, cards), /衍生物牌面/);
  conserved(s, 24);
});

test('the real token index distinguishes same-name variants and restores a transformed Incubator', () => {
  const data = JSON.parse(readFileSync(new URL('../web/data/playtest-tokens.json', import.meta.url), 'utf8'));
  assert.equal(data.version, 1);
  assert.ok(Object.values(data.byCard).every(ids => new Set(ids).size === ids.length && ids.every(id => Object.hasOwn(data.tokens, id))));
  const forCard = id => data.byCard[id].map(key => data.tokens[key]);
  const manufactor = forCard('f36d1d8b-8303-44a9-ab56-531931641ea2');
  assert.deepEqual(new Set(manufactor.map(token => token.zhName)), new Set(['珍宝', '线索', '食品']));
  assert.ok(manufactor.every(token => token.zhText && /^https:\/\/cards\.scryfall\.io\//.test(token.image)));
  const wurms = forCard('d1a60f44-7696-49ee-91fb-cab5b3102962');
  assert.deepEqual(new Set(wurms.map(token => token.zhText)), new Set(['死触', '系命']));
  assert.ok(wurms.every(token => token.name === 'Wurm' && token.power === '3' && token.toughness === '3'));
  assert.deepEqual(forCard('0a0a051c-59ed-4286-b842-a34da7ef15d5').map(token => token.name), ['Cursed']);
  const insect = forCard('aa854d50-444c-49d9-bfb1-5476b33c1c0b').find(token => token.name === 'Insect');
  assert.deepEqual([insect.power, insect.toughness, insect.colors], ['1', '1', ['G']]);
  const s = playing(), incubator = Object.values(data.tokens).find(token => token.name === 'Incubator');
  s.dispatch({ type: 'token', template: incubator });
  const id = s.state.zones.battlefield[0];
  s.dispatch({ type: 'flip', id });
  const restored = PlaytestSession.restore(s.export(), cards).state.pieces[id];
  assert.equal(restored.face, 1);
  assert.equal(restored.faces[restored.face].name, 'Phyrexian');
  assert.equal(restored.faces[restored.face].power, '0');
});
test('unrecognized, malformed and out-of-bounds actions preserve state and history', () => { const s = playing(), id = find(s, 'chief'), before = s.state; for (const a of [null, { type: 'bogus', id }, { type: 'draw', count: -1 }, { type: 'life', delta: NaN }, { type: 'move', id, to: 'nowhere' }, { type: 'tap', id }, { type: 'flip', id }, { type: 'token', name: '', quantity: 1 }]) assert.throws(() => s.dispatch(a)); assert.deepEqual(s.state, before); });
test('export/restore preserves zones, life, current snapshot, undo and redo without sharing references', () => { const s = playing(); s.dispatch({ type: 'life', delta: -5 }); s.dispatch({ type: 'draw', count: 2 }); s.undo(); const data = s.export(), restored = PlaytestSession.restore(data, cards); assert.deepEqual(restored.state, s.state); assert.equal(restored.canRedo, true); restored.redo(); s.redo(); assert.deepEqual(restored.state, s.state); data.state.life = 1; assert.notEqual(restored.state.life, 1); });
test('legacy progress defaults missing inversion flags and migrates fixed turn behavior', () => {
  const s = playing(), id = find(s, 'chief'); s.dispatch({ type: 'move', id, to: 'battlefield' }); s.dispatch({ type: 'tap', id }); const data = s.export();
  for (const state of [data.state, ...data.past, ...data.future]) {
    state.settings.drawEachTurn = false; state.settings.untapEachTurn = false;
    for (const piece of Object.values(state.pieces)) delete piece.inverted;
  }
  const restored = PlaytestSession.restore(data, cards), handSize = restored.state.zones.hand.length;
  assert.ok(Object.values(restored.state.pieces).every(piece => piece.inverted === false));
  assert.equal(restored.state.settings.drawEachTurn, true); assert.equal(restored.state.settings.untapEachTurn, true);
  restored.dispatch({ type: 'nextTurn' }); assert.equal(restored.state.pieces[id].tapped, false); assert.equal(restored.state.zones.hand.length, handSize + 1);
});
test('restore rejects malformed inversion flags and inversion on incompatible card definitions', () => {
  const s = playing(); s.dispatch({ type: 'token', name: '士兵' }); const base = s.export(), chief = find(s, 'chief'), token = s.state.zones.battlefield.at(-1);
  for (const [id, inverted] of [[chief, 'true'], [chief, null], [chief, true], [token, true]]) {
    const data = structuredClone(base); data.state.pieces[id].inverted = inverted; assert.throws(() => PlaytestSession.restore(data, cards));
  }
});
test('restore rejects duplicate, lost or foreign cards, unsupported format, broken settings and mismatched history', () => {
  const base = playing().export();
  const mutations = [d => { d.version = 9; }, d => { d.state.zones.hand.push(d.state.zones.hand[0]); }, d => { d.state.zones.hand.pop(); }, d => { d.state.pieces[d.state.zones.hand[0]].cardId = 'foreign'; }, d => { d.state.settings.freeMulligans = -1; }, d => { d.state.turn = 0; }, d => { d.past[0].sessionId = 'different'; }];
  for (const mutate of mutations) { const bad = structuredClone(base); mutate(bad); assert.throws(() => PlaytestSession.restore(bad, cards)); }
});
test('long sessions bound logs and persisted history while retaining valid progress', () => { const s = playing(); for (let i = 0; i < 110; i++) s.dispatch({ type: 'life', delta: -1 }); const data = s.export(); assert.equal(data.state.log.length, 100); assert.equal(data.past.length, 12); assert.ok(JSON.stringify(data).length < 1500000); assert.deepEqual(PlaytestSession.restore(data, cards).state, s.state); });
test('invalid random source cannot partially mutate a shuffle', () => { const s = new PlaytestSession(deck(), cards, {}, { random: () => 0.5 }); s.dispatch({ type: 'keep' }); const before = s.state; const restored = PlaytestSession.restore(s.export(), cards, { random: () => 1 }); assert.throws(() => restored.dispatch({ type: 'shuffle' }), /随机数/); assert.deepEqual(restored.state, before); });

test('lands and mana rocks fill lower slots while other cards fill upper slots and gaps stay open', () => {
  const tagCards = [
    { id: 'ring', typeLine: 'Artifact', tags: [{ slug: 'mana-rock' }] },
    { id: 'signet', typeLine: 'Artifact', tags: ['manarock'] },
    { id: 'elf', typeLine: 'Creature — Elf Druid', tags: ['mana-dork', 'ramp'] }
  ];
  const source = { ...deck(), entries: [entry('land', 2), entry('spell'), ...tagCards.map(card => entry(card.id))] };
  const s = new PlaytestSession(source, [...cards, ...tagCards], { drawFirstTurn: false });
  s.dispatch({ type: 'keep' });
  const [land, spareLand] = Object.values(s.state.pieces).filter(piece => piece.cardId === 'land').map(piece => piece.id);
  const [spell, ring, signet, elf] = ['spell', 'ring', 'signet', 'elf'].map(id => find(s, id));
  for (const id of [land, spell, ring, signet, elf]) s.dispatch({ type: 'move', id, to: 'battlefield' });
  assert.deepEqual(s.state.battlefieldPositions, {
    [land]: { row: 'lower', slot: 0 }, [spell]: { row: 'upper', slot: 0 }, [ring]: { row: 'lower', slot: 1 },
    [signet]: { row: 'lower', slot: 2 }, [elf]: { row: 'upper', slot: 1 }
  });
  s.dispatch({ type: 'move', id: land, to: 'graveyard' });
  assert.equal(s.state.battlefieldPositions[land], undefined);
  assert.deepEqual(s.state.battlefieldPositions[ring], { row: 'lower', slot: 1 });
  s.dispatch({ type: 'move', id: spareLand, to: 'battlefield' });
  assert.deepEqual(s.state.battlefieldPositions[spareLand], { row: 'lower', slot: 0 });
  conserved(s, 6);
});

test('moving or swapping battlefield slots keeps tap, counters and the selected face', () => {
  const s = playing(), chief = find(s, 'chief'), mdfc = find(s, 'mdfc');
  s.dispatch({ type: 'flip', id: mdfc });
  s.dispatch({ type: 'move', id: mdfc, to: 'battlefield' });
  s.dispatch({ type: 'move', id: chief, to: 'battlefield' });
  s.dispatch({ type: 'tap', id: mdfc });
  s.dispatch({ type: 'counter', id: mdfc, name: '测试', delta: 2 });
  const before = s.state;
  assert.deepEqual(before.battlefieldPositions[mdfc], { row: 'lower', slot: 0 });
  s.dispatch({ type: 'move', id: mdfc, to: 'battlefield', row: 'upper', slot: 0 });
  assert.deepEqual(s.state.battlefieldPositions, { [mdfc]: { row: 'upper', slot: 0 }, [chief]: { row: 'lower', slot: 0 } });
  assert.deepEqual(s.state.pieces, before.pieces);
  assert.deepEqual(s.state.zones, before.zones);
  s.dispatch({ type: 'move', id: mdfc, to: 'battlefield', slot: 6 });
  assert.deepEqual(s.state.battlefieldPositions[mdfc], { row: 'upper', slot: 6 });
  assert.deepEqual(PlaytestSession.restore(s.export(), cards).state.battlefieldPositions, s.state.battlefieldPositions);
  s.dispatch({ type: 'move', id: mdfc, to: 'battlefield', row: 'upper' });
  assert.deepEqual(s.state.battlefieldPositions[mdfc], { row: 'upper', slot: 0 });
  s.dispatch({ type: 'move', id: mdfc, to: 'battlefield', row: 'upper' });
  assert.deepEqual(s.state.battlefieldPositions[mdfc], { row: 'upper', slot: 0 });
  assert.deepEqual(s.state.pieces, before.pieces);
});

test('cross-zone placement falls back to the first free slot in the requested row', () => {
  const s = playing(), spell = find(s, 'spell'), land = find(s, 'land'), chief = find(s, 'chief');
  s.dispatch({ type: 'move', id: land, to: 'battlefield', row: 'lower', slot: 1199 });
  s.dispatch({ type: 'move', id: spell, to: 'battlefield', row: 'lower', slot: 1199 });
  assert.deepEqual(s.state.battlefieldPositions[land], { row: 'lower', slot: 1199 });
  assert.deepEqual(s.state.battlefieldPositions[spell], { row: 'lower', slot: 0 });
  const before = s.state;
  for (const extra of [{ slot: -1 }, { slot: 1200 }, { slot: 0.5 }, { row: 'middle' }, { to: 'hand', slot: 0 }]) {
    assert.throws(() => s.dispatch({ type: 'move', id: chief, to: 'battlefield', ...extra }));
  }
  assert.deepEqual(s.state, before);
  s.dispatch({ type: 'token', name: '地衍生物', typeLine: '基本地 — 平原' });
  const token = s.state.zones.battlefield.at(-1);
  assert.deepEqual(s.state.battlefieldPositions[token], { row: 'lower', slot: 1 });
  s.dispatch({ type: 'removeToken', id: token });
  assert.equal(s.state.battlefieldPositions[token], undefined);
  conserved(s);
});

test('reordering hand and viewed library cards preserves the rest of their zones', () => {
  const s = playing(), [first, second, ...restOfHand] = s.state.zones.hand;
  const [a, b, c, ...restOfLibrary] = s.state.zones.library;
  s.dispatch({ type: 'reorder', id: second, beforeId: first });
  assert.deepEqual(s.state.zones.hand, [second, first, ...restOfHand]);
  s.dispatch({ type: 'reorder', id: a, afterId: c });
  assert.deepEqual(s.state.zones.library, [b, c, a, ...restOfLibrary]);
  s.dispatch({ type: 'draw', count: 1 });
  assert.equal(s.state.zones.hand.at(-1), b);
  s.dispatch({ type: 'move', id: c, to: 'library', position: 'bottom' });
  assert.deepEqual(s.state.zones.library, [a, ...restOfLibrary, c]);
  const before = s.state;
  for (const extra of [{}, { beforeId: first, afterId: second }, { beforeId: second }, { afterId: a }]) {
    assert.throws(() => s.dispatch({ type: 'reorder', id: second, ...extra }));
  }
  assert.deepEqual(s.state, before);
  conserved(s);
});

test('older saves rebuild battlefield positions across current state and history', () => {
  const s = playing(), land = find(s, 'land'), chief = find(s, 'chief');
  s.dispatch({ type: 'move', id: land, to: 'battlefield', row: 'upper', slot: 6 });
  s.dispatch({ type: 'move', id: chief, to: 'battlefield', row: 'lower', slot: 4 });
  s.dispatch({ type: 'tap', id: land });
  s.undo();
  const data = s.export();
  for (const state of [data.state, ...data.past, ...data.future]) {
    delete state.battlefieldPositions;
    delete state.showLibraryTop;
  }
  const restored = PlaytestSession.restore(data, cards);
  assert.deepEqual(restored.state.battlefieldPositions, { [land]: { row: 'lower', slot: 0 }, [chief]: { row: 'upper', slot: 0 } });
  assert.equal(restored.state.showLibraryTop, false);
  restored.redo();
  assert.equal(restored.state.pieces[land].tapped, true);
  restored.undo(); restored.undo();
  assert.deepEqual(restored.state.battlefieldPositions, { [land]: { row: 'lower', slot: 0 } });
});

test('library top display persists and restore rejects corrupt battlefield positions', () => {
  const s = playing(), land = find(s, 'land'), chief = find(s, 'chief');
  s.dispatch({ type: 'move', id: land, to: 'battlefield' });
  s.dispatch({ type: 'move', id: chief, to: 'battlefield' });
  s.dispatch({ type: 'showLibraryTop', value: true });
  const data = s.export();
  assert.equal(PlaytestSession.restore(data, cards).state.showLibraryTop, true);
  assert.throws(() => s.dispatch({ type: 'showLibraryTop', value: 'false' }));
  assert.equal(s.state.showLibraryTop, true);
  const mutations = [
    state => { state.showLibraryTop = null; },
    state => { state.battlefieldPositions[land] = state.battlefieldPositions[chief]; },
    state => { state.battlefieldPositions[land].slot = 1200; },
    state => { delete state.battlefieldPositions[land]; state.battlefieldPositions.unknown = { row: 'lower', slot: 0 }; }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(data);
    mutate(bad.state);
    assert.throws(() => PlaytestSession.restore(bad, cards));
  }
});
