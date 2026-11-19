import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

// Amounts are shown with one decimal. Loans are borrowed and repaid in O$0.1 units; a debt is
// shown rounded up, and paying that shown amount charges only the exact due. Nothing is ever
// waived, so typing less never clears a debt. Every "可用" figure is rounded down.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`loan-rounding-${++sequence}`);
// Cash plus an approved O$100 loan with O$3.474 interest accrued: exact due O$103.47, shown O$103.5.
function borrowed(cash='1000',interestMicroCents=347_400_000){
 const s=initialState();setup(s,'t','t','loan-rounding-parent-password','123456');
 if(Number(cash)>0)act(s,'cash.grant',{amount:cash},'dad');act(s,'loan.request',{amount:'100'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 const l=s.loans[0];l.interestMicroCents=interestMicroCents;return {s,l,cash:s.cashCents};
}
async function mount(s){
 const root={innerHTML:'',addEventListener(){},querySelectorAll:()=>[]};
 const ctx=vm.createContext({document:{getElementById:id=>id==='root'?root:id==='toast'?{textContent:'',className:''}:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role:'kid',data:view(s,'kid')})),
  console,setTimeout:()=>0,clearTimeout(){},location:{hostname:'localhost'}});
 vm.runInContext(source,ctx);
 for(let i=0;i<6&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return code=>vm.runInContext(code,ctx);
}

test('paying the shown amount (due rounded up to O$0.1) settles and charges only the exact due',()=>{
 const {s,l,cash}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.5'});
 assert.equal(l.status,'repaid');assert.equal(l.principalCents,0);assert.equal(l.interestMicroCents,0);
 assert.equal(s.cashCents,cash-10347);assert.equal(s.ledger[0].deltaCents,-10347);
});

test('repayments must be whole O$0.1 units and cannot exceed the shown due',()=>{
 const {s,l}=borrowed(),before=JSON.stringify(s);
 for(const amount of ['103.47','103.45','0.01'])assert.throws(()=>act(s,'loan.repay',{id:l.id,amount}),/还款金额以 O\$ 0\.1 为单位/);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'103.6'}),/还款不能超过应还金额/);
 assert.equal(JSON.stringify(s),before);
});

test('paying less never waives the remainder: it stays owed and the next O$0.1 clears it exactly',()=>{
 const {s,l,cash}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.4'});
 assert.equal(l.status,'active');assert.equal(l.principalCents,7);assert.equal(l.waivedCents,undefined);
 assert.match(s.ledger[0].description,/利息 O\$ 3\.5/,'interest is still paid first');
 act(s,'loan.repay',{id:l.id,amount:'0.1'});
 assert.equal(l.status,'repaid');assert.equal(s.cashCents,cash-10347,'exactly the due in total: nothing waived, nothing extra');
});

test('"全部还清" with enough cash pays the exact due',()=>{
 const {s,l,cash}=borrowed();act(s,'loan.repay',{id:l.id,all:true});
 assert.equal(l.status,'repaid');assert.equal(s.cashCents,cash-10347);assert.equal(l.waivedCents,undefined);
});

test('all free cash short of the due by under O$0.1 clears the loan, by "全部还清" or by typing the shown due',()=>{
 for(const payload of [{all:true},{amount:'103.5'}]){
  const {s,l}=borrowed('3.42');// cash O$103.42, nothing held; due O$103.47
  act(s,'loan.repay',{id:l.id,...payload});
  assert.equal(l.status,'repaid');assert.equal(l.principalCents,0);assert.equal(l.waivedCents,5);
  assert.equal(s.cashCents,0,'every free cent is used');assert.equal(s.ledger[0].deltaCents,-10342);
  assert.match(s.ledger[0].description,/差额不足 O\$ 0\.1 免还/);
  assert.match(s.audit.find(x=>x.type==='loan.waive').summary,/差额 5 分免还/);
 }
});

test('a shortfall of O$0.1 or more still needs cash',()=>{
 const {s,l}=borrowed('3.37'),before=JSON.stringify(s);// cash O$103.37; due O$103.47
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/可用余额不足/);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'103.5'}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before);
});

test('no shortfall settlement while any cash is held, so a hold cannot be used to shave the debt',()=>{
 const {s,l}=borrowed('13.42');// cash O$113.42
 act(s,'purchase.request',{name:'书',amount:'10'});// O$10 held: O$103.42 free, due O$103.47
 const before=JSON.stringify(s);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/可用余额不足/);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'103.5'}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before);
});

