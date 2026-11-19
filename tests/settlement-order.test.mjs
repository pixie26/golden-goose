import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,setup,runAction,ingestHistories,derived} from '../lib/core.mjs';

const NativeDate=globalThis.Date;
let sequence=0;
function at(iso,fn){
 globalThis.Date=class extends NativeDate{
  constructor(...args){super(...(args.length?args:[iso]));}
  static now(){return NativeDate.parse(iso);}
 };
 try{return fn();}finally{globalThis.Date=NativeDate;}
}
function action(s,role,name,payload={},key=`settlement-order-${++sequence}`){return runAction(s,role,name,payload,key);}
function ingest(s,when,rows,symbol='0700.HK'){
 return at(when,()=>ingestHistories(s,[{symbol,rows}]));
}
function seededBank({amount='300',symbol='0700.HK',seedDate='2026-11-16',seedAmount='100'}={}){
 const s=at(`${seedDate}T03:00:00Z`,()=>{
  const state=initialState();
  setup(state,'settlement-token','settlement-token','settlement-test-password','123456');
  action(state,'dad','cash.grant',{amount});
  action(state,'kid','stock.buy',{symbol,amount:seedAmount});
  assert.equal(state.orders[0].targetDate,seedDate);
  return state;
 });
 ingest(s,`${seedDate}T23:00:00Z`,[{date:seedDate,priceMilli:100000}],symbol);
 assert.equal(s.positions[0].qtyMicro,1000000);
 assert.equal(s.positions[0].costCents,Number(seedAmount)*100);
 return s;
}
function pendingPair({amount='300',sameDay=false,sameInstant=false,first='sell'}={}){
 const s=seededBank({amount}),pair={s,requests:[]};
 const names=first==='sell'?['stock.sell','stock.buy']:['stock.buy','stock.sell'];
 for(const [index,name] of names.entries()){
  const when=index===0||sameInstant?'2026-11-17T03:00:00Z':sameDay?'2026-11-17T04:00:00Z':'2026-11-18T03:00:00Z';
  const payload=name==='stock.sell'?{symbol:'0700.HK',qty:'1'}:{symbol:'0700.HK',amount:'200'};
  const key=`settlement-order-${++sequence}`;
  at(when,()=>action(s,'kid',name,payload,key));
  pair[name==='stock.sell'?'sellId':'buyId']=s.orders[0].id;
  pair.requests.push({name,payload,key});
 }
 return pair;
}
const order=(pair,id)=>pair.s.orders.find(o=>o.id===pair[id]);
function financialResult(pair){
 const p=pair.s.positions.find(p=>p.symbol==='0700.HK');
 return {cashCents:pair.s.cashCents,reservedCents:pair.s.reservedCents,qtyMicro:p.qtyMicro,
  costCents:p.costCents,realizedPnLCents:order(pair,'sellId').realizedPnLCents};
}
const correctCrossDay={cashCents:15000,reservedCents:0,qtyMicro:1000000,costCents:20000,realizedPnLCents:5000};
const bars=[{date:'2026-11-17',priceMilli:150000},{date:'2026-11-18',priceMilli:200000}];
function assertFilledPair(pair){
 assert.equal(order(pair,'sellId').status,'filled');
 assert.equal(order(pair,'buyId').status,'filled');
 assert.equal(order(pair,'sellId').reason,undefined);
 assert.equal(order(pair,'buyId').reason,undefined);
 assert.equal(pair.s.cashCents,pair.s.ledger.reduce((sum,row)=>sum+row.deltaCents,0));
 assert.ok(derived(pair.s).availableCents>=0);
}

for(const reverseRows of [false,true]){
 test(`settlement order: batched daily bars${reverseRows?' in reverse row order':''} preserve chronological cost and profit`,()=>{
  const pair=pendingPair(),uiOrder=pair.s.orders.map(o=>o.id);
  ingest(pair.s,'2026-11-18T10:00:00Z',reverseRows?[...bars].reverse():bars);
  assertFilledPair(pair);
  assert.deepEqual(financialResult(pair),correctCrossDay);
  assert.deepEqual(pair.s.orders.map(o=>o.id),uiOrder,'settlement must not reorder the UI array');
  assert.deepEqual(pair.s.ledger.filter(l=>l.type.startsWith('stock.')).reverse().map(l=>l.type),['stock.buy','stock.sell','stock.buy']);
 });
}

