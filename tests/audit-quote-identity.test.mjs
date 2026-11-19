// Yahoo may answer an old ticker with a different canonical security. Exercise
// the actual HTTP handlers so registration, stored history and fills agree on
// the security that was requested; all accounts and prices below are synthetic.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory=await mkdtemp(join(tmpdir(),'goose-quote-identity-'));
const file=join(directory,'bank-test.json');
const envKeys=['BANK_DATA_FILE','DATABASE_URL','NETLIFY','SETUP_TOKEN'];
const savedEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.BANK_DATA_FILE=file;
process.env.SETUP_TOKEN='identity-test-setup';
delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const {handleApi}=await import('../lib/api.mjs');
const {initialState,setup,createSession}=await import('../lib/core.mjs');
const realFetch=globalThis.fetch;
const parentToken='identity-test-parent-session',childToken='identity-test-child-session';
const frozenNow=Date.parse('2026-11-19T01:00:00Z');
const quoteDate='2026-11-17';
let replies={},requests=[],sequence=0;

function chart(symbol,overrides={}){
  const hk=symbol.endsWith('.HK');
  return {chart:{result:[{
    meta:{symbol,currency:hk?'HKD':'USD',instrumentType:'EQUITY',exchangeTimezoneName:hk?'Asia/Hong_Kong':'America/New_York',...overrides},
    timestamp:[Date.parse(quoteDate+'T14:30:00Z')/1000],
    indicators:{quote:[{close:[100.75]}]},
  }],error:null}};
}
async function resetState(edit=()=>{}){
  const state=initialState();
  setup(state,'identity-test-setup','identity-test-setup','identity-parent-password','123456');
  createSession(state,'dad',parentToken);createSession(state,'kid',childToken);
  edit(state);
  await writeFile(file,JSON.stringify(state));
  return state;
}
const readState=async()=>JSON.parse(await readFile(file,'utf8'));
async function action(name,payload={},role='kid'){
  const response=await handleApi(new Request('https://bank.example/api/action',{
    method:'POST',headers:{'content-type':'application/json',origin:'https://bank.example',cookie:'goldengoose_session='+(role==='dad'?parentToken:childToken)},
    body:JSON.stringify({action:name,payload,expectedRole:role,idempotencyKey:'quote-identity-'+ ++sequence}),
  }));
  return {status:response.status,body:await response.json()};
}
beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:frozenNow});
  replies={};requests=[];
  globalThis.fetch=async input=>{
    const url=new URL(String(input));
    assert.match(url.hostname,/^query[12]\.finance\.yahoo\.com$/);
    const prefix='/v8/finance/chart/';assert.ok(url.pathname.startsWith(prefix),'unexpected external request');
    const symbol=decodeURIComponent(url.pathname.slice(prefix.length));
    requests.push({symbol,range:url.searchParams.get('range')});
    return new Response(JSON.stringify(chart(symbol,replies[symbol])),{status:200,headers:{'content-type':'application/json'}});
  };
  t.mock.method(console,'error',()=>{});
  await resetState();
});
after(async()=>{
  globalThis.fetch=realFetch;
  for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(directory,{recursive:true,force:true});
});

for(const name of ['watch.add','security.register']){
  test(name+': an old ticker redirected to META is rejected without changing the ledger',async()=>{
    replies.FB={symbol:'META'};
    const before=await readState();
    const response=await action(name,{symbol:'FB'});
    assert.equal(response.status,400,'a canonical ticker change must not be reported as success');
    assert.match(response.body.error,/FB/);assert.match(response.body.error,/META/);assert.match(response.body.error,/重新搜索/);
    assert.deepEqual(await readState(),before,'neither ticker, watch entry nor historical prices may be silently registered');
    assert.ok(requests.every(request=>request.range==='1mo'),'reject before trying to attach historical prices');
  });

  test(name+': an explicit NVDA-to-MSFT identity mismatch cannot fall back to the curated NVDA entry',async()=>{
    replies.NVDA={symbol:'MSFT'};
    const before=await readState();
    const response=await action(name,{symbol:'NVDA'});
    assert.equal(response.status,400,'an explicit provider identity conflict is not an offline-network failure');
    assert.match(response.body.error,/NVDA/);assert.match(response.body.error,/MSFT/);assert.match(response.body.error,/重新搜索/);
    assert.deepEqual(await readState(),before);
  });
}

test('an exact META request saves the security and its own confirmed closing price',async()=>{
  const response=await action('watch.add',{symbol:'META'});
  assert.equal(response.status,200);assert.equal(response.body.ok,true);
  assert.equal(response.body.warning,undefined);
  const state=await readState();
  assert.equal(state.securities.META.symbol,'META');assert.equal(state.securities.META.currency,'USD');
  assert.deepEqual(state.watchlist,['META']);
  assert.deepEqual(state.priceHistory.META,[{date:quoteDate,priceMilli:100750}]);
  assert.equal(state.quotes['META|'+quoteDate].priceMilli,100750);
  assert.equal(state.quotes['META|'+quoteDate].final,true);
  assert.deepEqual(requests.map(request=>request.range),['1mo','2y']);
});

for(const [label,metadata] of [
  ['symbol',{symbol:'MSFT'}],
  ['currency',{currency:'HKD'}],
  ['exchange time zone',{exchangeTimezoneName:'Asia/Hong_Kong'}],
]){
  test('manual refresh rejects mismatching '+label+' metadata and leaves the AAPL order unfilled',async()=>{
    replies.AAPL=metadata;
    await resetState(state=>{
      state.cashCents=10000;state.reservedCents=5000;
      state.orders.push({id:'identity-pending-buy',symbol:'AAPL',side:'buy',budgetCents:5000,targetDate:quoteDate,targetSession:'preopen',scheduleBasis:'session-close-v1.2',status:'pending',submittedAt:quoteDate+'T13:00:00Z'});
    });
    const response=await action('quote.refresh',{},'dad');
    assert.equal(response.status,200,'valid quotes for other securities may still be saved');
    assert.ok(response.body.errors.some(error=>error.includes('AAPL')),'the rejected quote is reported to the parent');
    const state=await readState();
    assert.equal(state.quotes['AAPL|'+quoteDate],undefined,'the conflicting price cannot enter the ledger');
    assert.equal(state.priceHistory.AAPL,undefined);
    assert.equal(state.orders[0].status,'pending');assert.equal(state.cashCents,10000);assert.equal(state.reservedCents,5000);
    assert.equal(state.positions.some(position=>position.symbol==='AAPL'),false);
    assert.equal(state.ledger.some(entry=>entry.type==='stock.buy'),false,'no cash or position may be filled using another identity');
  });
}
