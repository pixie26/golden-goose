import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction as coreAction,view,bankDate} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=(body,status=200)=>Response.json(body,{status});
let sequence=0;
const act=(s,action,payload={},role='kid')=>coreAction(s,role,action,payload,`final-ui-${++sequence}-key`);
function bank(){const s=initialState();setup(s,'t','t','a-strong-parent-password','123456');return s;}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function frozenDate(at){
 const NativeDate=Date,stamp=Date.parse(at);
 return class extends NativeDate{constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}};
}
async function mount(s,{role='dad',onState,DateClass=Date}={}){
 let serverRole=role,stateReads=0;
 const handlers={},intervals=[],confirmations=[],posts=[];
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn)};
 const toast={textContent:'',className:''};
 const document={activeElement:null,visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener(){}};
 const context=vm.createContext({document,console,Date:DateClass,location:{hostname:'localhost'},
  confirm:text=>{confirmations.push(text);return true;},setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},
  FormData:class{constructor(form){this.values=form.formDataEntries();}entries(){return this.values[Symbol.iterator]();}},
  fetch:async(path,options)=>{
   if(path==='/api/bootstrap')return response({initialized:true,role:serverRole,data:serverRole?view(s,serverRole):null});
   if(path==='/api/state'){
    if(onState){const result=await onState(++stateReads);if(result)return result;}
    return serverRole?response(view(s,serverRole)):response({error:'请先登录'},403);
   }
   const body=JSON.parse(options.body);
   if(path==='/api/logout'){serverRole=null;return response({ok:true});}
   if(path==='/api/login'){serverRole=body.role;return response({ok:true,role:serverRole});}
   if(path==='/api/action'){
    posts.push(body);
    if(body.expectedRole!==serverRole)return response({error:'登录账户已切换，请重新登录'},403);
    try{return response(coreAction(s,serverRole,body.action,body.payload,body.idempotencyKey));}
    catch(error){return response({error:error.message},400);}
   }
   throw Error('Unexpected path '+path);
  }});
 vm.runInContext(source,context);
 for(let i=0;i<20&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 const run=code=>vm.runInContext(code,context);
 async function click(attribute,value='',id){
  const key=attribute.replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
  const button={dataset:{[key]:value,...(id?{id}:{})},hasAttribute:name=>name===attribute,closest:()=>null};
  const event={target:{closest:selector=>selector.includes(`[${attribute}]`)?button:null},preventDefault(){}};
  for(const fn of handlers.click||[])await fn(event);
 }
 async function submit(action,values){
  const button={disabled:false,isConnected:true};
  const form={dataset:{op:action},querySelector:()=>button,querySelectorAll:()=>[],formDataEntries:()=>Object.entries(values)};
  for(const fn of handlers.submit||[])await fn({target:{closest:()=>form},preventDefault(){}});
 }
 return {root,toast,context,run,click,submit,intervals,confirmations,posts};
}

for(const nextRole of ['kid','dad'])for(const oldReply of ['snapshot','401','403']){
 test(`an earlier dad ${oldReply} response cannot expire or replace a new ${nextRole} login`,async()=>{
  const s=bank(),oldSnapshot=view(s,'dad'),delayed=deferred();
  const m=await mount(s,{onState:number=>number===1?delayed.promise:null});
  const pending=m.run('refreshWhenIdle()');
  await m.click('data-logout');
  act(s,'cash.grant',{amount:'20'},'dad');
  await m.submit('login',{role:nextRole,password:nextRole==='dad'?'a-strong-parent-password':'123456'});
  assert.equal(m.run('role'),nextRole);
  assert.equal(m.run('data.summary.cashCents'),2000);
  const newPage=m.root.innerHTML;
  delayed.resolve(oldReply==='snapshot'?response(oldSnapshot):response({error:'登录已过期'},Number(oldReply)));
  await pending;
  assert.equal(m.run('role'),nextRole,'the valid new login remains active');
  assert.equal(m.run('data.summary.cashCents'),2000,'the older snapshot is discarded');
  assert.equal(m.root.innerHTML,newPage);
  assert.doesNotMatch(m.root.innerHTML,/data-op="login"/);
 });
}

test('a current-session account mismatch or expiry still returns to login',async()=>{
 for(const reply of [response(view(bank(),'kid')),response({error:'登录已过期'},403)]){
  const m=await mount(bank(),{onState:()=>reply});
  await m.run('refreshWhenIdle()');
  assert.equal(m.run('role'),null);
  assert.match(m.root.innerHTML,/data-op="login"/);
 }
});

