import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,setup,runAction,derived,view} from '../lib/core.mjs';

const DAY=86400000;
let sequence=0;
const act=(s,action,payload={},role='kid')=>runAction(s,role,action,payload,`v195-rule-${++sequence}`);
function bank(){const s=initialState();setup(s,'token','token','a-long-parent-password','123456');return s;}
function bought(s,name='画笔',amount='30.5'){
  act(s,'cash.grant',{amount:'100'},'dad');
  act(s,'purchase.request',{name,amount});
  const r=s.purchaseRequests[0];act(s,'purchase.approve',{id:r.id},'dad');return r;
}
const record=(s,id)=>view(s,'kid').purchaseRequests.find(r=>r.id===id);
function purchaseDate(r,timestamp){r.reviewAt=new Date(timestamp).toISOString();r.deliveredAt=r.reviewAt;}

test('refund request is accepted at the exact seven-day deadline and rejected one millisecond later',t=>{
  const s=bank(),lastMoment=bought(s,'最后一刻'),tooLate=bought(s,'已经超时');
  const now=Date.now();t.mock.method(Date,'now',()=>now);
  purchaseDate(lastMoment,now-7*DAY);purchaseDate(tooLate,now-7*DAY-1);
  assert.equal(record(s,lastMoment.id).returnEligible,true);
  assert.equal(record(s,lastMoment.id).returnDeadlineAt,new Date(now).toISOString());
  assert.equal(record(s,tooLate.id).returnEligible,false);
  assert.match(record(s,tooLate.id).returnBlockedReason,/7 天/);
  const cash=s.cashCents;
  assert.throws(()=>act(s,'purchase.return.request',{id:tooLate.id,returnEligible:true}),/7 天/);
  assert.equal(tooLate.status,'delivered');assert.equal(s.cashCents,cash);
  act(s,'purchase.return.request',{id:lastMoment.id});
  assert.equal(lastMoment.status,'return_pending');assert.equal(s.cashCents,cash);
});

test('a valid request stays in the parent inbox after the window and is refunded exactly once',t=>{
  const s=bank(),r=bought(s),requestedAt=Date.now();
  act(s,'purchase.return.request',{id:r.id,reason:'尺寸不合适'});
  const before=s.cashCents;t.mock.method(Date,'now',()=>requestedAt+9*DAY);
  const pending=view(s,'dad').purchaseRequests.filter(r=>r.status==='return_pending');
  assert.equal(pending.length,1);assert.equal(pending[0].returnReason,'尺寸不合适');
  assert.equal(pending[0].returnRequested,true);assert.equal(pending[0].returnEligible,false);
  assert.throws(()=>act(s,'purchase.refund',{id:r.id}),/家长/);
  const key='refund-approved-once-195';
  runAction(s,'dad','purchase.refund',{id:r.id},key);
  assert.equal(s.cashCents,before+3050);
  assert.equal(runAction(s,'dad','purchase.refund',{id:r.id},key).duplicate,true);
  assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/不能退货/);
  assert.equal(s.ledger.filter(x=>x.type==='purchase.refund').length,1);
  assert.match(view(s,'kid').notifications[0].detail,/O\$ 30\.5/);
});

test('one request cannot be cancelled, repeated with a new key, or re-opened after rejection',()=>{
  const s=bank(),r=bought(s),cash=s.cashCents;
  const key='return-original-request-195';
  runAction(s,'kid','purchase.return.request',{id:r.id},key);
  assert.equal(runAction(s,'kid','purchase.return.request',{id:r.id},key).duplicate,true);
  assert.throws(()=>act(s,'purchase.return.request',{id:r.id}),/已提交/);
  assert.throws(()=>act(s,'purchase.return.cancel',{id:r.id}),/不能撤回/);
  assert.equal(r.status,'return_pending');
  assert.throws(()=>act(s,'purchase.return.reject',{id:r.id}),/家长/);
  act(s,'purchase.return.reject',{id:r.id},'dad');
  assert.equal(r.status,'delivered');assert.equal(r.returnRequestUsed,true);
  assert.equal(record(s,r.id).returnRequested,true);
  assert.throws(()=>act(s,'purchase.return.request',{id:r.id,returnRequestUsed:false}),/只能申请退款一次/);
  assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/没有待处理/);
  assert.equal(s.cashCents,cash);assert.equal(s.ledger.filter(x=>x.type==='purchase.refund').length,0);
  assert.match(view(s,'kid').notifications[0].title,/退货申请未通过/);
});

