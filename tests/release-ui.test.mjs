import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {initialState,setup,runAction as coreAction,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
let sequence=0;
const act=(s,action,payload={},role='kid')=>coreAction(s,role,action,payload,`release-ui-${++sequence}`);
function bank(){const s=initialState();setup(s,'t','t','a-strong-parent-password','123456');return s;}
function storage(){
 const entries=new Map();
 return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key),entries};
}
async function mount(state,{role='kid',sessionStorage=storage(),fetchImpl}={}){
 const handlers={},intervals=[],posts=[],reads=[],timers=new Map();let timerId=0;
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn)};
 const toast={textContent:'',className:''};
 const document={activeElement:null,visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener(){}};
 const context=vm.createContext({document,sessionStorage,console,crypto:webcrypto,TextEncoder,AbortController,location:{hostname:'localhost'},confirm:()=>true,
  setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:fn=>{intervals.push(fn);return intervals.length;},
  FormData:class{constructor(form){this.rows=form.formDataEntries();}entries(){return this.rows[Symbol.iterator]();}},
  fetch:async(path,options)=>{
   if(path==='/api/bootstrap')return response({initialized:true,role,data:view(state,role)});
   const body=options?.body?JSON.parse(options.body):null;
   if(body)posts.push(body);else reads.push(path);
   if(fetchImpl)return fetchImpl(path,options,body);
   return response(view(state,role));
  }});
 vm.runInContext(source,context);
 for(let i=0;i<20&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {root,document,toast,sessionStorage,context,handlers,intervals,posts,reads,timers,run:code=>vm.runInContext(code,context)};
}

test('idle polling shows new, repriced and paused tasks even without a balance or notification change',async()=>{
 const s=bank(),m=await mount(s);
 m.run("tab='tasks';render()");
 assert.doesNotMatch(m.root.innerHTML,/擦客厅玻璃/);
 act(s,'task.create',{name:'擦客厅玻璃',unit:'次',amount:'2'},'dad');
 await m.intervals[0]();
 assert.match(m.root.innerHTML,/擦客厅玻璃/);
 assert.equal(s.cashCents,0);assert.equal(s.notifications.length,0);
 act(s,'task.update',{id:s.tasks[0].id,name:'擦客厅玻璃',unit:'次',amount:'3',active:'true'},'dad');
 await m.intervals[0]();
 assert.match(m.root.innerHTML,/每次 O\$ 3\.0/);
 act(s,'task.update',{id:s.tasks[0].id,name:'擦客厅玻璃',unit:'次',amount:'3',active:'false'},'dad');
 await m.intervals[0]();
 assert.doesNotMatch(m.root.innerHTML,/擦客厅玻璃/);
});

test('idle polling refreshes unheld watchlist quotes and fixed rates without changing the balance',async()=>{
 const s=bank();s.watchlist=['AAPL'];
 const m=await mount(s);
 s.quotes['AAPL|2026-11-17']={symbol:'AAPL',date:'2026-11-17',priceMilli:250500,currency:'USD'};
 await m.intervals[0]();
 assert.match(m.root.innerHTML,/250\.5 USD/);
 m.run("tab='account';sub.account='fixed';render()");
 act(s,'settings.update',{rate3:'6.5'},'dad');
 await m.intervals[0]();
 assert.match(m.root.innerHTML,/<em>6\.5%<\/em>/);
 assert.equal(s.cashCents,0);
 // An identical response does not rebuild the page or disturb disclosures.
 m.root.innerHTML='preserved DOM';
 await m.intervals[0]();
 assert.equal(m.root.innerHTML,'preserved DOM');
});

test('background refresh protects a focused input before the first keystroke and while the read is in flight',async()=>{
 const s=bank(),m=await mount(s);
 m.document.activeElement={closest:()=>({dataset:{op:'wish.add'}})};
 await m.intervals[0]();await m.run('refreshWhenIdle()');
 assert.equal(m.reads.length,0,'focus alone protects the input');
 m.document.activeElement={id:'stock-search-field',closest:()=>null};
 await m.intervals[0]();assert.equal(m.reads.length,0,'stock search focus is preserved too');
 let release;
 const inFlight=await mount(s,{fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
 const pending=inFlight.intervals[0]();
 inFlight.document.activeElement={closest:()=>({dataset:{op:'purchase.request'}})};
 inFlight.root.innerHTML='focused purchase form';
 act(s,'task.create',{name:'新增任务',unit:'次',amount:'2'},'dad');
 release(response(view(s,'kid')));await pending;
 assert.equal(inFlight.root.innerHTML,'focused purchase form');
});

test('a timed-out financial submit releases the busy UI and retries the same key without a second credit',{timeout:10000},async()=>{
 const s=bank();let attempts=0,submitStarted;
 const started=new Promise(resolve=>{submitStarted=resolve;});
 const m=await mount(s,{role:'dad',fetchImpl:(path,options,body)=>{
  if(path==='/api/action'){
   const result=coreAction(s,'dad',body.action,body.payload,body.idempotencyKey);
   if(++attempts===1){submitStarted();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));}
   return response(result);
  }
  return response(view(s,'dad'));
 }});
 const button={disabled:false,isConnected:true};
 const form={dataset:{op:'cash.grant'},querySelector:()=>button,formDataEntries:()=>[['amount','20'],['note','零花钱']]};
 const submit=m.handlers.submit[0]({target:{closest:()=>form},preventDefault(){}});
 await started;
 assert.equal(m.posts.length,1);assert.equal(m.posts[0].expectedRole,'dad');assert.equal(m.run('busy'),true);
 const timeout=[...m.timers.values()].find(x=>x.ms===45000);assert.ok(timeout);timeout.fn();await submit;
 assert.equal(m.run('busy'),false);assert.equal(button.disabled,false);
 assert.match(m.toast.textContent,/连接超时.*尚未确认操作结果/);
 await m.run("runAction('cash.grant',{amount:'20',note:'零花钱'})");
 assert.equal(m.posts[0].idempotencyKey,m.posts[1].idempotencyKey);
 assert.equal(s.cashCents,2000);assert.equal(s.ledger.length,1);
});

