// V2.0.2: an order fills at the first close after it was placed. Calendar gaps
// (unknown holidays, special closures, suspensions) roll to the first later close;
// NYSE and HKEX half-day rules replace the yearly calendar update; the parent can
// cancel an order that never gets a close.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,ingestHistories,settleOrders,view,derived} from '../lib/core.mjs';
import {calendarRules,tradingDay,closeMinute,orderTarget,orderCanCancel,closeIsFinal} from '../lib/market.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const NativeDate=globalThis.Date;
let sequence=0;
function at(iso,fn){
 globalThis.Date=class extends NativeDate{
  constructor(...args){super(...(args.length?args:[iso]));}
  static now(){return NativeDate.parse(iso);}
 };
 try{return fn();}finally{globalThis.Date=NativeDate;}
}
const act=(s,role,name,payload={})=>runAction(s,role,name,payload,`release-202-${++sequence}`);
function bank(when='2026-11-16T03:00:00Z',amount='1000'){
 return at(when,()=>{const s=initialState();setup(s,'t','t','release-202-parent-password','123456');act(s,'dad','cash.grant',{amount});return s;});
}
const ingest=(s,when,symbol,rows)=>at(when,()=>ingestHistories(s,[{symbol,rows}]));
const sorted=set=>[...set].sort();

test('NYSE rules reproduce the official 2026–2028 schedule and continue it (verified against pandas_market_calendars to 2099)',()=>{
 const official={
  holidays:'2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25',
  half:'2026-11-27 2026-12-24 2027-11-26 2028-07-03 2028-11-24'};
 for(const kind of ['holidays','half']){
  const rules=[2026,2027,2028].flatMap(y=>[...calendarRules('US',y)[kind]]).filter(d=>![0,6].includes(new Date(d+'T12:00:00Z').getUTCDay()));
  assert.deepEqual(rules.sort(),official[kind].split(' '),kind);
 }
 assert.deepEqual(sorted(calendarRules('US',2029).holidays),['2029-01-01','2029-01-15','2029-02-19','2029-03-30','2029-05-28','2029-06-19','2029-07-04','2029-09-03','2029-11-22','2029-12-25']);
 assert.deepEqual(sorted(calendarRules('US',2029).half),['2029-07-03','2029-11-23','2029-12-24']);
 // Saturday holidays close the Friday before; New Year's Day on a Saturday closes nothing.
 for(const d of ['2032-06-18','2032-12-24'])assert.equal(tradingDay('US',d),false,d);
 assert.equal(tradingDay('US','2032-12-31'),true);
 assert.equal(closeMinute('US','2032-12-24'),16*60,'Christmas Eve that is itself the holiday is not also a half-day');
 assert.equal(closeMinute('US','2029-11-23'),13*60);
 assert.equal(orderTarget('US',new Date('2029-11-23T18:30:00Z')).date,'2029-11-26','13:30 ET on a rule-based half-day is after the close');
 assert.equal(closeIsFinal('US','2029-11-23',new Date('2029-11-23T19:00:00Z')),true,'final one hour after the 13:00 close');
});

test('HKEX half-day rules reproduce 2026–2027 and keep the eves of Lunar New Year, Christmas and New Year later on',()=>{
 assert.deepEqual([2026,2027].flatMap(y=>[...calendarRules('HK',y).half]).sort(),['2026-02-16','2026-12-24','2026-12-31','2027-02-05','2027-12-24','2027-12-31']);
 assert.deepEqual(sorted(calendarRules('HK',2028).half),['2028-01-25'],'24 and 31 Dec 2028 are Sundays');
 assert.deepEqual(sorted(calendarRules('HK',2029).half),['2029-02-12','2029-12-24','2029-12-31']);
 assert.deepEqual(sorted(calendarRules('HK',2030).half),['2030-12-24','2030-12-31'],'Lunar New Year eve 2030 is a Saturday');
 assert.deepEqual(sorted(calendarRules('HK',2034).half),[],'2034: every eve falls on a weekend; the Friday before is a full day');
 assert.equal(closeMinute('HK','2028-01-25'),12*60);
 assert.equal(orderTarget('HK',new Date('2028-01-25T04:30:00Z')).date,'2028-01-26','12:30 HKT on Lunar New Year eve is after the close');
 // HKEX full-day holidays after 2027 are not guessed: they roll (next test).
 assert.equal(calendarRules('HK',2028).holidays.size,0);
 assert.equal(tradingDay('HK','2028-04-04'),true);
});

