import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,setup,runAction,derived,checkSecret,maintenance,nextWeekday,ingestHistories,settleOrders,view} from '../lib/core.mjs';
import {orderTarget,closeIsFinal,nextMarketDay,orderCanCancel} from '../lib/market.mjs';
import {parseDailyChart} from '../lib/quotes.mjs';

let seq=0;const id=()=>`key-${++seq}-unique`;const act=(s,a,p={},role='kid')=>runAction(s,role,a,p,id());
function init(){const s=initialState();setup(s,'secret','secret','a-strong-local-password','123456');return s;}
function grant(s,amount){return act(s,'cash.grant',{amount},'dad');}

test('setup requires token; dad password and child pin are hashed',()=>{
 const s=initialState();assert.throws(()=>setup(s,'wrong','token','a-strong-password','123456'));
 setup(s,'token','token','a-strong-password','123456');assert.ok(checkSecret('123456',s.kidHash));assert.ok(!s.kidHash.includes('123456'));
});
test('no deposit request: dad directly credits real-backed funds, child cannot self-credit',()=>{
 const s=init();assert.throws(()=>act(s,'deposit.request',{amount:'125',note:'现金'}));
 assert.equal(s.cashCents,0);assert.throws(()=>act(s,'cash.grant',{amount:'125'}));
 act(s,'cash.grant',{amount:'125',note:'收到现金'},'dad');
 assert.equal(s.cashCents,12500);assert.equal(s.depositRequests.length,0);
});
test('child opens and redeems fixed deposit without dad approval; early interest is zero',()=>{
 const s=init();grant(s,'1000');act(s,'fixed.open',{amount:'300',term:'3'},'kid');const f=s.fixed[0];assert.equal(s.cashCents,70000);assert.equal(f.rateBps,500);
 act(s,'settings.update',{rate3:'9.5'},'dad');assert.equal(f.rateBps,500);
 act(s,'fixed.redeem',{id:f.id},'kid');assert.equal(s.cashCents,100000);assert.equal(f.interestCents,0);assert.equal(f.status,'early');
});
test('redeem after deposit matures but before maintenance pays maturity interest, not zero',()=>{
 const s=init();grant(s,'100');act(s,'fixed.open',{amount:'100',term:'3'},'kid');const f=s.fixed[0];
 f.start='2026-07-01';f.maturity='2026-10-01';
 act(s,'fixed.redeem',{id:f.id},'kid');
 assert.equal(f.status,'matured');assert.ok(f.interestCents>0);assert.equal(s.cashCents,10000+f.interestCents);
});
test('dad approves + delivers in ONE step; Olivia requests return, dad refunds once',()=>{
 const s=init();grant(s,'1000');act(s,'purchase.request',{name:'LEGO castle',amount:'150'});const r=s.purchaseRequests[0];assert.equal(s.cashCents,100000);
 act(s,'purchase.approve',{id:r.id},'dad');assert.equal(s.cashCents,85000);
 assert.equal(r.status,'delivered');assert.equal(r.reviewAt,r.deliveredAt);
 assert.throws(()=>act(s,'purchase.deliver',{id:r.id},'dad'),/无需再次/);
 assert.throws(()=>act(s,'purchase.refund',{id:r.id},'kid'),/家长/);
 act(s,'purchase.return.request',{id:r.id,reason:'尺寸不合适'});
 assert.equal(r.status,'return_pending');assert.equal(r.returnReason,'尺寸不合适');assert.equal(s.cashCents,85000);
 act(s,'purchase.refund',{id:r.id},'dad');assert.equal(s.cashCents,100000);assert.equal(r.status,'refunded');
 assert.equal(s.ledger.filter(l=>l.type==='purchase.refund').length,1);
 assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/不能退货/);
});
test('refunds require one child request, cannot be withdrawn, and a rejection is final for that order',()=>{
 const s=init();grant(s,'300');act(s,'purchase.request',{name:'Picture book',amount:'40'});
 const r=s.purchaseRequests[0];act(s,'purchase.approve',{id:r.id},'dad');
 assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/没有待处理/);
 act(s,'purchase.return.request',{id:r.id});assert.equal(r.status,'return_pending');
 assert.throws(()=>act(s,'purchase.return.cancel',{id:r.id}),/不能撤回/);assert.equal(r.status,'return_pending');assert.equal(s.cashCents,26000);
 act(s,'purchase.return.reject',{id:r.id},'dad');assert.equal(r.status,'delivered');
 assert.throws(()=>act(s,'purchase.return.request',{id:r.id}),/只能申请退款一次/);
 assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/没有待处理/);assert.equal(s.cashCents,26000);
});
test('legacy V1.5 approved-and-debited purchases remain refundable without double cash debit',()=>{
 const s=init();grant(s,'100');act(s,'purchase.request',{name:'Old purchase',amount:'20'});
 const r=s.purchaseRequests[0];act(s,'purchase.approve',{id:r.id},'dad');r.status='approved';delete r.deliveredAt;
 const old=s.cashCents;act(s,'purchase.return.request',{id:r.id});assert.equal(s.cashCents,old);
 act(s,'purchase.refund',{id:r.id},'dad');assert.equal(s.cashCents,10000);
});
test('duplicate requests cannot double-debit',()=>{
 const s=init();grant(s,'1000');act(s,'purchase.request',{name:'Painting set',amount:'100'});const r=s.purchaseRequests[0];const k='same-idempotency-key';const a=runAction(s,'dad','purchase.approve',{id:r.id},k);const b=runAction(s,'dad','purchase.approve',{id:r.id},k);assert.equal(a.ok,true);assert.equal(b.duplicate,true);assert.equal(s.cashCents,90000);
});
test('loan cap O$500; loan proceeds do not create equity; repay interest first',()=>{
 const s=init();act(s,'loan.request',{amount:'500'});const l=s.loans[0];act(s,'loan.approve',{id:l.id},'dad');assert.equal(s.cashCents,50000);assert.equal(derived(s).netWorthCents,0);assert.throws(()=>act(s,'loan.request',{amount:'1'}));
 l.lastAccruedDay='2026-01-01';act(s,'maintenance.run',{},'dad');assert.ok(l.interestMicroCents>0);
 grant(s,'400');act(s,'loan.repay',{id:l.id,amount:'100'});assert.ok(l.principalCents>40000);assert.equal(s.cashCents,80000);
});
test('buy order holds funds, its own session close fills fractional shares',()=>{
 const s=init();grant(s,'1000');act(s,'stock.buy',{symbol:'0700.HK',amount:'200'});const o=s.orders[0];assert.equal(s.reservedCents,20000);assert.equal(s.cashCents,100000);assert.equal(derived(s).availableCents,80000);
 o.targetDate='2026-10-13';
 // Entered in one batch, newest first: the order still uses its own session close.
 act(s,'quote.batch',{quotes:[{symbol:'0700.HK',date:'2026-10-14',price:500},{symbol:'0700.HK',date:o.targetDate,price:400}]},'dad');
 assert.equal(o.status,'filled');assert.equal(o.priceDate,o.targetDate);assert.equal(o.rolledFrom,undefined);assert.equal(s.reservedCents,0);assert.equal(s.cashCents,80000);assert.equal(s.positions[0].qtyMicro,500000);
 assert.equal(derived(s).netWorthCents,105000); // valued at the later market close at 500
});
test('US stock uses USD 1 = O$8 and records closing date',()=>{
 const s=init();grant(s,'800');act(s,'stock.buy',{symbol:'AAPL',amount:'800'});const o=s.orders[0];o.targetDate='2026-10-13';act(s,'quote.set',{symbol:'AAPL',date:o.targetDate,price:200},'dad');assert.equal(o.status,'filled');assert.equal(s.positions[0].qtyMicro,500000);assert.equal(s.cashCents,0);assert.equal(derived(s).netWorthCents,80000);
});
test('sell reservations prevent overselling same position',()=>{
 const s=init();grant(s,'1000');act(s,'stock.buy',{symbol:'2800.HK',amount:'100'});const o=s.orders[0];o.targetDate='2026-10-13';act(s,'quote.set',{symbol:'2800.HK',date:o.targetDate,price:20},'dad');act(s,'stock.sell',{symbol:'2800.HK',qty:3});assert.throws(()=>act(s,'stock.sell',{symbol:'2800.HK',qty:3}));
});
test('multiple purchase requests cannot overcommit available cash before approval',()=>{
 const s=init();grant(s,'100');act(s,'purchase.request',{name:'toy alpha',amount:'80'});
 assert.throws(()=>act(s,'purchase.request',{name:'toy beta',amount:'80'}),/可用余额不足/);
 assert.equal(s.purchaseRequests.length,1);assert.equal(derived(s).availableCents,2000);
 act(s,'purchase.approve',{id:s.purchaseRequests[0].id},'dad');assert.equal(s.cashCents,2000);
});
test('maturity runs only once',()=>{
 const s=init();grant(s,'100');act(s,'fixed.open',{amount:'100',term:'3'});const f=s.fixed[0];f.maturity='2000-01-01';maintenance(s);const a=s.cashCents;maintenance(s);assert.equal(s.cashCents,a);assert.equal(f.status,'matured');
});
test('only dad may approve or set quotes',()=>{
 const s=init();assert.throws(()=>act(s,'cash.grant',{amount:'500'}));assert.throws(()=>act(s,'quote.set',{symbol:'AAPL',date:'2026-11-17',price:250}));
});

