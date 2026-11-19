import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

// Plain, non-repeating wording a child can follow, with numbers that agree with each other.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`copy-clarity-${++sequence}`);
function bank(){const s=initialState();setup(s,'t','t','copy-clarity-parent-password','123456');return s;}
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

test('ledger lines use plain words, including lines saved by earlier versions',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');
 act(s,'purchase.request',{name:'贴纸本',amount:'5'});act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
 act(s,'loan.request',{amount:'10'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 act(s,'fixed.open',{term:3,amount:'10'});act(s,'fixed.redeem',{id:s.fixed[0].id});
 assert.deepEqual(s.ledger.slice(0,4).map(x=>x.description),['提前取出3个月定期（无利息）','开立3个月定期','向家长借钱','购买：贴纸本']);
 s.ledger.unshift({...s.ledger[0],id:'old-1',description:'提前赎回6个月定期（无利息）'},{...s.ledger[0],id:'old-2',description:'向家长借钱（本金为负债）'},{...s.ledger[0],id:'old-3',description:'确认购买并交付：彩色笔'});
 const run=await mount(s),history=run('history()');
 for(const text of ['提前取出6个月定期（无利息）','向家长借钱<','购买：彩色笔'])assert.ok(history.includes(text),text);
 for(const text of ['本金为负债','确认购买并交付','赎回'])assert.ok(!history.includes(text),text);
 assert.match(run('recentCard()'),/购买：彩色笔/);
 assert.equal(s.ledger.find(x=>x.id==='old-3').description,'确认购买并交付：彩色笔','saved records are not rewritten');
});

test('a loan row\'s principal and interest add up to the due shown, and the account page agrees',async()=>{
 const s=bank();act(s,'loan.request',{amount:'40'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 s.loans[0].interestMicroCents=1_230_000;// O$0.0123: due O$40.01, shown O$40.1
 let run=await mount(s),loan=run('loanPanel()');
 assert.match(loan,/利息 O\$ 0\.1<\/span>/);assert.doesNotMatch(loan,/<span class="nw">(还剩)?本金 O\$/,'principal equals the amount borrowed, so it is not repeated');
 assert.match(loan,/<b class="num neg">O\$ 40\.1<\/b>/);
 assert.match(run('account()'),/欠家长<\/span><b class="num neg">O\$ 40\.1<\/b>|欠家长[\s\S]{0,80}O\$ 40\.1/);
 act(s,'cash.grant',{amount:'100'},'dad');act(s,'loan.repay',{id:s.loans[0].id,amount:'10.5'});// interest first, then principal
 const l=s.loans[0];assert.equal(l.principalCents,2951);
 run=await mount(s);loan=run('loanPanel()');
 assert.match(loan,/还剩本金 O\$ 29\.5<\/span> · <span class="nw">利息 O\$ 0\.1<\/span>/);
 assert.match(loan,/<b class="num neg">O\$ 29\.6<\/b>/,'29.5 + 0.1 = 29.6 shown; exact due 29.51');
});

test('lists show page controls only when there is more than one page',async()=>{
 const s=bank();for(let i=0;i<10;i++)act(s,'cash.grant',{amount:'1'},'dad');
 let run=await mount(s);
 assert.doesNotMatch(run('history()'),/record-pagination/);assert.match(run('history()'),/共 10 条/);
 act(s,'cash.grant',{amount:'1'},'dad');run=await mount(s);
 assert.match(run('history()'),/record-pagination[\s\S]*1–10 \/ 11 条[\s\S]*1 \/ 2/);
});

test('budget, shopping, wish and stock texts are short and say each thing once',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'50'},'dad');act(s,'purchase.request',{name:'书',amount:'10'});act(s,'wish.add',{name:'绘本',amount:'20'});
 const run=await mount(s),shopping=run('shoppingPanel()');
 assert.doesNotMatch(shopping,/已扣除待处理/);assert.match(shopping,/买到后 7 天内可以申请退款，每笔只能申请一次。/);assert.match(shopping,/家长买好才扣钱，不同意就把钱还给你/);
 assert.match(run('account()'),/购物 O\$ 10\.0 · 股票买单 O\$ 0\.0 正在等待处理，这部分钱暂时不能用。/);
 const wishes=run('wishes()');
 assert.match(wishes,/钱够啦！/);assert.doesNotMatch(wishes,/可以申请购买！|一键/);
 const fixed=run('fixedPanel()');
 assert.match(fixed,/提前取出只拿回本金，没有利息/);assert.doesNotMatch(fixed,/赎回|连本带息/);
 const stocks=run("tab='stocks';render();document.getElementById('root').innerHTML");
 for(const jargon of ['未实现','不含股息','停牌','目标交易日','释放预留'])assert.ok(!stocks.includes(jargon),jargon);
});