test('an HK holiday the calendar does not know fills at the next real close, never at an already published one',()=>{
 const s=bank('2028-03-31T03:00:00Z');
 // Monday 3 April 2028 after the close: the calendar names Tuesday 4 April (Ching Ming, really closed).
 at('2028-04-03T09:30:00Z',()=>act(s,'kid','stock.buy',{symbol:'0700.HK',amount:'300'}));
 const o=s.orders[0];
 assert.deepEqual([o.targetDate,o.targetSession],['2028-04-04','afterclose']);
 // 17:30 HKT on the holiday: Yahoo has no bar for 4 April and nothing later yet, so the order waits.
 ingest(s,'2028-04-04T09:30:00Z','0700.HK',[{date:'2028-04-03',priceMilli:300000}]);
 assert.deepEqual([o.status,o.reason,o.rolledFrom],['pending',undefined,undefined]);
 assert.equal(at('2028-04-04T09:30:00Z',()=>orderCanCancel('HK',o.targetDate)),false,'the kid\'s cancel window ended at 16:00');
 // 17:30 HKT next day: the series now continues on 5 April, so 4 April had no trading.
 ingest(s,'2028-04-05T09:30:00Z','0700.HK',[{date:'2028-04-03',priceMilli:300000},{date:'2028-04-05',priceMilli:250000}]);
 assert.deepEqual([o.status,o.rolledFrom,o.targetDate,o.priceDate,o.priceMilli],['filled','2028-04-04','2028-04-05','2028-04-05',250000]);
 assert.equal(s.positions[0].qtyMicro,1200000,'O$300 at HK$250 = 1.2 shares; the HK$300 close known at placement was not used');
 assert.deepEqual([s.cashCents,s.reservedCents],[70000,0]);
 assert.match(s.audit.find(a=>a.type==='stock.close.roll').summary,/0700\.HK: 2028-04-04 → 2028-04-05/);
});

