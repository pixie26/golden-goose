import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise authentication, persistence, concurrent submissions and the views
// actually received by Olivia and the parent; no real account is touched.
const directory=await mkdtemp(join(tmpdir(),'goose-refund-api-'));
const stateFile=join(directory,'state.json');
const envNames=['BANK_DATA_FILE','SETUP_TOKEN','DATABASE_URL','NETLIFY'];
const oldEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
process.env.BANK_DATA_FILE=stateFile;
process.env.SETUP_TOKEN='refund-api-setup';
delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const { handleApi }=await import('../lib/api.mjs');
const { mutateStore }=await import('../lib/store.mjs');
after(async()=>{
  for(const [key,value] of Object.entries(oldEnv)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  await rm(directory,{recursive:true,force:true});
});

let sequence=0;
async function route(path,method='GET',body=null,cookie=''){
  const headers={'content-type':'application/json',origin:'http://localhost:3000'};
  if(cookie)headers.cookie=cookie;
  const response=await handleApi(new Request('http://localhost:3000'+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)})}));
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const action=(cookie,action,payload={},idempotencyKey=`refund-api-${++sequence}-unique`)=>route('/api/action','POST',{action,payload,idempotencyKey},cookie);
const state=async cookie=>(await route('/api/state','GET',null,cookie)).body;
const stored=async()=>JSON.parse(await readFile(stateFile,'utf8'));
async function bank(){
  await rm(stateFile,{force:true});
  assert.equal((await route('/api/setup','POST',{token:'refund-api-setup',password:'parent-refund-password',pin:'123456'})).status,200);
  const dad=(await route('/api/login','POST',{role:'dad',password:'parent-refund-password'})).cookie;
  const kid=(await route('/api/login','POST',{role:'kid',password:'123456'})).cookie;
  assert.ok(dad);assert.ok(kid);
  assert.equal((await action(dad,'cash.grant',{amount:'250.50'})).status,200);
  return {dad,kid};
}
async function purchase({dad,kid},amount='40.50'){
  assert.equal((await action(kid,'purchase.request',{name:'鞋',amount})).status,200);
  const item=(await state(kid)).purchaseRequests[0];
  assert.equal((await action(dad,'purchase.approve',{id:item.id})).status,200);
  return item.id;
}

test('refund API delivers the request to the parent and credits the exact amount only once',async()=>{
  const accounts=await bank(),id=await purchase(accounts),{dad,kid}=accounts;
  assert.equal((await state(kid)).summary.cashCents,21000);
  const eligible=(await state(kid)).purchaseRequests.find(x=>x.id===id);
  assert.equal(eligible.returnEligible,true);
  assert.ok(Date.parse(eligible.returnDeadlineAt)>Date.now());
  assert.equal((await action(kid,'purchase.return.request',{id,reason:'尺寸不合适'})).status,200);
  const inbox=(await state(dad)).purchaseRequests.filter(x=>x.status==='return_pending');
  assert.equal(inbox.length,1);assert.equal(inbox[0].id,id);assert.equal(inbox[0].returnReason,'尺寸不合适');
  assert.equal((await action(kid,'purchase.refund',{id})).status,400);
  const responses=await Promise.all([
    action(dad,'purchase.refund',{id},'approve-refund-same-key'),
    action(dad,'purchase.refund',{id},'approve-refund-same-key'),
  ]);
  assert.ok(responses.every(x=>x.status===200));
  assert.equal(responses.filter(x=>x.body.duplicate).length,1);
  const child=await state(kid),saved=await stored();
  assert.equal(child.summary.cashCents,25050);
  assert.equal(child.purchaseRequests[0].status,'refunded');
  assert.equal(child.purchaseRequests[0].returnEligible,false);
  assert.equal(saved.ledger.filter(x=>x.type==='purchase.refund').length,1);
  assert.ok(child.notifications.some(x=>x.title==='退款已经到账'&&x.detail.includes('40.5')));
  assert.equal((await state(dad)).purchaseRequests.filter(x=>x.status==='return_pending').length,0);
});