test('settlement order: timely daily history gives the same result as a delayed batch',()=>{
 const pair=pendingPair();
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[0]]);
 assert.equal(order(pair,'sellId').status,'filled');
 assert.equal(order(pair,'buyId').status,'pending');
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[1]]);
 assertFilledPair(pair);
 assert.deepEqual(financialResult(pair),correctCrossDay);
});

test('settlement order: a missing close waits until it arrives; the later order never crosses it',()=>{
 const pair=pendingPair(),uiOrder=pair.s.orders.map(o=>o.id);
 // 17 Nov is over but no close exists yet and nothing later is known: wait.
 ingest(pair.s,'2026-11-18T03:00:00Z',[]);
 assert.equal(order(pair,'sellId').status,'pending');
 assert.equal(order(pair,'buyId').status,'pending');
 assert.equal(order(pair,'sellId').reason,undefined,'a normal wait needs no warning');
 assert.equal(order(pair,'buyId').reason,undefined);
 assert.equal(order(pair,'sellId').rolledFrom,undefined);
 // Persist and reload between refreshes; no ephemeral queue may control ordering.
 pair.s=JSON.parse(JSON.stringify(pair.s));
 ingest(pair.s,'2026-11-18T10:00:00Z',bars);
 assertFilledPair(pair);
 assert.equal(order(pair,'sellId').priceDate,'2026-11-17');
 assert.deepEqual(financialResult(pair),correctCrossDay);
 assert.deepEqual(pair.s.orders.map(o=>o.id),uiOrder);
});

test('settlement order: a session with no close (unknown closure) fills at the first later close, in submission order',()=>{
 const pair=pendingPair(),uiOrder=pair.s.orders.map(o=>o.id);
 // Yahoo has 18 Nov but no bar at all for 17 Nov: the stock did not trade then.
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[1]]);
 assertFilledPair(pair);
 const sell=order(pair,'sellId'),buy=order(pair,'buyId');
 assert.deepEqual([sell.rolledFrom,sell.targetDate,sell.priceDate,sell.priceMilli],['2026-11-17','2026-11-18','2026-11-18',200000]);
 assert.equal(buy.rolledFrom,undefined);
 // The earlier-submitted sell still settles first: its cost basis excludes the later buy.
 assert.deepEqual(financialResult(pair),{cashCents:20000,reservedCents:0,qtyMicro:1000000,costCents:20000,realizedPnLCents:10000});
 assert.deepEqual(pair.s.ledger.filter(l=>l.type.startsWith('stock.')).reverse().map(l=>l.type),['stock.buy','stock.sell','stock.buy']);
 assert.equal(pair.s.audit.filter(a=>a.type==='stock.close.roll').length,1);
 assert.deepEqual(pair.s.orders.map(o=>o.id),uiOrder);
 // A late bar for 17 Nov cannot reopen or move a completed fill.
 const before=JSON.stringify(pair.s.orders);
 ingest(pair.s,'2026-11-19T10:00:00Z',[bars[0]]);
 assert.equal(JSON.stringify(pair.s.orders),before);
});

for(const first of ['sell','buy']){
 for(const sameInstant of [false,true]){
  test(`settlement order: same-day ${first} first${sameInstant?' at the same millisecond survives reload':''}`,()=>{
   const pair=pendingPair({sameDay:true,sameInstant,first}),uiOrder=pair.s.orders.map(o=>o.id);
   if(sameInstant){
    assert.equal(order(pair,'sellId').submittedAt,order(pair,'buyId').submittedAt);
    pair.s=JSON.parse(JSON.stringify(pair.s));
   }
   ingest(pair.s,'2026-11-17T10:00:00Z',[{date:'2026-11-17',priceMilli:200000}]);
   assertFilledPair(pair);
   assert.deepEqual(financialResult(pair),{
    cashCents:20000,reservedCents:0,qtyMicro:1000000,
    costCents:first==='sell'?20000:15000,realizedPnLCents:first==='sell'?10000:5000,
   });
   assert.deepEqual(pair.s.orders.map(o=>o.id),uiOrder);
  });
 }
}

