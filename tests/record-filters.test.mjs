import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,view} from '../lib/core.mjs';

// node --test isolates test files. Exercise the viewer's calendar in Hong Kong,
// with a fixed clock so these boundary tests never depend on the day they run.
const previousTZ=process.env.TZ;
process.env.TZ='Asia/Hong_Kong';
after(()=>{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;});
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const NOW='2026-11-18T04:00:00.000Z';
async function mount(state=initialState(),role='kid',now=NOW){
 const NativeDate=Date;
 class FixedDate extends NativeDate{
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return NativeDate.parse(now);}
 }
 const handlers={},root={innerHTML:'',addEventListener(type,fn){(handlers[type]??=[]).push(fn);},querySelectorAll(){return [];}};
 const toast={textContent:'',className:''};
 const context=vm.createContext({Date:FixedDate,document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(source,context);
 for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {context,root,handlers,run:code=>vm.runInContext(code,context),json:code=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context))};
}

test('dated lists default to 30 local calendar days; undated, invalid and future records stay accessible in All time',async()=>{
 const m=await mount();
 m.run(`globalThis.rows=${JSON.stringify([
  {id:'today',at:'2026-11-18T00:00:00+08:00'},
  {id:'first-day',at:'2026-10-20T00:00:00+08:00'},
  {id:'too-old',at:'2026-10-19T23:59:59.999+08:00'},
  {id:'tomorrow',at:'2026-11-19T00:00:00+08:00'},
  {id:'undated'},
  {id:'invalid',at:'not-a-date'},
 ])};`);
 assert.equal(m.run("recordState('default-window').period"),'30');
 assert.deepEqual(m.json("recordsPage('default-window',rows).items.map(x=>x.id)"),['today','first-day']);
 assert.deepEqual(m.json("(()=>{const p=recordsPage('default-window',rows);return [p.total,p.allCount,p.hiddenByTime]})()"),[2,6,4]);
 const html=m.run("recordsContent('default-window',rows,x=>'<li>'+x.id+'</li>')");
 assert.match(html,/<option value="30" selected>最近 30 天<\/option>/);
 assert.match(html,/<option value="today">今日<\/option>/);
 assert.match(html,/<option value="year">今年<\/option>/);
 assert.match(html,/筛选 2 \/ 6 条/);
 assert.match(html,/有 4 条记录未显示/);
 assert.match(html,/较早和未标日期的记录/);
 assert.match(html,/data-record-all-time>查看全部时间/);
 m.run("recordState('default-window').period='all'");
 assert.equal(m.run("recordsPage('default-window',rows).total"),6);
 assert.equal(m.run("recordsPage('default-window',rows).hiddenByTime"),0);
 assert.doesNotMatch(m.run("recordsContent('default-window',rows,x=>'<li>'+x.id+'</li>')"),/record-time-hint/);
 m.run("recordState('default-window').period='unknown-period'");
 assert.equal(m.run("recordsPage('default-window',rows).state.period"),'30');
});

test('Today and This year use Hong Kong midnight and year boundaries, not UTC calendar dates',async()=>{
 const m=await mount();
 assert.equal(m.run('new Date().getTimezoneOffset()'),-480);
 m.run(`globalThis.days=${JSON.stringify([
  {id:'before-today',at:'2026-11-17T15:59:59.999Z'},
  {id:'today-start',at:'2026-11-17T16:00:00.000Z'},
  {id:'today-end',at:'2026-11-18T15:59:59.999Z'},
  {id:'tomorrow',at:'2026-11-18T16:00:00.000Z'},
 ])};recordState('today-boundary').period='today';`);
 assert.deepEqual(m.json("recordsPage('today-boundary',days).items.map(x=>x.id)"),['today-end','today-start']);
 m.run(`globalThis.years=${JSON.stringify([
  {id:'last-year',at:'2025-12-31T15:59:59.999Z'},
  {id:'this-year-start',at:'2025-12-31T16:00:00.000Z'},
  {id:'date-only-local',at:'2026-01-01'},
  {id:'this-year-today',at:'2026-11-18T04:00:00.000Z'},
  {id:'future',at:'2027-01-01T00:00:00+08:00'},
  {id:'undated'},
 ])};recordState('year-boundary').period='year';`);
 assert.deepEqual(m.json("recordsPage('year-boundary',years).items.map(x=>x.id)"),['this-year-today','this-year-start','date-only-local']);
 assert.equal(m.run("recordsPage('year-boundary',years).hiddenByTime"),3);
});

