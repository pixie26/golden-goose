// Quote units must survive registration and refresh unchanged: a pence price
// cannot be labelled as pounds. All provider responses are deterministic fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialState,setup,createSession,runAction,ingestHistories,view} from '../lib/core.mjs';
import {normalizeSecurity,parseDailyChart,fetchQuotes} from '../lib/quotes.mjs';

const now=new Date('2026-11-18T14:00:00Z');
const cases=[
 {symbol:'AZN.L',currency:'GBp',legacy:'GBP',zone:'Europe/London'},
 {symbol:'NPN.JO',currency:'ZAc',legacy:'ZAC',zone:'Africa/Johannesburg'},
];
function metadata({symbol,currency,zone}){return {symbol,currency,exchangeTimezoneName:zone,instrumentType:'EQUITY'};}
function chart(meta,price=12000){return {chart:{result:[{meta,timestamp:[Date.parse('2026-11-17T08:00:00Z')/1000],indicators:{quote:[{close:[price]}]}}]}};}
function bank(){const s=initialState();setup(s,'t','t','quote-unit-test-password','123456');return s;}

for(const item of cases){
 test(`new ${item.currency} watch prices preserve their unit through registration and refresh`,()=>{
  const meta=metadata(item),security=normalizeSecurity(meta,item.symbol),s=bank();
  assert.equal(security.currency,item.currency);
  assert.equal(security.quoteUnitVerified,true);
  assert.equal(security.tradable,false);
  runAction(s,'kid','watch.add',{verifiedSecurity:security},'new-unit-'+item.symbol);
  const rows=parseDailyChart(chart(meta),security,now);
  ingestHistories(s,[{symbol:item.symbol,rows,currency:item.currency}],now);
  const result=view(s,'kid').watchlist[0];
  assert.equal(result.currency,item.currency);
  assert.equal(result.quote.currency,item.currency);
  assert.equal(result.quote.priceMilli,12000000,'provider values are not rescaled');
  assert.equal(s.cashCents,0,'a watch-only quote cannot change cash');
 });

 test(`legacy ${item.legacy} registration is repaired once from authoritative ${item.currency} metadata`,async t=>{
  const s=bank(),legacy={...normalizeSecurity(metadata(item),item.symbol),currency:item.legacy};
  delete legacy.quoteUnitVerified;
  s.securities[item.symbol]=legacy;s.watchlist=[item.symbol];
  s.priceHistory[item.symbol]=[{date:'2026-11-16',priceMilli:11000000}];
  s.quotes[item.symbol+'|2026-11-16']={symbol:item.symbol,date:'2026-11-16',priceMilli:11000000,currency:item.legacy,final:true};
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(chart(metadata(item)))));
  const before=JSON.stringify(s);
  const fetched=await fetchQuotes([legacy],now,{budgetMs:2000});
  assert.equal(JSON.stringify(s),before,'fetching metadata cannot mutate the live ledger');
  assert.equal(fetched.errors.length,0);
  assert.equal(fetched.histories[0].currency,item.currency);
  ingestHistories(s,fetched.histories,now);
  assert.equal(s.securities[item.symbol].currency,item.currency);
  assert.equal(s.securities[item.symbol].quoteUnitVerified,true);
  assert.equal(s.quotes[item.symbol+'|2026-11-16'].currency,item.currency);
  assert.deepEqual(s.priceHistory[item.symbol],[{date:'2026-11-16',priceMilli:11000000},{date:'2026-11-17',priceMilli:12000000}]);
  assert.equal(view(s,'kid').watchlist[0].performance.day,9.09);
  assert.throws(()=>parseDailyChart(chart({...metadata(item),currency:item.legacy}),s.securities[item.symbol],now),/行情币种/,'an already verified unit must not silently change back');
 });
}