test('an unconfirmed mutation survives same-tab reload using a payload-free fingerprint; acknowledged repeats get new keys',async()=>{
 const s=bank(),saved=storage(),payload={amount:'20',note:'生日零花钱'};
 const first=await mount(s,{role:'dad',sessionStorage:saved,fetchImpl:(path,options,body)=>{
  if(path==='/api/action'){coreAction(s,'dad',body.action,body.payload,body.idempotencyKey);throw new TypeError('Response lost after commit');}
  return response(view(s,'dad'));
 }});
 await assert.rejects(first.run(`runAction('cash.grant',${JSON.stringify(payload)})`),/Response lost/);
 const serialized=JSON.stringify([...saved.entries]);
 assert.doesNotMatch(serialized,/生日零花钱|cash\.grant|"amount"|"note"|password|123456/);
 assert.equal(saved.entries.size,1);
 const second=await mount(s,{role:'dad',sessionStorage:saved,fetchImpl:(path,options,body)=>path==='/api/action'?response(coreAction(s,'dad',body.action,body.payload,body.idempotencyKey)):response(view(s,'dad'))});
 let result=await second.run(`runAction('cash.grant',${JSON.stringify(payload)})`);
 assert.equal(result.duplicate,true);assert.equal(first.posts[0].idempotencyKey,second.posts[0].idempotencyKey);
 assert.equal(s.cashCents,2000);assert.equal(saved.entries.size,0,'success removes recovery data before the follow-up read');
 result=await second.run(`runAction('cash.grant',${JSON.stringify(payload)})`);
 assert.notEqual(result.duplicate,true);assert.notEqual(second.posts[0].idempotencyKey,second.posts[1].idempotencyKey);
 assert.equal(s.cashCents,4000,'a later intentional equal-value grant is accepted');
});

test('credential actions are never persisted, and explicit logout removes outstanding recovery keys',async()=>{
 const s=bank(),saved=storage();
 const m=await mount(s,{role:'dad',sessionStorage:saved,fetchImpl:path=>path==='/api/logout'?response({ok:true}):Promise.reject(new TypeError('offline'))});
 await assert.rejects(m.run("runAction('pin.change',{pin:'87654321'})"),/offline/);
 assert.equal(saved.entries.size,0);
 await assert.rejects(m.run("runAction('password.change',{oldPassword:'secret-before',newPassword:'secret-after'})"),/offline/);
 assert.equal(saved.entries.size,0);
 await assert.rejects(m.run("runAction('cash.grant',{amount:'30'})"),/offline/);
 assert.equal(saved.entries.size,1);
 const logout={dataset:{},hasAttribute:name=>name==='data-logout'};
 for(const fn of m.handlers.click)await fn({target:{closest:selector=>selector.includes('[data-logout]')?logout:null},preventDefault(){}});
 assert.equal(saved.entries.size,0);assert.equal(m.run('role'),null);
});


test('shared-cookie account switches return to login without applying another role or losing role-scoped recovery keys',async()=>{
 const s=bank(),saved=storage();let switched=false;
 const m=await mount(s,{role:'dad',sessionStorage:saved,fetchImpl:(path,options,body)=>{
  if(path==='/api/action')return Promise.reject(new TypeError('Response uncertain'));
  return response(view(s,switched?'kid':'dad'));
 }});
 await assert.rejects(m.run("runAction('cash.grant',{amount:'40'})"),/Response uncertain/);
 assert.equal(m.posts[0].expectedRole,'dad');assert.equal(saved.entries.size,1);
 switched=true;await m.intervals[0]();
 assert.equal(m.run('role'),null);assert.equal(m.run('data'),null);
 assert.match(m.root.innerHTML,/data-op="login"/);
 assert.equal(saved.entries.size,1,'the old role can safely recover its outstanding request after reauthentication');
});

test('a role-change rejection during a mutation returns to login and retains the unconfirmed request key',async()=>{
 const s=bank(),saved=storage();
 const m=await mount(s,{role:'dad',sessionStorage:saved,fetchImpl:()=>response({error:'登录账户已切换，请重新登录'},403)});
 await assert.rejects(m.run("runAction('fixed.open',{amount:'10',term:'3'})"),/登录账户已切换/);
 assert.equal(m.posts[0].expectedRole,'dad');assert.equal(m.run('role'),null);
 assert.match(m.root.innerHTML,/data-op="login"/);assert.equal(saved.entries.size,1);
});
