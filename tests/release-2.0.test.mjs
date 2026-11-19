// V2.0.0 regressions: list defaults, jsonb-safe text, bounded quotes and Yahoo 404 (the V2.0.0
// calendar notice was removed in V2.0.2: later calendars follow rules and missing closes roll).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction,view,ingestHistories,pruneQuotes,lastQuote} from '../lib/core.mjs';
import {tradingDay} from '../lib/market.mjs';
import {lookupYahooSymbol,searchYahoo} from '../lib/quotes.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const NativeDate=Date;
let sequence=0;
const act=(s,action,payload={},role='kid',key=`release-2-0-${++sequence}`)=>runAction(s,role,action,payload,key);
function bank(){const s=initialState();setup(s,'t','t','release-two-parent-password','123456');return s;}
function fixedDateClass(iso){const now=NativeDate.parse(iso);return class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};}
async function mount(state,role='kid',iso=null){
 const root={innerHTML:'',addEventListener(){},querySelectorAll(){return [];}};
 const globals={document:{getElementById:id=>id==='root'?root:{textContent:'',className:''}},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}};
 if(iso)globals.Date=fixedDateClass(iso);
 const context=vm.createContext(globals);
 vm.runInContext(source,context);
 for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {run:code=>vm.runInContext(code,context)};
}

test('parent task catalogue and pending-order queue keep items older than 30 days visible by default',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'500'},'dad');
 act(s,'task.create',{name:'整理书架',unit:'次',amount:'2'},'dad');
 act(s,'stock.buy',{symbol:'0700.HK',amount:'100'});
 const old=new Date(Date.now()-40*86400000).toISOString();
 s.tasks[0].createdAt=s.tasks[0].updatedAt=old;s.orders[0].submittedAt=old;
 const parent=await mount(s,'dad');
 const tasks=parent.run('parentTasks()');
 assert.match(tasks,/data-op="task.update"/,'an open task created 40 days ago can still be edited');
 assert.doesNotMatch(tasks,/当前时间范围内没有记录|record-time-hint/);
 const orders=parent.run('parentStocks()');
 assert.match(orders,/目标交易日/,'an unsettled 40-day-old order stays in the parent queue');
 assert.doesNotMatch(orders,/当前时间范围内没有记录/);
 // The filters remain available and still work when chosen explicitly.
 parent.run("recordState('parent-tasks').period='30'");
 assert.match(parent.run('parentTasks()'),/data-record-key="parent-tasks" data-record-all-time/);
 // Olivia's own histories keep the documented 30-day default.
 const kid=await mount(s,'kid');
 assert.equal(kid.run("recordState('orders').period"),'30');
});

test('V2.0.2: no calendar-expiry notice or coverage field remains; the calendar never needs a yearly update',async()=>{
 const s=bank();
 assert.equal(view(s,'dad').calendarCoverage,undefined);
 assert.equal(view(s,'kid').calendarCoverage,undefined);
 for(const iso of ['2027-11-01T04:00:00Z','2028-10-02T04:00:00Z','2031-06-02T04:00:00Z']){
  const page=(await mount(s,'dad',iso)).run('parentStocks()');
  assert.doesNotMatch(page,/calendar-notice|交易日历只覆盖到|lib\/market\.mjs/);
 }
 assert.doesNotMatch(source,/calendarNotice/);
});

test('stored text never contains NUL or a split emoji, which PostgreSQL jsonb would reject',()=>{
 const s=bank();act(s,'cash.grant',{amount:'500',note:'红包\u0000'},'dad');
 const cut='小'.repeat(89)+'🦄'; // 91 UTF-16 units: the 90-unit limit falls inside the emoji
 act(s,'purchase.request',{name:cut,amount:'10',note:'x\u0000y',link:'https://example.com/'+'a'.repeat(379)+'🎁'});
 act(s,'wish.add',{name:'\udc00孤立低位'+'🎀',amount:'20'});
 act(s,'task.propose',{name:'整理\u0000书架',unit:'次',amount:'1',reason:'🍀'.repeat(130)});
 const r=s.purchaseRequests[0];
 assert.equal(r.name,'小'.repeat(89),'the half emoji is dropped instead of stored');
 assert.equal(r.note,'xy');assert.ok(!r.link.endsWith('\ud83c'));
 assert.equal(s.wishes[0].name,'孤立低位🎀');
 assert.equal(s.taskProposals[0].name,'整理书架');
 assert.equal(s.taskProposals[0].reason,'🍀'.repeat(120));
 const stored=JSON.stringify(s);
 assert.doesNotMatch(stored,/\\u0000/);
 assert.doesNotMatch(stored,/\\ud[89a-f][0-9a-f]{2}/i,'no unpaired surrogate escapes remain');
});

