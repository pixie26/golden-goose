import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const NOW='2026-11-18T04:00:00.000Z';
const NativeDate=Date;
const fixedDateClass=iso=>{const now=NativeDate.parse(iso);return class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};};
async function mount(state,role='dad'){
 globalThis.Date=fixedDateClass(NOW); // view() runs server code: keep it on the page's instant
 try{
  const root={innerHTML:'',addEventListener(){},querySelectorAll(){return [];}};
  const toast={textContent:'',className:''};
  const context=vm.createContext({Date:fixedDateClass(NOW),document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
   fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
  vm.runInContext(source,context);
  for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(root.innerHTML,'bootstrap rendered');
  return {run:code=>vm.runInContext(code,context)};
 }finally{globalThis.Date=NativeDate;}
}
let seq=0;const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,'v1910-key-'+(++seq));
const INBOX_KEYS=['inbox-purchases','inbox-returns','inbox-loans','inbox-proposals','inbox-completions'];

// One request of every kind, all submitted on 5 Jan 2026 (more than 30 days before NOW).
function olderPendingRequests(){
 globalThis.Date=fixedDateClass('2026-01-05T02:00:00Z');
 try{
  const s=initialState();setup(s,'t','t','a-strong-local-password','123456');
  act(s,'cash.grant',{amount:'1000'},'dad');
  act(s,'purchase.request',{name:'绘本',amount:'40'});act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
  act(s,'purchase.return.request',{id:s.purchaseRequests[0].id,reason:'重复购买'});
  act(s,'purchase.request',{name:'跳绳',amount:'25'});
  act(s,'loan.request',{amount:'100'});
  act(s,'task.propose',{name:'浇花',unit:'次',amount:'1',reason:'每天浇'});
  act(s,'task.create',{name:'整理书架',unit:'次',amount:'2'},'dad');act(s,'task.complete',{id:s.tasks[0].id,quantity:'2'});
  return s;
 }finally{globalThis.Date=NativeDate;}
}

test('every 待处理 list opens on 全部时间, so requests older than 30 days can be handled straight away',async()=>{
 const s=olderPendingRequests(),before=JSON.stringify(s);
 const m=await mount(s),html=m.run('parentInbox()');
 for(const key of INBOX_KEYS){
  assert.equal(m.run(`recordState('${key}').period`),'all',key);
  assert.match(html,new RegExp(`data-record-key="${key}" data-record-filter="period"[^>]*>[\\s\\S]*?<option value="all" selected>全部时间</option>`),key+' select');
 }
 const ids={purchase:s.purchaseRequests.find(r=>r.status==='pending').id,ret:s.purchaseRequests.find(r=>r.status==='return_pending').id,
  loan:s.loans[0].id,proposal:s.taskProposals[0].id,completion:s.taskCompletions[0].id};
 for(const [action,id] of [['purchase.approve',ids.purchase],['purchase.refund',ids.ret],['loan.approve',ids.loan],['task.proposal.approve',ids.proposal],['task.completion.approve',ids.completion]])
  assert.match(html,new RegExp(`data-act="${action.replace('.','\\.')}" data-id="${id}"`),action);
 assert.doesNotMatch(html,/record-time-hint|当前时间范围内没有记录/);
 assert.equal(JSON.stringify(s),before,'rendering does not touch the ledger');
});

test('待处理 keeps the time filter: an explicit 30-day choice hides older items with a recovery link; bad values fall back to all time',async()=>{
 const m=await mount(olderPendingRequests());
 for(const key of INBOX_KEYS)m.run(`recordState('${key}').period='30'`);
 const recent=m.run('parentInbox()');
 for(const key of INBOX_KEYS)assert.match(recent,new RegExp(`data-record-key="${key}" data-record-all-time`),key);
 assert.doesNotMatch(recent,/data-act="(?:purchase\.approve|purchase\.refund|loan\.approve|task\.proposal\.approve|task\.completion\.approve)"/);
 m.run("recordState('inbox-loans').period='unsupported'");
 assert.equal(m.run("recordsPage('inbox-loans',data.loans.filter(x=>x.status==='pending')).state.period"),'all');
});

test('待处理 paging stays ten per page under all time; Olivia\'s own lists keep their 30-day default',async()=>{
 const s=initialState();setup(s,'t','t','a-strong-local-password','123456');s.cashCents=1000000;
 s.purchaseRequests=Array.from({length:23},(_,i)=>({id:'old-'+i,name:'旧申请-'+i,amountCents:100,reservedCents:100,status:'pending',at:'2026-01-01T00:00:00Z'}));
 const m=await mount(s);
 assert.match(m.run('parentInbox()'),/1–10 \/ 23 条/);
 m.run("recordState('inbox-purchases').page=3");
 const last=m.run('parentInbox()');
 assert.match(last,/21–23 \/ 23 条/);assert.match(last,/data-act="purchase\.approve" data-id="old-22"/);
 const kid=await mount(s,'kid');
 for(const key of ['purchases','orders','ledger','task-proposals','task-completions'])assert.equal(kid.run(`recordState('${key}').period`),'30',key);
});

test('an empty 待处理 page is unchanged',async()=>{
 const s=initialState();setup(s,'t','t','a-strong-local-password','123456');
 assert.match((await mount(s)).run('parentInbox()'),/没有待处理的事项/);
});
