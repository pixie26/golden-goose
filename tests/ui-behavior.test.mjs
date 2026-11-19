// V1.7 regression tests: redesigned UI keeps every function and fixes the V1.6 front-end bugs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

const appJs=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let seq=0;const act=(s,a,p={},role='kid')=>runAction(s,role,a,p,`ui17-${++seq}-key`);
function bank(){const s=initialState();setup(s,'t','t','a-strong-local-password','123456');return s;}
const ok=s=>role=>new Response(JSON.stringify({initialized:true,role,data:view(s,role)}),{status:200,headers:{'content-type':'application/json'}});

function mount(s,role='kid',fetchImpl){
 const handlers={};
 const root={innerHTML:'',addEventListener:(type,fn)=>{handlers[type]=fn;},querySelectorAll:()=>[]};
 const toastEl={textContent:'',className:''};
 const document={getElementById:id=>id==='root'?root:id==='toast'?toastEl:null};
 const calls=[];
 const fetch=async(path,opts)=>{calls.push(path);return fetchImpl?fetchImpl(path,opts):ok(s)(role);};
 const ctx=vm.createContext({document,fetch,console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(appJs,ctx);
 const ready=new Promise(r=>setTimeout(r,25));
 return {ctx,root,handlers,toastEl,calls,async html(code){await ready;if(code)vm.runInContext(code,ctx);return root.innerHTML;}};
}

test('task completion quantity is a whole-number stepper (server only accepts integers)',async()=>{
 const s=bank();act(s,'task.create',{name:'叠衬衫',unit:'件',amount:'2'},'dad');
 const html=await mount(s).html("tab='tasks';render()");
 assert.match(html,/name="quantity" type="number" inputmode="numeric" required min="1" max="500" step="1"/);
 assert.doesNotMatch(html,/name="quantity"[^>]*step="0\.1"/);
 assert.match(html,/data-step="-1"/);assert.match(html,/data-step="1"/);
});

test('return controls are Olivia-only; dad refunds from his own page',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');
 act(s,'purchase.request',{name:'画笔',amount:'20'});act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
 act(s,'purchase.request',{name:'贴纸',amount:'5'});act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
 act(s,'purchase.return.request',{id:s.purchaseRequests[0].id,reason:'重复'});
 const kid=await mount(s,'kid').html("tab='account';render()");
 assert.match(kid,/data-op="purchase.return.request"/);assert.doesNotMatch(kid,/data-act="purchase.return.cancel"/);
 const dad=await mount(s,'dad').html("tab='account';render()");
 assert.doesNotMatch(dad,/data-op="purchase.return.request"/);assert.doesNotMatch(dad,/data-act="purchase.return.cancel"/);
 const dadPage=await mount(s,'dad').html("tab='parent';render()");
 assert.match(dadPage,/同意退款/);assert.match(dadPage,/拒绝退款/);
});

test('search results outside HK/US are watch-only (no dead "trade" button)',async()=>{
 const s=bank();
 const html=await mount(s).html(`tab='stocks';stockSearchTerm='toy';stockSearchResults=${JSON.stringify([
  {symbol:'7203.T',name:'Toyota',exchange:'JPX',type:'EQUITY',tradeHint:'OTHER'},
  {symbol:'AAPL',name:'Apple',exchange:'NMS',type:'EQUITY',tradeHint:'US'}])};render()`);
 assert.match(html,/data-buy-symbol="AAPL"/);
 assert.doesNotMatch(html,/data-buy-symbol="7203\.T"/);
 assert.match(html,/仅观察/);
 assert.match(html,/data-watch-symbol="7203\.T"/);
});

test('empty account renders a neutral ring, and debt is listed but never drawn as an asset slice',async()=>{
 let html=await mount(bank()).html();
 assert.match(html,/conic-gradient\(var\(--c-empty\) 0% 100%\)/);
 assert.doesNotMatch(html,/#ffe090/);
 const s=bank();act(s,'loan.request',{amount:'50'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 html=await mount(s).html();
 assert.match(html,/conic-gradient\(var\(--c-cash\) 0\.00% 100\.00%,var\(--c-fixed\) 100\.00% 100\.00%,var\(--c-stock\) 100\.00% 100\.00%\)/);
 assert.match(html,/欠家长<\/span><b class="num neg">−O\$ 50\.0</);
 assert.match(html,/现在可用/);
});

test('early-redeemed deposit shows no interest; active deposit shows its estimate',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'1000'},'dad');
 act(s,'fixed.open',{term:'12',amount:'365'});act(s,'fixed.open',{term:'3',amount:'100'});
 act(s,'fixed.redeem',{id:s.fixed[0].id});
 const html=await mount(s).html("tab='account';render()");
 assert.match(html,/不计利息/);
 // 365 × 10% × days/365. Twelve months span 366 days when they include 29 February.
 const active=s.fixed.find(f=>f.status==='active'&&f.term===12),days=(Date.parse(active.maturity)-Date.parse(active.start))/86400000;
 const shown=(Math.round(Math.round(36500*1000*days/3650000)/10)/10).toFixed(1);
 assert.match(html,new RegExp('预计利息 O\\$ '+shown.replace('.','\\.')));
 assert.doesNotMatch(html,/到期预计利息/);
});

test('closed-session orders need parent cancellation and active loans offer exact pay-off',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'1000'},'dad');
 act(s,'stock.buy',{symbol:'AAPL',amount:'100'});s.orders[0].targetDate='2026-01-05';
 act(s,'loan.request',{amount:'20'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 const kidStocks=await mount(s).html("tab='stocks';render()");
 assert.doesNotMatch(kidStocks,/data-act="stock.cancel"/);
 const kidAccount=await mount(s).html("tab='account';render()");
 assert.match(kidAccount,/data-act="loan.payoff"/);
 const dadPage=await mount(s,'dad').html("tab='parent';render()");
 assert.match(dadPage,/data-act="order.cancel"/);
});

