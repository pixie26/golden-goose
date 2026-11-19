// The app keeps Yahoo page work within 7 s, leaving time to fall back (search),
// save (registration) or report. This is stricter than Netlify's platform limit.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=await mkdtemp(join(tmpdir(),'goose-page-deadline-'));
const saved=Object.fromEntries(['BANK_DATA_FILE','SETUP_TOKEN','DISABLE_LOCAL_TIMER','DATABASE_URL','NETLIFY'].map(k=>[k,process.env[k]]));
process.env.BANK_DATA_FILE=join(dir,'bank.json');process.env.SETUP_TOKEN='page-deadline-token';process.env.DISABLE_LOCAL_TIMER='1';
delete process.env.DATABASE_URL;delete process.env.NETLIFY;
const {handleApi}=await import('../lib/api.mjs');
const networkFetch=globalThis.fetch;
// Yahoo accepts the request and never answers: the slow case that previously outlived the limit.
globalThis.fetch=(url,{signal}={})=>new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason)));
const keepAlive=setInterval(()=>{},250); // a real server keeps the event loop alive
after(async()=>{clearInterval(keepAlive);globalThis.fetch=networkFetch;for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});});

async function route(path,method='GET',payload=null,cookie=''){
 const headers={};if(cookie)headers.cookie=cookie;if(payload!==null)headers['content-type']='application/json';
 const started=Date.now();
 const r=await handleApi(new Request('http://localhost:3000'+path,{method,headers,...(payload!==null?{body:JSON.stringify(payload)}:{})}));
 return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie'),ms:Date.now()-started};
}
let n=0;const act=(cookie,action,payload={})=>route('/api/action','POST',{action,payload,idempotencyKey:'page-deadline-'+ ++n},cookie);

test('search, registration and the manual refresh answer within 10 s while Yahoo hangs',async()=>{
 assert.equal((await route('/api/setup','POST',{token:'page-deadline-token',password:'page-deadline-parent',pin:'123456'})).status,200);
 const kid=(await route('/api/login','POST',{role:'kid',password:'123456'})).cookie.split(';')[0];
 const dad=(await route('/api/login','POST',{role:'dad',password:'page-deadline-parent'})).cookie.split(';')[0];
 const [search,known,unknown,refresh]=await Promise.all([
  route('/api/stocks/search?q=0700','GET',null,kid),
  act(kid,'security.register',{symbol:'NVDA'}),
  act(kid,'security.register',{symbol:'ZZZZ'}),
  act(dad,'quote.refresh',{}),
 ]);
 for(const [name,r] of Object.entries({search,known,unknown,refresh}))assert.ok(r.ms<9000,`${name} answered in ${r.ms} ms`);
 assert.equal(search.status,200);assert.equal(search.body.offline,true);assert.equal(search.body.results[0].symbol,'0700.HK');
 assert.match(search.body.warning,/超时/);
 assert.equal(known.status,200);assert.match(known.body.warning,/行情暂不可用：连接 Yahoo 超时/);
 assert.equal(unknown.status,400);assert.match(unknown.body.error,/暂时无法在线验证 ZZZZ/);
 assert.equal(refresh.status,200);assert.equal(refresh.body.ok,true);assert.ok(refresh.body.errors.length>0);
 const state=await route('/api/state','GET',null,kid);
 assert.ok(state.body.symbols.some(s=>s.symbol==='NVDA'),'the offline-directory registration was saved');
});
