import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPlaytestType, playtestTypeOptions } from '../web/lib/playtest-batch.js';

test('batch type filters resolve Chinese subtypes and respect current face, without partial word matches', () => {
  const card = { typeLine: 'Legendary Artifact Creature — Elf Druid', zhTypeLine: '传奇神器生物 ～ 妖精／德鲁伊' };
  const options = playtestTypeOptions([card]);
  const piece = { face: 0 };
  for (const query of ['传奇', '生物', '神器', 'Elf', '妖精', '德鲁伊', 'nonland', 'all']) assert.equal(matchesPlaytestType(piece, card, query, options), true, query);
  for (const query of ['Land', 'Artifact Creature', 'El', 'missing']) assert.equal(matchesPlaytestType(piece, card, query, options), false, query);
  const double = { layout: 'modal_dfc', faces: [{ typeLine: 'Sorcery' }, { typeLine: 'Land — Forest' }] };
  assert.equal(matchesPlaytestType({ face: 0 }, double, 'Land', options), false);
  assert.equal(matchesPlaytestType({ face: 1 }, double, 'Land', options), true);
  assert.equal(matchesPlaytestType({ face: 1 }, double, 'nonland', options), false);
  const token = { face: 0, typeLine: 'Token Artifact Creature — Golem' };
  assert.equal(matchesPlaytestType(token, token, 'Artifact', options), true);
  assert.equal(matchesPlaytestType(token, token, 'Creature', options), true);
  const custom = { typeLine: '神器生物 ～ 龙' };
  assert.equal(matchesPlaytestType(custom, custom, '生物', options), true);
  assert.equal(matchesPlaytestType(custom, custom, '龙', options), true);
  assert.equal(matchesPlaytestType(custom, custom, '地', options), false);
});