test('refund API blocks withdrawal, a second attempt after rejection, expired requests and direct parent refunds',async()=>{
  const accounts=await bank(),{dad,kid}=accounts,id=await purchase(accounts);
  assert.equal((await action(dad,'purchase.refund',{id})).status,400);
  assert.equal((await action(kid,'purchase.return.request',{id})).status,200);
  assert.equal((await action(kid,'purchase.return.cancel',{id})).status,400);
  assert.equal((await state(dad)).purchaseRequests[0].status,'return_pending');
  assert.equal((await action(dad,'purchase.return.reject',{id})).status,200);
  assert.equal((await action(kid,'purchase.return.request',{id})).status,400);
  let child=await state(kid);
  assert.equal(child.summary.cashCents,21000);
  assert.equal(child.purchaseRequests[0].returnRequested,true);
  assert.equal(child.purchaseRequests[0].returnEligible,false);
  assert.ok(child.notifications.some(x=>/申请未通过/.test(x.title)));
  const expiredId=await purchase(accounts,'10');
  await mutateStore(s=>{
    const r=s.purchaseRequests.find(x=>x.id===expiredId);
    r.reviewAt=r.deliveredAt=new Date(Date.now()-8*86400000).toISOString();
  });
  const before=await readFile(stateFile,'utf8');
  assert.equal((await action(kid,'purchase.return.request',{id:expiredId,returnEligible:true,returnDeadlineAt:'2099-01-01T00:00:00Z'})).status,400);
  assert.equal((await action(dad,'purchase.refund',{id:expiredId})).status,400);
  assert.equal(await readFile(stateFile,'utf8'),before);
  child=await state(kid);
  assert.equal(child.purchaseRequests.find(x=>x.id===expiredId).returnEligible,false);
});

test('loan limit API is parent-only, persists and reserves capacity across concurrent pending requests',async()=>{
  const {dad,kid}=await bank();
  assert.equal((await state(kid)).summary.loanLimitCents,50000);
  assert.equal((await action(kid,'settings.update',{loanLimit:'900'})).status,400);
  assert.equal((await action(dad,'settings.update',{loanLimit:'125.50'})).status,200);
  assert.equal((await stored()).settings.loanLimitCents,12550);
  const submitted=await Promise.all([
    action(kid,'loan.request',{amount:'80'},'loan-limit-race-first'),
    action(kid,'loan.request',{amount:'80'},'loan-limit-race-second'),
  ]);
  assert.deepEqual(submitted.map(x=>x.status).sort(),[200,400]);
  let child=await state(kid);
  assert.equal(child.summary.loanPendingCents,8000);
  assert.equal(child.summary.loanAvailableCents,4550);
  const first=child.loans[0].id;
  assert.equal((await action(kid,'loan.request',{amount:'45.50'})).status,200);
  assert.equal((await action(kid,'loan.request',{amount:'0.01'})).status,400);
  assert.equal((await action(dad,'loan.approve',{id:first})).status,200);
  assert.equal((await action(dad,'settings.update',{loanLimit:'50'})).status,200);
  child=await state(kid);
  assert.equal(child.summary.loanPrincipalCents,8000);
  assert.equal(child.summary.loanAvailableCents,0);
  const pending=child.loans.find(x=>x.status==='pending').id;
  assert.equal((await action(dad,'loan.approve',{id:pending})).status,400);
  assert.equal((await action(dad,'loan.reject',{id:pending})).status,200);
  assert.equal((await action(dad,'settings.update',{loanLimit:'0'})).status,200);
  assert.equal((await action(kid,'loan.request',{amount:'1'})).status,400);
  child=await state(kid);
  assert.equal(child.settings.loanLimitCents,0);
  assert.equal(child.summary.loanPrincipalCents,8000);
  assert.equal(child.summary.loanAvailableCents,0);
});
