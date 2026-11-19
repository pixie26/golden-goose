import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,runAction as coreAction,view} from '../lib/core.mjs';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
let sequence=0;
const act=(s,action,payload={},role='kid')=>coreAction(s,role,action,payload,`v195-ui-${++sequence}`);
function bank(){const s=initialState();setup(s,'t','t','a-strong-parent-password','123456');return s;}
function purchase(s,name,amount='20'){act(s,'purchase.request',{name,amount});const r=s.purchaseRequests[0];act(s,'purchase.approve',{id:r.id},'dad');return r;}
async function mount(s,role='kid',fetchImpl){
 const handlers={},intervals=[],posts=[],reads=[];
 const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener:(event,handler)=>(handlers[event]??=[]).push(handler)};
 const toast={textContent:'',className:''};
 const document={visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?toast:null,addEventListener(){}};
 const context=vm.createContext({document,console,location:{hostname:'localhost'},confirm:()=>true,setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},
  fetch:async(path,options)=>{
   if(path==='/api/bootstrap')return response({initialized:true,role,data:role?view(s,role):null});
   const body=options?.body?JSON.parse(options.body):null;
   if(body)posts.push(body);else reads.push(path);
   if(fetchImpl)return fetchImpl(path,options,body);
   return response(view(s,role));
  }});
 vm.runInContext(source,context);
 for(let i=0;i<6&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML);
 return {context,root,toast,posts,reads,intervals,handlers,run:code=>vm.runInContext(code,context),html(code){if(code)vm.runInContext(code,context);return root.innerHTML;}};
}

test('bank wording, goose parent avatar and fixed one-decimal amounts preserve real fractions',async()=>{
 const s=bank(),m=await mount(s,'dad');
 assert.match(m.root.innerHTML,/class="avatar-goose" src="\/assets\/images\/brand-goose\.png" alt="戴皇冠的金鹅"/);
 assert.doesNotMatch(m.root.innerHTML,/>爸<|avatar-dad-label|id="kid-avatar-file"/);
 const kid=await mount(s,'kid');assert.match(kid.root.innerHTML,/id="kid-avatar-file"/);
 const login=await mount(s,null);assert.match(login.root.innerHTML,/金鹅银行/);assert.doesNotMatch(login.root.innerHTML,/金鹅王国/);
 for(const [cents,expected] of [[16200,'O$ 162.0'],[16250,'O$ 162.5'],[16256,'O$ 162.6'],[123456,'O$ 1,234.6'],[-1255,'O$ -12.6'],[-1,'O$ 0.0']])assert.equal(m.run(`money(${cents})`),expected);
 assert.equal(m.run('signedMoney(-1)'),'O$ 0.0');
 assert.equal(m.run('priceText(162000)'),'162.0');assert.equal(m.run('priceText(125)'),'0.1');
 assert.equal(m.run("moneyInText('O$ 20, next; O$ 1,234.56.')"),'O$ 20.0, next; O$ 1,234.6.');
 kid.run("data.notifications=[{id:'legacy-note',title:'旧退款通知',detail:'已退款 O$ 20',tone:'ok',at:'2026-11-18T00:00:00Z',readAt:null,target:'account'}];data.ledger=[{id:'legacy-ledger',type:'loan.repay',description:'偿还家长借款（利息 O$0）',deltaCents:0,cashAfterCents:0,at:'2026-11-18T00:00:00Z'},{id:'legacy-ledger-2',type:'loan.repay',description:'偿还家长借款（利息 O$1.25）',deltaCents:0,cashAfterCents:0,at:'2026-11-17T00:00:00Z'}]");
 assert.match(kid.run('notificationsMenu()'),/已退款 O\$ 20\.0/);assert.equal(kid.run('data.notifications[0].detail'),'已退款 O$ 20');
 kid.run("recordState('ledger').period='all'"); // This test verifies historical currency formatting, independent of today's default date range.
 assert.match(kid.run('history()'),/偿还家长借款（利息 O\$ 1\.3）/);// old one-decimal-less amounts are formatted
 assert.match(kid.run('history()'),/偿还家长借款<\/b>/);assert.doesNotMatch(kid.run('history()'),/利息 O\$ 0\.0/,'a zero interest note is dropped');assert.equal(kid.run('data.ledger[0].description'),'偿还家长借款（利息 O$0）');
 assert.equal(s.cashCents,0,'formatting never changes ledger cents');
});

