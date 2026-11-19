import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialState, runAction, view } from '../lib/core.mjs';

let nextKey=0;
const act=(s,role,action,payload={},key=`task-v15-${++nextKey}`)=>runAction(s,role,action,payload,key);
const task=(s,name='叠衬衫',amount='2',unit='件')=>{act(s,'dad','task.create',{name,amount,unit});return s.tasks[0];};

test('Dad adds fold-shirt task, Olivia logs 5, Dad acceptance credits O$10 exactly once',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 const t=task(s);assert.equal(t.rewardCents,200);assert.equal(t.unit,'件');
 assert.equal(view(s,'kid').tasks[0].name,'叠衬衫');
 act(s,'kid','task.complete',{id:t.id,quantity:'5',notes:'叠好五件衬衫'});
 const c=s.taskCompletions[0];assert.equal(c.status,'pending');assert.equal(c.amountCents,1000);
 assert.equal(s.cashCents,0);assert.equal(s.ledger.length,0);
 const key='task-v15-special-uuid-123';
 act(s,'dad','task.completion.approve',{id:c.id},key);
 assert.equal(c.status,'approved');assert.equal(s.cashCents,1000);
 assert.equal(view(s,'kid').summary.availableCents,1000);
 assert.equal(s.ledger[0].type,'task.earn');assert.equal(s.ledger[0].deltaCents,1000);
 assert.equal(s.ledger[0].description,'完成任务：叠衬衫 × 5件');
 assert.equal(runAction(s,'dad','task.completion.approve',{id:c.id},key).duplicate,true);
 assert.throws(()=>act(s,'dad','task.completion.approve',{id:c.id}),/已验收/);
 assert.equal(s.cashCents,1000);assert.equal(s.ledger.length,1);
});

test('Olivia can propose task and rate, Dad can approve proposal without immediately paying',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 act(s,'kid','task.propose',{name:'整理书架',unit:'次',amount:'4.5',reason:'想把书摆好'});
 const p=s.taskProposals[0];assert.equal(p.status,'pending');assert.equal(p.rewardCents,450);
 assert.equal(s.tasks.length,0);assert.equal(s.cashCents,0);
 assert.throws(()=>act(s,'kid','task.proposal.approve',{id:p.id}),/家长/);
 act(s,'dad','task.proposal.approve',{id:p.id});
 assert.equal(p.status,'approved');assert.equal(s.tasks[0].name,'整理书架');assert.equal(s.tasks[0].rewardCents,450);
 assert.equal(s.cashCents,0);assert.equal(s.ledger.length,0);
 assert.throws(()=>act(s,'dad','task.proposal.approve',{id:p.id}),/已处理/);
});

test('Dad edits reward and pauses tasks; old submissions lock their earlier rate',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 const t=task(s);
 act(s,'kid','task.complete',{id:t.id,quantity:'3'});const older=s.taskCompletions[0];
 act(s,'dad','task.update',{id:t.id,name:'叠衬衫',unit:'件',amount:'3.5',active:'true'});
 assert.equal(s.tasks[0].rewardCents,350);assert.equal(older.amountCents,600);
 act(s,'kid','task.complete',{id:t.id,quantity:'2'});const newer=s.taskCompletions[0];assert.equal(newer.amountCents,700);
 act(s,'dad','task.update',{id:t.id,name:'叠衬衫',unit:'件',amount:'3.5',active:'false'});
 assert.throws(()=>act(s,'kid','task.complete',{id:t.id,quantity:'1'}),/暂停/);
 act(s,'dad','task.completion.approve',{id:older.id});
 act(s,'dad','task.completion.approve',{id:newer.id});
 assert.equal(s.cashCents,1300);assert.equal(s.ledger.filter(x=>x.type==='task.earn').length,2);
});

test('Rejected task completion / rejected proposed task never credits cash',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 const t=task(s);
 act(s,'kid','task.complete',{id:t.id,quantity:'1'});
 const c=s.taskCompletions[0];act(s,'dad','task.completion.reject',{id:c.id});
 assert.equal(c.status,'rejected');assert.equal(s.cashCents,0);
 assert.throws(()=>act(s,'dad','task.completion.approve',{id:c.id}));
 act(s,'kid','task.propose',{name:'洗碗',unit:'次',amount:'5'});
 const p=s.taskProposals[0];act(s,'dad','task.proposal.reject',{id:p.id});
 assert.equal(p.status,'rejected');assert.equal(s.tasks.length,1);
});