test('paying part of the due is never waived, even when it leaves less than O$0.1',()=>{
 const {s,l}=borrowed('3.42');
 act(s,'loan.repay',{id:l.id,amount:'103.4'});// O$0.02 left in cash, O$0.07 owed
 assert.equal(l.status,'active');assert.equal(l.principalCents,7);assert.equal(l.waivedCents,undefined);
 act(s,'loan.repay',{id:l.id,amount:'0.1'});// the shown due again: all free cash, short by O$0.05
 assert.equal(l.status,'repaid');assert.equal(l.waivedCents,5);assert.equal(s.cashCents,0);
});

test('a legacy remainder under O$0.1 needs cash and is cleared by one O$0.1 repayment',()=>{
 const {s,l}=borrowed('0',0);// cash O$100.0, all from the loan
 act(s,'purchase.request',{name:'玩具',amount:'100'});// reserves every cent
 l.principalCents=4;// left by an earlier version
 const before=JSON.stringify(s);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/可用余额不足/);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'0.1'}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before,'no debt is cleared without paying it');
 act(s,'purchase.reject',{id:s.purchaseRequests[0].id},'dad');
 act(s,'loan.repay',{id:l.id,amount:'0.1'});
 assert.equal(l.status,'repaid');assert.equal(s.cashCents,9996);
});

test('loan requests must be whole O$0.1 units',()=>{
 const s=initialState();setup(s,'t','t','loan-rounding-parent-password','123456');
 for(const amount of ['0.05','45.55'])assert.throws(()=>act(s,'loan.request',{amount}),/借款金额以 O\$ 0\.1 为单位/);
 assert.equal(s.loans.length,0);
 act(s,'loan.request',{amount:'45.5'});assert.equal(s.loans[0].requestedCents,4550);
});

test('every "可用" figure is rounded down to O$0.1; other balances keep standard rounding',async()=>{
 const s=initialState();setup(s,'t','t','loan-rounding-parent-password','123456');act(s,'cash.grant',{amount:'99.99'},'dad');
 const run=await mount(s);
 assert.match(run("pageHead('定期','bank')"),/可用 <b class="num">O\$ 99\.9<\/b>/);
 assert.match(run('heroBanner()'),/净资产 · 可用 <b class="num">O\$ 99\.9<\/b>/);
 const assets=run('assetsCard()');
 assert.match(assets,/现在可用<\/span><b class="num pinktext">O\$ 99\.9<\/b>/);
 assert.match(assets,/活期账户<\/span><b class="num">O\$ 100\.0<\/b>/,'cash balance is not a spending limit');
 assert.match(run('fixedPanel()'),/本次最多<\/span><b class="num">O\$ 99\.9<\/b>/);
});

test('loan rows show the due rounded up, and the repay field takes that amount in O$0.1 steps',async()=>{
 for(const [interest,shown] of [[347_400_000,'103\\.5'],[341_000_000,'103\\.5'],[340_000_000,'103\\.4']]){
  const run=await mount(borrowed('1000',interest).s),html=run('loanPanel()');
  assert.match(html,new RegExp(`<b class="num neg">O\\$ ${shown}</b>`));
  assert.match(html,new RegExp(`name="amount"[^>]*min="0\\.1" step="0\\.1" max="${shown}0"`));
  assert.match(run('assetsCard()'),new RegExp(`欠家长</span><b class="num neg">−O\\$ ${shown}</b>`));
 }
});

test('the loan row explains the shortfall settlement only when it applies',async()=>{
 const hint=/用掉全部可用余额并结清/;
 assert.match((await mount(borrowed('3.42').s))('loanPanel()'),hint);
 assert.doesNotMatch((await mount(borrowed('3.37').s))('loanPanel()'),hint,'short by O$0.1 or more');
 assert.doesNotMatch((await mount(borrowed().s))('loanPanel()'),hint,'enough cash');
 const held=borrowed('13.42').s;act(held,'purchase.request',{name:'书',amount:'10'});
 assert.doesNotMatch((await mount(held))('loanPanel()'),hint,'cash on hold');
});

test('the loan request field uses O$0.1 steps and hides when less than O$0.1 can be borrowed',async()=>{
 const s=initialState();setup(s,'t','t','loan-rounding-parent-password','123456');
 s.loans=[{id:'L1',principalCents:49995,requestedCents:49995,interestMicroCents:0,aprBps:0,status:'active',createdAt:'2026-11-01T00:00:00Z',lastAccruedDay:'2026-11-18'}];
 const html=(await mount(s))('loanPanel()');// O$0.05 of the O$500 limit left
 assert.doesNotMatch(html,/data-op="loan\.request"/);assert.match(html,/当前没有可申请的额度/);
});