test('settlement order: one stock missing its earlier close does not block another stock',()=>{
 const pair=pendingPair({amount:'500'});
 at('2026-11-18T03:30:00Z',()=>action(pair.s,'kid','stock.buy',{symbol:'2800.HK',amount:'50'}));
 const other=pair.s.orders[0];
 // Yahoo failed for 0700.HK in this run: it waits, 2800.HK still settles.
 at('2026-11-18T10:00:00Z',()=>ingestHistories(pair.s,[
  {symbol:'2800.HK',rows:[{date:'2026-11-18',priceMilli:25000}]},
 ]));
 assert.equal(order(pair,'sellId').status,'pending');
 assert.equal(order(pair,'buyId').status,'pending');
 assert.equal(other.status,'filled');
 assert.equal(pair.s.reservedCents,20000);
 assert.equal(pair.s.cashCents,35000);
 assert.deepEqual(pair.s.positions.find(p=>p.symbol==='2800.HK'),{symbol:'2800.HK',qtyMicro:2000000,costCents:5000});
 ingest(pair.s,'2026-11-19T10:00:00Z',bars);
 assertFilledPair(pair);
 assert.equal(pair.s.positions.find(p=>p.symbol==='0700.HK').costCents,20000);
});

test('settlement order: no same-day order fills during the closing-price safety window',()=>{
 const pair=pendingPair({sameDay:true});
 ingest(pair.s,'2026-11-17T08:30:00Z',[{date:'2026-11-17',priceMilli:190000}]);
 assert.equal(order(pair,'sellId').status,'pending');
 assert.equal(order(pair,'buyId').status,'pending');
 assert.equal(pair.s.quotes['0700.HK|2026-11-17'],undefined);
 assert.equal(pair.s.reservedCents,20000);
 ingest(pair.s,'2026-11-17T09:05:00Z',[{date:'2026-11-17',priceMilli:200000}]);
 assertFilledPair(pair);
 assert.equal(order(pair,'sellId').priceMilli,200000);
 assert.equal(pair.s.positions[0].costCents,20000);
});

test('settlement order: a cancelled earlier order is excluded from the stock queue',()=>{
 const pair=pendingPair({sameDay:true});
 at('2026-11-17T07:00:00Z',()=>action(pair.s,'kid','stock.cancel',{id:pair.sellId}));
 ingest(pair.s,'2026-11-17T10:00:00Z',[{date:'2026-11-17',priceMilli:200000}]);
 assert.equal(order(pair,'sellId').status,'cancelled');
 assert.equal(order(pair,'buyId').status,'filled');
 assert.equal(order(pair,'buyId').reason,undefined);
 assert.equal(pair.s.positions[0].qtyMicro,2000000);
 assert.equal(pair.s.positions[0].costCents,30000);
 assert.equal(pair.s.reservedCents,0);
});

test('settlement order: cancelling a waiting later buy clears its reason and releases only its reservation',()=>{
 const pair=pendingPair();
 // A V2.0.1 ledger may still carry the old wording on a waiting order.
 order(pair,'buyId').reason='同一股票有更早订单尚未结算，请先补齐该交易日行情或处理该订单';
 ingest(pair.s,'2026-11-18T03:30:00Z',[]);
 assert.equal(order(pair,'buyId').reason,undefined,'the old warning is cleared at the next settlement');
 order(pair,'buyId').reason='同一股票有更早订单尚未结算，请先补齐该交易日行情或处理该订单';
 at('2026-11-18T04:00:00Z',()=>action(pair.s,'kid','stock.cancel',{id:pair.buyId}));
 assert.equal(order(pair,'buyId').status,'cancelled');
 assert.equal(order(pair,'buyId').reason,undefined);
 assert.equal(order(pair,'sellId').status,'pending');
 assert.equal(pair.s.reservedCents,0);
 assert.equal(pair.s.cashCents,20000);
});

function rollSalePastBuy(pair){
 at('2026-11-18T10:00:00Z',()=>{
  while(order(pair,'sellId').targetDate<=order(pair,'buyId').targetDate){
   action(pair.s,'dad','order.roll',{id:pair.sellId,confirmExceptionalClosure:true});
  }
 });
}

test('settlement order: a legitimate retarget before any conflicting fill reorders all pending trades',()=>{
 const pair=pendingPair();
 rollSalePastBuy(pair);
 assert.equal(order(pair,'sellId').targetDate,'2026-11-19');
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[0]]);
 assert.equal(order(pair,'sellId').status,'pending');
 at('2026-11-18T10:00:00Z',()=>action(pair.s,'dad','order.retarget',{id:pair.sellId}));
 assert.equal(order(pair,'sellId').targetDate,'2026-11-17');
 assert.equal(order(pair,'sellId').status,'filled');
 assert.equal(order(pair,'sellId').reason,undefined);
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[1]]);
 assertFilledPair(pair);
 assert.deepEqual(financialResult(pair),correctCrossDay);
});

