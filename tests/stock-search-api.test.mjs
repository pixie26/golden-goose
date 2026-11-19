import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=await mkdtemp(join(tmpdir(),'golden-goose-test-'));
process.env.BANK_DATA_FILE=join(dir,'bank-test.json');
process.env.SETUP_TOKEN='unit-test-token';
process.env.DISABLE_LOCAL_TIMER='1';
const {handleApi}=await import('../lib/api.mjs');
const chart=range=>({chart:{result:[{meta:{symbol:'TSLA',currency:'USD',instrumentType:'EQUITY',exchangeTimezoneName:'America/New_York',fullExchangeName:'NasdaqGS'},timestamp:[Math.floor(Date.parse('2025-12-31T14:30:00Z')/1000),Math.floor(Date.parse('2026-11-16T14:30:00Z')/1000)],indicators:{quote:[{close:[100,125]}]}}],error:null}});
const prevFetch=globalThis.fetch;
globalThis.fetch=async url=>{
 const u=String(url);
 if(u.includes('/v1/finance/search?'))return new Response(JSON.stringify({quotes:[{symbol:'TSLA',shortname:'Tesla Inc.',quoteType:'EQUITY',exchange:'NMS'}]}),{status:200});
 if(u.includes('/v8/finance/chart/TSLA'))return new Response(JSON.stringify(chart()),{status:200});
 throw Error('unexpected Yahoo network URL '+u);
};
async function route(path,method='GET',payload=null,cookie=''){
 const headers={};if(cookie)headers.cookie=cookie;if(payload!==null)headers['content-type']='application/json';
 const r=await handleApi(new Request('http://localhost:3000'+path,{method,headers,...(payload!==null?{body:JSON.stringify(payload)}:{})}));
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};
}
const key=()=>Math.random().toString(36).slice(2)+'test-uuid';
const act=(cookie,action,payload={})=>route('/api/action','POST',{action,payload,idempotencyKey:key()},cookie);
test('stock search is private and Yahoo fuzzy search + 10-watchlist change are live through API',async()=>{
 try{
  assert.equal((await route('/api/stocks/search?q=tesla')).status,403);
  const setup=await route('/api/setup','POST',{token:'unit-test-token',password:'dad-password-secure-123',pin:'123456'});assert.equal(setup.status,200);
  const login=await route('/api/login','POST',{role:'kid',password:'123456'});assert.equal(login.status,200);
  const cookie=login.cookie.split(';')[0];
  const search=await route('/api/stocks/search?q=tesla','GET',null,cookie);
  assert.equal(search.status,200);assert.equal(search.body.results[0].symbol,'TSLA');
  const add=await act(cookie,'watch.add',{symbol:'TSLA',verifiedSecurity:{symbol:'EVIL',market:'HK',currency:'HKD'}});
  assert.equal(add.status,200);assert.equal(add.body.ok,true);
  const state=await route('/api/state','GET',null,cookie);
  assert.equal(state.body.watchlist.length,1);assert.equal(state.body.watchlist[0].symbol,'TSLA');assert.equal(state.body.watchlist[0].currency,'USD');
  assert.equal(state.body.watchlist[0].performance.ytd,25);
  const dadLogin=await route('/api/login','POST',{role:'dad',password:'dad-password-secure-123'});
  const dadCookie=dadLogin.cookie.split(';')[0];
  assert.equal((await act(dadCookie,'cash.grant',{amount:'200',note:'测试零花钱'})).status,200);
  const buy=await act(cookie,'stock.buy',{symbol:'TSLA',amount:'100'});
  assert.equal(buy.status,200);
  const position=await route('/api/state','GET',null,cookie);
  assert.equal(position.body.orders[0].symbol,'TSLA');
  assert.equal(position.body.orders[0].status,'pending');
  assert.equal(position.body.summary.availableCents,10000);
  const dadOnly=await act(cookie,'quote.set',{symbol:'TSLA',date:'2026-10-01',price:'10'});assert.equal(dadOnly.status,400);
 }finally{globalThis.fetch=prevFetch;await rm(dir,{recursive:true,force:true});}
});
