import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const at=i=>new Date(Date.UTC(2026,0,1+i,12)).toISOString();
async function mount(state=initialState(),role='kid'){
 const handlers={};
 const root={innerHTML:'',addEventListener(type,fn){(handlers[type]??=[]).push(fn);},querySelectorAll(){return [];}};
 const toast={textContent:'',className:''};
 const document={getElementById:id=>id==='root'?root:id==='toast'?toast:null};
 const context=vm.createContext({document,fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(source,context);
 await new Promise(resolve=>setTimeout(resolve,15));
 return {context,root,handlers,run:code=>vm.runInContext(code,context),json:code=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context))};
}

test('records expose all pages of long history, sort stably, clamp after shrinking, and never mutate input',async()=>{
 const m=await mount();
 m.run(`globalThis.rows=${JSON.stringify(Array.from({length:25},(_,i)=>({id:i,at:at(i)})))};recordState('sample').period='all';recordState('ties').period='all';`);
 assert.deepEqual(m.json("recordsPage('sample',rows).items.map(x=>x.id)"),[24,23,22,21,20,19,18,17,16,15]);
 m.run("recordState('sample').page=3");
 assert.deepEqual(m.json("recordsPage('sample',rows).items.map(x=>x.id)"),[4,3,2,1,0]);
 assert.deepEqual(m.json("(()=>{const p=recordsPage('sample',rows);return [p.total,p.pages,p.from,p.to]})()"),[25,3,21,25]);
 assert.deepEqual(m.json("rows.map(x=>x.id)"),Array.from({length:25},(_,i)=>i));
 assert.equal(m.run("recordsPage('sample',rows.slice(0,2)).state.page"),1);
 m.run("recordState('sample').order='oldest'");
 assert.deepEqual(m.json("recordsPage('sample',rows).items.map(x=>x.id)"),[0,1,2,3,4,5,6,7,8,9]);
 assert.deepEqual(m.json("recordsPage('ties',[{id:'a',at:'2026-01-01'},{id:'b',at:'2026-01-01'}]).items.map(x=>x.id)"),['a','b']);
 assert.deepEqual(m.json("(()=>{const p=recordsPage('empty',[]);return [p.total,p.pages,p.from,p.to,p.state.page]})()"),[0,1,0,0,1]);
});

test('record category and local calendar date filters cover 7 days, 30 days and current month',async()=>{
 const m=await mount();
 m.run(`globalThis.options={categories:[['pending','待处理'],['done','已完成']]};globalThis.now=new Date('2026-02-10T12:00:00');globalThis.rows=${JSON.stringify([
  {id:'today',at:'2026-02-10T10:00:00',status:'pending'},
  {id:'boundary7',at:'2026-02-04T00:00:00',status:'done'},
  {id:'eight',at:'2026-02-03T23:59:59',status:'pending'},
  {id:'lastmonth',at:'2026-01-31T20:00:00',status:'done'},
  {id:'boundary30',at:'2026-01-12T00:00:00',status:'pending'},
  {id:'thirtyone',at:'2026-01-11T23:59:59',status:'pending'},
  {id:'future',at:'2026-02-11T00:00:00',status:'pending'},
  {id:'legacy',at:'',status:'pending'},
 ])};`);
 m.run("recordState('dated').period='7'");
 assert.deepEqual(m.json("recordsPage('dated',rows,options,now).items.map(x=>x.id)"),['today','boundary7']);
 m.run("recordState('dated').period='30'");
 assert.deepEqual(m.json("recordsPage('dated',rows,options,now).items.map(x=>x.id)"),['today','boundary7','eight','lastmonth','boundary30']);
 m.run("recordState('dated').period='month'");
 assert.deepEqual(m.json("recordsPage('dated',rows,options,now).items.map(x=>x.id)"),['today','boundary7','eight']);
 m.run("recordState('dated').category='pending'");
 assert.deepEqual(m.json("recordsPage('dated',rows,options,now).items.map(x=>x.id)"),['today','eight']);
 m.run("recordState('dated').period='all';recordState('dated').category='done'");
 assert.deepEqual(m.json("recordsPage('dated',rows,options,now).items.map(x=>x.id)"),['boundary7','lastmonth']);
 m.run("recordState('dated').category='invalid'");
 assert.equal(m.run("recordsPage('dated',rows,options,now).total"),8,'legacy undated records remain accessible in All time');
});

