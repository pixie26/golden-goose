import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,setup,runAction,authenticate,createSession,sessionRole,ingestHistories,settleOrders,derived,checkSecret} from '../lib/core.mjs';

let sequence=0;
const action=(state,role,name,payload={},key=`release-core-${++sequence}`)=>runAction(state,role,name,payload,key);
function bank(){const s=initialState();s.dadHash='test-parent';s.kidHash='test-child';return s;}
function quotedStock(s,priceMilli=1000){
  s.quotes['0700.HK|2026-10-13']={symbol:'0700.HK',date:'2026-10-13',currency:'HKD',priceMilli,final:true};
}

test('release: full money-movement history and replay protection survive more than 3,000 actions',()=>{
  const s=bank(),key='release-first-grant';
  action(s,'dad','cash.grant',{amount:'1'},key);const firstId=s.ledger[0].id;
  for(let i=0;i<3005;i++)action(s,'dad','cash.grant',{amount:'0.01'});
  assert.equal(s.ledger.length,3006);
  assert.equal(s.audit.length,3006);
  assert.equal(s.ledger.at(-1).id,firstId);
  assert.equal(s.cashCents,3105);
  assert.equal(s.ledger.reduce((sum,row)=>sum+row.deltaCents,0),s.cashCents);
  const reloaded=JSON.parse(JSON.stringify(s));
  assert.deepEqual(action(reloaded,'dad','cash.grant',{amount:'1'},key),{ok:true,duplicate:true});
  assert.equal(reloaded.cashCents,s.cashCents);
  assert.equal(reloaded.ledger.length,s.ledger.length);
});

test('release: idempotency keys bind action and payload, while object-key order and old keys stay compatible',()=>{
  const s=bank(),key='release-bound-key';
  action(s,'dad','cash.grant',{amount:'10',note:'奖励'},key);
  assert.equal(action(s,'dad','cash.grant',{note:'奖励',amount:'10'},key).duplicate,true);
  assert.throws(()=>action(s,'dad','cash.grant',{amount:'100',note:'奖励'},key),/请求标识/);
  assert.throws(()=>action(s,'dad','settings.update',{rate3:'10'},key),/请求标识/);
  assert.equal(s.cashCents,1000);assert.equal(s.settings.fixedRates[3],500);
  s.processed.push('dad|legacy-request-key');
  assert.equal(action(s,'dad','cash.grant',{amount:'100'},'legacy-request-key').duplicate,true);
  assert.equal(s.cashCents,1000);
});

test('release: quote metadata changing during lookup does not break a retried watchlist request',()=>{
  const s=bank(),key='release-watch-retry';
  const security={symbol:'AAPL',name:'Apple',market:'US',currency:'USD',quoteType:'EQUITY'};
  action(s,'kid','watch.add',{symbol:'AAPL',verifiedSecurity:security},key);
  assert.equal(action(s,'kid','watch.add',{symbol:'aapl',verifiedSecurity:{...security,name:'Apple Inc.',tradable:true,zone:'America/New_York'}},key).duplicate,true);
  assert.equal(s.watchlist.length,1);
  assert.throws(()=>action(s,'kid','watch.add',{symbol:'MSFT',verifiedSecurity:{...security,symbol:'MSFT'}},key),/请求标识/);
});

test('release: splitting a stock sale into fractional-cent trades cannot create extra cash',()=>{
  const s=bank();s.positions=[{symbol:'0700.HK',qtyMicro:1000000,costCents:100}];quotedStock(s);
  for(let i=0;i<20;i++){
    action(s,'kid','stock.sell',{symbol:'0700.HK',qty:'0.015'});
    s.orders[0].targetDate='2026-10-13';
  }
  settleOrders(s,new Date('2026-10-14T10:00:00Z'));
  assert.equal(s.positions[0].qtyMicro,700000);
  assert.equal(s.cashCents,20); // round each 1.5-cent execution down to the ledger's cent unit
  assert.equal(s.orders.filter(o=>o.status==='filled').length,20);
  assert.ok(derived(s).netWorthCents<=100,'rounding must not create a trading profit at an unchanged price');
});

test('release: a sub-cent sell is cancelled without giving away shares or crediting a free cent',()=>{
  const s=bank();s.positions=[{symbol:'0700.HK',qtyMicro:1000000,costCents:100}];quotedStock(s);
  action(s,'kid','stock.sell',{symbol:'0700.HK',qty:'0.005'});const order=s.orders[0];order.targetDate='2026-10-13';
  settleOrders(s,new Date('2026-10-14T10:00:00Z'));
  assert.equal(order.status,'cancelled');assert.match(order.reason,/保留持仓/);
  assert.equal(s.positions[0].qtyMicro,1000000);assert.equal(s.cashCents,0);assert.equal(s.ledger.length,0);
});

