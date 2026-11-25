import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceCharacteristics, detailDeckEntry } from '../web/lib/card-detail-state.js';
test('card characteristics preserve zero and variable values, omitting absent values', () => {
  assert.deepEqual(faceCharacteristics({power:'0',toughness:'1+*'}), [['力量 / 防御力','0 / 1+*']]);
  assert.deepEqual(faceCharacteristics({loyalty:'0',defense:'7'}), [['起始忠诚','0'],['防御值','7']]);
  assert.deepEqual(faceCharacteristics({power:null,toughness:undefined}), []);
});
test('detail matches the precise entry and zone, never another printing or deck', () => {
  const deck={id:'a',entries:[{id:'commander',cardId:'c',zone:'commander'}, {id:'one',cardId:'c',zone:'main'}, {id:'two',cardId:'c',zone:'main'}]};
  assert.equal(detailDeckEntry(deck,'c').id,'one');
  assert.equal(detailDeckEntry(deck,'c',{deckId:'a',entryId:'commander'}).zone,'commander');
  assert.equal(detailDeckEntry(deck,'c',{deckId:'a',entryId:'two'}).id,'two');
  assert.equal(detailDeckEntry(deck,'c',{deckId:'b',entryId:'two'}),null);
  assert.equal(detailDeckEntry(deck,'wrong',{deckId:'a',entryId:'two'}),null);
  assert.equal(detailDeckEntry(deck,'c',{deckId:'a',entryId:'gone'}),null);
});