test('legacy cancelled and rejected requests consume their one opportunity without resetting history',()=>{
  const s=bank();
  for(const field of ['returnRequestedAt','returnCancelledAt','returnRejectedAt']){
    const r=bought(s,field);r[field]=new Date().toISOString();
    delete r.returnRequestUsed;
    assert.equal(record(s,r.id).returnEligible,false);
    assert.equal(record(s,r.id).returnRequested,true);
    assert.throws(()=>act(s,'purchase.return.request',{id:r.id}),/只能申请退款一次/);
  }
});

test('legacy delivery cannot restart an expired purchase window; unknown dates stay closed',()=>{
  const s=bank(),r=bought(s);r.status='approved';delete r.deliveredAt;
  r.reviewAt=new Date(Date.now()-8*DAY).toISOString();
  const originalDeadline=new Date(Date.parse(r.reviewAt)+7*DAY).toISOString();
  act(s,'purchase.deliver',{id:r.id},'dad');
  assert.equal(record(s,r.id).returnDeadlineAt,originalDeadline);
  assert.throws(()=>act(s,'purchase.return.request',{id:r.id}),/7 天/);
  const missing=bought(s,'没有日期');delete missing.reviewAt;delete missing.deliveredAt;
  assert.equal(record(s,missing.id).returnDeadlineAt,null);
  assert.throws(()=>act(s,'purchase.return.request',{id:missing.id}),/购买时间不完整/);
  const legacy=bought(s,'旧版批准');legacy.status='approved';delete legacy.deliveredAt;
  act(s,'purchase.return.request',{id:legacy.id});
  act(s,'purchase.return.reject',{id:legacy.id},'dad');assert.equal(legacy.status,'approved');
});

test('unbought orders have no refund deadline and a parent cannot directly refund or impersonate a request',()=>{
  const s=bank();act(s,'cash.grant',{amount:'100'},'dad');
  act(s,'purchase.request',{name:'未购买',amount:'20'});const pending=s.purchaseRequests[0];
  assert.equal(record(s,pending.id).returnDeadlineAt,null);
  assert.throws(()=>act(s,'purchase.return.request',{id:pending.id}),/已购买/);
  act(s,'purchase.reject',{id:pending.id},'dad');assert.equal(record(s,pending.id).returnDeadlineAt,null);
  const r=bought(s);assert.throws(()=>act(s,'purchase.refund',{id:r.id},'dad'),/没有待处理/);
  assert.throws(()=>act(s,'purchase.return.request',{id:r.id},'dad'),/只有 Olivia/);
});

test('loan limit defaults to 500 for both new and legacy states and only the parent may configure it',()=>{
  const s=bank();assert.equal(derived(s).loanLimitCents,50000);
  delete s.settings.loanLimitCents;
  assert.equal(view(s,'kid').settings.loanLimitCents,50000);
  assert.equal(derived(s).loanAvailableCents,50000);
  assert.throws(()=>act(s,'settings.update',{loanLimit:'800'}),/家长/);
  act(s,'settings.update',{loanLimit:'725.5'},'dad');
  assert.equal(s.settings.loanLimitCents,72550);
  act(s,'loan.request',{amount:'725.5'});assert.equal(derived(s).loanAvailableCents,0);
  assert.throws(()=>act(s,'loan.request',{amount:'0.1'}),/725\.5/);
  assert.throws(()=>act(s,'loan.request',{amount:'1'},'dad'),/只有 Olivia/);
});

