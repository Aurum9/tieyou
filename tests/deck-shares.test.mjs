import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openLocalD1 } from '../scripts/local-d1.mjs';
import { createStandaloneAuth } from '../scripts/standalone-auth.mjs';
import { createDeckShareService } from '../scripts/standalone-deck-shares.mjs';
const origin='https://example.test';
async function setup(t) {
  const db=openLocalD1();t.after(()=>db.close());const auth=await createStandaloneAuth(db);
  await db.exec(await readFile(new URL('../drizzle/0002_deck_libraries.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../drizzle/0005_deck_shares.sql',import.meta.url),'utf8'));
  const cookies=[],accounts=[];
  for(const username of ['分享甲','分享乙']) {
    const r=await auth.handle(new Request(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username,password:'share-test-password'})}));
    assert.equal(r.status,201);const cookie=r.headers.get('Set-Cookie').split(';')[0];cookies.push(cookie);
    const account=await auth.currentAccount(new Request(origin,{headers:{Cookie:cookie}}));accounts.push(account);
  }
  const deck={id:'deck',name:'<script>牌表</script> $&',description:'说明 \" <b>测试</b>',updatedAt:new Date().toISOString(),entries:[{id:'secret-entry',cardId:'c',versionId:'v',quantity:2,zone:'main',notes:'private-note',categories:['private-category']},{cardId:'leader',versionId:'l',quantity:1,zone:'commander'},{cardId:'private-candidate',versionId:'p',quantity:1,zone:'considering'}]};
  const key=createHash('sha256').update('standalone:'+accounts[0].id).digest('hex');
  await db.prepare('INSERT INTO deck_libraries VALUES(?,?,?)').bind(key,1,JSON.stringify({version:1,decks:[deck],trash:[]})).run();
  const service=createDeckShareService(db,auth,{readIndex:async()=>'<html><head><title>铁有</title><meta name="description" content="old" /></head></html>'});
  const req=(path,{who=0,method='GET',headers={}}={})=>new Request(origin+path,{method,headers:{Origin:origin,...(who===null?{}:{Cookie:cookies[who],'X-Tieyou-Share-Owner':encodeURIComponent(accounts[who].username)}),...headers}});
  return {db,deck,key,service,req};
}
test('sharing requires the owner, stays private by default, strips private content and keeps a stable live link',async t=>{
 const {db,deck,key,service,req}=await setup(t);
 const path='/api/deck-shares/deck';
 assert.equal((await service.handle(req(path,{who:null}))).status,401);
 assert.equal((await service.handle(req(path,{who:1}))).status,404);
 assert.equal((await (await service.handle(req(path))).json()).url,null);
 const shared=await (await service.handle(req(path,{method:'POST'}))).json();
 assert.match(shared.url,/\/s\/[A-Za-z0-9_-]{32}$/);
 assert.equal((await (await service.handle(req(path,{method:'POST'}))).json()).url,shared.url);
 const token=shared.url.split('/').at(-1),publicPath='/api/shared-decks/'+token;
 const publicResponse=await service.handle(req(publicPath,{who:null}));assert.equal(publicResponse.status,200);
 const output=await publicResponse.text();assert.ok(!output.includes('private-'));assert.ok(!output.includes('secret-entry'));
 assert.deepEqual(JSON.parse(output).deck.entries.map(e=>e.zone),['main','commander']);
 deck.name='编辑后的牌表';await db.prepare('UPDATE deck_libraries SET library_json=? WHERE account=?').bind(JSON.stringify({version:1,decks:[deck],trash:[]}),key).run();
 assert.equal((await (await service.handle(req(publicPath,{who:null}))).json()).deck.name,deck.name);
 assert.equal((await service.handle(req(path,{method:'DELETE',who:1}))).status,200);
 assert.equal((await service.handle(req(publicPath,{who:null}))).status,200,'another account cannot revoke owner link');
 await service.handle(req(path,{method:'DELETE'}));assert.equal((await service.handle(req(publicPath,{who:null}))).status,404);
 const renewed=await (await service.handle(req(path,{method:'POST'}))).json();assert.notEqual(renewed.url,shared.url);
 await db.prepare('UPDATE deck_libraries SET library_json=? WHERE account=?').bind(JSON.stringify({version:1,decks:[],trash:[{deck}]}),key).run();
 assert.equal((await service.handle(req('/api/shared-decks/'+renewed.url.split('/').at(-1),{who:null}))).status,404);
});
test('sharing rejects cross-origin and changed accounts; public metadata escapes all user text',async t=>{
 const {service,req}=await setup(t);const path='/api/deck-shares/deck';
 assert.equal((await service.handle(req(path,{method:'POST',headers:{Origin:'https://evil.test'}}))).status,403);
 assert.equal((await service.handle(req(path,{method:'POST',headers:{'X-Tieyou-Share-Owner':encodeURIComponent('分享乙')}}))).status,409);
 assert.equal((await service.handle(req(path,{method:'POST',who:1}))).status,404);
 const {url}=await (await service.handle(req(path,{method:'POST'}))).json();
 const page=await service.handle(req(new URL(url).pathname,{who:null}));const html=await page.text();
 assert.ok(html.includes('<base href="/" />'));assert.ok(html.includes('&lt;script&gt;牌表&lt;/script&gt; $&amp;'));assert.ok(!html.includes('<script>'));
 assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow');
 assert.equal((await service.handle(req(new URL(url).pathname,{who:null,method:'HEAD'}))).body,null);
 assert.equal((await service.handle(req('/api/shared-decks/not-a-token',{who:null}))).status,404);
});
