import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, setup, runAction, derived, view, settleOrders } from '../lib/core.mjs';

let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`budget193-${++sequence}-request`);
function bank(amount='0'){
  const s=initialState();setup(s,'test','test','parent-test-password','123456');
  if(amount!=='0')act(s,'cash.grant',{amount},'dad');
  return s;
}
function unchangedOnError(s,action,payload,pattern,role='kid'){
  const before=JSON.stringify(s);
  assert.throws(()=>act(s,action,payload,role),pattern);
  assert.equal(JSON.stringify(s),before,'rejected action must not change saved balances, reservations or requests');
}

test('the screenshot wish 鞋 is accepted; whitespace-only names still fail in wishes and shopping',()=>{
  const s=bank('162');
  act(s,'wish.add',{name:'  鞋  ',amount:'123'});
  assert.equal(s.wishes[0].name,'鞋');assert.equal(s.wishes[0].goalCents,12300);
  unchangedOnError(s,'wish.add',{name:' \t\n ',amount:'1'},/心愿名称/);
  unchangedOnError(s,'purchase.request',{name:'　 ',amount:'1'},/商品名称/);
  act(s,'purchase.request',{name:'鞋',amount:'123'});
  assert.equal(s.purchaseRequests[0].name,'鞋');
  assert.equal(derived(s).availableCents,3900);
});

test('shopping request equal to available cash succeeds; one cent over fails without changing state',()=>{
  const s=bank('12.34');
  unchangedOnError(s,'purchase.request',{name:'画笔',amount:'12.35'},/可用余额不足/);
  act(s,'purchase.request',{name:'画笔',amount:'12.34'});
  assert.equal(s.cashCents,1234,'an application reserves cash but never spends it');
  assert.equal(s.ledger.length,1,'only the initial grant belongs to the cash ledger');
  assert.deepEqual([derived(s).availableCents,derived(s).purchaseReservedCents,derived(s).reservedCents],[0,1234,1234]);
  assert.equal(derived(s).assetsCents,1234);assert.equal(derived(s).netWorthCents,1234);
  unchangedOnError(s,'purchase.request',{name:'另一支',amount:'0.01'},/可用余额不足/);
  unchangedOnError(s,'stock.buy',{symbol:'AAPL',amount:'0.01'},/可用余额不足/);
});

test('shopping and stock applications share one spending limit; fixed deposits cannot consume held funds',()=>{
  const s=bank('100');
  act(s,'stock.buy',{symbol:'AAPL',amount:'30'});
  unchangedOnError(s,'purchase.request',{name:'鞋',amount:'70.01'},/可用余额不足/);
  act(s,'purchase.request',{name:'鞋',amount:'60'});
  assert.deepEqual([derived(s).stockReservedCents,derived(s).purchaseReservedCents,derived(s).reservedCents,derived(s).availableCents],[3000,6000,9000,1000]);
  unchangedOnError(s,'stock.buy',{symbol:'AAPL',amount:'10.01'},/可用余额不足/);
  unchangedOnError(s,'fixed.open',{term:3,amount:'10.01'},/可用余额不足/);
  act(s,'fixed.open',{term:3,amount:'10'});
  assert.equal(derived(s).availableCents,0);
  act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');
  assert.equal(s.cashCents,3000);assert.equal(s.reservedCents,3000);assert.equal(derived(s).availableCents,0);
});

