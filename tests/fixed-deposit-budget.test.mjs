import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`fixed-ui-v197-${++sequence}`);
function bank(amount='100'){
 const s=initialState();setup(s,'t','t','fixed-budget-parent-password','123456');
 if(Number(amount)>0)act(s,'cash.grant',{amount},'dad');
 return s;
}
async function mount(s){
 const root={innerHTML:'',addEventListener(){},querySelectorAll:()=>[]};
 const toast={textContent:'',className:''};
 const ctx=vm.createContext({document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role:'kid',data:view(s,'kid')})),
  console,setTimeout:()=>0,clearTimeout(){},location:{hostname:'localhost'}});
 vm.runInContext(source,ctx);
 for(let i=0;i<6&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {run:code=>vm.runInContext(code,ctx)};
}

test('fixed deposit cap uses spendable cash after shopping and stock reservations',async()=>{
 const s=bank();act(s,'stock.buy',{symbol:'AAPL',amount:'30'});
 act(s,'purchase.request',{name:'鞋',amount:'60'});
 const m=await mount(s),html=m.run('fixedPanel()');
 assert.match(html,/data-op="fixed\.open" novalidate/);
 assert.match(html,/name="amount"[^>]*max="10\.00" data-budget-amount/);
 assert.match(html,/本次最多<\/span><b class="num">O\$ 10\.0<\/b>/);
 assert.match(html,/已扣除待处理购物和股票买单的预留金额/);
 assert.equal(s.cashCents,10000);
 assert.equal(view(s,'kid').summary.availableCents,1000);

 // A second device can spend while this form is open: the unchanged server
 // guard still rejects the old displayed cap and does not debit any money.
 act(s,'purchase.request',{name:'书',amount:'3'});
 const before=JSON.stringify(s);
 assert.throws(()=>act(s,'fixed.open',{term:3,amount:'10'}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before);
});

test('one-decimal cap never advertises more than the next valid amount step',async()=>{
 const s=bank('12.55'),before=JSON.stringify(s),m=await mount(s);
 // Enter the real stock page, which establishes the initial confirmed selection.
 // A buy card without any selected security must no longer guess a replacement.
 for(const panel of ['fixedPanel()','shoppingPanel()','stocks()']){
  const html=m.run(panel);
  assert.match(html,/name="amount"[^>]*step="0\.1"[^>]*max="12\.55" data-budget-amount/);
  assert.match(html,/本次最多<\/span><b class="num">O\$ 12\.5<\/b>/);
 }
 assert.equal(m.run('money(data.summary.availableCents)'),'O$ 12.6','ordinary balances keep standard display rounding');
 assert.equal(JSON.stringify(s),before,'formatting must not round or rewrite saved cents');
});

test('zero available cash is shown as zero and becomes available after a reservation is released',async()=>{
 const s=bank('20');act(s,'purchase.request',{name:'礼物',amount:'20'});
 const m=await mount(s),empty=m.run('fixedPanel()');
 assert.match(empty,/max="0\.00" data-budget-amount/);
 assert.match(empty,/本次最多<\/span><b class="num">O\$ 0\.0<\/b>/);
 act(s,'purchase.reject',{id:s.purchaseRequests[0].id},'dad');
 m.run(`data=${JSON.stringify(view(s,'kid'))}`);
 const released=m.run('fixedPanel()');
 assert.match(released,/max="20\.00" data-budget-amount/);
 assert.match(released,/本次最多<\/span><b class="num">O\$ 20\.0<\/b>/);
});
