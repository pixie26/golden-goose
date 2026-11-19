import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
let seq=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`wish-ui-v193-${++seq}`);
function bank(amount='162'){
 const s=initialState();setup(s,'fixture','fixture','test-parent-password-193','123456');
 if(Number(amount)>0)act(s,'cash.grant',{amount},'dad');
 return s;
}
async function mount(s,role='kid'){
 const root={innerHTML:'',addEventListener(){},querySelectorAll:()=>[]};
 const toast={textContent:'',className:''};
 const ctx=vm.createContext({document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(s,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(source,ctx);await new Promise(r=>setTimeout(r,15));
 return {root,ctx,html(code="tab='wishes';render()"){vm.runInContext(code,ctx);return root.innerHTML;}};
}

test('screenshot case: one-character wish offers one-click purchase and keeps progress after funds are reserved',async()=>{
 const s=bank();act(s,'wish.add',{name:'鞋',amount:'123'});const wish=s.wishes[0];
 let m=await mount(s),html=m.html();
 assert.match(html,/class="wish-name">鞋<\/b>/);
 assert.match(html,/data-act="wish.purchase"/);
 assert.match(html,/一键申请购买/);
 assert.match(m.html("tab='home';render()"),/data-act="wish.purchase"/);
 act(s,'wish.purchase',{id:wish.id});
 assert.equal(view(s,'kid').summary.availableCents,3900);
 m=await mount(s);html=m.html();
 assert.match(html,/等待家长确认/);
 assert.match(html,/金额已预留/);
 assert.match(html,/100%/);
 assert.doesNotMatch(html,/data-act="wish.purchase"/);
 assert.match(html,/查看购买记录/);
 vm.runInContext("Object.assign(recordState('purchases'),{category:'rejected',period:'7',page:5});openPurchaseRecord(data.purchaseRequests[0].id)",m.ctx);
 assert.equal(vm.runInContext('tab',m.ctx),'account');
 assert.equal(vm.runInContext('sub.account',m.ctx),'shopping');
 assert.equal(vm.runInContext("recordState('purchases').category",m.ctx),'all');
 assert.equal(vm.runInContext("recordState('purchases').period",m.ctx),'all');
 assert.match(m.root.innerHTML,/来自心愿/);
 act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
 m=await mount(s);html=m.html();
 assert.match(html,/心愿已实现/);
 assert.doesNotMatch(html,/data-act="wish.purchase"/);
 assert.equal(view(s,'kid').summary.availableCents,3900);
});

test('unfunded wishes cannot be applied for; parent cannot submit from a wish; rejected and refunded wishes can retry',async()=>{
 const s=bank('20');act(s,'wish.add',{name:'书',amount:'21'});
 let m=await mount(s),html=m.html();
 assert.match(html,/还差 O\$ 1\.0(?![\d.])/);
 assert.match(html,/disabled>攒够后申请购买/);
 assert.doesNotMatch(html,/data-act="wish.purchase"/);
 act(s,'cash.grant',{amount:'1'},'dad');
 m=await mount(s,'dad');assert.doesNotMatch(m.html(),/data-act="wish.purchase"/);
 act(s,'wish.purchase',{id:s.wishes[0].id});
 act(s,'purchase.reject',{id:s.purchaseRequests[0].id},'dad');
 m=await mount(s);html=m.html();
 assert.match(html,/上次申请未通过/);assert.match(html,/data-act="wish.purchase"/);
 act(s,'wish.purchase',{id:s.wishes[0].id});
 act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
 act(s,'purchase.return.request',{id:s.purchaseRequests[0].id});
 act(s,'purchase.refund',{id:s.purchaseRequests[0].id},'dad');
 m=await mount(s);html=m.html();
 assert.match(html,/上次购买已退款/);assert.match(html,/data-act="wish.purchase"/);
});

test('shopping and stock forms show and enforce the same remaining cash after both kinds of hold',async()=>{
 const s=bank('200');act(s,'purchase.request',{name:'鞋',amount:'123'});act(s,'stock.buy',{symbol:'AAPL',amount:'50'});
 const m=await mount(s);
 const shopping=m.html("tab='account';render()");
 assert.match(shopping,/max="27\.00" data-budget-amount/);
 assert.match(shopping,/购物 O\$ 123\.0 · 股票买单 O\$ 50\.0(?![\d.])/);
 const stocks=m.html("tab='stocks';render()");
 assert.match(stocks,/max="27\.00" data-budget-amount/);
 assert.match(stocks,/本次最多<\/span><b class="num">O\$ 27\.0(?![\d.])/);
 const empty=await mount(bank('0'));
 assert.match(empty.html("tab='stocks';render()"),/max="0\.00" data-budget-amount/);
});

test('wish cards paginate, filter by actual progress, and escape user names',async()=>{
 const s=bank('20');
 for(let i=0;i<23;i++)act(s,'wish.add',{name:i===22?'<img src=x onerror=alert(1)>':`心愿 ${i}`,amount:i%2?'21':'20'});
 const m=await mount(s),html=m.html();
 assert.equal((html.match(/class="card wish-card"/g)||[]).length,10);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html,/<img src=x/);
 assert.match(html,/data-record-list="wishes"/);
 const states=vm.runInContext('data.wishes.map(w=>wishState(w).key)',m.ctx);
 assert.equal(states.filter(x=>x==='ready').length,12);
 assert.equal(states.filter(x=>x==='saving').length,11);
});
