import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {initialState,setup,runAction as coreAction,view} from '../lib/core.mjs';
import {normalizeSecurity} from '../lib/quotes.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=(body,status=200)=>Response.json(body,{status});
const verified=symbol=>normalizeSecurity({symbol,currency:'USD',exchangeTimezoneName:'America/New_York',instrumentType:symbol==='SWPPX'?'MUTUALFUND':'EQUITY',longName:symbol},symbol);
let sequence=0;
function bank(){
 const s=initialState();setup(s,'test-token','test-token','a-parent-password-for-ui','123456');
 coreAction(s,'dad','cash.grant',{amount:'100'},`selection-grant-${++sequence}`);
 return s;
}
async function mount(state,{role='kid',failStateReads=0,onStateRead}={}){
 const handlers={},intervals=[],posts=[],reads=[];let serverRole=role;
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn)};
 const toast={textContent:'',className:''};
 const document={activeElement:null,visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener(){}};
 const context=vm.createContext({document,console,crypto:webcrypto,TextEncoder,AbortController,location:{hostname:'localhost'},confirm:()=>true,
  setTimeout:()=>1,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},
  FormData:class{constructor(form){this.rows=form.formDataEntries();}entries(){return this.rows[Symbol.iterator]();}},
  fetch:async(path,options)=>{
   if(path==='/api/bootstrap')return response({initialized:true,role:serverRole,data:serverRole?view(state,serverRole):null});
   if(path==='/api/state'){
    reads.push(path);
    if(!serverRole)return response({error:'请先登录'},401);
    if(reads.length<=failStateReads)return response({error:'账户读取暂时失败'},503);
    if(onStateRead){const result=await onStateRead(reads.length,()=>response(view(state,serverRole)));if(result)return result;}
    return response(view(state,serverRole));
   }
   if(path==='/api/logout'){serverRole=null;return response({ok:true});}
   const body=JSON.parse(options.body);posts.push(body);
   if(!serverRole||body.expectedRole!==serverRole)return response({error:'登录账户已切换'},403);
   // Use the real registration/tradability and money rules. Only provider metadata
   // and the network read failure are fixtures; registrations cannot fake success.
   const payload=body.action==='security.register'?{symbol:body.payload.symbol,verifiedSecurity:verified(body.payload.symbol)}:body.payload;
   const next=structuredClone(state);
   try{const result=coreAction(next,serverRole,body.action,payload,body.idempotencyKey);Object.assign(state,next);return response(result);}
   catch(error){return response({error:error.message},400);}
  }});
 vm.runInContext(source,context);
 for(let i=0;i<20&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 const run=code=>vm.runInContext(code,context);
 run("tab='stocks';render()");
 async function click(attribute,value=''){
  const key=attribute.replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
  const button={dataset:{[key]:value},hasAttribute:name=>name===attribute,closest:()=>null};
  const event={target:{closest:selector=>selector.includes(`[${attribute}]`)?button:null},preventDefault(){}};
  for(const fn of handlers.click||[])await fn(event);
 }
 return {root,document,toast,context,run,click,handlers,intervals,posts,reads,setRole:value=>{serverRole=value;}};
}
const buyForm=m=>m.root.innerHTML.match(/<form[^>]*data-op="stock.buy"[\s\S]*?<\/form>/)?.[0]||'';
const formSymbol=m=>buyForm(m).match(/<option value="([^"]+)" selected>/)?.[1];
async function submitVisibleBuy(m,amount='10'){
 const symbol=formSymbol(m);assert.ok(symbol,'a confirmed buy form exists');
 const button={disabled:false,isConnected:true};
 const form={dataset:{op:'stock.buy'},querySelector:()=>button,formDataEntries:()=>[['symbol',symbol],['amount',amount]]};
 await m.handlers.submit[0]({target:{closest:()=>form},preventDefault(){}});
}
async function waitFor(check){for(let i=0;i<30&&!check();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(check(),'async request started');}

test('RGG-003: successful registration selects the requested security before any buy can be submitted',async()=>{
 const s=bank(),m=await mount(s);
 await m.click('data-buy-symbol','NVDA');
 assert.equal(formSymbol(m),'NVDA');assert.equal(m.run('pendingBuySelection'),null);
 assert.deepEqual(m.posts.map(p=>p.action),['security.register']);assert.equal(s.orders.length,0);
 await submitVisibleBuy(m);
 assert.equal(s.orders.length,1);assert.equal(s.orders[0].symbol,'NVDA');assert.equal(s.orders[0].budgetCents,1000);
});

for(const recovery of ['manual refresh','visibility refresh','interval refresh','same buy button']){
 test(`RGG-003: failed state read keeps NVDA and ${recovery} restores only NVDA`,async()=>{
  const s=bank(),m=await mount(s,{failStateReads:1});
  await m.click('data-buy-symbol','NVDA');
  assert.equal(s.securities.NVDA.tradable,true,'registration really committed');
  assert.equal(m.run('selectedSymbol'),'NVDA');assert.equal(m.run('pendingBuySelection.symbol'),'NVDA');
  assert.ok(m.run('pendingStateRefresh'));assert.equal(buyForm(m),'','no fallback form while confirmation is missing');
  assert.match(m.root.innerHTML,/已选择 NVDA/);assert.equal(s.orders.length,0);
  if(recovery==='manual refresh')await m.click('data-refresh-state');
  else if(recovery==='visibility refresh')await m.run('refreshWhenIdle()');
  else if(recovery==='interval refresh')await m.intervals[0]();
  else await m.click('data-buy-symbol','NVDA');
  assert.equal(m.run('pendingBuySelection'),null);assert.equal(m.run('pendingStateRefresh'),null);
  assert.equal(formSymbol(m),'NVDA');assert.equal(s.orders.length,0,'recovery never submits money actions');
  assert.deepEqual(m.posts.map(p=>p.action),['security.register'],'refresh never re-registers or retries a purchase');
  await submitVisibleBuy(m);
  assert.equal(s.orders.length,1);assert.equal(s.orders[0].symbol,'NVDA');
 });
}

test('RGG-003: a stale buy submit during recovery only refreshes, and repeated read failures keep the form blocked',async()=>{
 const s=bank(),m=await mount(s,{failStateReads:2});
 await m.click('data-buy-symbol','NVDA');
 const failed=await m.run("runAction('stock.buy',{symbol:'0700.HK',amount:'10'})");
 assert.equal(failed.refreshOnly,true);assert.equal(failed.refreshed,false);
 assert.equal(buyForm(m),'');assert.equal(s.orders.length,0);
 const recovered=await m.run("runAction('stock.buy',{symbol:'0700.HK',amount:'10'})");
 assert.equal(recovered.refreshOnly,true);assert.equal(recovered.refreshed,true);
 assert.equal(formSymbol(m),'NVDA');assert.equal(s.orders.length,0);
 assert.deepEqual(m.posts.map(p=>p.action),['security.register']);
});

test('RGG-003: rejected nontradable registration is shown and cannot expose or submit another stock',async()=>{
 const s=bank(),m=await mount(s);
 await m.click('data-buy-symbol','SWPPX');
 assert.match(m.toast.textContent,/只能加入自选观察，不能买卖/);
 assert.match(m.root.innerHTML,/已选择 SWPPX/);assert.match(m.root.innerHTML,/只能加入自选观察，不能买卖/);
 assert.equal(s.securities.SWPPX,undefined);assert.equal(buyForm(m),'');
 await assert.rejects(m.run("runAction('stock.buy',{symbol:'0700.HK',amount:'10'})"),/请先确认 SWPPX/);
 assert.equal(s.orders.length,0);assert.equal(m.posts.length,1);
 await m.click('data-buy-symbol','AAPL');
 assert.equal(m.run('pendingBuySelection'),null);assert.equal(formSymbol(m),'AAPL');
 await submitVisibleBuy(m);assert.equal(s.orders[0].symbol,'AAPL');
});

test('RGG-003: an explicit newer choice wins over an in-flight refresh of the old target',async()=>{
 let release;
 const s=bank(),m=await mount(s,{failStateReads:1,onStateRead:(number,current)=>number===2?new Promise(resolve=>{release=()=>resolve(current());}):null});
 await m.click('data-buy-symbol','NVDA');
 const refresh=m.run('refreshWhenIdle()');await waitFor(()=>!!release);
 await m.click('data-buy-symbol','AAPL');
 assert.equal(formSymbol(m),'AAPL');assert.equal(m.run('pendingBuySelection'),null);
 release();await refresh;
 assert.equal(formSymbol(m),'AAPL');assert.equal(m.run('selectedSymbol'),'AAPL');
 await submitVisibleBuy(m);assert.equal(s.orders[0].symbol,'AAPL');
 assert.equal(m.posts.filter(p=>p.action==='security.register').length,1);
});

test('RGG-003: choosing a different new ticker does not revive the old target or auto-register the new one',async()=>{
 const s=bank(),m=await mount(s,{failStateReads:1});
 await m.click('data-buy-symbol','NVDA');
 await m.click('data-buy-symbol','AMZN');
 assert.equal(m.run('selectedSymbol'),'AMZN');assert.equal(m.run('pendingBuySelection.symbol'),'AMZN');
 assert.equal(buyForm(m),'');assert.equal(s.securities.AMZN,undefined);
 assert.equal(m.posts.length,1,'the existing pending-state guard only refreshed');
 await m.click('data-buy-symbol','AMZN');
 assert.equal(formSymbol(m),'AMZN');assert.equal(m.run('pendingBuySelection'),null);
 assert.deepEqual(m.posts.map(p=>p.payload.symbol),['NVDA','AMZN']);assert.equal(s.orders.length,0);
});

test('RGG-003: an explicit dropdown change survives the old selection recovery',async()=>{
 const s=bank(),m=await mount(s,{failStateReads:1});
 await m.click('data-buy-symbol','NVDA');
 await m.click('data-buy-symbol','AAPL');
 const input={id:'buy-symbol',value:'MSFT',dataset:{},closest:()=>({dataset:{op:'stock.buy'}})};
 for(const fn of m.handlers.change)await fn({target:input});
 assert.equal(m.run('selectedSymbol'),'MSFT');assert.equal(m.run('pendingBuySelection'),null);
 await m.run('refreshConfirmedState()');
 assert.equal(formSymbol(m),'MSFT');assert.equal(s.orders.length,0);
});

for(const exit of ['logout','expired session','role switch','bootstrap role switch']){
 test(`RGG-003: ${exit} discards the previous account's pending stock selection`,async()=>{
  const s=bank(),m=await mount(s,{failStateReads:1});
  await m.click('data-buy-symbol','NVDA');assert.ok(m.run('pendingBuySelection'));
  if(exit==='logout')await m.click('data-logout');
  else if(exit==='expired session'){m.setRole(null);await m.run('refreshWhenIdle()');}
  else if(exit==='role switch'){m.setRole('dad');await m.run('refreshWhenIdle()');}
  else{m.setRole('dad');await m.run('boot()');}
  assert.equal(m.run('pendingBuySelection'),null);assert.notEqual(m.run('selectedSymbol'),'NVDA');
  assert.equal(s.orders.length,0);assert.equal(m.posts.length,1);
 });
}

test('RGG-001: both child and parent pending order cards show an escaped reconciliation reason',async()=>{
 const s=bank();coreAction(s,'kid','stock.buy',{symbol:'AAPL',amount:'10'},`reason-order-${++sequence}`);
 s.orders[0].reason='需核对历史成本 <img src=x onerror=alert(1)>';
 const kid=await mount(s);assert.match(kid.root.innerHTML,/需核对历史成本 &lt;img src=x onerror=alert\(1\)&gt;/);
 const dad=await mount(s,{role:'dad'});dad.run("tab='parent';sub.parent='stocks';render()");
 assert.match(dad.root.innerHTML,/需核对历史成本 &lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(dad.root.innerHTML,/<img src=x/);assert.doesNotMatch(kid.root.innerHTML,/<img src=x/);
});
