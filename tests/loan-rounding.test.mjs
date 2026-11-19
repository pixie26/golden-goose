import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

// Amounts are shown with one decimal. Loan repayment ignores differences under O$0.1,
// and every "可用" figure is rounded down, so a shown amount can always be paid or spent.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`loan-rounding-${++sequence}`);
// Cash O$1,000 plus an approved O$100 loan with O$3.474 interest accrued: exact due O$103.47, shown O$103.5.
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

test('paying the shown amount that rounded up settles the loan and charges only the exact due',()=>{
 const {s,l,cash}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.5'});
 assert.equal(l.status,'repaid');assert.equal(l.principalCents,0);assert.equal(l.interestMicroCents,0);
 assert.equal(s.cashCents,cash-10347);assert.equal(s.ledger[0].deltaCents,-10347);
 assert.equal(l.waivedCents,undefined,'nothing is waived when the full due is paid');
});

test('overpaying by O$0.1 or more is still rejected without changing the ledger',()=>{
 const {s,l}=borrowed(),before=JSON.stringify(s);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'103.57'}),/还款不能超过应还金额/);
 assert.equal(JSON.stringify(s),before);
});

test('a remainder under O$0.1 is waived, recorded and audited',()=>{
 const {s,l,cash}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.4'});
 assert.equal(l.status,'repaid');assert.equal(l.principalCents,0);assert.equal(l.waivedCents,7);
 assert.equal(s.cashCents,cash-10340,'only the amount actually paid leaves cash');
 assert.match(s.ledger[0].description,/余下不足 O\$ 0\.1 免还/);
 const waive=s.audit.find(x=>x.type==='loan.waive');assert.ok(waive);assert.match(waive.summary,/7 分/);
 assert.equal(view(s,'kid').summary.loanPrincipalCents,0);
});

test('a remainder of exactly O$0.1 is not waived and keeps accruing as an active loan',()=>{
 const {s,l,cash}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.37'});
 assert.equal(l.status,'active');assert.equal(l.principalCents,10);assert.equal(l.waivedCents,undefined);
 assert.equal(s.cashCents,cash-10337);
});

test('interest is still paid before principal when a partial repayment is waived',()=>{
 const {s,l}=borrowed();
 act(s,'loan.repay',{id:l.id,amount:'103.45'});
 assert.match(s.ledger[0].description,/利息 O\$ 3\.5/);assert.equal(l.waivedCents,2);
});

test('"全部还清" pays what is available when the shortfall is under O$0.1',()=>{
 const {s,l}=borrowed('3.42');// cash O$103.42 after the loan; due O$103.47
 act(s,'loan.repay',{id:l.id,all:true});
 assert.equal(l.status,'repaid');assert.equal(l.waivedCents,5);assert.equal(s.cashCents,0);
});

test('"全部还清" still requires cash when the shortfall is O$0.1 or more',()=>{
 const {s,l}=borrowed('3.37'),before=JSON.stringify(s);// cash O$103.37; due O$103.47
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before);
});

test('a legacy remainder under O$0.1 needs some cash and closes on the next repayment',()=>{
 const {s,l}=borrowed('0',0);// cash O$100.0, all from the loan
 act(s,'purchase.request',{name:'玩具',amount:'100'});// reserves every cent
 l.principalCents=4;// left by an earlier version
 const before=JSON.stringify(s);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/可用余额不足/);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,amount:'0.01'}),/可用余额不足/);
 assert.equal(JSON.stringify(s),before,'no debt is cleared without paying something');
 act(s,'purchase.reject',{id:s.purchaseRequests[0].id},'dad');
 act(s,'loan.repay',{id:l.id,amount:'0.01'});
 assert.equal(l.status,'repaid');assert.equal(l.waivedCents,3);assert.equal(s.cashCents,9999);
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

test('the repay field accepts the shown due whether it rounded up or down',async()=>{
 const up=borrowed().s;// due O$103.47 shown O$103.5
 assert.match((await mount(up))('loanPanel()'),/name="amount"[^>]*step="0\.01" max="103\.50"/);
 const down=borrowed('1000',341_000_000).s;// due O$103.41 shown O$103.4
 assert.match((await mount(down))('loanPanel()'),/name="amount"[^>]*step="0\.01" max="103\.41"/);
});