for(const sameInstant of [false,true]){
 test(`settlement order: retarget cannot backdate a rolled trade behind a completed trade${sameInstant?' with an identical submission timestamp':''}`,()=>{
  const pair=pendingPair({sameDay:sameInstant,sameInstant});
  rollSalePastBuy(pair);
  ingest(pair.s,'2026-11-18T10:00:00Z',[{date:order(pair,'buyId').targetDate,priceMilli:200000}]);
  assert.equal(order(pair,'buyId').status,'filled');
  assert.equal(order(pair,'sellId').status,'pending');
  const before=JSON.stringify(pair.s);
  at('2026-11-18T10:00:00Z',()=>assert.throws(
   ()=>action(pair.s,'dad','order.retarget',{id:pair.sellId}),/已有较晚成交记录.*核对历史成本/,
  ));
  assert.equal(JSON.stringify(pair.s),before,'an unsafe target change must not mutate the order or ledger');
 });
}

test('settlement order: pre-upgrade late fills pause the old gap and same-stock successors without rewriting money',()=>{
 const pair=pendingPair({amount:'500'});
 rollSalePastBuy(pair);
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[1]]);
 // Compatibility fixture: V1.0.2 could fill the later buy while the original
 // November 17 sell was still pending. All money and trades above are real actions.
 pair.s=JSON.parse(JSON.stringify(pair.s));
 order(pair,'sellId').targetDate='2026-11-17';
 at('2026-11-19T03:00:00Z',()=>action(pair.s,'kid','stock.buy',{symbol:'0700.HK',amount:'50'}));
 const successor=pair.s.orders[0];
 at('2026-11-19T04:00:00Z',()=>action(pair.s,'kid','stock.buy',{symbol:'2800.HK',amount:'50'}));
 const independent=pair.s.orders[0],filledBefore=structuredClone(order(pair,'buyId'));
 at('2026-11-19T10:00:00Z',()=>ingestHistories(pair.s,[
  {symbol:'0700.HK',rows:[bars[0],{date:'2026-11-19',priceMilli:250000}]},
  {symbol:'2800.HK',rows:[{date:'2026-11-19',priceMilli:25000}]},
 ]));
 assert.equal(order(pair,'sellId').status,'pending');
 assert.match(order(pair,'sellId').reason,/核对历史成本/);
 assert.equal(successor.status,'pending');
 assert.match(successor.reason,/更早的订单需要家长处理/);
 assert.equal(independent.status,'filled');
 assert.deepEqual(order(pair,'buyId'),filledBefore);
 assert.deepEqual(pair.s.positions.find(p=>p.symbol==='0700.HK'),{symbol:'0700.HK',qtyMicro:2000000,costCents:30000});
 assert.equal(pair.s.cashCents,15000);
 assert.equal(pair.s.reservedCents,5000);
});

test('settlement order: an unsafe roll is rejected and the actual fill date takes priority over a legacy target',()=>{
 const pair=pendingPair();
 rollSalePastBuy(pair);
 ingest(pair.s,'2026-11-18T10:00:00Z',[bars[1]]);
 // A legacy target can disagree with the recorded execution date. The fill
 // still happened on November 18, regardless of this old scheduling metadata.
 order(pair,'buyId').targetDate='2026-11-16';
 order(pair,'sellId').targetDate='2026-11-17';
 const before=JSON.stringify(pair.s);
 at('2026-11-18T10:00:00Z',()=>{
  assert.throws(()=>action(pair.s,'dad','order.roll',{id:pair.sellId,confirmExceptionalClosure:true}),/已有较晚成交记录/);
  assert.throws(()=>action(pair.s,'dad','order.retarget',{id:pair.sellId}),/已有较晚成交记录/);
 });
 assert.equal(JSON.stringify(pair.s),before);
});