test('HK and US pre-open and intraday orders use same-day close; after close use next session',()=>{
 const T=s=>new Date(s);
 assert.deepEqual(orderTarget('HK',T('2026-11-17T00:45:00Z')).date,'2026-11-17');
 assert.equal(orderTarget('HK',T('2026-11-17T07:00:00Z')).date,'2026-11-17');
 assert.equal(orderTarget('HK',T('2026-11-17T08:15:00Z')).date,'2026-11-18');
 assert.equal(orderTarget('US',T('2026-11-17T13:00:00Z')).date,'2026-11-17');
 assert.equal(orderTarget('US',T('2026-11-17T16:00:00Z')).date,'2026-11-17');
 assert.equal(orderTarget('US',T('2026-11-17T22:00:00Z')).date,'2026-11-18');
});
test('US DST works; HK and NYSE exchange holidays and early closings are honored',()=>{
 assert.equal(orderTarget('US',new Date('2026-07-15T12:00:00Z')).date,'2026-07-15');
 assert.equal(orderTarget('US',new Date('2026-07-15T21:00:00Z')).date,'2026-07-16');
 assert.equal(orderTarget('US',new Date('2026-11-26T16:00:00Z')).date,'2026-11-27');
 assert.equal(orderTarget('US',new Date('2026-11-27T17:00:00Z')).date,'2026-11-27'); // 12:00 ET on half day
 assert.equal(orderTarget('US',new Date('2026-11-27T18:30:00Z')).date,'2026-11-30'); // after 13:00 ET
 assert.equal(orderTarget('HK',new Date('2026-12-24T04:20:00Z')).date,'2026-12-28'); // 12:20 HKT, half day closed
 assert.equal(orderTarget('HK',new Date('2026-02-17T02:00:00Z')).date,'2026-02-20'); // Chinese New Year
});
test('cannot mark partial session price as final close or cancel after target session close',()=>{
 assert.equal(closeIsFinal('HK','2026-11-17',new Date('2026-11-17T07:30:00Z')),false);
 // V1.7: HKEX closing auction ends 16:08–16:10 HKT and Yahoo's HK feed lags ~15 min,
 // so 16:05 / 16:30 HKT are NOT final yet; 17:00 HKT (close + 60 min) is.
 assert.equal(closeIsFinal('HK','2026-11-17',new Date('2026-11-17T08:05:00Z')),false);
 assert.equal(closeIsFinal('HK','2026-11-17',new Date('2026-11-17T08:30:00Z')),false);
 assert.equal(closeIsFinal('HK','2026-11-17',new Date('2026-11-17T09:00:00Z')),true);
 assert.equal(closeIsFinal('HK','2026-12-24',new Date('2026-12-24T04:30:00Z')),false); // half day 12:30 HKT
 assert.equal(closeIsFinal('HK','2026-12-24',new Date('2026-12-24T05:00:00Z')),true);  // half day 13:00 HKT
 assert.equal(closeIsFinal('US','2026-11-17',new Date('2026-11-17T21:30:00Z')),false); // 16:30 EST
 assert.equal(closeIsFinal('US','2026-11-17',new Date('2026-11-17T22:00:00Z')),true);  // 17:00 EST
 assert.equal(orderCanCancel('HK','2026-11-17',new Date('2026-11-17T07:50:00Z')),true);
 assert.equal(orderCanCancel('HK','2026-11-17',new Date('2026-11-17T08:10:00Z')),false);
 const s=init();assert.throws(()=>act(s,'quote.set',{symbol:'AAPL',date:'2099-01-02',price:200},'dad'));
});
test('exchange holiday rolls at once; a missing close waits, a session without any close uses the first later close',()=>{
 const make=()=>{const s=init();grant(s,'1000');act(s,'stock.buy',{symbol:'AAPL',amount:'200'});const order=s.orders[0];order.targetDate='2026-11-26';return {s,order};};
 // Known holiday (Thanksgiving): moved to the next session immediately.
 const late=make();settleOrders(late.s,new Date('2026-11-28T00:00:00Z'));
 assert.deepEqual([late.order.targetDate,late.order.rolledFrom,late.order.status],['2026-11-27','2026-11-26','pending']);
 // The 27 Nov close has not arrived and nothing later is known: keep waiting, then fill at it.
 ingestHistories(late.s,[{symbol:'AAPL',rows:[]}],new Date('2026-11-30T12:00:00Z'));
 assert.equal(late.order.status,'pending');
 ingestHistories(late.s,[{symbol:'AAPL',rows:[{date:'2026-11-27',priceMilli:380000},{date:'2026-11-30',priceMilli:400000}]}],new Date('2026-12-02T00:00:00Z'));
 assert.deepEqual([late.order.status,late.order.priceDate,late.order.priceMilli],['filled','2026-11-27',380000]);
 // No bar for 27 Nov at all while 30 Nov exists: the stock did not trade that day.
 const gap=make();
 ingestHistories(gap.s,[{symbol:'AAPL',rows:[{date:'2026-11-30',priceMilli:400000}]}],new Date('2026-12-02T00:00:00Z'));
 assert.deepEqual([gap.order.status,gap.order.targetDate,gap.order.rolledFrom,gap.order.priceDate,gap.order.priceMilli],['filled','2026-11-30','2026-11-26','2026-11-30',400000]);
});
test('watchlist is capped at ten, supports Yahoo securities from any exchange; trades remain HK/US only',()=>{
 const s=init();const sec=n=>({symbol:`TEST${n}.T`,name:`测试公司 ${n}`,market:'OTHER',currency:'JPY',quoteType:'EQUITY',exchange:'Tokyo',zone:'Asia/Tokyo'});
 for(let n=0;n<10;n++)act(s,'watch.add',{verifiedSecurity:sec(n)});
 assert.equal(s.watchlist.length,10);assert.equal(view(s,'kid').watchlist.length,10);
 assert.throws(()=>act(s,'watch.add',{verifiedSecurity:sec(11)}),/最多/);
 assert.throws(()=>act(s,'stock.buy',{symbol:'TEST0.T',amount:'100'}),/港股/);
 act(s,'watch.remove',{symbol:'TEST0.T'});act(s,'watch.add',{verifiedSecurity:sec(11)});assert.equal(s.watchlist.length,10);
});
test('watchlist daily weekly ytd results use price history; insufficient data does not invent returns',()=>{
 const s=init();act(s,'watch.add',{verifiedSecurity:{symbol:'AAPL',name:'Apple',market:'US',currency:'USD',quoteType:'EQUITY'}});
 ingestHistories(s,[{symbol:'AAPL',rows:[
   {date:'2025-12-31',priceMilli:100000},{date:'2026-11-09',priceMilli:110000},
   {date:'2026-11-10',priceMilli:113000},{date:'2026-11-11',priceMilli:115000},
   {date:'2026-11-12',priceMilli:118000},{date:'2026-11-13',priceMilli:120000},
   {date:'2026-11-16',priceMilli:125000}
 ]}],new Date('2026-11-17T22:00:00Z'));
 const w=view(s,'kid').watchlist[0];assert.equal(w.performance.day,4.17);assert.equal(w.performance.week,13.64);assert.equal(w.performance.ytd,25);
 const s2=init();act(s2,'watch.add',{verifiedSecurity:{symbol:'AAPL',name:'Apple',market:'US',currency:'USD',quoteType:'EQUITY'}});
 assert.equal(view(s2,'kid').watchlist[0].performance.ytd,null);
});
test('quote parser excludes unfinished session and includes completed closing date',()=>{
 const epoch=Math.floor(Date.parse('2026-11-17T14:30:00Z')/1000); // 09:30 EST
 const sample={chart:{result:[{meta:{},timestamp:[epoch],indicators:{quote:[{close:[255.12]}]}}]}};
 const sec={symbol:'AAPL',market:'US',currency:'USD',zone:'America/New_York'};
 assert.equal(parseDailyChart(sample,sec,new Date('2026-11-17T16:00:00Z')).length,0);
 assert.equal(parseDailyChart(sample,sec,new Date('2026-11-17T21:10:00Z')).length,0); // 16:10 EST: auction prints may still update
 assert.equal(parseDailyChart(sample,sec,new Date('2026-11-17T22:10:00Z')).length,1); // 17:10 EST: final
});
test('V1.7: a HK order cannot fill from a delayed pre-auction price inside the settlement window',()=>{
 const s=init();grant(s,'1000');act(s,'stock.buy',{symbol:'0700.HK',amount:'500'});
 const o=s.orders[0];o.targetDate='2026-11-17';
 // 16:20 HKT: Yahoo still shows a delayed continuous-session price for "today"
 ingestHistories(s,[{symbol:'0700.HK',rows:[{date:'2026-11-17',priceMilli:500000}]}],new Date('2026-11-17T08:20:00Z'));
 assert.equal(o.status,'pending');
 // 17:05 HKT: the closing-auction price is final
 ingestHistories(s,[{symbol:'0700.HK',rows:[{date:'2026-11-17',priceMilli:502000}]}],new Date('2026-11-17T09:05:00Z'));
 assert.equal(o.status,'filled');assert.equal(o.priceMilli,502000);
});
test('V1.7: loan "pay off all" settles the exact cent amount after accrual',()=>{
 const s=init();grant(s,'1000');act(s,'loan.request',{amount:'100'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 const l=s.loans[0];l.interestMicroCents=347_400_000; // O$3.474 accrued: UI shows O$3.5
 act(s,'loan.repay',{id:l.id,all:true});
 assert.equal(l.status,'repaid');assert.equal(l.principalCents,0);assert.equal(s.cashCents,100000+10000-10347);
 assert.throws(()=>act(s,'loan.repay',{id:l.id,all:true}),/未找到/);
});
test('V1.7: only HK/USD and US/USD securities can be registered for trading',()=>{
 const s=init();
 assert.throws(()=>act(s,'security.register',{verifiedSecurity:{symbol:'7203.T',name:'Toyota',market:'OTHER',currency:'JPY',quoteType:'EQUITY'}}),/只能加入自选/);
 assert.equal(s.securities?.['7203.T'],undefined);
 act(s,'security.register',{verifiedSecurity:{symbol:'MSFT',name:'Microsoft',market:'US',currency:'USD',quoteType:'EQUITY'}});
 assert.equal(view(s,'kid').symbols.find(x=>x.symbol==='MSFT').tradable,true);
});
