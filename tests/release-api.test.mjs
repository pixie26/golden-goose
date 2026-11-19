import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory=await mkdtemp(join(tmpdir(),'goose-release-api-'));
const envKeys=['BANK_DATA_FILE','DATABASE_URL','NETLIFY','SETUP_TOKEN'];
const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.BANK_DATA_FILE=join(directory,'state.json');
process.env.SETUP_TOKEN='release-api-test-setup';
delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const { handleApi }=await import('../lib/api.mjs');
const origin='https://bank.example';
const request=(path,payload,headers={})=>handleApi(new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,...headers},body:JSON.stringify(payload)}));
let kidCookie='';
before(async()=>{
  assert.equal((await request('/api/setup',{token:process.env.SETUP_TOKEN,password:'release-parent-password',pin:'123456'})).status,200);
  const response=await request('/api/login',{role:'kid',password:'123456'});
  assert.equal(response.status,200);kidCookie=response.headers.get('set-cookie').split(';')[0];
});
after(async()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(directory,{recursive:true,force:true});});

test('JSON boundaries reject null, arrays and non-object action payloads without touching the ledger',async()=>{
  const before=await readFile(process.env.BANK_DATA_FILE,'utf8');
  for(const payload of [null,[],false,'hello']){
    const response=await request('/api/action',payload,{cookie:kidCookie});
    assert.equal(response.status,400);assert.match((await response.json()).error,/JSON 对象/);
  }
  for(const payload of [[],false,'hello']){
    const response=await request('/api/action',{action:'purchase.request',payload,idempotencyKey:'release-invalid-object'},{cookie:kidCookie});
    assert.equal(response.status,400);assert.match((await response.json()).error,/JSON 对象/);
  }
  assert.equal(await readFile(process.env.BANK_DATA_FILE,'utf8'),before);
});

test('request size is bounded by UTF-8 bytes even without Content-Length',async()=>{
  const response=await request('/api/login',{role:'kid',password:'中'.repeat(6000)});
  assert.equal(response.status,413);assert.match((await response.json()).error,/过大/);
});

test('oversized request stream is cancelled before consuming the remainder',async()=>{
  let reads=0,cancelled=false;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(20000));},cancel(){cancelled=true;}});
  const response=await handleApi(new Request(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin},body,duplex:'half'}));
  assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(reads<=2);
});

test('simple form content types and cross-scheme / cross-site mutation requests are rejected',async()=>{
  const login={role:'kid',password:'123456'};
  assert.equal((await request('/api/login',login,{'content-type':'text/plain'})).status,415);
  assert.equal((await request('/api/login',login,{origin:'http://bank.example'})).status,403);
  assert.equal((await request('/api/login',login,{'sec-fetch-site':'cross-site'})).status,403);
  const proxied=new Request('http://bank.example/api/login',{method:'POST',headers:{'content-type':'application/json',origin,'x-forwarded-proto':'https'},body:JSON.stringify(login)});
  const response=await handleApi(proxied);assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);
});

test('a stale tab cannot mutate funds using the other account now in the shared cookie',async()=>{
  const response=await request('/api/login',{role:'dad',password:'release-parent-password'});
  const parentCookie=response.headers.get('set-cookie').split(';')[0];
  const before=await readFile(process.env.BANK_DATA_FILE,'utf8');
  const rejected=await request('/api/action',{action:'deposit.request',payload:{amount:'20.0'},idempotencyKey:'release-stale-account',expectedRole:'kid'},{cookie:parentCookie});
  assert.equal(rejected.status,403);assert.match((await rejected.json()).error,/账户已切换/);
  assert.equal(await readFile(process.env.BANK_DATA_FILE,'utf8'),before);
  const accepted=await request('/api/action',{action:'cash.grant',payload:{amount:'20.0'},idempotencyKey:'release-current-account',expectedRole:'dad'},{cookie:parentCookie});
  assert.equal(accepted.status,200);assert.equal(JSON.parse(await readFile(process.env.BANK_DATA_FILE,'utf8')).cashCents,2000);
});

test('failed login counters persist; locked accounts cannot bypass the lock with a correct password',async()=>{
  for(let i=0;i<8;i++)assert.equal((await request('/api/login',{role:'kid',password:'999999'})).status,401);
  const response=await request('/api/login',{role:'kid',password:'123456'});
  assert.equal(response.status,400);assert.match((await response.json()).error,/15分钟/);
  const state=JSON.parse(await readFile(process.env.BANK_DATA_FILE,'utf8'));
  assert.ok(state.authLocks.kid.until>Date.now());
});