function legacyGapAfterFill(pair){
 rollSalePastBuy(pair);
 ingest(pair.s,'2026-11-18T10:00:00Z',[{date:'2026-11-17',priceMilli:200000}]);
 // Reconstruct only the pending date left by the old release, retaining the
 // original fill, ledger and balances. Do not ingest November 17 again.
 order(pair,'sellId').targetDate='2026-11-17';delete order(pair,'sellId').rolledFrom;
 delete pair.s.quotes['0700.HK|2026-11-17'];
 pair.s.priceHistory['0700.HK']=pair.s.priceHistory['0700.HK'].filter(r=>r.date!=='2026-11-17');
}
test('settlement order: a safe manual roll clears a legacy history block and settles using an available final close',()=>{
 const pair=pendingPair({sameDay:true});
 legacyGapAfterFill(pair);
 ingest(pair.s,'2026-11-18T03:00:00Z',[]);
 assert.match(order(pair,'sellId').reason,/核对历史成本/);
 at('2026-11-18T10:00:00Z',()=>action(pair.s,'dad','order.roll',{id:pair.sellId,confirmExceptionalClosure:true}));
 assert.equal(order(pair,'sellId').targetDate,'2026-11-18');
 assert.equal(order(pair,'sellId').reason,undefined,'after the roll the sale is no longer behind a completed trade');
 ingest(pair.s,'2026-11-18T10:00:00Z',[{date:'2026-11-18',priceMilli:200000}]);
 assertFilledPair(pair);
 assert.deepEqual(financialResult(pair),{cashCents:20000,reservedCents:0,qtyMicro:1000000,costCents:15000,realizedPnLCents:5000});
});

test('settlement order: the automatic roll resolves the same legacy gap exactly like the safe manual roll',()=>{
 const pair=pendingPair({sameDay:true});
 legacyGapAfterFill(pair);
 ingest(pair.s,'2026-11-18T10:00:00Z',[{date:'2026-11-18',priceMilli:200000}]);
 assert.deepEqual([order(pair,'sellId').rolledFrom,order(pair,'sellId').targetDate],['2026-11-17','2026-11-18']);
 assertFilledPair(pair);
 assert.deepEqual(financialResult(pair),{cashCents:20000,reservedCents:0,qtyMicro:1000000,costCents:15000,realizedPnLCents:5000});
});

test('settlement order: normalize every holiday target before sorting a shared half-day session',()=>{
 const s=seededBank({amount:'2400',symbol:'AAPL',seedDate:'2026-11-24',seedAmount:'800'});
 at('2026-11-25T22:30:00Z',()=>action(s,'kid','stock.sell',{symbol:'AAPL',qty:'1'}));
 const sell=s.orders[0];
 at('2026-11-26T15:00:00Z',()=>action(s,'kid','stock.buy',{symbol:'AAPL',amount:'1600'}));
 const buy=s.orders[0],uiOrder=s.orders.map(o=>o.id);
 assert.equal(sell.targetDate,'2026-11-27');
 assert.equal(buy.targetDate,'2026-11-27');
 // Persisted older schedules could still name Thanksgiving. Sorting this raw
 // date first would wrongly put the later buy ahead of the earlier sell.
 buy.targetDate='2026-11-26';
 ingest(s,'2026-11-27T19:05:00Z',[{date:'2026-11-27',priceMilli:200000}],'AAPL');
 assert.equal(sell.status,'filled');assert.equal(buy.status,'filled');
 assert.equal(buy.targetDate,'2026-11-27');
 assert.equal(sell.realizedPnLCents,80000);
 assert.equal(s.positions[0].costCents,160000);
 assert.equal(s.positions[0].qtyMicro,1000000);
 assert.equal(s.cashCents,160000);assert.equal(s.reservedCents,0);
 assert.deepEqual(s.orders.map(o=>o.id),uiOrder);
 assert.equal(s.audit.filter(a=>a.type==='stock.holiday.roll').length,1);
});

test('settlement order: quote refresh and original request retries cannot repeat completed fills',()=>{
 const pair=pendingPair();
 ingest(pair.s,'2026-11-18T10:00:00Z',bars);
 assertFilledPair(pair);
 const before=JSON.stringify(pair.s);
 ingest(pair.s,'2026-11-18T10:00:00Z',[...bars].reverse());
 assert.equal(JSON.stringify(pair.s),before);
 for(const request of pair.requests){
  assert.equal(action(pair.s,'kid',request.name,request.payload,request.key).duplicate,true);
  assert.equal(JSON.stringify(pair.s),before);
 }
 assert.deepEqual(financialResult(pair),correctCrossDay);
});
