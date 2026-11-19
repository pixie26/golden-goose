import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, setup, createSession, runAction } from '../lib/core.mjs';

const dir=await fs.mkdtemp(join(tmpdir(),'goose-store-v195-'));
const stateFile=join(dir,'ledger.json');
const savedEnv=Object.fromEntries(['BANK_DATA_FILE','DATABASE_URL','NETLIFY'].map(key=>[key,process.env[key]]));
process.env.BANK_DATA_FILE=stateFile;delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const { readStore, mutateStore }=await import('../lib/store.mjs');
const { handleApi }=await import('../lib/api.mjs');
const realReadFile=fs.readFile;
const template=initialState();setup(template,'setup','setup','strong-parent-password','123456');
after(async()=>{
  for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fs.rm(dir,{recursive:true,force:true});
});
async function seed(state=structuredClone(template)){
  await fs.writeFile(stateFile,JSON.stringify(state,null,2),'utf8');return state;
}
const readSaved=async()=>JSON.parse(await realReadFile(stateFile,'utf8'));
async function route(path,method='GET',payload=null,cookie=''){
  const headers={'content-type':'application/json'};if(cookie)headers.cookie=cookie;
  const response=await handleApi(new Request('http://localhost:3000'+path,{method,headers,...(payload===null?{}:{body:JSON.stringify(payload)})}));
  return {status:response.status,body:await response.json()};
}

test('a genuinely missing local file still creates an uninitialized bank',async()=>{
  await fs.rm(stateFile,{force:true});
  const state=await readStore();assert.equal(state.dadHash,null);assert.equal(state.cashCents,0);
  await assert.rejects(realReadFile(stateFile,'utf8'),{code:'ENOENT'},'reading must not create a ledger');
});

test('two transient incomplete JSON reads recover from a complete third snapshot',async t=>{
  const state=await seed();state.cashCents=16250;await seed(state);
  let attempts=0;
  t.mock.method(fs,'readFile',async function(file,...rest){
    if(String(file)===stateFile&&++attempts<3)return '{"cashCents":16250,"note":"unfinished';
    return realReadFile.call(this,file,...rest);
  });
  const read=await readStore();assert.equal(read.cashCents,16250);assert.equal(attempts,3);
  assert.equal((await readSaved()).cashCents,16250,'no write occurred during read recovery');
});

test('persistent invalid JSON is never reset, partially repaired or passed to a financial mutation',async()=>{
  const damaged='{"cashCents":16250,"audit":[{"note":"'+('long saved note '.repeat(2000));
  await fs.writeFile(stateFile,damaged,'utf8');let mutations=0;
  await assert.rejects(mutateStore(state=>{mutations++;state.cashCents=0;}),error=>{
    assert.equal(error.code,'BANK_STORE_UNREADABLE');assert.match(error.message,/账本文件暂时无法读取/);
    assert.ok(error.cause instanceof SyntaxError);return true;
  });
  assert.equal(mutations,0);assert.equal(await realReadFile(stateFile,'utf8'),damaged);
  assert.deepEqual(await fs.readdir(dir),['ledger.json'],'failure does not leave a replacement ledger or temporary file');
});

test('a ledger disappearing after a malformed read is not treated as a fresh bank',async t=>{
  await seed();let attempts=0;
  t.mock.method(fs,'readFile',async function(file,...rest){
    if(String(file)!==stateFile)return realReadFile.call(this,file,...rest);
    if(++attempts===1)return '{"cashCents":';
    throw Object.assign(new Error('simulated temporary missing file'),{code:'ENOENT'});
  });
  await assert.rejects(readStore(),{code:'BANK_STORE_UNREADABLE'});assert.equal(attempts,2);
  assert.ok((await readSaved()).dadHash,'the existing file is not overwritten with an empty bank');
});