test('outstanding principal plus pending loan requests reserve the configurable shared limit',()=>{
  const s=bank();act(s,'loan.request',{amount:'200'});const first=s.loans[0];
  act(s,'loan.approve',{id:first.id},'dad');act(s,'loan.request',{amount:'300'});const second=s.loans[0];
  let d=derived(s);assert.equal(d.loanPrincipalCents,20000);assert.equal(d.loanPendingCents,30000);assert.equal(d.loanAvailableCents,0);
  assert.throws(()=>act(s,'loan.request',{amount:'0.1'}),/500/);
  act(s,'loan.approve',{id:second.id},'dad');d=derived(s);
  assert.equal(d.loanPrincipalCents,50000);assert.equal(d.loanPendingCents,0);assert.equal(d.loanAvailableCents,0);
  assert.equal(s.cashCents,50000);
  act(s,'loan.repay',{id:first.id,amount:'100'});
  assert.equal(derived(s).loanAvailableCents,10000);
  act(s,'loan.request',{amount:'100'});assert.equal(derived(s).loanAvailableCents,0);
});

test('rejected requests release loan room, and lowering the cap preserves debt while rechecking approvals',()=>{
  const s=bank();act(s,'loan.request',{amount:'300'});const debt=s.loans[0];act(s,'loan.approve',{id:debt.id},'dad');
  act(s,'loan.request',{amount:'100'});const first=s.loans[0];
  act(s,'loan.request',{amount:'100'});const second=s.loans[0];
  act(s,'settings.update',{loanLimit:'400'},'dad');
  assert.throws(()=>act(s,'loan.approve',{id:first.id},'dad'),/400/);
  assert.equal(debt.principalCents,30000);assert.equal(s.cashCents,30000);
  act(s,'loan.reject',{id:second.id},'dad');act(s,'loan.approve',{id:first.id},'dad');
  assert.equal(derived(s).loanPrincipalCents,40000);
  act(s,'settings.update',{loanLimit:'200'},'dad');
  assert.equal(derived(s).loanPrincipalCents,40000);assert.equal(derived(s).loanAvailableCents,0);
  assert.throws(()=>act(s,'loan.request',{amount:'1'}),/200/);
  act(s,'loan.repay',{id:first.id,all:true});assert.equal(first.status,'repaid');
  assert.equal(debt.principalCents,30000);
});

test('zero limit disables new lending and pending approvals while existing borrowing remains repayable',()=>{
  const s=bank();act(s,'loan.request',{amount:'100'});const debt=s.loans[0];act(s,'loan.approve',{id:debt.id},'dad');
  act(s,'loan.request',{amount:'20'});const pending=s.loans[0];
  act(s,'settings.update',{loanLimit:'0'},'dad');
  assert.equal(view(s,'kid').settings.loanLimitCents,0);
  assert.throws(()=>act(s,'loan.request',{amount:'1'}),/暂停/);
  assert.throws(()=>act(s,'loan.approve',{id:pending.id},'dad'),/暂停/);
  act(s,'loan.repay',{id:debt.id,all:true});assert.equal(debt.status,'repaid');
  assert.equal(pending.status,'pending');
  act(s,'settings.update',{loanLimit:'50'},'dad');act(s,'loan.approve',{id:pending.id},'dad');
  assert.equal(pending.principalCents,2000);
});

test('loan setting rejects malformed, negative, overly precise and out-of-range amounts without changing the cap',()=>{
  const s=bank();
  for(const value of ['',null,'-1','NaN','Infinity','500.001','1e3','100000000',true]){
    assert.throws(()=>act(s,'settings.update',{loanLimit:value},'dad'));
    assert.equal(s.settings.loanLimitCents,50000);
  }
  act(s,'settings.update',{loanLimit:'0.00'},'dad');assert.equal(s.settings.loanLimitCents,0);
});

test('notification amounts use one fixed decimal without rounding ledger cents',()=>{
  const s=bank(),r=bought(s,'小数金额','12.34');
  assert.equal(r.approvedCents,1234);assert.equal(s.cashCents,8766);
  assert.match(view(s,'kid').notifications[0].detail,/O\$ 12\.3$/);
  act(s,'loan.request',{amount:'20'});act(s,'loan.approve',{id:s.loans[0].id},'dad');
  assert.match(view(s,'kid').notifications[0].detail,/O\$ 20\.0 的借款/);
  assert.doesNotMatch(view(s,'kid').notifications[0].detail,/20\.00/);
});
