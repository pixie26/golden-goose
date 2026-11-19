import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every request goes through authentication, live-state validation and the
// actual local transaction queue. No production state or quote service is used.
const dir=await mkdtemp(join(tmpdir(),'goose-budget-api-'));
const stateFile=join(dir,'state.json');
const savedEnv=Object.fromEntries(['BANK_DATA_FILE','SETUP_TOKEN','DISABLE_LOCAL_TIMER','DATABASE_URL','NETLIFY'].map(k=>[k,process.env[k]]));
process.env.BANK_DATA_FILE=stateFile;
process.env.SETUP_TOKEN='budget-api-setup';
process.env.DISABLE_LOCAL_TIMER='1';
delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const previousFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('The spending API tests must not call external quote services');};
const { handleApi }=await import('../lib/api.mjs');
after(async()=>{
  globalThis.fetch=previousFetch;
  for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(dir,{recursive:true,force:true});
});

let sequence=0;
async function route(path,method='GET',body=null,cookie=''){
  const headers={'content-type':'application/json',origin:'http://localhost:3000'};
  if(cookie)headers.cookie=cookie;
  const response=await handleApi(new Request('http://localhost:3000'+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const action=(cookie,action,payload={},idempotencyKey=`budget-api-${++sequence}-unique`)=>route('/api/action','POST',{action,payload,idempotencyKey},cookie);
const state=cookie=>route('/api/state','GET',null,cookie);
const stored=async()=>JSON.parse(await readFile(stateFile,'utf8'));
async function bank(amount='100'){
  await rm(stateFile,{force:true});
  assert.equal((await route('/api/setup','POST',{token:'budget-api-setup',password:'parent-budget-password',pin:'123456'})).status,200);
  const dad=(await route('/api/login','POST',{role:'dad',password:'parent-budget-password'})).cookie;
  const kid=(await route('/api/login','POST',{role:'kid',password:'123456'})).cookie;
  assert.ok(dad);assert.ok(kid);
  assert.equal((await action(dad,'cash.grant',{amount})).status,200);
  return {dad,kid};
}

test('API serializes concurrent shopping requests and rolls back the rejected request completely',async()=>{
  const {dad,kid}=await bank();
  const keys=['concurrent-shopping-first','concurrent-shopping-second'];
  const results=await Promise.all(keys.map((key,i)=>action(kid,'purchase.request',{name:`礼物${i+1}`,amount:'80'},key)));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
  const winner=results.findIndex(x=>x.status===200),loser=1-winner;
  assert.match(results[loser].body.error,/可用余额不足/);
  let saved=await stored();
  assert.equal(saved.purchaseRequests.length,1);assert.equal(saved.cashCents,10000);
  assert.ok(saved.processed.includes('kid|'+keys[winner]));
  assert.ok(!saved.processed.includes('kid|'+keys[loser]),'failed idempotency key is not recorded');
  assert.equal(saved.audit.filter(x=>x.type==='purchase.request').length,1);
  const response=await state(kid);assert.equal(response.body.summary.availableCents,2000);
  const before=await readFile(stateFile,'utf8');
  assert.equal((await action(kid,'purchase.request',{name:'超额申请',amount:'20.01'})).status,400);
  assert.equal(await readFile(stateFile,'utf8'),before,'failed transaction leaves the file byte-for-byte unchanged');
  assert.equal((await action(dad,'purchase.reject',{id:saved.purchaseRequests[0].id})).status,200);
  saved=await stored();
  assert.equal(saved.purchaseRequests[0].status,'rejected');assert.equal(saved.purchaseRequests[0].reservedCents,0);
  assert.equal((await state(kid)).body.summary.availableCents,10000);
  assert.equal((await action(kid,'purchase.request',{name:'重新申请',amount:'100'})).status,200);
  assert.equal((await state(kid)).body.summary.availableCents,0);
});

test('stock and shopping API calls contend for the same available funds inside the transaction',async()=>{
  const {kid}=await bank();
  const keys=['competing-stock-budget','competing-shopping-budget'];
  const results=await Promise.all([
    action(kid,'stock.buy',{symbol:'AAPL',amount:'70'},keys[0]),
    action(kid,'purchase.request',{name:'鞋',amount:'70'},keys[1]),
  ]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
  const saved=await stored();
  assert.equal(saved.orders.length+saved.purchaseRequests.length,1);
  assert.equal(saved.cashCents,10000);
  const response=(await state(kid)).body;
  assert.equal(response.summary.availableCents,3000);
  assert.equal(response.summary.stockReservedCents+response.summary.purchaseReservedCents,7000);
  const loser=results.findIndex(x=>x.status===400);
  assert.ok(!saved.processed.includes('kid|'+keys[loser]));
  assert.match(results[loser].body.error,/可用余额不足/);
});

test('concurrent requests at the exact combined budget succeed and approval uses its own hold',async()=>{
  const {dad,kid}=await bank();
  const results=await Promise.all([
    action(kid,'stock.buy',{symbol:'AAPL',amount:'40'}),
    action(kid,'purchase.request',{name:'鞋',amount:'60'}),
  ]);
  assert.deepEqual(results.map(x=>x.status),[200,200]);
  const request=(await stored()).purchaseRequests[0];
  assert.equal((await state(kid)).body.summary.availableCents,0);
  assert.equal((await action(dad,'purchase.approve',{id:request.id,amount:'50'})).status,200);
  const saved=await stored(),summary=(await state(kid)).body.summary;
  assert.equal(saved.cashCents,5000);assert.equal(saved.reservedCents,4000);
  assert.equal(saved.purchaseRequests[0].reservedCents,0);
  assert.equal(summary.availableCents,1000);assert.equal(summary.purchaseReservedCents,0);
});

test('two simultaneous wish purchases with different keys create only one persistent linked request',async()=>{
  const {kid}=await bank('200');
  assert.equal((await action(kid,'wish.add',{name:'鞋',amount:'90'})).status,200);
  const wish=(await stored()).wishes[0];
  const keys=['same-wish-first-device','same-wish-second-device'];
  const results=await Promise.all(keys.map(key=>action(kid,'wish.purchase',{id:wish.id,name:'替换名称',amount:'0.01'},key)));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,400]);
  const saved=await stored();assert.equal(saved.purchaseRequests.length,1);
  assert.equal(saved.purchaseRequests[0].wishId,wish.id);
  assert.equal(saved.purchaseRequests[0].name,'鞋');assert.equal(saved.purchaseRequests[0].amountCents,9000);
  assert.equal(saved.cashCents,20000);assert.equal((await state(kid)).body.summary.availableCents,11000);
  const winner=results.findIndex(x=>x.status===200);
  const retry=await action(kid,'wish.purchase',{id:wish.id},keys[winner]);
  assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);
  assert.equal((await stored()).purchaseRequests.length,1);
});

test('deleting a wish cannot release its pending shopping hold; malformed amounts do not persist',async()=>{
  const {dad,kid}=await bank();
  for(const amount of ['-1','0','NaN','1e2','999999999999999999999999','10.001']){
    const before=await readFile(stateFile,'utf8');
    assert.equal((await action(kid,'purchase.request',{name:'鞋',amount})).status,400);
    assert.equal(await readFile(stateFile,'utf8'),before);
  }
  assert.equal((await action(kid,'wish.add',{name:'鞋',amount:'80'})).status,200);
  const wish=(await stored()).wishes[0];
  assert.equal((await action(kid,'wish.purchase',{id:wish.id})).status,200);
  const request=(await stored()).purchaseRequests[0];
  assert.equal((await action(kid,'wish.remove',{id:wish.id})).status,200);
  const saved=await stored();
  assert.equal(saved.wishes.length,0);assert.equal(saved.purchaseRequests[0].reservedCents,8000);
  assert.equal((await state(kid)).body.summary.availableCents,2000);
  assert.equal((await action(kid,'wish.purchase',{id:wish.id})).status,400);
  assert.equal((await action(kid,'stock.buy',{symbol:'AAPL',amount:'20.01'})).status,400);
  assert.equal((await action(dad,'purchase.reject',{id:request.id})).status,200);
  assert.equal((await state(kid)).body.summary.availableCents,10000);
});