test('release: large fractional-share fills use exact integer arithmetic and release only their budget',()=>{
  const s=bank();action(s,'dad','cash.grant',{amount:'90000000.01'});
  action(s,'kid','stock.buy',{symbol:'0700.HK',amount:'90000000.01'});
  const order=s.orders[0];order.targetDate='2026-10-13';quotedStock(s,997);
  const expectedQty=Number(9000000001n*10000000n/997n);
  settleOrders(s,new Date('2026-10-14T10:00:00Z'));
  assert.equal(order.qtyMicro,expectedQty);
  assert.equal(order.filledCents,9000000001);
  assert.equal(s.cashCents,0);assert.equal(s.reservedCents,0);
});

test('release: invalid calendar dates and nonnumeric quote inputs are rejected without a quote',()=>{
  const s=bank();
  for(const date of ['2026-02-30','2026-13-01','2026-00-10','2026-04-31']){
    assert.throws(()=>action(s,'dad','quote.set',{symbol:'0700.HK',date,price:10}),/正确交易日期/);
  }
  for(const price of [true,false,null,{},[],['10'],'']){
    assert.throws(()=>action(s,'dad','quote.set',{symbol:'0700.HK',date:'2026-10-13',price}),/收盘价不正确/);
  }
  assert.deepEqual(s.quotes,{});
  action(s,'dad','quote.set',{symbol:'0700.HK',date:'2026-10-13',price:'10.25'});
  assert.equal(s.quotes['0700.HK|2026-10-13'].priceMilli,10250);
});

test('release: unfinished daily bars cannot become stale final prices on a later failed refresh',()=>{
  const s=bank();action(s,'dad','cash.grant',{amount:'100'});
  action(s,'kid','stock.buy',{symbol:'0700.HK',amount:'100'});const order=s.orders[0];order.targetDate='2026-11-17';
  ingestHistories(s,[{symbol:'0700.HK',rows:[{date:'2026-11-17',priceMilli:500000},{date:'2026-02-30',priceMilli:999999}]}],new Date('2026-11-17T08:20:00Z'));
  assert.equal(s.quotes['0700.HK|2026-11-17'],undefined);
  assert.equal(s.quotes['0700.HK|2026-02-30'],undefined);
  settleOrders(s,new Date('2026-11-17T09:05:00Z'));
  assert.equal(order.status,'pending');assert.equal(s.reservedCents,10000);
  ingestHistories(s,[{symbol:'0700.HK',rows:[{date:'2026-11-17',priceMilli:502000}]}],new Date('2026-11-17T09:05:00Z'));
  assert.equal(order.status,'filled');assert.equal(order.priceMilli,502000);
});

test('release: a parent PIN reset recovers a locked child account and revokes old sessions',()=>{
  const s=initialState();setup(s,'setup-test','setup-test','parent-test-password','123456');
  createSession(s,'kid','old-child-session');
  for(let i=0;i<8;i++)assert.equal(authenticate(s,'kid','wrong-pin'),null);
  assert.throws(()=>authenticate(s,'kid','123456'),/15分钟/);
  action(s,'dad','pin.change',{pin:'654321'},'release-pin-reset');
  assert.match(s.requestDigests['dad|release-pin-reset'],/^scrypt\$/);
  assert.equal(action(s,'dad','pin.change',{pin:'654321'},'release-pin-reset').duplicate,true);
  assert.throws(()=>action(s,'dad','pin.change',{pin:'999999'},'release-pin-reset'),/请求标识/);
  assert.equal(sessionRole(s,'old-child-session'),null);
  assert.equal(authenticate(s,'kid','654321'),'kid');
  assert.equal(authenticate(s,'kid','123456'),null);
});

test('release: password changes retain setup length limits and clear the recovered parent lock',()=>{
  const s=initialState();setup(s,'setup-test','setup-test','parent-test-password','123456');
  const original=s.dadHash;
  assert.throws(()=>action(s,'dad','password.change',{oldPassword:'parent-test-password',newPassword:'a'.repeat(129)}),/12至128/);
  assert.equal(s.dadHash,original);
  createSession(s,'dad','old-parent-session');s.authLocks.dad={count:0,until:Date.now()+900000};
  action(s,'dad','password.change',{oldPassword:'parent-test-password',newPassword:'a-new-parent-password'});
  assert.equal(checkSecret('a-new-parent-password',s.dadHash),true);
  assert.equal(sessionRole(s,'old-parent-session'),null);
  assert.equal(authenticate(s,'dad','a-new-parent-password'),'dad');
});