test('a refresh waits for a previously queued local transaction to commit',async()=>{
  await seed();let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  const mutation=mutateStore(async state=>{started();await gate;state.cashCents=12345;});
  await entered;let readFinished=false;
  const read=readStore().then(value=>{readFinished=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(readFinished,false);
  release();await mutation;assert.equal((await read).cashCents,12345);
});

test('concurrent local reads and writes return complete snapshots without losing serialized updates',async()=>{
  await seed();const jobs=[];
  for(let i=0;i<30;i++){
    jobs.push(mutateStore(state=>{state.cashCents++;state.audit.push({sequence:i,note:'snapshot '.repeat(350)});}));
    jobs.push(readStore().then(state=>{
      assert.ok(Number.isInteger(state.cashCents));
      assert.equal(state.audit.filter(row=>Number.isInteger(row.sequence)).length,state.cashCents);
    }));
  }
  await Promise.all(jobs);const state=await readSaved();assert.equal(state.cashCents,30);
  assert.equal(new Set(state.audit.filter(row=>Number.isInteger(row.sequence)).map(row=>row.sequence)).size,30);
  assert.deepEqual(await fs.readdir(dir),['ledger.json']);
});

test('failed atomic rename leaves the prior ledger unchanged and removes its unique temporary file',async t=>{
  await seed();const before=await realReadFile(stateFile,'utf8');
  t.mock.method(fs,'rename',async()=>{throw Object.assign(new Error('simulated rename denial'),{code:'EACCES'});});
  await assert.rejects(mutateStore(state=>{state.cashCents=99999;}),{code:'EACCES'});
  assert.equal(await realReadFile(stateFile,'utf8'),before);
  assert.deepEqual(await fs.readdir(dir),['ledger.json']);
});

test('pay off all succeeds after a transient bad read and a same-key retry never debits twice',async t=>{
  const state=structuredClone(template);
  runAction(state,'dad','cash.grant',{amount:'1000'},'store-grant-initial');
  runAction(state,'kid','loan.request',{amount:'100'},'store-loan-request');
  const loan=state.loans[0];runAction(state,'dad','loan.approve',{id:loan.id},'store-loan-approval');
  loan.interestMicroCents=347_400_000;
  createSession(state,'kid','store-test-child-session');await seed(state);
  const before=state.cashCents,due=loan.principalCents+Math.round(loan.interestMicroCents/1e6);
  let attempts=0;
  t.mock.method(fs,'readFile',async function(file,...rest){
    if(String(file)===stateFile&&++attempts===1)return '{"note":"truncated';
    return realReadFile.call(this,file,...rest);
  });
  const payload={action:'loan.repay',payload:{id:loan.id,all:true},idempotencyKey:'store-exact-payoff-idempotent'};
  const cookie='goldengoose_session=store-test-child-session';
  const first=await route('/api/action','POST',payload,cookie);
  assert.equal(first.status,200);assert.equal(first.body.ok,true);
  const retried=await route('/api/action','POST',payload,cookie);
  assert.equal(retried.status,200);assert.equal(retried.body.duplicate,true);
  const saved=await readSaved();assert.equal(saved.cashCents,before-due);
  assert.equal(saved.loans[0].status,'repaid');assert.equal(saved.loans[0].principalCents,0);
  assert.equal(saved.ledger.filter(row=>row.type==='loan.repay').length,1);
});

test('persistent local read failure returns a controlled JSON API error without leaking parser details',async t=>{
  await seed();const before=await realReadFile(stateFile,'utf8');let attempts=0;
  t.mock.method(console,'error',()=>{});
  t.mock.method(fs,'readFile',async function(file,...rest){
    if(String(file)===stateFile){attempts++;return '{"private-note":"unfinished';}
    return realReadFile.call(this,file,...rest);
  });
  const response=await route('/api/bootstrap');
  assert.equal(response.status,503);assert.equal(response.body.code,'BANK_STORE_UNREADABLE');
  assert.match(response.body.error,/保留原文件/);assert.doesNotMatch(response.body.error,/Unterminated|private-note|position|ledger\.json/);
  assert.equal(attempts,3);assert.equal(await realReadFile(stateFile,'utf8'),before);
});