test('a matured deposit uses the bank date, confirms principal plus interest, and reports the correct payout',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');act(s,'fixed.open',{amount:'100',term:'3'});
 const f=s.fixed[0],today=bankDate();
 f.start=new Date(Date.parse(today+'T00:00:00Z')-90*86400000).toISOString().slice(0,10);f.maturity=today;
 const m=await mount(s,{role:'kid',DateClass:frozenDate('2000-01-01T00:00:00Z')});
 const html=m.run('fixedPanel()');
 assert.match(html,/已到期，待入账/);assert.match(html,/到期利息/);assert.match(html,/>到期取回<\/button>/);
 assert.doesNotMatch(html,/>提前赎回<\/button>/);
 await m.click('data-act','fixed.redeem',f.id);
 assert.match(m.confirmations[0],/已到期.*本金和利息/);assert.doesNotMatch(m.confirmations[0],/没有利息/);
 assert.equal(f.status,'matured');assert.ok(f.interestCents>0);
 assert.equal(s.cashCents,f.principalCents+f.interestCents);
 assert.match(m.toast.textContent,/已到期.*本金和利息已转回活期/);
});

test('a deposit before its bank maturity date retains the early-redemption warning',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');act(s,'fixed.open',{amount:'100',term:'3'});
 const f=s.fixed[0],m=await mount(s,{role:'kid',DateClass:frozenDate('2099-01-01T00:00:00Z')});
 const html=m.run('fixedPanel()');
 assert.match(html,/预计利息/);assert.match(html,/>提前赎回<\/button>/);assert.doesNotMatch(html,/>到期取回<\/button>/);
 await m.click('data-act','fixed.redeem',f.id);
 assert.match(m.confirmations[0],/提前赎回只退本金，没有利息/);
 assert.equal(f.status,'early');assert.equal(f.interestCents,0);assert.equal(s.cashCents,10000);
 assert.doesNotMatch(m.toast.textContent,/已到期|本金和利息/);
});

test('order controls follow the server eligibility through a same-day Hong Kong close',async()=>{
 const m=await mount(bank(),{DateClass:frozenDate('2026-11-19T08:30:00Z')});
 m.context.serverOrders=[
  {id:'hk-closed',symbol:'0700.HK',side:'buy',budgetCents:1000,status:'pending',targetDate:'2026-11-19',submittedAt:'2026-11-19T02:00:00Z',scheduleBasis:'session-close-v1.2',canCancel:false,canParentCancel:true},
  {id:'us-open',symbol:'AAPL',side:'buy',budgetCents:1000,status:'pending',targetDate:'2026-11-19',submittedAt:'2026-11-19T02:00:00Z',scheduleBasis:'session-close-v1.2',canCancel:true,canParentCancel:false}
 ];
 m.run("data.orders=serverOrders;recordState('orders').period='all'");
 const orders=m.run('ordersCard()'),parent=m.run('parentStocks()');
 assert.doesNotMatch(orders,/data-act="stock.cancel" data-id="hk-closed"/);
 assert.match(orders,/data-act="stock.cancel" data-id="us-open"/);
 assert.match(parent,/data-act="order.cancel" data-id="hk-closed"/,'same-date closed session is immediately manageable');
 assert.doesNotMatch(parent,/data-act="order.cancel" data-id="us-open"/);
 const afterUsClose=await mount(bank(),{DateClass:frozenDate('2026-11-20T00:30:00Z')});
 afterUsClose.context.serverOrders=[{...m.context.serverOrders[1],canCancel:false,canParentCancel:true}];
 afterUsClose.run('data.orders=serverOrders');
 const usParent=afterUsClose.run('parentStocks()');
 assert.match(usParent,/<option value="AAPL" selected>/);
 assert.match(usParent,/name="date"[^>]*value="2026-11-19"/,'manual close defaults to the completed US session, not the following Hong Kong date');
});

test('older snapshots retain the prior cancel behavior and use a Hong Kong maturity-date fallback',async()=>{
 const m=await mount(bank(),{DateClass:frozenDate('2026-11-19T16:30:00Z')});
 m.run(`delete data.bankDate;data.fixed=[{id:'legacy-fixed',term:3,principalCents:10000,rateBps:500,start:'2026-08-20',maturity:'2026-11-20',status:'active'}];data.orders=[{id:'legacy-order',symbol:'0700.HK',side:'buy',budgetCents:1000,status:'pending',targetDate:'2026-11-19',submittedAt:'2026-11-19T02:00:00Z',scheduleBasis:'session-close-v1.2'}];recordState('orders').period='all'`);
 assert.match(m.run('fixedPanel()'),/>到期取回<\/button>/,'fallback uses Hong Kong 20 November, not UTC 19 November');
 assert.match(m.run('ordersCard()'),/data-act="stock.cancel" data-id="legacy-order"/);
 assert.match(m.run('parentStocks()'),/data-act="order.cancel" data-id="legacy-order"/);
});

test('quote labels use the authoritative quote currency without uppercasing subunits',async()=>{
 const m=await mount(bank());
 assert.equal(m.run("quoteText({currency:'GBP',quote:{priceMilli:123450,currency:'GBp'}})"),'123.5 GBp');
 assert.equal(m.run("quoteText({currency:'ZAR',quote:{priceMilli:123450,currency:'ZAc'}})"),'123.5 ZAc');
 assert.equal(m.run("quoteText({currency:'USD',quote:{priceMilli:123450}})"),'123.5 USD');
});
