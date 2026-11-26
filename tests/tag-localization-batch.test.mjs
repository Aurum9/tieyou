import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateTagLocalization, importTagLocalization } from '../scripts/import-tag-localization.mjs';

const bundle=JSON.parse(await readFile(new URL('../data/tag-localization/2026-11-26.zh-CN.json',import.meta.url),'utf8'));
test('translation batch preserves manual terminology, settings and land cycles with complete visible coverage',()=>{
  const entries=validateTagLocalization(bundle), bySlug=new Map(entries.map(row=>[row.slug,row]));
  assert.equal(entries.length,4603);
  assert.equal(bySlug.get('mana-rock').label,'饼');assert.equal(bySlug.get('regrowth').label,'再生新芽');
  assert.equal(bySlug.get('cycle-abu-dual-land').label,'老圈');assert.equal(bySlug.get('cycle-abu-dual-land').visible,true);
  for(const row of entries) {
    if(!bundle.preservedOverrides[row.slug]) assert.equal(row.includeInAnalysis,false,row.slug);
    if(row.visible) assert.match(row.label,/\p{Script=Han}/u,row.slug);
  }
  assert.equal(bySlug.get('namesake-spell').label,'冠名咒语');assert.equal(bySlug.get('namesake-spell').visible,false);
  assert.equal(bySlug.get('precognition-engine').label,'私看牌库顶引擎');assert.equal(bySlug.get('future-sight-engine').label,'展示牌库顶引擎');
  assert.equal(bySlug.get('pillage-effect').label,'换牌造宝');assert.equal(bySlug.get('genesis-effect').label,'牌库顶生物进场');
  assert.equal(bySlug.get('typal-dragon').visible,true);assert.equal(bySlug.get('grave-pact').visible,true);
});
test('the saved translation order follows descending card counts and depth-first children, retaining multiple parents',()=>{
  const entries=bundle.entries, bySlug=new Map(entries.map(row=>[row.slug,row])), children=new Map();
  for(const row of entries)for(const parent of row.parentSlugs){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(row);}
  const compare=(a,b)=>b.cardCount-a.cardCount||(a.slug<b.slug?-1:a.slug>b.slug?1:0),seen=new Set(),order=[];
  function walk(row){if(seen.has(row.slug))return;seen.add(row.slug);order.push(row.slug);for(const child of (children.get(row.slug)||[]).sort(compare))walk(child);}
  for(const row of [...entries].sort(compare))walk(row);
  assert.deepEqual(entries.map(row=>row.slug),order);assert.ok(bySlug.get('burn-any').parentSlugs.length>1);
});
test('atomic import backs up tag settings, rejects stale revisions and leaves unrelated data intact',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'tieyou-tags-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const database=join(folder,'test.sqlite'),backup=join(folder,'before.json');const db=new DatabaseSync(database);
  for(const file of ['0006_tag_settings.sql','0007_tag_descriptions.sql','0008_tag_analysis.sql'])db.exec(await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  db.exec("CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('keep');UPDATE tag_settings_state SET revision=3;");db.close();
  assert.deepEqual(await importTagLocalization({database,bundle,expectedRevision:3}),{applied:false,revision:3,changes:4603});
  await assert.rejects(()=>importTagLocalization({database,bundle,expectedRevision:2,backup,apply:true}),/Settings changed/);
  const result=await importTagLocalization({database,bundle,expectedRevision:3,backup,apply:true});assert.equal(result.revision,4);assert.equal(result.changes,4603);
  const before=JSON.parse(await readFile(backup,'utf8'));assert.equal(before.state.revision,3);assert.deepEqual(before.overrides,[]);
  const check=new DatabaseSync(database);assert.equal(check.prepare('SELECT value FROM unrelated').get().value,'keep');assert.equal(check.prepare('SELECT COUNT(*) AS n FROM tag_label_overrides').get().n,4603);check.close();
  assert.deepEqual(await importTagLocalization({database,bundle,expectedRevision:4}),{applied:false,revision:4,changes:0});
});