test('shopping, stocks, task proposals and completed tasks have ten-row pages with older records still accessible',async()=>{
 const state=initialState();
 state.purchaseRequests=Array.from({length:35},(_,i)=>({id:'p'+i,name:`PURCHASE-${i}`,status:i%2?'delivered':'pending',amountCents:100,at:at(i)}));
 state.purchaseRequests[33].status='approved'; // Legacy and current purchased states share one category.
 state.orders=Array.from({length:35},(_,i)=>({id:'o'+i,symbol:`ORDER-${i}`,status:'pending',side:'buy',budgetCents:100,targetDate:'2026-03-10',submittedAt:at(i)}));
 state.tasks=Array.from({length:23},(_,i)=>({id:'t'+i,name:`TASK-${i}`,unit:'次',active:true,rewardCents:100,createdAt:at(i)}));
 state.taskProposals=Array.from({length:21},(_,i)=>({id:'tp'+i,name:`PROPOSAL-${i}`,unit:'次',rewardCents:100,status:'approved',at:at(i)}));
 state.taskCompletions=Array.from({length:35},(_,i)=>({id:'tc'+i,taskName:`COMPLETION-${i}`,unit:'次',quantity:1,amountCents:100,status:'approved',at:at(i)}));
 const m=await mount(state);
 m.run("for(const key of ['purchases','orders','task-proposals','task-completions'])recordState(key).period='all'");
 const shopping=m.run('shoppingPanel()');
 assert.equal((shopping.match(/class="row"/g)||[]).length,10);
 assert.match(shopping,/>PURCHASE-34</);assert.doesNotMatch(shopping,/>PURCHASE-24</);
 const bought=m.run("recordState('purchases').category='bought';shoppingPanel()");
 assert.deepEqual({options:(bought.match(/>已购买<\/option>/g)||[]).length,legacy:bought.includes('>PURCHASE-33<'),delivered:bought.includes('>PURCHASE-31<'),pending:bought.includes('>PURCHASE-34<')},{options:1,legacy:true,delivered:true,pending:false});
 m.run("recordState('purchases').category='all';recordState('purchases').page=4");
 const last=m.run('shoppingPanel()');assert.match(last,/>PURCHASE-0</);assert.match(last,/31–35 \/ 35 条/);
 const orders=m.run('ordersCard()');assert.equal((orders.match(/class="row"/g)||[]).length,10);assert.match(orders,/>买入 ORDER-34</);
 m.run("recordState('orders').page=4");assert.match(m.run('ordersCard()'),/>买入 ORDER-0</);
 const tasks=m.run('tasks()');
 assert.equal((tasks.match(/class="task"/g)||[]).length,10);
 assert.equal((tasks.match(/class="row"/g)||[]).length,20);
 assert.match(tasks,/>PROPOSAL-20</);assert.doesNotMatch(tasks,/>PROPOSAL-10</);
 assert.match(tasks,/>COMPLETION-34 ×/);assert.doesNotMatch(tasks,/>COMPLETION-24 ×/);
 m.run("recordState('task-proposals').page=3;recordState('task-completions').page=4;recordState('tasks').page=3");
 const oldest=m.run('tasks()');assert.match(oldest,/>PROPOSAL-0</);assert.match(oldest,/>COMPLETION-0 ×/);assert.match(oldest,/>TASK-0</);
});

test('ledger categories expose retained entries beyond the former 150-row cutoff and escape record names',async()=>{
 const state=initialState();
 state.ledger=Array.from({length:170},(_,i)=>({id:'l'+i,type:i%2?'purchase.approve':'task.earn',deltaCents:i%2?-100:100,cashAfterCents:10000,description:i===169?'<img src=x onerror=alert(1)>':`ENTRY-${i}`,at:at(i)}));
 const m=await mount(state);
 m.run("recordState('ledger').period='all'");
 const html=m.run('history()');assert.match(html,/共 170 条/);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img src=x/);
 m.run("recordState('ledger').page=17");assert.match(m.run('history()'),/>ENTRY-0</);
 m.run("recordState('ledger').category='task';recordState('ledger').page=1");
 const filtered=m.run('history()');assert.match(filtered,/筛选 85 \/ 170 条/);assert.doesNotMatch(filtered,/>ENTRY-167</);assert.match(filtered,/>ENTRY-168</);
});

test('record paging updates one list, keeps surrounding forms intact and resets filters to page one',async()=>{
 const m=await mount();
 const scope={dataset:{recordList:'interactive'},innerHTML:'',querySelectorAll(){return [];},querySelector(){return {focus(){}};}};
 m.root.querySelectorAll=selector=>selector==='[data-record-list]'?[scope]:[];
 m.run(`globalThis.rows=${JSON.stringify(Array.from({length:24},(_,i)=>({id:i,at:at(i),status:i%2?'done':'pending'})))};recordState('interactive').period='all';recordsList('interactive',rows,x=>'<li>'+x.id+'</li>',{label:'测试记录',categories:[['pending','待处理'],['done','已完成']]});`);
 const before=m.root.innerHTML;
 const button={dataset:{recordKey:'interactive',recordPage:'3'},disabled:false};
 for(const handler of m.handlers.click)await handler({target:{closest:selector=>selector==='[data-record-page]'?button:null},preventDefault(){}});
 assert.equal(m.root.innerHTML,before,'root is never rebuilt by list pagination');
 assert.match(scope.innerHTML,/21–24 \/ 24 条/);
 for(const handler of m.handlers.change)await handler({target:{dataset:{recordKey:'interactive',recordFilter:'category'},value:'pending'}});
 assert.equal(m.run("recordState('interactive').page"),1);
 assert.match(scope.innerHTML,/筛选 12 \/ 24 条/);
 assert.match(scope.innerHTML,/1–10 \/ 12 条/);
 assert.equal(m.root.innerHTML,before);
});

test('parent editing and inbox actions stay available after pagination',async()=>{
 const state=initialState();
 state.tasks=Array.from({length:23},(_,i)=>({id:'t'+i,name:'TASK-'+i,unit:'次',active:i%2===0,rewardCents:100,createdAt:at(i)}));
 state.purchaseRequests=Array.from({length:23},(_,i)=>({id:'p'+i,name:'PURCHASE-'+i,amountCents:100,status:'pending',reservedCents:100,at:at(i)}));
 const m=await mount(state,'dad');
 m.run("recordState('parent-tasks').period='all';recordState('inbox-purchases').period='all'");
 assert.equal((m.run('parentTasks()').match(/data-op="task.update"/g)||[]).length,10);
 m.run("recordState('parent-tasks').page=3");assert.match(m.run('parentTasks()'),/name="id" value="t0"/);
 m.run("recordState('parent-tasks').category='paused'");assert.match(m.run('parentTasks()'),/筛选 11 \/ 23 条/);
 assert.equal((m.run('parentInbox()').match(/data-act="purchase.approve"/g)||[]).length,10);
 m.run("recordState('inbox-purchases').page=3");
 const page=m.run('parentInbox()');assert.match(page,/data-act="purchase.approve" data-id="p0"/);assert.match(page,/已预留 O\$ 1\.0(?![\d.])/);
});