test('time-hidden hint recovers only the selected category, resets pagination and updates just that list',async()=>{
 const m=await mount();
 const rows=[...Array.from({length:17},(_,i)=>({id:'recent-'+i,status:'pending',at:'2026-11-18'})),
  ...Array.from({length:12},(_,i)=>({id:'old-'+i,status:'pending',at:'2026-01-01'})),
  ...Array.from({length:4},(_,i)=>({id:'other-'+i,status:'done',at:'2026-01-01'}))];
 m.run(`globalThis.rows=${JSON.stringify(rows)};recordState('inbox').category='pending';recordState('inbox').page=2;recordsList('inbox',rows,x=>'<li>'+x.id+'</li>',{label:'待处理',categories:[['pending','待处理'],['done','已完成']]});`);
 assert.deepEqual(m.json("(()=>{const v=recordViews.get('kid:inbox'),p=recordsPage('inbox',v.items,v.options);return [p.total,p.pages,p.from,p.to,p.hiddenByTime]})()"),[17,2,11,17,12]);
 const before=m.root.innerHTML;
 let focused=false,prevented=false;
 const scope={dataset:{recordList:'inbox'},innerHTML:'',querySelectorAll(){return [];},querySelector(){return {focus(){focused=true;}};}};
 m.root.querySelectorAll=selector=>selector==='[data-record-list]'?[scope]:[];
 const button={dataset:{recordKey:'inbox'},disabled:false};
 for(const handler of m.handlers.click)await handler({target:{closest:selector=>selector==='[data-record-all-time]'?button:null},preventDefault(){prevented=true;}});
 assert.equal(prevented,true);assert.equal(focused,true);
 assert.equal(m.root.innerHTML,before,'surrounding forms are not rebuilt');
 assert.deepEqual(m.json("(()=>{const s=recordState('inbox');return [s.category,s.period,s.page]})()"),['pending','all',1]);
 assert.match(scope.innerHTML,/筛选 29 \/ 33 条/);
 assert.match(scope.innerHTML,/1–10 \/ 29 条/);
 assert.doesNotMatch(scope.innerHTML,/record-time-hint|other-0/);
 m.run("updateRecords('inbox',{page:3})");
 assert.match(scope.innerHTML,/>old-11<\/li>/);
 assert.match(scope.innerHTML,/21–29 \/ 29 条/);
});

test('explicit 30-day filtering of older deposits and loans retains recovery; parent task approvals default to all time (V1.9.10) and keep 30-day recovery',async()=>{
 const state=initialState();
 state.fixed=[{id:'older-fixed',term:12,principalCents:5000,rateBps:300,status:'active',start:'2026-01-01',maturity:'2027-01-01'}];
 state.loans=[{id:'older-loan',requestedCents:10000,principalCents:10000,interestMicroCents:0,aprBps:500,status:'active',createdAt:'2026-01-01T00:00:00Z'}];
 state.taskProposals=[{id:'older-proposal',name:'旧提议',unit:'次',rewardCents:200,status:'pending',at:'2026-01-01T00:00:00Z'}];
 state.taskCompletions=[{id:'older-completion',taskName:'旧任务',unit:'次',quantity:1,unitRewardCents:200,amountCents:200,status:'pending',at:'2026-01-01T00:00:00Z'}];
 const kid=await mount(state);
 for(const [key,renderer,action] of [['fixed','fixedPanel()','fixed.redeem'],['loans','loanPanel()','loan.payoff']]){
  kid.run(`recordState('${key}').period='30'`);
  const recent=kid.run(renderer);
  assert.match(recent,/当前时间范围内没有记录/);
  assert.match(recent,new RegExp(`data-record-key="${key}" data-record-all-time`));
  assert.doesNotMatch(recent,new RegExp(`data-act="${action}"`));
  kid.run(`recordState('${key}').period='all'`);
  assert.match(kid.run(renderer),new RegExp(`data-act="${action}"`));
 }
 const parent=await mount(state,'dad'),all=parent.run('parentInbox()');
 assert.match(all,/data-act="task\.proposal\.approve" data-id="older-proposal"/);
 assert.match(all,/data-act="task\.completion\.approve" data-id="older-completion"/);
 parent.run("recordState('inbox-proposals').period='30';recordState('inbox-completions').period='30'");
 const recent=parent.run('parentInbox()');
 assert.match(recent,/data-record-key="inbox-proposals" data-record-all-time/);
 assert.match(recent,/data-record-key="inbox-completions" data-record-all-time/);
 assert.doesNotMatch(recent,/data-act="task\.(?:proposal|completion)\.approve"/);
});

