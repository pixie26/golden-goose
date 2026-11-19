import test from 'node:test';
import assert from 'node:assert/strict';
import {searchYahoo, lookupYahooSymbol} from '../lib/quotes.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState, view, setup,runAction} from '../lib/core.mjs';

const networkFetch=globalThis.fetch;
test('unavailable Yahoo triggers labelled offline catalogue instead of raw `fetch failed`',async()=>{
 globalThis.fetch=async()=>{const cause=new Error('getaddrinfo EAI_AGAIN query2.finance.yahoo.com');cause.code='EAI_AGAIN';throw new TypeError('fetch failed',{cause});};
 try{
  const search=await searchYahoo('tsla');
  assert.equal(search.offline,true);assert.equal(search.results[0].symbol,'TSLA');
  assert.match(search.warning,/DNS|Yahoo/);assert.doesNotMatch(search.warning,/fetch failed/);
  const cn=await searchYahoo('特斯拉');assert.equal(cn.results[0].symbol,'TSLA');
  const known=await lookupYahooSymbol('TSLA');assert.equal(known.currency,'USD');assert.equal(known.market,'US');
  assert.equal(known.offlineDirectory,true);
  await assert.rejects(()=>lookupYahooSymbol('UNKNOWN999'),/在线验证|预置/);
  const notInvented=await searchYahoo('AAPL');assert.equal(notInvented.results[0].price,undefined);
 }finally{globalThis.fetch=networkFetch;}
});
test('Yahoo online results still remain the primary full-universe source',async()=>{
 globalThis.fetch=async(url)=>new Response(JSON.stringify({quotes:[{symbol:'SAMPLE.HK',quoteType:'EQUITY',shortname:'Sample Co',exchange:'HKG'}]}),{status:200});
 try{const r=await searchYahoo('SAMPLE');assert.equal(r.offline,false);assert.equal(r.results[0].symbol,'SAMPLE.HK');}finally{globalThis.fetch=networkFetch;}
});

test('kid and dad pages show one-step purchase / separate optional return, with no delivery-only button',async()=>{
 const s=initialState();setup(s,'token','token','test-dad-password-12345','654321');
 const a=(role,action,payload={})=>runAction(s,role,action,payload,Math.random().toString(36).slice(2)+'-test-v16');
 a('dad','cash.grant',{amount:'100'});a('kid','purchase.request',{name:'LEGO House',amount:'20'});
 const id=s.purchaseRequests[0].id;
 const appJs=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const root={innerHTML:'',addEventListener:()=>{}};
 const doc={getElementById:k=>k==='root'?root:k==='toast'?{textContent:'',className:''}:null};
 const fakeFetch=async()=>new Response(JSON.stringify({initialized:true,role:'dad',data:view(s,'dad')}));
 const context=vm.createContext({document:doc,fetch:fakeFetch,setTimeout,clearTimeout,location:{hostname:'localhost'},console});
 vm.runInContext(appJs,context);
 await new Promise(resolve=>setTimeout(resolve,30));
 vm.runInContext("tab='parent';render()",context);
 assert.match(root.innerHTML,/确认购买并交付（扣款）/);
 assert.doesNotMatch(root.innerHTML,/data-act="purchase\.deliver"/);
 a('dad','purchase.approve',{id});
 const kid=vm.createContext({document:{getElementById:k=>k==='root'?root:k==='toast'?{textContent:'',className:''}:null},fetch:async()=>new Response(JSON.stringify({initialized:true,role:'kid',data:view(s,'kid')})),setTimeout,clearTimeout,location:{hostname:'localhost'},console});
 vm.runInContext(appJs,kid);
 await new Promise(resolve=>setTimeout(resolve,30));
 vm.runInContext("tab='account';render()",kid);
 assert.match(root.innerHTML,/data-op="purchase\.return\.request"/);
});
