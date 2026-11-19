import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const NOW='2026-11-18T04:00:00.000Z';
async function mount(state=initialState(),role='kid'){
 const NativeDate=Date;
 class FixedDate extends NativeDate{
  constructor(...args){super(...(args.length?args:[NOW]));}
  static now(){return NativeDate.parse(NOW);}
 }
 const root={innerHTML:'',addEventListener(){},querySelectorAll(){return [];}};
 const toast={textContent:'',className:''};
 const context=vm.createContext({Date:FixedDate,document:{getElementById:id=>id==='root'?root:id==='toast'?toast:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role,data:view(state,role)})),console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 vm.runInContext(source,context);
 for(let i=0;i<10&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return {run:code=>vm.runInContext(code,context),json:code=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context))};
}

test('both roles initially see old deposits, loans and wishes across all-time ten-item pages',async()=>{
 const state=initialState();
 state.fixed=Array.from({length:23},(_,i)=>({id:'fixed-'+i,term:12,principalCents:1000,rateBps:300,status:'active',start:'2026-01-01',maturity:'2027-01-01'}));
 state.loans=Array.from({length:23},(_,i)=>({id:'loan-'+i,requestedCents:1000,principalCents:1000,interestMicroCents:0,aprBps:500,status:'active',createdAt:'2026-01-01T00:00:00Z'}));
 state.wishes=Array.from({length:23},(_,i)=>({id:'wish-'+i,name:'旧心愿-'+i,goalCents:2000,at:i===22?'':'2026-01-01T00:00:00Z'}));
 const before=JSON.stringify(state);
 for(const role of ['kid','dad']){
  const m=await mount(state,role);
  for(const [key,renderer,rowPattern] of [['fixed','fixedPanel()',/class="row"/g],['loans','loanPanel()',/class="row"/g],['wishes','wishes()',/class="card wish-card"/g]]){
   const first=m.run(renderer);
   assert.equal(m.run(`recordState('${key}').period`),'all');
   assert.match(first,/<option value="all" selected>全部时间<\/option>/);
   assert.match(first,/<option value="today">今日<\/option>/);
   assert.match(first,/<option value="year">今年<\/option>/);
   assert.match(first,/1–10 \/ 23 条/);
   assert.equal((first.match(rowPattern)||[]).length,10);
   assert.doesNotMatch(first,/record-time-hint|当前时间范围内没有记录/);
   m.run(`recordState('${key}').page=3`);
   const last=m.run(renderer);
   assert.match(last,/21–23 \/ 23 条/);
   assert.equal((last.match(rowPattern)||[]).length,3);
   if(key==='wishes')assert.match(last,/>旧心愿-22<\/b>/,'an undated legacy wish remains reachable');
   if(key==='fixed')assert.match(last,/data-act="fixed.redeem" data-id="fixed-22"/);
   if(key==='loans')assert.match(last,/data-act="loan.payoff" data-id="loan-22"/);
  }
 }
 assert.equal(JSON.stringify(state),before,'default filters do not change saved account records');
});

test('other dated records retain a 30-day default and invalid periods return to each list default',async()=>{
 // The parent's 待处理 lists (inbox-*) default to all time since V1.9.10, and the parent's
 // task catalogue and pending-order queue since V2.0.0 (see parent-lists.test.mjs).
 const otherKeys=['purchases','orders','ledger','task-proposals','task-completions'];
 for(const role of ['kid','dad']){
  const m=await mount(initialState(),role);
  m.run("globalThis.rows=[{id:'recent',at:'2026-11-18T00:00:00Z'},{id:'old',at:'2025-01-01T00:00:00Z'},{id:'undated'}]");
  for(const key of otherKeys){
   assert.equal(m.run(`recordState('${key}').period`),'30',key+' default');
   assert.deepEqual(m.json(`recordsPage('${key}',rows).items.map(x=>x.id)`),['recent']);
   m.run(`recordState('${key}').period='unsupported'`);
   assert.equal(m.run(`recordsPage('${key}',rows).state.period`),'30',key+' fallback');
  }
  for(const key of ['fixed','loans','wishes','parent-tasks','parent-orders']){
   m.run(`recordState('${key}').period='unsupported'`);
   assert.deepEqual(m.json(`(()=>{const p=recordsPage('${key}',rows);return [p.state.period,p.total,p.hiddenByTime]})()`),['all',3,0],key+' fallback');
  }
 }
});

test('all-time defaults do not overwrite manually chosen date filters or break category paging',async()=>{
 const m=await mount();
 m.run("globalThis.rows=[...Array.from({length:12},(_,i)=>({id:'new-'+i,status:'active',at:'2026-11-18T00:00:00Z'})),...Array.from({length:13},(_,i)=>({id:'old-'+i,status:'active',at:'2025-01-01T00:00:00Z'}))];globalThis.options={categories:[['active','有效'],['done','完成']]}");
 for(const key of ['fixed','loans','wishes']){
  assert.deepEqual(m.json(`(()=>{const p=recordsPage('${key}',rows,options);return [p.total,p.pages]})()`),[25,3]);
  for(const period of ['today','7','30','month','year']){
   m.run(`Object.assign(recordState('${key}'),{period:'${period}',category:'active',page:3})`);
   assert.deepEqual(m.json(`(()=>{const p=recordsPage('${key}',rows,options);return [p.state.period,p.state.category,p.total,p.pages,p.state.page,p.from,p.to,p.hiddenByTime]})()`),[period,'active',12,2,2,11,12,13]);
   const html=m.run(`recordsList('${key}',rows,x=>'<li>'+x.id+'</li>',options)`);
   assert.equal(m.run(`recordState('${key}').period`),period,'re-render preserves chosen time');
   assert.match(html,new RegExp(`<option value="${period}" selected>`));
   assert.match(html,/查看全部时间/);
  }
  m.run(`Object.assign(recordState('${key}'),{period:'all',page:3})`);
  assert.deepEqual(m.json(`(()=>{const p=recordsPage('${key}',rows,options);return [p.total,p.pages,p.from,p.to]})()`),[25,3,21,25]);
 }
});