test('Kid cannot create/update/pay tasks; all rewards must use O$0.1 increments; quantity integers',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 assert.throws(()=>act(s,'kid','task.create',{name:'测试任务',unit:'件',amount:'2'}),/家长/);
 assert.throws(()=>act(s,'kid','task.propose',{name:'测试任务',unit:'件',amount:'2.05'}),/0.1/);
 assert.throws(()=>act(s,'kid','task.propose',{name:'测试任务',unit:'件',amount:'0.01'}),/0.1/);
 assert.throws(()=>act(s,'dad','task.create',{name:'测试任务',unit:'件',amount:'2.05'}),/0.1/);
 const t=task(s);
 assert.throws(()=>act(s,'kid','task.update',{id:t.id,name:'任务',unit:'件',amount:'1',active:true}),/家长/);
 assert.throws(()=>act(s,'kid','task.complete',{id:t.id,quantity:'1.5'}),/整数/);
 assert.throws(()=>act(s,'kid','task.complete',{id:t.id,quantity:'501'}),/1到500/);
 act(s,'kid','task.complete',{id:t.id,quantity:'1'});
 assert.throws(()=>act(s,'kid','task.completion.approve',{id:s.taskCompletions[0].id}),/家长/);
 assert.equal(s.cashCents,0);
});

test('Legacy V1.4 accounts without tasks arrays remain valid; tasks initialize on first modification',()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 delete s.tasks;delete s.taskProposals;delete s.taskCompletions;
 const oldView=view(s,'kid');assert.deepEqual(oldView.tasks,[]);assert.deepEqual(oldView.taskProposals,[]);
 act(s,'kid','task.propose',{name:'整理书桌',unit:'次',amount:'2'});
 assert.equal(s.taskProposals.length,1);assert.equal(s.cashCents,0);
});

const appJs=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const asUI=(s,role,tab)=>{
 const root={innerHTML:'',addEventListener:()=>{}};
 const document={getElementById:id=>id==='root'?root:id==='toast'?{textContent:'',className:''}:null};
 const fetch=async()=>new Response(JSON.stringify({initialized:true,role,data:view(s,role)}),{headers:{'content-type':'application/json'}});
 const ctx=vm.createContext({document,fetch,console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(appJs,ctx);
 return new Promise(done=>setTimeout(()=>{vm.runInContext(`tab=${JSON.stringify(tab)};render()`,ctx);done(root.innerHTML);},25));
};

test('Task UI has real forms and dad management; all currency values display with one decimal',async()=>{
 const s=initialState();s.dadHash='test-dad';s.kidHash='test-kid';
 const t=task(s);act(s,'kid','task.complete',{id:t.id,quantity:'3'});
 const kid=await asUI(s,'kid','tasks');
 assert.match(kid,/叠衬衫/);assert.match(kid,/O\$ 2\.0(?![\d.])/);
 assert.match(kid,/data-op="task\.complete"/);assert.match(kid,/data-op="task\.propose"/);
 const available=kid.match(/data-record-list="tasks"[\s\S]*?<\/section>/)?.[0];
 assert.ok(available);assert.doesNotMatch(available,/record-toolbar|data-record-filter/);
 assert.match(available,/<form[^>]*data-op="task\.complete"[^>]*novalidate/);
 assert.match(kid,/等待家长验收/);assert.doesNotMatch(kid,/O\$1 = HK\$1/);assert.doesNotMatch(kid,/data-op="task\.update"/);
 const parent=await asUI(s,'dad','parent');
 assert.match(parent,/data-op="task\.create"/);
 assert.match(parent,/data-op="task\.update"/);
 assert.match(parent,/data-act="task\.completion\.approve"/);
 const home=await asUI(s,'kid','home');
 assert.match(home,/任务赚钱/);assert.match(home,/O\$ 0\.0(?![\d.])/);
 assert.doesNotMatch(home,/O\$ 0\.00/);
});
