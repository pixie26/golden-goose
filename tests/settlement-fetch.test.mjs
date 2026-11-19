// V1.8: the twice-daily scheduled settlement must finish inside Netlify's 30-second limit
// even when Yahoo hangs, and must fetch the symbols that settle orders first.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchQuotes} from '../lib/quotes.mjs';
import {initialState,setup,runAction,trackedSecurities} from '../lib/core.mjs';

test('Yahoo fetching stops at the time budget instead of running past the 30 s function limit',async()=>{
 const realFetch=globalThis.fetch;
 // A real request holds a socket open; the fake one doesn't, so keep the event loop alive explicitly.
 const keepAlive=setInterval(()=>{},50);
 // A Yahoo that never answers: each request only ends when its own timeout aborts it.
 globalThis.fetch=(url,opts)=>new Promise((_,reject)=>{opts?.signal?.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'TimeoutError'})));});
 try{
  const secs=Array.from({length:12},(_,i)=>({symbol:'S'+i,market:'US',currency:'USD',zone:'America/New_York'}));
  const t0=Date.now();
  const r=await fetchQuotes(secs,new Date(),{budgetMs:1500});
  const ms=Date.now()-t0;
  assert.ok(ms<2800,`took ${ms} ms`);
  assert.equal(r.histories.length,0);
  assert.equal(r.errors.length,12);
  assert.ok(r.errors.some(e=>/下次自动重试/.test(e)));
 }finally{globalThis.fetch=realFetch;clearInterval(keepAlive);}
});

test('symbols with pending orders are fetched before holdings, watchlist and defaults',()=>{
 const s=initialState();setup(s,'t','t','a-strong-local-password','123456');
 let n=0;const act=(a,p,role='kid')=>runAction(s,role,a,p,'v18-'+(++n)+'-key');
 act('cash.grant',{amount:'500'},'dad');
 act('watch.add',{verifiedSecurity:{symbol:'NVDA',name:'NVIDIA',market:'US',currency:'USD',quoteType:'EQUITY'}});
 act('stock.buy',{symbol:'VOO',amount:'100'}); // VOO is the last default symbol
 const order=trackedSecurities(s).map(x=>x.symbol);
 assert.equal(order[0],'VOO');
 assert.ok(order.indexOf('NVDA')<order.indexOf('0700.HK'),'watchlist before untouched defaults');
});