test('legitimate whole-pound quotes remain GBP and reject a later pence-unit change',async t=>{
 const item={symbol:'TEST.L',currency:'GBP',zone:'Europe/London'},meta=metadata(item);
 const security=normalizeSecurity(meta,item.symbol),s=bank();
 s.securities[item.symbol]={...security};delete s.securities[item.symbol].quoteUnitVerified;
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify(chart(meta,120))));
 const fetched=await fetchQuotes([s.securities[item.symbol]],now,{budgetMs:2000});
 ingestHistories(s,fetched.histories,now);
 assert.equal(s.securities[item.symbol].currency,'GBP');
 assert.equal(s.securities[item.symbol].quoteUnitVerified,true);
 assert.equal(s.quotes[item.symbol+'|2026-11-17'].priceMilli,120000);
 assert.throws(()=>parseDailyChart(chart({...meta,currency:'GBp'},12000),s.securities[item.symbol],now),/行情币种/);
});

test('HKD/USD identities stay strict and their cash conversions are unchanged',()=>{
 for(const item of [
  {symbol:'0700.HK',currency:'HKD',zone:'Asia/Hong_Kong',budget:'100',price:100},
  {symbol:'AAPL',currency:'USD',zone:'America/New_York',budget:'800',price:100},
 ]){
  const security=normalizeSecurity(metadata(item),item.symbol),s=bank();
  assert.equal(security.currency,item.currency);assert.equal(security.tradable,true);
  assert.throws(()=>parseDailyChart(chart({...metadata(item),currency:'GBp'}),security,now),/行情币种/);
  s.cashCents=Number(item.budget)*100;s.reservedCents=s.cashCents;
  s.orders=[{id:'units-buy',symbol:item.symbol,side:'buy',budgetCents:s.cashCents,targetDate:'2026-11-17',submittedAt:'2026-11-17T01:00:00Z',status:'pending'}];
  ingestHistories(s,[{symbol:item.symbol,currency:item.currency,rows:[{date:'2026-11-17',priceMilli:item.price*1000}]}],now);
  assert.equal(s.positions[0].qtyMicro,1000000);
  assert.equal(s.cashCents,0);assert.equal(s.reservedCents,0);
 }
});

test('watch.add existing-security fast path persists the repaired quote unit in its transaction',async t=>{
 t.mock.timers.enable({apis:['Date'],now:now.getTime()});
 const directory=await mkdtemp(join(tmpdir(),'goose-quote-units-')),file=join(directory,'bank-test.json');
 const keys=['BANK_DATA_FILE','DATABASE_URL','NETLIFY','SETUP_TOKEN'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.BANK_DATA_FILE=file;process.env.SETUP_TOKEN='t';delete process.env.DATABASE_URL;delete process.env.NETLIFY;
 try{
  const item=cases[0],s=bank(),legacy={...normalizeSecurity(metadata(item),item.symbol),currency:'GBP'};
  delete legacy.quoteUnitVerified;s.securities[item.symbol]=legacy;
  createSession(s,'kid','quote-unit-session');await writeFile(file,JSON.stringify(s));
  const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));return new Response(JSON.stringify(chart(metadata(item))));});
  const {handleApi}=await import('../lib/api.mjs');
  const response=await handleApi(new Request('https://bank.example/api/action',{method:'POST',headers:{'content-type':'application/json',origin:'https://bank.example',cookie:'goldengoose_session=quote-unit-session'},body:JSON.stringify({action:'watch.add',payload:{symbol:item.symbol},expectedRole:'kid',idempotencyKey:'legacy-unit-api'})}));
  assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  assert.equal(calls.length,1,'already registered securities still need only the daily-history request');
  assert.match(calls[0],/range=2y/);
  const savedState=JSON.parse(await readFile(file,'utf8'));
  assert.equal(savedState.securities[item.symbol].currency,'GBp');
  assert.equal(savedState.securities[item.symbol].quoteUnitVerified,true);
  assert.equal(view(savedState,'kid').watchlist[0].quote.currency,'GBp');
 }finally{
  for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(directory,{recursive:true,force:true});
 }
});