test('a US special closure rolls both of the day\'s orders to the next close',()=>{
 const s=bank('2029-01-08T15:00:00Z','2000');
 // Two AAPL orders before an unscheduled closure on Wednesday 10 January 2029 (e.g. a national day of mourning).
 at('2029-01-10T02:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'AAPL',amount:'800'}));
 const first=s.orders[0];
 at('2029-01-10T03:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'AAPL',amount:'800'}));
 const second=s.orders[0];
 assert.equal(first.targetDate,'2029-01-10');assert.equal(second.targetDate,'2029-01-10');
 ingest(s,'2029-01-11T22:30:00Z','AAPL',[{date:'2029-01-09',priceMilli:100000},{date:'2029-01-11',priceMilli:200000}]);
 for(const o of [first,second])assert.deepEqual([o.status,o.rolledFrom,o.priceDate],['filled','2029-01-10','2029-01-11']);
 assert.equal(s.positions[0].qtyMicro,1000000,'2 × O$800 at US$200 × 8');
 assert.ok(Date.parse(first.filledAt)<=Date.parse(second.filledAt));
 const fills=s.ledger.filter(l=>l.type==='stock.buy');assert.equal(fills.length,2);
});

test('the roll uses stored daily history when old settlement quotes were already pruned',()=>{
 const s=bank('2026-11-16T03:00:00Z');
 at('2026-11-16T03:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'AAPL',amount:'400'}));
 const o=s.orders[0];
 // A legacy order from months ago whose session had no close; only the history series remains.
 o.targetDate='2026-06-17';
 s.priceHistory.AAPL=[{date:'2026-06-16',priceMilli:90000},{date:'2026-06-18',priceMilli:100000},{date:'2026-06-22',priceMilli:110000}];
 at('2026-11-16T03:00:00Z',()=>settleOrders(s));
 assert.deepEqual([o.status,o.rolledFrom,o.priceDate,o.priceMilli],['filled','2026-06-17','2026-06-18',100000]);
 assert.equal(o.qtyMicro,500000,'O$400 at US$100 × 8 = 0.5 shares');
 assert.equal(s.quotes['AAPL|2026-06-18'].currency,'USD');
});

test('parent cancel: only for orders past their close, releases the reservation, notifies Olivia and unblocks later orders',()=>{
 const s=bank('2026-11-16T03:00:00Z');
 // A suspended stock: no close on 17 Nov and none afterwards.
 at('2026-11-17T02:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'2800.HK',amount:'200'}));
 const stuck=s.orders[0];
 at('2026-11-17T02:30:00Z',()=>assert.throws(()=>act(s,'dad','order.cancel',{id:stuck.id}),/收市前请让 Olivia 自己撤单/));
 assert.throws(()=>at('2026-11-18T02:00:00Z',()=>act(s,'kid','order.cancel',{id:stuck.id})),/只有家长/);
 at('2026-11-18T02:00:00Z',()=>assert.throws(()=>act(s,'kid','stock.cancel',{id:stuck.id}),/已收盘，不能取消/));
 // A later order on the same stock waits behind it.
 at('2026-11-18T02:30:00Z',()=>act(s,'kid','stock.buy',{symbol:'2800.HK',amount:'100'}));
 const later=s.orders[0];
 assert.equal(derived(s).availableCents,70000);
 at('2026-11-18T03:00:00Z',()=>act(s,'dad','order.cancel',{id:stuck.id}));
 assert.deepEqual([stuck.status,stuck.reason],['cancelled','家长已撤销']);
 assert.equal(s.reservedCents,10000);assert.equal(derived(s).availableCents,90000);
 const note=s.notifications.find(n=>n.title==='股票订单已撤销');
 assert.equal(note.target,'stocks');assert.match(note.detail,/买入 2800\.HK.*成交日 2026-11-17.*O\$ 200\.0 已退回活期/);
 assert.throws(()=>at('2026-11-18T03:00:00Z',()=>act(s,'dad','order.cancel',{id:stuck.id})),/订单已处理/);
 // Trading resumes: the later order fills at its own session.
 ingest(s,'2026-11-18T10:00:00Z','2800.HK',[{date:'2026-11-18',priceMilli:25000}]);
 assert.deepEqual([later.status,later.priceDate,later.rolledFrom],['filled','2026-11-18',undefined]);
});

test('parent cancel of a stuck sell unfreezes the shares',()=>{
 const s=bank('2026-11-16T01:00:00Z');
 at('2026-11-16T01:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'0700.HK',amount:'100'}));
 ingest(s,'2026-11-16T10:00:00Z','0700.HK',[{date:'2026-11-16',priceMilli:100000}]);
 at('2026-11-17T01:00:00Z',()=>act(s,'kid','stock.sell',{symbol:'0700.HK',qty:'1'}));
 const sell=s.orders[0];
 at('2026-11-17T02:00:00Z',()=>assert.throws(()=>act(s,'kid','stock.sell',{symbol:'0700.HK',qty:'0.5'}),/可卖出持仓不足/));
 at('2026-11-19T02:00:00Z',()=>act(s,'dad','order.cancel',{id:sell.id}));
 assert.equal(sell.status,'cancelled');
 assert.match(s.notifications[0].detail,/卖出 0700\.HK.*股票已解冻/);
 at('2026-11-19T02:00:00Z',()=>act(s,'kid','stock.sell',{symbol:'0700.HK',qty:'1'}));
 assert.equal(s.positions[0].qtyMicro,1000000);
});

test('waiting needs no warning; only an order blocked behind a parent review is labelled',()=>{
 const s=bank('2026-11-16T03:00:00Z');
 at('2026-11-17T02:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'0700.HK',amount:'100'}));
 const first=s.orders[0];
 at('2026-11-17T09:30:00Z',()=>act(s,'kid','stock.buy',{symbol:'0700.HK',amount:'100'}));
 const second=s.orders[0];
 assert.equal(second.targetDate,'2026-11-18');
 ingest(s,'2026-11-18T03:00:00Z','0700.HK',[]);
 assert.equal(first.reason,undefined);assert.equal(second.reason,undefined);
 // A pre-upgrade out-of-order fill on this stock now needs the parent: say so on the queue.
 s.orders.push({id:'legacy-fill',symbol:'0700.HK',side:'buy',budgetCents:0,targetDate:'2026-11-17',status:'filled',priceDate:'2026-11-18',submittedAt:'2026-11-17T08:00:00Z',qtyMicro:0,filledCents:0});
 ingest(s,'2026-11-18T03:00:00Z','0700.HK',[]);
 assert.match(first.reason,/核对历史成本/);
 assert.match(second.reason,/更早的订单需要家长处理/);
});

async function mount(state,role,iso){
 const root={innerHTML:'',addEventListener(){},querySelectorAll(){return [];}};
 const fixed=NativeDate.parse(iso);
 const FixedDate=class extends NativeDate{constructor(...a){super(...(a.length?a:[fixed]));}static now(){return fixed;}};
 const context=vm.createContext({document:{getElementById:id=>id==='root'?root:{textContent:'',className:''}},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:at(iso,()=>view(state,role))})),console,setTimeout,clearTimeout,location:{hostname:'localhost'},Date:FixedDate});
 vm.runInContext(source,context);
 for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return code=>vm.runInContext(code,context);
}

test('pages: a rolled order explains itself; overdue orders offer cancel (not roll); manual closes start at the oldest gap',async()=>{
 const s=bank('2028-03-31T03:00:00Z','2000');
 at('2028-04-03T09:30:00Z',()=>act(s,'kid','stock.buy',{symbol:'0700.HK',amount:'300'}));
 const rolled=s.orders[0];
 ingest(s,'2028-04-05T09:30:00Z','0700.HK',[{date:'2028-04-03',priceMilli:300000},{date:'2028-04-05',priceMilli:250000}]);
 at('2028-04-05T02:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'AAPL',amount:'100'}));
 at('2028-04-06T02:00:00Z',()=>act(s,'kid','stock.buy',{symbol:'2800.HK',amount:'100'}));
 const kid=await mount(s,'kid','2028-04-07T04:00:00Z');
 const orders=kid("ordersCard()");
 assert.match(orders,/成交日 2028-04-05<\/span>[^<]*<span class="nw">预留 O\$ 300\.0<\/span><br>原定 2028-04-04 休市或无收盘价，已顺延<br>/,'the roll note is its own wrapping line');
 assert.match(orders,/2028-04-05 收盘价/);
 // The buy form states the basic rule; a roll is explained on the order itself (above).
 assert.match(kid("tab='stocks';render();document.getElementById('root').innerHTML"),/收盘前下单按当天收盘价成交，收盘后下单按下一个交易日的收盘价/);
 const dad=await mount(s,'dad','2028-04-07T04:00:00Z');
 const page=dad('parentStocks()');
 assert.doesNotMatch(page,/data-act="order\.roll"/);
 assert.match(page,/data-act="order\.cancel" data-id="[^"]+"/);
 assert.equal((page.match(/data-act="order\.cancel"/g)||[]).length,2,'both overdue orders (5 Apr US, 6 Apr HK) can be cancelled');
 assert.match(page,/<option value="AAPL" selected>/,'the form starts at the earliest overdue session');
 assert.match(page,/name="date" type="date" required value="2028-04-05"/);
 assert.match(page,/从最早缺价的交易日开始逐日登记/);
 assert.match(page,/一旦之后出现收盘价，订单自动按之后第一个收盘价成交/);
 assert.match(source,/'order\.cancel':'撤销这笔订单？/);
 assert.equal(rolled.status,'filled');
});