test('idempotency keys must be printable ASCII so they can be stored in jsonb',()=>{
 const s=bank();
 for(const key of ['short','bad key with space','控制字符-1234','abc\u0000defgh','x'.repeat(101)])
  assert.throws(()=>act(s,'cash.grant',{amount:'1'},'dad',key),/唯一标识/,JSON.stringify(key));
 assert.equal(act(s,'cash.grant',{amount:'1'},'dad','0123abcd-ok_key.~').ok,true);
 assert.equal(s.cashCents,100);
});

test('manual quote source text is clamped like other stored text',()=>{
 const s=bank();
 act(s,'quote.set',{symbol:'0700.HK',date:'2026-11-17',price:'500',source:'人工'.repeat(80)+'\u0000'},'dad');
 assert.equal(s.quotes['0700.HK|2026-11-17'].source.length,80);
});

test('settlement quotes stay bounded: old closes are pruned except pending targets and each latest close',()=>{
 const s=bank();
 const q=(symbol,date)=>({symbol,date,priceMilli:100000,currency:symbol.endsWith('.HK')?'HKD':'USD',final:true});
 for(const date of ['2026-01-05','2026-03-02','2026-06-01','2026-11-16'])s.quotes['0700.HK|'+date]=q('0700.HK',date);
 s.quotes['AAPL|2025-12-01']=q('AAPL','2025-12-01'); // a security no longer tracked: its latest close stays
 s.orders.unshift({id:'old-pending',symbol:'0700.HK',side:'buy',budgetCents:100,targetDate:'2026-03-02',status:'pending',submittedAt:'2026-03-01T01:00:00Z'});
 assert.equal(pruneQuotes(s,'2026-07-20'),2);
 assert.deepEqual(Object.keys(s.quotes).sort(),['0700.HK|2026-03-02','0700.HK|2026-11-16','AAPL|2025-12-01']);
 assert.equal(lastQuote(s,'AAPL').date,'2025-12-01');
});

test('a long-running bank keeps about 125 days of settlement quotes per security instead of growing forever',()=>{
 const s=bank();let day=NativeDate.parse('2026-01-02T12:00:00Z'),ingested=0,last=null;
 for(let i=0;i<540;i++,day+=86400000){
  const date=new NativeDate(day).toISOString().slice(0,10);if(!tradingDay('HK',date))continue;
  last={date,priceMilli:100000+i};
  ingestHistories(s,[{symbol:'0700.HK',rows:[last]}],new NativeDate(day+12*3600000));ingested++;
 }
 const kept=Object.keys(s.quotes).filter(k=>k.startsWith('0700.HK|')).length;
 assert.ok(ingested>350,'the simulation spans well over a year of sessions');
 assert.ok(kept<=90,`only the recent window is kept (${kept} of ${ingested})`);
 assert.deepEqual([lastQuote(s,'0700.HK').date,lastQuote(s,'0700.HK').priceMilli],[last.date,last.priceMilli],'latest close remains for valuation');
 assert.ok(s.priceHistory['0700.HK'].length<=560,'performance history keeps its own bound');
});

test('Yahoo 404 is a definite "not found": no second host and no misleading reconnect advice',async()=>{
 const networkFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({chart:{result:null,error:{code:'Not Found'}}}),{status:404});};
 try{
  await assert.rejects(lookupYahooSymbol('NOSUCHTICKER'),error=>{assert.match(error.message,/找不到该证券 NOSUCHTICKER/);assert.doesNotMatch(error.message,/联网|在线验证/);return true;});
  assert.equal(calls,1);
 }finally{globalThis.fetch=networkFetch;}
});

test('a deadline bounds a hanging Yahoo search and still returns the offline directory',async()=>{
 const networkFetch=globalThis.fetch;
 globalThis.fetch=(url,{signal}={})=>new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason)));
 const keepAlive=setInterval(()=>{},250); // AbortSignal.timeout timers are unref'd; a server keeps the loop alive
 try{
  const started=Date.now();
  const r=await searchYahoo('0700',{deadline:Date.now()+1500});
  assert.ok(Date.now()-started<2500,'finished at the deadline');
  assert.equal(r.offline,true);assert.match(r.warning,/超时/);assert.equal(r.results[0].symbol,'0700.HK');
 }finally{clearInterval(keepAlive);globalThis.fetch=networkFetch;}
});
