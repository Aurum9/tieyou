import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {COMPOSITION_ROLES,analyzeDeckComposition} from '../web/lib/deck-composition.js';
import {applyTagSettings} from '../web/lib/tag-settings.js';

const vocabulary=JSON.parse(await readFile(new URL('../web/data/tag-vocabulary.json',import.meta.url),'utf8'));
let revision=100;
function setup(extra={}) {applyTagSettings({revision:revision++,aliases:{'mana-rock':['manarock']},overrides:{...Object.fromEntries(COMPOSITION_ROLES.map(role=>[role.slug,{label:role.label,visible:true,includeInAnalysis:true}])),...extra}});}
function analyze(cards,entries=cards.map(card=>({id:card.id,cardId:card.id,quantity:1,zone:'main'}))) {return new Map(analyzeDeckComposition({entries},cards,{tagVocabulary:vocabulary}).map(row=>[row.slug,row]));}
test('access counts overlapping roles once, keeps tutors and supports repeatable draw/filter engines',()=>{
  setup();const rows=analyze([
    {id:'engine',tags:['draw','loot','repeatable-loot','draw-engine','repeatable-card-advantage']},
    {id:'tutor',tags:['tutor-land','land-ramp','ramp','card-advantage']},
    {id:'attribute-only',tags:['repeatable-card-advantage']},
    {id:'exile',tags:['impulsive-draw','long-term-impulsive-draw']},
    {id:'top',tags:['play-from-top']},
    {id:'stolen',tags:['nightveil-theft']},
  ]);
  const access=rows.get('card-advantage');assert.equal(access.count,5);assert.equal(access.repeatable.count,1);
  assert.equal(rows.get('tutor').count,1);assert.equal(rows.get('ramp').count,1);
  const draw=access.children.find(row=>row.slug==='draw');assert.equal(draw.count,1);assert.equal(draw.children.find(row=>row.slug==='loot').count,1);assert.equal(draw.children.find(row=>row.slug==='draw-engine').count,1);
});
test('regrowth-only tomes remain recursion; mixed draw and recursion cards can count in both',()=>{
  setup();const rows=analyze([
    {id:'regrowth',tags:['regrowth','card-advantage']},
    {id:'grave-tome',tags:['tome','regrowth','repeatable-card-advantage']},
    {id:'library-tome',tags:['tome','repeatable-card-advantage']},
    {id:'mixed',tags:['draw','regrowth','tome']},
    {id:'recast',tags:['gives-castable-from-graveyard']},
    {id:'self-recast',tags:['castable-from-graveyard']},
  ]);
  assert.equal(rows.get('card-advantage').count,2);assert.equal(rows.get('card-advantage').repeatable.count,1);
  assert.equal(rows.get('recursion').count,5);assert.equal(rows.get('recursion').children.find(row=>row.slug==='regrowth').count,3);
  assert.equal(rows.get('recursion').children.find(row=>row.slug==='gives-castable-from-graveyard').count,2);
});
test('blink, rescue and haven need protection evidence; methods overlap without inflating protection',()=>{
  setup();const rows=analyze([
    {id:'value-blink',tags:['flicker']}, {id:'protect-blink',tags:['flicker','protection','rescue']},
    {id:'self',tags:['protects-self','gains-indestructible']}, {id:'grant',tags:['gives-indestructible']},
    {id:'prevent-self',tags:['damage-prevention-self']},
    {id:'haven',tags:['protection','haven']}, {id:'prevention',tags:['damage-prevention']},
  ]);const protection=rows.get('protection');assert.equal(protection.count,4);
  assert.equal(protection.children.find(row=>row.slug==='flicker').count,1);assert.equal(protection.children.find(row=>row.slug==='rescue').count,1);assert.equal(protection.children.find(row=>row.slug==='haven').count,1);
});
test('reducers join ramp, quantities and zones remain correct, aliases do not double count',()=>{
  setup();const cards=[{id:'rock',tags:['manarock','mana-rock','ramp']},{id:'reducer',tags:['cost-reducer']}];
  const entries=[{id:'one',cardId:'rock',quantity:2,zone:'main'},{id:'two',cardId:'rock',quantity:1,zone:'commander'},{id:'three',cardId:'reducer',quantity:1,zone:'main'},{id:'candidate',cardId:'reducer',quantity:8,zone:'considering'}];
  const ramp=analyze(cards,entries).get('ramp');assert.equal(ramp.count,4);assert.deepEqual(ramp.entryIds,['one','two','three']);assert.equal(ramp.children.find(row=>row.slug==='cost-reducer').count,1);
});
test('hidden or disabled roles and hidden evidence do not leak into composition counts',()=>{
  setup({'card-advantage':{label:'卡牌访问',visible:true,includeInAnalysis:false},'cost-reducer':{label:'减费源',visible:false,includeInAnalysis:false},'seek':{label:'寻找',visible:false,includeInAnalysis:false}});
  const rows=analyze([{id:'draw',tags:['draw']},{id:'reduce',tags:['cost-reducer']}]);assert.equal(rows.has('card-advantage'),false);assert.equal(rows.get('ramp').count,0);
});
