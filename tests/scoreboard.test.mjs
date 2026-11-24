import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freshTable, startTable, finishTable, commanderEligible, commanderRule, commanderPairFits, validateGameRecord } from '../web/lib/scoreboard-model.js';
import { createScoreboardStorage } from '../web/lib/scoreboard-storage.js';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createStandaloneAuth } from '../scripts/standalone-auth.mjs';
import { createScoreboardService } from '../scripts/standalone-scoreboard.mjs';

const card = (name, oracleText = '', typeLine = 'Legendary Creature — Human') => ({ id: name, name, faces: [{ oracleText, typeLine }] });
test('commander matching distinguishes eligible cards and each supported two-commander mechanic', () => {
  assert.equal(commanderEligible(card('Sol Ring', '', 'Artifact')), false);
  assert.equal(commanderEligible(card('ordinary', '', 'Creature — Human')), false);
  assert.equal(commanderEligible(card('forbidden', "This card can't be your commander.")), false);
  assert.ok(commanderEligible(card('walker', 'This card can be your commander.', 'Legendary Planeswalker — Test')));
  const partner = card('A', 'Partner (You can have two commanders.)'), other = card('B', 'Partner');
  assert.ok(commanderPairFits(partner, other)); assert.equal(commanderPairFits(partner, partner), false);
  const a = card('A', 'Partner with B (Reminder)'), b = card('B', 'Partner with A');
  assert.ok(commanderPairFits(a, b)); assert.equal(commanderPairFits(a, other), false);
  assert.equal(commanderRule(card('X', 'Another creature has partner.')), null);
  const bg = card('Background', '', 'Legendary Enchantment — Background'), choose = card('Choose', 'Choose a Background');
  assert.ok(commanderEligible(bg)); assert.ok(commanderPairFits(bg, choose)); assert.ok(commanderPairFits(choose, bg));
  assert.equal(commanderPairFits(bg, partner), false);
  const doctor = card('Doctor', '', 'Legendary Creature — Time Lord Doctor'), companion = card('Companion', "Doctor’s companion (Reminder)");
  assert.ok(commanderPairFits(doctor, companion)); assert.ok(commanderPairFits(companion, doctor));
  assert.ok(commanderPairFits(card('F', 'Friends forever'), card('G', 'Friends forever')));
  assert.equal(commanderPairFits(partner, card('F', 'Friends forever')), false);
  assert.ok(commanderPairFits(card('F', 'Partner—Friends forever (Reminder)'), card('G', 'Friends forever')));
  assert.equal(commanderPairFits(card('F', 'Partner—Friends forever'), card('G', 'Partner—Father & son')), false);
  assert.ok(commanderEligible(card('Grist, the Hunger Tide', "As long as Grist isn't on the battlefield, it's a 1/1 Insect creature in addition to its other types.", 'Legendary Planeswalker — Grist')));
});
test('start resets life, preserves seats and commanders; finish creates an immutable validated snapshot', () => {
  const table = freshTable(); table.players[1].life = 2; table.players[1].commanders = [{ id: 'c', name: '统帅', image: '' }];
  const playing = startTable(table, { first: 3 }); assert.equal(playing.players[1].life, 40); assert.equal(table.players[1].life, 2);
  assert.throws(() => startTable(playing)); assert.throws(() => finishTable(table, 0)); assert.throws(() => finishTable(playing, 4));
  const record = finishTable(playing, 1); playing.players[1].life = 39;
  assert.equal(record.players[1].life, 40); assert.equal(record.players[1].commanders[0].name, '统帅'); assert.equal(record.first, 3);
  assert.throws(() => validateGameRecord({ ...record, endedAt: '2000-01-01' }));
  assert.throws(() => validateGameRecord({ ...record, players: record.players.map((p, i) => i ? p : { ...p, commanders: [{ id: 'c', name: 'bad', image: 'javascript:evil()' }] }) }));
});
test('record API isolates accounts, validates origin and content, and handles retries without changing the winner', async t => {
  const db = openLocalD1(); t.after(() => db.close()); const auth = await createStandaloneAuth(db);
  await db.exec(await readFile(new URL('../drizzle/0004_scoreboard.sql', import.meta.url), 'utf8'));
  const origin = 'https://example.test', cookies = [];
  for (const username of ['计分甲', '计分乙']) {
    const r = await auth.handle(new Request(origin + '/api/auth/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'scoreboard-test-password' }) }));
    assert.equal(r.status, 201); cookies.push(r.headers.get('Set-Cookie').split(';')[0]);
  }
  const service = createScoreboardService(db, auth);
  const req = (cookie, record, headers = {}) => new Request(origin + '/api/scoreboard/records', { method: record ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', 'X-Tieyou-Scoreboard-Owner': encodeURIComponent('计分甲'), ...headers }, ...(record ? { body: JSON.stringify(record) } : {}) });
  assert.equal((await service.handle(req())).status, 401);
  const record = finishTable(startTable(freshTable()), 2);
  assert.equal((await service.handle(req(cookies[0], record, { Origin: 'https://elsewhere.test' }))).status, 403);
  assert.equal((await service.handle(req(cookies[1], record))).status, 409);
  assert.equal((await service.handle(req(cookies[0], { ...record, winner: 9 }))).status, 400);
  assert.equal((await service.handle(req(cookies[0], record))).status, 200);
  assert.equal((await service.handle(req(cookies[0], { ...record, winner: 1 }))).status, 200);
  const ours = await (await service.handle(req(cookies[0]))).json(), theirs = await (await service.handle(req(cookies[1]))).json();
  assert.equal(ours.records.length, 1); assert.equal(ours.records[0].winner, 2); assert.deepEqual(theirs.records, []);
  const annotated = { ...record, winner: 1, note: '关键回合\n成功翻盘', noteUpdatedAt: new Date(Date.parse(record.endedAt) + 1000).toISOString() };
  const updated = await (await service.handle(req(cookies[0], annotated))).json();
  assert.equal(updated.record.note, annotated.note); assert.equal(updated.record.winner, 2);
  await service.handle(req(cookies[0], { ...record, note: '过时备注' }));
  assert.equal((await (await service.handle(req(cookies[0]))).json()).records[0].note, annotated.note);
  assert.equal((await service.handle(req(cookies[0], { ...record, note: 'x'.repeat(2001) }))).status, 400);
});
test('guest and account caches stay separate, failed sync retains a queue, and reconnect uploads it to the correct account', async () => {
  const memory = new Map(), storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  let username = null, offline = false, uploads = [];
  const fetcher = async (path, options) => {
    if (path.includes('/session')) return Response.json({ username });
    if (offline) throw new Error('offline');
    if (options.method === 'POST') { uploads.push({ username, record: JSON.parse(options.body) }); return Response.json({ id: uploads.at(-1).record.id }); }
    return Response.json({ username, records: [], more: false });
  };
  const guest = createScoreboardStorage({ storage, fetcher }); await guest.ready;
  const g = startTable(freshTable()); guest.finish(finishTable(g, 0), { ...g, phase: 'ended' }); assert.equal(guest.records.length, 1);
  username = 'guest'; offline = true;
  const account = createScoreboardStorage({ storage, fetcher }); await account.ready; await new Promise(r => setTimeout(r, 0));
  assert.equal(account.records.length, 0);
  const a = startTable(freshTable()); account.finish(finishTable(a, 3), { ...a, phase: 'ended' }); await new Promise(r => setTimeout(r, 0));
  assert.equal(account.records[0].pending, true); assert.equal(uploads.length, 0);
  offline = false; await account.sync(); assert.equal(uploads.length, 1); assert.equal(uploads[0].username, 'guest'); assert.equal(account.records[0].pending, false);
  offline = true; account.annotate(a.game.id, '  保留这局的备注  '); await new Promise(r => setTimeout(r, 0));
  assert.equal(account.records[0].record.note, '保留这局的备注'); assert.equal(account.records[0].pending, true);
  offline = false; await account.sync(); assert.equal(uploads.length, 2); assert.equal(uploads[1].record.note, '保留这局的备注'); assert.equal(account.records[0].pending, false);
  username = null; const again = createScoreboardStorage({ storage, fetcher }); await again.ready; assert.equal(again.records[0].record.winner, 0);
});