test('shopping shows eligible deadline, expired or used refund attempt, and no cancellation',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'500'},'dad');
 const eligible=purchase(s,'有效订单'),expired=purchase(s,'过期订单'),declined=purchase(s,'已拒绝订单'),pending=purchase(s,'待退订单');
 expired.deliveredAt=expired.reviewAt=new Date(Date.now()-8*86400000).toISOString();
 act(s,'purchase.return.request',{id:declined.id});act(s,'purchase.return.reject',{id:declined.id},'dad');
 act(s,'purchase.return.request',{id:pending.id,reason:'尺寸不合适'});
 const m=await mount(s),html=m.html("tab='account';sub.account='shopping';render()");
 assert.equal((html.match(/data-op="purchase.return.request"/g)||[]).length,1);
 assert.match(html,new RegExp(`name="id" value="${eligible.id}"`));
 assert.match(html,/退款申请截止/);assert.match(html,/超过.*7.*天|7.*天.*期限/);
 assert.match(html,/退款申请未通过；每笔订单只能申请一次/);
 assert.match(html,/<span class="badge [^"]*">退款待处理<\/span>/,'a pending refund is shown by its status badge');
 assert.doesNotMatch(html,/data-act="purchase.return.cancel"|data-act="purchase.refund"/);
 const parent=await mount(s,'dad'),parentHtml=parent.html("tab='parent';render()");
 assert.equal((parentHtml.match(/data-act="purchase.refund"/g)||[]).length,1,'only the pending child request can be approved');
 assert.match(parentHtml,/同意退款/);assert.match(parentHtml,/拒绝退款/);
 assert.match(parent.run('header()'),/<em class="count">1<\/em>/);
 assert.doesNotMatch(parent.run('parentMoney()'),/data-act="purchase.refund"/);
});

test('parent settings default to 500, remaining allowance subtracts pending requests, and zero disables borrowing',async()=>{
 const s=bank(),parent=await mount(s,'dad');
 assert.match(parent.run('parentSettings()'),/name="loanLimit"[^>]*value="500"/);
 act(s,'loan.request',{amount:'200'});act(s,'loan.approve',{id:s.loans[0].id},'dad');act(s,'loan.request',{amount:'100'});
 const child=await mount(s),html=child.run('loanPanel()');
 assert.match(html,/借款总额度 O\$ 500\.0/);assert.match(html,/本次最多可申请/);
 assert.match(html,/name="amount"[^>]*max="200\.00"/);assert.match(html,/待批申请 O\$ 100\.0/);
 act(s,'settings.update',{loanLimit:'0'},'dad');
 const disabled=await mount(s),disabledHtml=disabled.run('loanPanel()');
 assert.match(disabledHtml,/家长已暂停新增借款/);assert.doesNotMatch(disabledHtml,/data-op="loan.request"/);
 const disabledParent=await mount(s,'dad');assert.match(disabledParent.run('parentSettings()'),/name="loanLimit"[^>]*value="0"/);
});

test('parent receives a new refund in the idle poll without reloading or losing an edited form',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'100'},'dad');const r=purchase(s,'尺子');
 const parent=await mount(s,'dad');parent.run("tab='parent';render()");
 assert.doesNotMatch(parent.run('parentInbox()'),/data-act="purchase.refund"/);
 act(s,'purchase.return.request',{id:r.id});
 parent.run('formDirty=true');await parent.intervals[0]();assert.equal(parent.reads.length,0);
 parent.run('formDirty=false');await parent.intervals[0]();
 assert.match(parent.root.innerHTML,/data-act="purchase.refund"/);assert.match(parent.root.innerHTML,/同意退款/);
 assert.match(parent.run('header()'),/<em class="count">1<\/em>/);
});