test('timestamps show the viewer local date (HK), not the UTC date',async()=>{
 const before=process.env.TZ;process.env.TZ='Asia/Hong_Kong';
 try{
  const s=bank();act(s,'cash.grant',{amount:'5',note:'零花钱'},'dad');s.ledger[0].at='2026-11-16T23:30:00.000Z';
  // A fixed historical timestamp: show all time so the default 30-day filter cannot hide it later.
  const html=await mount(s).html("recordState('ledger').period='all';tab='history';render()");
  assert.match(html,/2026-11-17 07:30/);
  assert.doesNotMatch(html,/2026-11-16/);
 }finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});

test('a second submit while busy is still prevented (no native GET that would put the PIN in the URL)',async()=>{
 const m=mount(bank());await m.html();
 vm.runInContext('busy=true',m.ctx);
 let prevented=false;
 await m.handlers.submit({target:{closest:()=>({dataset:{op:'login'},querySelector:()=>null})},preventDefault(){prevented=true;}});
 assert.equal(prevented,true);
 assert.equal(m.calls.filter(p=>p==='/api/login').length,0);
});

test('a revoked session (PIN / password changed) returns to the login screen',async()=>{
 const s=bank();
 const m=mount(s,'kid',async path=>path==='/api/bootstrap'?ok(s)('kid'):new Response(JSON.stringify({error:'登录已过期'}),{status:403,headers:{'content-type':'application/json'}}));
 await m.html();
 const message=await vm.runInContext("runAction('wish.add',{name:'x',amount:'1'}).then(()=>'resolved',e=>e.message)",m.ctx);
 assert.equal(message,'登录已过期，请重新登录');
 assert.equal(vm.runInContext('role',m.ctx),null);
 assert.match(m.root.innerHTML,/data-op="login"/);
});

test('hash routes restore the page and sub-tab on reload',async()=>{
 const s=bank();
 const handlers={};
 const root={innerHTML:'',addEventListener:(t,f)=>{handlers[t]=f;},querySelectorAll:()=>[]};
 const document={getElementById:id=>id==='root'?root:id==='toast'?{textContent:'',className:''}:null};
 const ctx=vm.createContext({document,fetch:async()=>ok(s)('kid'),console,setTimeout,clearTimeout,location:{hostname:'localhost',hash:'#/account/loan'}});
 vm.runInContext(appJs,ctx);await new Promise(r=>setTimeout(r,25));
 assert.equal(vm.runInContext('tab',ctx),'account');
 assert.match(root.innerHTML,/id="loan" data-panel="account:loan">/);
 assert.match(root.innerHTML,/id="fixed" data-panel="account:fixed" hidden>/);
});

test('local server CSP allows blob: images, so avatar upload works locally',async()=>{
 const folder=dirname(fileURLToPath(import.meta.url)),rootDir=join(folder,'..');
 const port=await new Promise((resolve,reject)=>{const srv=createServer();srv.on('error',reject);srv.listen(0,'127.0.0.1',()=>{const p=srv.address().port;srv.close(()=>resolve(p));});});
 const dir=await mkdtemp(join(tmpdir(),'goose-csp-'));
 const proc=spawn(process.execPath,[join(rootDir,'server.mjs')],{cwd:dir,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DISABLE_LOCAL_TIMER:'1',BANK_DATA_FILE:join(dir,'s.json')},stdio:'ignore'});
 try{
  let r;for(let i=0;i<70;i++){try{r=await fetch(`http://127.0.0.1:${port}/`);if(r.ok)break;}catch{}await new Promise(x=>setTimeout(x,75));}
  assert.ok(r?.ok);
  assert.match(r.headers.get('content-security-policy'),/img-src 'self' data: blob:/);
  for(const f of ['assets/images/logo.svg','assets/icons/apple-touch-icon.png','assets/icons/favicon.svg','assets/images/goose.svg','assets/images/coin.svg','assets/images/hero-fairytale.png','assets/images/hero-mobile.png','assets/images/action-icons.png','assets/images/brand-goose.png']){const a=await fetch(`http://127.0.0.1:${port}/${f}`);assert.equal(a.status,200,f);}
  for(const f of ['.env','data/bank.local.json','lib/core.mjs','docs/NETLIFY.md','castle.svg']){
   assert.equal((await fetch(`http://127.0.0.1:${port}/${f}`)).status,404,f);
  }
  const head=await fetch(`http://127.0.0.1:${port}/assets/images/logo.svg`,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(`http://127.0.0.1:${port}/style.css`,{method:'POST',body:'invalid'})).status,405);
 }finally{proc.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
});