test('both roles see every active available task without filters, with ten per page and completion forms retained',async()=>{
 const state=initialState();
 state.tasks=[...Array.from({length:23},(_,i)=>({id:'task-'+i,name:'任务-'+i,unit:'次',rewardCents:200,active:true,createdAt:i===22?'':`2026-01-${String(i+1).padStart(2,'0')}T00:00:00Z`})),
  {id:'paused-task',name:'暂停任务',unit:'次',rewardCents:200,active:false,createdAt:'2026-11-18T00:00:00Z'}];
 for(const role of ['kid','dad']){
  const m=await mount(state,role);
  m.run("Object.assign(recordState('tasks'),{category:'paused',period:'today'})");
  const html=m.run('tasks()'),available=html.match(/data-record-list="tasks"[\s\S]*?<\/section>/)?.[0];
  assert.ok(available);
  assert.doesNotMatch(available,/record-toolbar|data-record-filter|record-time-hint|暂停任务/);
  assert.match(available,/1–10 \/ 23 条/);
  assert.deepEqual(m.json("(()=>{const s=recordState('tasks');return [s.category,s.period]})()"),['all','all']);
  const rowClass=role==='kid'?'task':'row';
  assert.equal((available.match(new RegExp(`class="${rowClass}"`,'g'))||[]).length,10);
  if(role==='kid'){
   assert.equal((available.match(/data-op="task.complete" novalidate/g)||[]).length,10);
   assert.match(available,/name="quantity"/);assert.match(available,/提交验收/);
   assert.equal(m.run("recordState('task-proposals').period"),'30');
   assert.equal(m.run("recordState('task-completions').period"),'30');
   assert.match(html,/data-record-key="task-proposals" data-record-filter="period"/);
   assert.match(html,/data-record-key="task-completions" data-record-filter="period"/);
  }
  m.run("recordState('tasks').page=3");
  const last=m.run('tasks()').match(/data-record-list="tasks"[\s\S]*?<\/section>/)[0];
  assert.equal((last.match(new RegExp(`class="${rowClass}"`,'g'))||[]).length,3);
  assert.match(last,/21–23 \/ 23 条/);assert.match(last,/>任务-22<\/b>/,'legacy undated active task is still visible');
  assert.doesNotMatch(last,/data-record-filter/);
  if(role==='dad'){
   const management=m.run('parentTasks()');
   // V2.0.0: the parent's task catalogue keeps its filters but opens on 全部时间,
   // so open tasks created more than 30 days ago are not hidden.
   assert.match(management,/data-record-key="parent-tasks" data-record-filter="category"/);
   assert.match(management,/<option value="all" selected>全部时间<\/option>/);
   assert.doesNotMatch(management,/data-record-key="parent-tasks" data-record-all-time/);
  }
 }
});

test('current holdings remain an undated catalog, and active loan status is clearly labelled 待还清',async()=>{
 const m=await mount();
 m.run("globalThis.holdings=Array.from({length:12},(_,i)=>({id:i,market:i%2?'US':'HK'}))");
 const options="{time:false,order:false,categories:[['HK','港股'],['US','美股']],category:x=>x.market}";
 assert.equal(m.run(`recordsPage('holdings-catalog',holdings,${options}).total`),12);
 assert.equal(m.run("recordState('holdings-catalog').period"),'all');
 assert.match(m.run(`recordsContent('holdings-catalog',holdings,x=>'<li>'+x.id+'</li>',${options})`),/1–10 \/ 12 条/);
 m.run("recordState('holdings-catalog').page=2");
 assert.deepEqual(m.json(`recordsPage('holdings-catalog',holdings,${options}).items.map(x=>x.id)`),[10,11]);
 assert.equal(m.run("STATUS.loan.active[0]"),'待还清');
 assert.match(m.run("statusBadge('loan','active')"),/>待还清<\/span>/);
 assert.doesNotMatch(m.run("statusBadge('loan','active')"),/还款中/);
});

test('wish-linked purchase navigation explicitly reveals an old target outside the default 30-day window',async()=>{
 const state=initialState();
 state.purchaseRequests=Array.from({length:25},(_,i)=>({id:'old-purchase-'+i,name:'购买-'+i,amountCents:100,status:'pending',at:`2026-01-${String(i+1).padStart(2,'0')}T00:00:00Z`}));
 const m=await mount(state);
 assert.doesNotMatch(m.run('shoppingPanel()'),/>购买-0<\/b>/);
 m.run("openPurchaseRecord('old-purchase-0')");
 assert.equal(m.run("recordState('purchases').period"),'all');
 assert.equal(m.run("recordState('purchases').page"),3);
 assert.match(m.root.innerHTML,/>购买-0<\/b>/);
 assert.match(m.root.innerHTML,/21–25 \/ 25 条/);
});
