import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {initialState,setup,runAction,maintenance,view,bankDate,createSession} from '../lib/core.mjs';

// The family's devices are in Hong Kong: date filters and "today" in the page use that calendar.
const savedTZ=process.env.TZ;process.env.TZ='Asia/Hong_Kong';
after(()=>{if(savedTZ===undefined)delete process.env.TZ;else process.env.TZ=savedTZ;});

const NativeDate=Date;
function fixedDateClass(iso){const now=NativeDate.parse(iso);return class FixedDate extends NativeDate{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};}
// Server code reads the global clock (new Date(), Date.now()); install a fixed instant.
function clock(iso){globalThis.Date=fixedDateClass(iso);}
function realClock(){globalThis.Date=NativeDate;}
let seq=0;const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,'v199-key-'+(++seq));
function bank(){const s=initialState();setup(s,'t','t','a-strong-local-password','123456');return s;}

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
async function mount(state,role='kid',NOW='2026-11-18T04:00:00.000Z'){
 clock(NOW); // view() runs server-side code; keep it on the same instant as the page
 try{
  const root={innerHTML:'',addEventListener(){},querySelectorAll(){return [];}};
  const toast={textContent:'',className:''};
  const context=vm.createContext({Date:fixedDateClass(NOW),document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
   fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
  vm.runInContext(source,context);
  for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(root.innerHTML,'bootstrap rendered');
  return {run:code=>vm.runInContext(code,context)};
 }finally{realClock();}
}

test('fixed deposits and loans use the Hong Kong calendar day, including 00:00–08:00 HKT',()=>{
 assert.equal(bankDate(new NativeDate('2026-11-17T23:30:00Z')),'2026-11-18');
 assert.equal(bankDate(new NativeDate('2026-11-18T15:59:59Z')),'2026-11-18');
 assert.equal(bankDate(new NativeDate('2026-11-18T16:00:00Z')),'2026-11-19');
 try{
  clock('2026-11-17T23:30:00Z'); // 07:30 HKT on 18 Nov: UTC is still 17 Nov
  const s=bank();act(s,'cash.grant',{amount:'1000'},'dad');
  act(s,'fixed.open',{amount:'100',term:'3'});
  const f=s.fixed[0];assert.equal(f.start,'2026-11-18');assert.equal(f.maturity,'2027-02-18');
  act(s,'loan.request',{amount:'50'});const l=s.loans[0];assert.equal(l.lastAccruedDay,'2026-11-18');
  act(s,'loan.approve',{id:l.id},'dad');assert.equal(l.lastAccruedDay,'2026-11-18');
  clock('2026-11-18T15:30:00Z');maintenance(s); // 23:30 HKT, same Hong Kong day
  assert.equal(l.interestMicroCents,0,'no interest within the borrowing day');
  clock('2026-11-18T16:30:00Z');maintenance(s); // 00:30 HKT on 19 Nov: one day
  assert.equal(l.interestMicroCents,Math.round(5000*2500*1e6/3650000));assert.equal(l.lastAccruedDay,'2026-11-19');
  clock('2027-02-17T00:30:00Z');maintenance(s); // 08:30 HKT on 17 Feb: one Hong Kong day early
  assert.equal(f.status,'active','does not mature on the UTC date');
  clock('2027-02-17T16:05:00Z');maintenance(s); // 00:05 HKT on 18 Feb
  assert.equal(f.status,'matured');assert.equal(f.interestCents,Math.round(10000*500*92/3650000));
 }finally{realClock();}
});

test('a deposit opened at 07:30 in Hong Kong is listed under 今日 with that day as its start',async()=>{
 const NOW='2026-11-17T23:30:00.000Z';let s;
 try{clock(NOW);s=bank();act(s,'cash.grant',{amount:'1000'},'dad');act(s,'fixed.open',{amount:'100',term:'3'});}finally{realClock();}
 const m=await mount(s,'kid',NOW);
 m.run("recordState('fixed').period='today'");
 const html=m.run('fixedPanel()');
 assert.match(html,/data-act="fixed.redeem"/,'visible under the 今日 filter');
 assert.match(html,/2026-11-18 → 2027-02-18/);
 assert.doesNotMatch(html,/record-time-hint/);
});

test('the displayed amount due includes interest through today and equals what pay-off-all deducts',async()=>{
 let s;
 try{
  clock('2026-11-10T02:00:00Z');s=bank();act(s,'cash.grant',{amount:'1000'},'dad');
  act(s,'loan.request',{amount:'100'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
  clock('2026-11-13T02:00:00Z'); // three Hong Kong days later, before any maintenance run
  const stored=JSON.stringify(s.loans);
  const v=view(s,'kid'),shown=v.loans[0],interest=Math.round(shown.interestMicroCents/1e6);
  assert.equal(shown.interestMicroCents,Math.round(10000*2500*3*1e6/3650000));
  assert.equal(interest,21);assert.equal(v.summary.loanInterestCents,21);
  assert.equal(v.summary.netWorthCents,s.cashCents-10000-21);
  assert.equal(JSON.stringify(s.loans),stored,'view never books interest');
  const before=s.cashCents;act(s,'loan.repay',{id:s.loans[0].id,all:true});
  assert.equal(before-s.cashCents,10000+interest,'pay-off-all charges exactly the displayed amount');
  assert.equal(s.loans[0].status,'repaid');
 }finally{realClock();}
 const m=await mount(s,'kid','2026-11-13T02:00:00.000Z');assert.match(m.run('loanPanel()'),/已还清/);
});

test('parent decisions notify Olivia with 家长 wording; no 爸爸 remains in page or server text',()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');
 act(s,'loan.request',{amount:'20'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
 act(s,'task.create',{name:'整理书架',unit:'次',amount:'2'},'dad');act(s,'task.complete',{id:s.tasks[0].id,quantity:'1'});
 act(s,'task.completion.reject',{id:s.taskCompletions[0].id},'dad');
 s.depositRequests=[{id:'legacy-deposit',amountCents:500,note:'',status:'pending',at:'2026-01-01T00:00:00Z'}];
 act(s,'deposit.reject',{id:'legacy-deposit'},'dad');
 const text=s.notifications.map(n=>n.title+' '+n.detail).join('\n');
 assert.match(text,/家长批准了 O\$ 20\.0 的借款/);assert.match(text,/可以问问家长原因/);assert.match(text,/请和家长确认/);
 assert.doesNotMatch(text,/爸爸/);
 assert.doesNotMatch(source,/爸爸/,'app.js');
 assert.doesNotMatch(readFileSync(new URL('../lib/core.mjs',import.meta.url),'utf8'),/爸爸/,'core.mjs');
});

test('settings reject blank or non-numeric rates instead of silently saving 0%',()=>{
 const s=bank();
 for(const payload of [{rate3:''},{rate6:'  '},{rate12:'abc'},{loanAPR:''},{rate3:true}])
  assert.throws(()=>act(s,'settings.update',payload,'dad'),/利率/,JSON.stringify(payload));
 assert.deepEqual({...s.settings.fixedRates},{3:500,6:800,12:1000});assert.equal(s.settings.loanAprBps,2500);
 act(s,'settings.update',{rate12:'7.25',loanAPR:'0'},'dad');
 assert.equal(s.settings.fixedRates[12],725);assert.equal(s.settings.loanAprBps,0,'an explicit zero is still allowed');
});

test('wish progress never shows 100% or "还差 O$ 0.0" before the goal is actually reached',async()=>{
 const make=cash=>{const s=bank();s.cashCents=cash;s.wishes=[{id:'w1',name:'LEGO',goalCents:8000,at:'2026-11-18T03:00:00Z'}];return s;};
 let m=await mount(make(7996));
 for(const html of [m.run('wishes()'),m.run('wishCard()')]){
  assert.match(html,/<b class="num">99%<\/b>/);assert.match(html,/还差 O\$ 0\.1/);assert.doesNotMatch(html,/100%|还差 O\$ 0\.0/);
 }
 assert.match(m.run('wishes()'),/攒钱中/);
 m=await mount(make(8000));assert.match(m.run('wishes()'),/<b class="num">100%<\/b>[\s\S]*钱够啦/);assert.match(m.run('wishes()'),/可以购买/);
 m=await mount(make(4000));assert.match(m.run('wishCard()'),/<b class="num">50%<\/b>/);assert.match(m.run('wishCard()'),/还差 O\$ 40\.0/);
});

test('the loan form never states a larger remaining allowance than the server accepts',async()=>{
 const s=bank();s.cashCents=100000;
 s.loans=[{id:'L1',principalCents:12345,requestedCents:20000,interestMicroCents:0,aprBps:0,status:'active',createdAt:'2026-11-01T00:00:00Z',lastAccruedDay:'2026-11-18'}];
 const html=(await mount(s)).run('loanPanel()'); // exact remaining allowance: O$376.55
 assert.match(html,/本次最多可申请<\/span><b class="num">O\$ 376\.5<\/b>/);
 assert.match(html,/name="amount"[^>]*max="376\.55"/,'the exact cent limit stays usable');
 assert.throws(()=>act(s,'loan.request',{amount:'376.6'}),/目前还可申请 O\$ 376\.5(?!\d)/);
 act(s,'loan.request',{amount:'376.55'});assert.equal(s.loans[0].requestedCents,37655);
});

test('the task price editor uses the same O$0.1 step that the server enforces',async()=>{
 // Create the task on the same fixed instant as the page (the test previously mixed
 // the real clock with the page clock and failed once the real date passed 19 Nov).
 const s=bank();clock('2026-11-18T04:00:00.000Z');try{act(s,'task.create',{name:'叠衬衫',unit:'件',amount:'2.5'},'dad');}finally{realClock();}
 const html=(await mount(s,'dad')).run('parentTasks()');
 assert.match(html,/data-op="task.update"[\s\S]*name="amount" type="number" inputmode="decimal" required min="0\.1" max="10000" step="0\.1" value="2\.5"/);
 assert.throws(()=>act(s,'task.update',{id:s.tasks[0].id,name:'叠衬衫',unit:'件',amount:'2.55',active:'true'},'dad'),/0\.1 的倍数/);
});

test('cancelling a stuck order is offered only after the order\'s own exchange date has passed',async()=>{
 const s=bank();s.cashCents=100000;
 s.orders=[
  {id:'us-live',symbol:'AAPL',side:'buy',budgetCents:1000,targetDate:'2026-11-18',targetSession:'intraday',scheduleBasis:'session-close-v1.2',status:'pending',submittedAt:'2026-11-18T15:00:00Z'},
  {id:'hk-past',symbol:'0700.HK',side:'buy',budgetCents:1000,targetDate:'2026-11-18',targetSession:'intraday',scheduleBasis:'session-close-v1.2',status:'pending',submittedAt:'2026-11-18T03:00:00Z'}];
 s.reservedCents=2000;
 // 01:00 HKT on 19 Nov = 12:00 ET on 18 Nov: the US session is still open.
 let html=(await mount(s,'dad','2026-11-18T17:00:00.000Z')).run('parentStocks()');
 assert.doesNotMatch(html,/data-act="order.cancel" data-id="us-live"/);
 assert.match(html,/data-act="order.cancel" data-id="hk-past"/,'the Hong Kong date has passed');
 assert.doesNotMatch(html,/data-act="order.roll"/,'missing closes roll automatically');
 // 13:30 HKT on 19 Nov = 00:30 ET on 19 Nov: the US date has passed too.
 html=(await mount(s,'dad','2026-11-19T05:30:00.000Z')).run('parentStocks()');
 assert.match(html,/data-act="order.cancel" data-id="us-live"/);
});

const dir=await fs.mkdtemp(join(tmpdir(),'goose-v199-'));
const savedEnv=Object.fromEntries(['BANK_DATA_FILE','DATABASE_URL','NETLIFY'].map(k=>[k,process.env[k]]));
after(async()=>{for(const [k,v] of Object.entries(savedEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await fs.rm(dir,{recursive:true,force:true});});
test('API: Secure session cookie behind an HTTPS proxy; an opaque Origin is a 403, not a parser error',async()=>{
 const file=join(dir,'ledger.json');process.env.BANK_DATA_FILE=file;delete process.env.DATABASE_URL;delete process.env.NETLIFY;
 const s=bank();await fs.writeFile(file,JSON.stringify(s),'utf8');
 const {handleApi}=await import('../lib/api.mjs');
 const login=headers=>handleApi(new Request('http://bank.local/api/login',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({role:'kid',password:'123456'})}));
 let r=await login({'x-forwarded-proto':'https'});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/; Secure/);
 r=await login({'x-forwarded-proto':'https, http'});assert.match(r.headers.get('set-cookie'),/; Secure/);
 r=await login({});assert.equal(r.status,200);assert.doesNotMatch(r.headers.get('set-cookie'),/Secure/);
 r=await login({origin:'null'});assert.equal(r.status,403);assert.equal((await r.json()).error,'访问来源校验失败');
 r=await login({origin:'http://evil.example'});assert.equal(r.status,403);
 r=await login({origin:'http://bank.local'});assert.equal(r.status,200);
});