test('loan repayment also respects shopping reservations',()=>{
  const s=bank();
  act(s,'loan.request',{amount:'100'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
  act(s,'purchase.request',{name:'书',amount:'90'});
  unchangedOnError(s,'loan.repay',{id:s.loans[0].id,amount:'10.1'},/可用余额不足/);
  act(s,'loan.repay',{id:s.loans[0].id,amount:'10'});
  assert.equal(s.cashCents,9000);assert.equal(derived(s).availableCents,0);
});

test('approval consumes its own reservation, releases a lower final price, and is idempotent',()=>{
  const s=bank('100');
  act(s,'purchase.request',{name:'鞋',amount:'80'});const first=s.purchaseRequests[0];
  act(s,'purchase.request',{name:'书',amount:'20'});
  assert.equal(derived(s).availableCents,0);
  const key='approve-reserved-budget-once';
  runAction(s,'dad','purchase.approve',{id:first.id,amount:'70'},key);
  assert.equal(first.status,'delivered');assert.equal(first.reservedCents,0);
  assert.equal(s.cashCents,3000);assert.equal(derived(s).purchaseReservedCents,2000);assert.equal(derived(s).availableCents,1000);
  assert.equal(runAction(s,'dad','purchase.approve',{id:first.id,amount:'70'},key).duplicate,true);
  assert.equal(s.cashCents,3000);assert.equal(s.notifications.length,1);
  unchangedOnError(s,'purchase.approve',{id:first.id},/申请已处理/,'dad');
});

test('rejection releases only that request reservation without a debit',()=>{
  const s=bank('100');
  act(s,'purchase.request',{name:'鞋',amount:'60'});const first=s.purchaseRequests[0];
  act(s,'purchase.request',{name:'书',amount:'30'});
  act(s,'purchase.reject',{id:first.id},'dad');
  assert.equal(s.cashCents,10000);assert.equal(first.reservedCents,0);
  assert.equal(derived(s).availableCents,7000);assert.equal(derived(s).purchaseReservedCents,3000);
  act(s,'stock.buy',{symbol:'AAPL',amount:'70'});assert.equal(derived(s).availableCents,0);
});

test('stock fill and cancellation preserve shopping reservations',()=>{
  const s=bank('100');
  act(s,'purchase.request',{name:'鞋',amount:'60'});
  act(s,'stock.buy',{symbol:'0700.HK',amount:'40'});const order=s.orders[0];
  order.targetDate='2026-10-13';
  s.quotes['0700.HK|2026-10-13']={symbol:'0700.HK',date:'2026-10-13',priceMilli:400000,currency:'HKD',final:true};
  settleOrders(s,new Date('2026-10-14T12:00:00Z'));
  assert.equal(order.status,'filled');assert.equal(s.cashCents,6000);assert.equal(s.reservedCents,0);
  assert.equal(derived(s).purchaseReservedCents,6000);assert.equal(derived(s).availableCents,0);
  act(s,'cash.grant',{amount:'20'},'dad');act(s,'stock.buy',{symbol:'AAPL',amount:'20'});
  s.orders[0].targetDate='2099-01-05';act(s,'stock.cancel',{id:s.orders[0].id});
  assert.equal(derived(s).availableCents,2000);assert.equal(derived(s).purchaseReservedCents,6000);
});

test('old pending shopping requests remain readable and cannot consume a newer reservation',()=>{
  const s=bank('100');
  s.purchaseRequests.push({id:'legacy-request-a',name:'旧申请一',amountCents:8000,status:'pending',at:'2026-01-01T00:00:00Z'},
    {id:'legacy-request-b',name:'旧申请二',amountCents:8000,status:'pending',at:'2026-01-02T00:00:00Z'});
  assert.equal(view(s,'kid').summary.availableCents,10000,'upgrade does not retroactively hold unaffordable legacy requests');
  act(s,'purchase.request',{name:'新申请',amount:'30'});const current=s.purchaseRequests[0];
  unchangedOnError(s,'purchase.approve',{id:'legacy-request-a'},/可用余额不足/,'dad');
  act(s,'purchase.reject',{id:current.id},'dad');
  act(s,'purchase.approve',{id:'legacy-request-a'},'dad');
  assert.equal(s.cashCents,2000);assert.equal(derived(s).availableCents,2000);
  unchangedOnError(s,'purchase.approve',{id:'legacy-request-b'},/可用余额不足/,'dad');
  act(s,'purchase.reject',{id:'legacy-request-b'},'dad');
});

test('one-click wish purchase uses saved name and price, reserves once, and waits for parent approval',()=>{
  const s=bank('162');act(s,'wish.add',{name:'鞋',amount:'123'});const wish=s.wishes[0];
  const key='wish-purchase-retry-one-time';
  runAction(s,'kid','wish.purchase',{id:wish.id,name:'篡改',amount:'0.01',wishId:'different'},key);
  const request=s.purchaseRequests[0];
  assert.equal(request.wishId,wish.id);assert.equal(request.name,'鞋');assert.equal(request.amountCents,12300);
  assert.equal(request.status,'pending');assert.equal(s.cashCents,16200);assert.equal(derived(s).availableCents,3900);
  assert.equal(runAction(s,'kid','wish.purchase',{id:wish.id},key).duplicate,true);
  unchangedOnError(s,'wish.purchase',{id:wish.id},/已有购物申请/);
  assert.equal(s.purchaseRequests.length,1);
  act(s,'purchase.approve',{id:request.id},'dad');assert.equal(s.cashCents,3900);
  unchangedOnError(s,'wish.purchase',{id:wish.id},/已有购物申请/);
});

test('wish conversion checks current spendable cash, existence and Olivia role on the server',()=>{
  const s=bank('100');act(s,'wish.add',{name:'相机',amount:'90'});const wish=s.wishes[0];
  act(s,'fixed.open',{amount:'20',term:3});
  assert.equal(derived(s).assetsCents,10000);assert.equal(derived(s).availableCents,8000);
  unchangedOnError(s,'wish.purchase',{id:wish.id,amount:'1'},/可用余额不足/);
  unchangedOnError(s,'wish.purchase',{id:'missing-wish'},/心愿不存在/);
  unchangedOnError(s,'wish.purchase',{id:wish.id},/只有 Olivia/,'dad');
  assert.equal(s.purchaseRequests.length,0);
  act(s,'cash.grant',{amount:'10'},'dad');act(s,'wish.purchase',{id:wish.id});
  assert.equal(derived(s).availableCents,0);
});

test('rejected or refunded wish applications may be retried; a pending return cannot be duplicated',()=>{
  const s=bank('100');act(s,'wish.add',{name:'书',amount:'100'});const wish=s.wishes[0];
  act(s,'wish.purchase',{id:wish.id});act(s,'purchase.reject',{id:s.purchaseRequests[0].id},'dad');
  assert.equal(derived(s).availableCents,10000);
  act(s,'wish.purchase',{id:wish.id});const bought=s.purchaseRequests[0];
  act(s,'purchase.approve',{id:bought.id},'dad');act(s,'purchase.return.request',{id:bought.id});
  unchangedOnError(s,'wish.purchase',{id:wish.id},/已有购物申请/);
  act(s,'purchase.refund',{id:bought.id},'dad');
  act(s,'wish.purchase',{id:wish.id});assert.equal(s.purchaseRequests.length,3);
  assert.equal(s.cashCents,10000);assert.equal(derived(s).availableCents,0);
});

test('purchase holds and wish links survive save/reload and older retained history is exposed for pagination',()=>{
  const s=bank('200');act(s,'wish.add',{name:'鞋',amount:'120'});act(s,'wish.purchase',{id:s.wishes[0].id});
  const restored=JSON.parse(JSON.stringify(s));
  assert.equal(derived(restored).availableCents,8000);
  unchangedOnError(restored,'wish.purchase',{id:restored.wishes[0].id},/已有购物申请/);
  s.ledger=Array.from({length:180},(_,i)=>({id:`ledger-${i}`,at:'2026-01-01T00:00:00Z',type:'cash.grant',deltaCents:1,cashAfterCents:1,description:'记录'}));
  s.audit=Array.from({length:130},(_,i)=>({id:`audit-${i}`,at:'2026-01-01T00:00:00Z',role:'kid',type:'login'}));
  assert.equal(view(s,'kid').ledger.length,180);assert.equal(view(s,'dad').ledger.length,180);
  // v1.0.2: the audit log stays in the database but is not sent to either page (the UI never reads it).
  assert.equal(view(s,'dad').audit,undefined);assert.equal(view(s,'kid').audit,undefined);assert.equal(s.audit.length,130);
});