test('a confirmed payoff followed by failed refresh remains successful; next click only reloads state',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'500'},'dad');act(s,'loan.request',{amount:'100'});const loan=s.loans[0];act(s,'loan.approve',{id:loan.id},'dad');
 let reads=0;
 const m=await mount(s,'kid',(path,options,body)=>{
  if(path==='/api/action')return response(coreAction(s,'kid',body.action,body.payload,body.idempotencyKey));
  if(++reads===1)return response({error:'账本文件暂时无法读取',code:'BANK_STORE_UNREADABLE'},503);
  return response(view(s,'kid'));
 });
 const command=`runAction('loan.repay',{id:${JSON.stringify(loan.id)},all:true})`;
 const first=await m.run(command);assert.equal(first.ok,true);assert.equal(loan.status,'repaid');
 assert.match(m.toast.textContent,/还款成功/);assert.match(m.root.innerHTML,/data-refresh-state/);
 assert.doesNotMatch(m.toast.className,/error/);
 const second=await m.run(command);assert.equal(second.refreshOnly,true);
 assert.equal(m.posts.length,1);assert.equal(s.ledger.filter(x=>x.type==='loan.repay').length,1);
 assert.equal(m.run('pendingStateRefresh'),null);assert.doesNotMatch(m.root.innerHTML,/data-refresh-state/);
 assert.equal(m.run('data.loans[0].status'),'repaid');
});

test('uncertain POST response reuses its idempotency key on manual retry without repeating repayment',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'500'},'dad');act(s,'loan.request',{amount:'100'});const loan=s.loans[0];act(s,'loan.approve',{id:loan.id},'dad');
 let sent=0;
 const m=await mount(s,'kid',(path,options,body)=>{
  if(path==='/api/action'){
   const result=coreAction(s,'kid',body.action,body.payload,body.idempotencyKey);
   if(++sent===1)throw new TypeError('Network connection interrupted after commit');
   return response(result);
  }
  return response(view(s,'kid'));
 });
 const command=`runAction('loan.repay',{id:${JSON.stringify(loan.id)},all:true})`;
 await assert.rejects(m.run(command),/Network connection interrupted/);
 const result=await m.run(command);assert.equal(result.duplicate,true);
 assert.equal(m.posts[0].idempotencyKey,m.posts[1].idempotencyKey);
 assert.equal(s.ledger.filter(x=>x.type==='loan.repay').length,1);
 assert.equal(s.cashCents,50000);
});

test('submitting another form while a confirmed operation awaits refresh preserves its draft and does not claim submission',async()=>{
 const s=bank();act(s,'cash.grant',{amount:'500'},'dad');act(s,'loan.request',{amount:'100'});const loan=s.loans[0];act(s,'loan.approve',{id:loan.id},'dad');
 let reads=0,refreshed=false;
 const m=await mount(s,'kid',(path,options,body)=>{
  if(path==='/api/action')return response(coreAction(s,'kid',body.action,body.payload,body.idempotencyKey));
  if(++reads===1)return response({error:'暂时无法刷新'},503);
  refreshed=true;return response(view(s,'kid'));
 });
 await m.run(`runAction('loan.repay',{id:${JSON.stringify(loan.id)},all:true})`);
 const makeForm=values=>({dataset:{op:'wish.add'},id:'',querySelector:()=>null,closest:()=>null,querySelectorAll:()=>values});
 const fields=values=>Object.entries(values).map(([name,value])=>({name,value,type:name==='amount'?'number':'text',disabled:false}));
 const oldValues=fields({name:'鞋',amount:'23.45'}),newValues=fields({name:'',amount:''});
 const oldForm=makeForm(oldValues),newForm=makeForm(newValues);
 m.root.querySelectorAll=selector=>selector==='form[data-op]'?[refreshed?newForm:oldForm]:[];
 m.run('formDirty=true');
 const result=await m.run("runAction('wish.add',{name:'鞋',amount:'23.45'})");
 assert.equal(result.refreshOnly,true);assert.equal(result.submitted,false);assert.equal(result.ok,undefined);
 assert.equal(m.posts.length,1,'no new wish action was posted during the safe refresh');
 assert.deepEqual(newValues.map(x=>x.value),['鞋','23.45']);
 assert.equal(m.run('formDirty'),true);
 assert.equal(m.toast.textContent,'账户已刷新，请核对后重新提交本次操作');
 assert.equal(s.wishes.length,0);
});
