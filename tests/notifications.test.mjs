import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialState, setup, runAction, view } from '../lib/core.mjs';

let index=0;
const act=(s,role,action,payload={})=>runAction(s,role,action,payload,`notice192-${++index}-request`);
function bank(){const s=initialState();setup(s,'t','t','very-strong-parent-password','123456');return s;}

function noticeList(s){return view(s,'kid').notifications;}

test('approval creates one persistent Olivia-only red-dot message; reading does not modify the cash ledger',()=>{
 const s=bank();
 act(s,'dad','cash.grant',{amount:'200'});
 act(s,'kid','purchase.request',{name:'LEGO 城堡',amount:'60'});
 assert.equal(noticeList(s).length,0, 'submitting a request does not notify about a completed decision');
 const r=s.purchaseRequests[0];
 runAction(s,'dad','purchase.approve',{id:r.id},'approved-idempotency-key');
 assert.equal(s.cashCents,14000);
 assert.equal(noticeList(s).length,1);
 assert.match(noticeList(s)[0].title,/购物申请已完成/);
 assert.match(noticeList(s)[0].detail,/LEGO 城堡/);
 assert.match(noticeList(s)[0].detail,/O\$ 60\.0$/);
 assert.equal(noticeList(s)[0].readAt,null);
 assert.deepEqual(view(s,'dad').notifications,[], 'parent account does not receive child notifications');
 assert.equal(runAction(s,'dad','purchase.approve',{id:r.id},'approved-idempotency-key').duplicate,true);
 assert.equal(noticeList(s).length,1,'repeated idempotency key must not generate another notification');
 assert.throws(()=>act(s,'dad','notifications.read'),/只有 Olivia/);
 const cashBefore=s.cashCents;
 act(s,'kid','notifications.read');
 assert.equal(s.cashCents,cashBefore);
 assert.ok(noticeList(s)[0].readAt);
 const readTime=noticeList(s)[0].readAt;
 act(s,'kid','notifications.read');
 assert.equal(noticeList(s)[0].readAt,readTime,'read receipt is stable');
 act(s,'kid','purchase.request',{name:'画笔',amount:'10'});
 act(s,'dad','purchase.reject',{id:s.purchaseRequests[0].id});
 assert.equal(noticeList(s).length,2);
 assert.equal(noticeList(s)[0].readAt,null);
 assert.equal(noticeList(s)[1].readAt,readTime);
});

test('task approval, rejection and task completion results appear in Olivia inbox',()=>{
 const s=bank();
 act(s,'kid','task.propose',{name:'叠衬衫',unit:'件',amount:'2'});
 act(s,'dad','task.proposal.approve',{id:s.taskProposals[0].id});
 assert.match(noticeList(s)[0].title,/任务提议通过/);
 const task=s.tasks[0];
 act(s,'kid','task.complete',{id:task.id,quantity:'3'});
 act(s,'dad','task.completion.approve',{id:s.taskCompletions[0].id});
 assert.match(noticeList(s)[0].detail,/O\$ 6\.0(?:[^\d.]|$)/);
 assert.doesNotMatch(noticeList(s)[0].detail,/O\$ 6\.00/);
 act(s,'kid','task.complete',{id:task.id,quantity:'1'});
 act(s,'dad','task.completion.reject',{id:s.taskCompletions[0].id});
 assert.equal(noticeList(s)[0].tone,'no');
 act(s,'kid','task.propose',{name:'洗袜子',unit:'次',amount:'3'});
 act(s,'dad','task.proposal.reject',{id:s.taskProposals[0].id});
 assert.match(noticeList(s)[0].title,/任务提议未通过/);
 assert.equal(noticeList(s).length,4);
});

test('loan and final return decisions are notified for separate requests',()=>{
 const s=bank();
 act(s,'dad','cash.grant',{amount:'200'});
 act(s,'kid','loan.request',{amount:'30'});
 act(s,'dad','loan.reject',{id:s.loans[0].id});
 assert.match(noticeList(s)[0].title,/借款申请未通过/);
 act(s,'kid','loan.request',{amount:'20'});
 act(s,'dad','loan.approve',{id:s.loans[0].id});
 assert.match(noticeList(s)[0].title,/借款已批准/);
 act(s,'kid','purchase.request',{name:'书本',amount:'25'});
 act(s,'dad','purchase.approve',{id:s.purchaseRequests[0].id});
 const purchase=s.purchaseRequests[0];
 act(s,'kid','purchase.return.request',{id:purchase.id});
 act(s,'dad','purchase.return.reject',{id:purchase.id});
 assert.match(noticeList(s)[0].title,/退货申请未通过/);
 assert.throws(()=>act(s,'kid','purchase.return.request',{id:purchase.id}),/只能申请退款一次/);
 act(s,'kid','purchase.request',{name:'另一本书',amount:'25.5'});
 const second=s.purchaseRequests[0];act(s,'dad','purchase.approve',{id:second.id});
 act(s,'kid','purchase.return.request',{id:second.id});
 act(s,'dad','purchase.refund',{id:second.id});
 assert.match(noticeList(s)[0].title,/退款已经到账/);
 assert.match(noticeList(s)[0].detail,/O\$ 25\.5/);
});

test('V1.9.1 data without notifications remains readable and is migrated on first decision',()=>{
 const s=bank();delete s.notifications;
 assert.deepEqual(noticeList(s),[]);
 act(s,'dad','cash.grant',{amount:'5'});
 act(s,'kid','purchase.request',{name:'旧数据库测试',amount:'5'});
 act(s,'dad','purchase.reject',{id:s.purchaseRequests[0].id});
 assert.equal(noticeList(s).length,1);
});

test('Olivia UI has notification button and counts unread decisions; Dad retains pending red count',async()=>{
 const s=bank();
 act(s,'dad','cash.grant',{amount:'5'});
 act(s,'kid','purchase.request',{name:'<hello>&" test',amount:'5'});
 act(s,'dad','purchase.reject',{id:s.purchaseRequests[0].id});
 const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 async function screen(role){
  const root={innerHTML:'',addEventListener(){}},toastEl={textContent:'',className:''};
  const document={getElementById:id=>id==='root'?root:id==='toast'?toastEl:null};
  const fetch=async()=>new Response(JSON.stringify({initialized:true,role,data:view(s,role)}),{status:200,headers:{'content-type':'application/json'}});
  vm.runInNewContext(js,{document,fetch,console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
  await new Promise(r=>setTimeout(r,20));return root.innerHTML;
 }
 let html=await screen('kid');
 assert.match(html,/class="notifications"/);
 assert.match(html,/data-notice-toggle/);
 assert.match(html,/class="notice-count"/);
 assert.match(html,/购物申请未通过/);
 assert.match(html,/&lt;hello&gt;&amp;&quot; test/,'user text must not become HTML');
 assert.match(html,/class="notice-item is-unread"/);
 act(s,'kid','notifications.read');
 html=await screen('kid');
 assert.doesNotMatch(html,/class="notice-count"/);
 assert.doesNotMatch(html,/class="notice-item is-unread"/);
 assert.match(html,/购物申请未通过/,'notification history must remain visible after reading');
 html=await screen('dad');
 assert.doesNotMatch(html,/class="notifications"/);
 assert.match(html,/家长后台/);
});
