import assert from 'node:assert/strict';
import { initialState, runAction, maintenance, view } from '../../lib/core.mjs';
const RealDate=Date; let clock=RealDate.parse('2026-11-19T00:00:00Z');
class AuditDate extends RealDate {constructor(...args){super(...(args.length?args:[clock]));} static now(){return clock;}}
globalThis.Date=AuditDate;
let executed=0, expectedRejects=0;
for(let seed=1;seed<=12;seed++){
 let randState=seed;const rand=()=>((randState=(Math.imul(randState,1664525)+1013904223)>>>0)/2**32);const pick=a=>a[Math.floor(rand()*a.length)];
 let s=initialState();s.dadHash='audit';s.kidHash='audit';let serial=0;
 const act=(role,action,payload={})=>{let draft=structuredClone(s);const k=`nonstock-audit-${seed}-${++serial}`;try{runAction(draft,role,action,payload,k);s=draft;executed++;return true;}catch(e){expectedRejects++;return false;}};
 const amount=()=>((Math.floor(rand()*50000)+1)/100).toFixed(2);
 // Loans are borrowed and repaid in O$0.1 units; one in five tries a cent amount, which must be refused.
 const loanAmount=()=>rand()<0.2?amount():((Math.floor(rand()*5000)+1)/10).toFixed(1);
 const dueOf=id=>{const v=view(s,'kid').loans.find(x=>x.id===id);return v.principalCents+Math.round(v.interestMicroCents/1e6);};
 const repay=(l,payload)=>{
  const due=dueOf(l.id),cash=s.cashCents,ok=act('kid','loan.repay',{id:l.id,...payload}),after=s.loans.find(x=>x.id===l.id),paid=cash-s.cashCents;
  if(payload.amount&&!/^\d+(\.\d0?)?$/.test(payload.amount))assert.equal(ok,false,'cent repayments are refused');
  if(!ok)return assert.equal(paid,0);
  assert(paid>0&&paid<=due,'never charged more than the due');assert.equal(after.waivedCents,undefined,'nothing is ever waived');
  if(after.status==='repaid')assert.equal(paid,due,'a loan closes only when its exact due is paid');
  else assert.equal(dueOf(l.id),due-paid,'the debt falls by exactly the amount paid');
 };
 act('dad','cash.grant',{amount:'1000'});
 for(let step=0;step<800;step++){
  let r,l,f;
  switch(Math.floor(rand()*15)){
   case 0: act('dad','cash.grant',{amount:amount()});break;
   case 1: act('kid','purchase.request',{name:`purchase-${seed}-${serial}`,amount:amount()});break;
   case 2: r=pick(s.purchaseRequests.filter(r=>r.status==='pending'));if(r)act('dad',rand()<0.6?'purchase.approve':'purchase.reject',{id:r.id});break;
   case 3: r=pick(s.purchaseRequests.filter(r=>r.status==='delivered'));if(r)act('kid','purchase.return.request',{id:r.id});break;
   case 4: r=pick(s.purchaseRequests.filter(r=>r.status==='return_pending'));if(r)act('dad',rand()<0.7?'purchase.refund':'purchase.return.reject',{id:r.id});break;
   case 5: act('kid','fixed.open',{term:pick([3,6,12]),amount:amount()});break;
   case 6: f=pick(s.fixed.filter(f=>f.status==='active'));if(f)act('kid','fixed.redeem',{id:f.id});break;
   case 7: {const v=loanAmount(),n=s.loans.length,ok=act('kid','loan.request',{amount:v});if(!/^\d+(\.\d0?)?$/.test(v))assert(!ok&&s.loans.length===n,'cent loan requests are refused');break;}
   case 8: l=pick(s.loans.filter(l=>l.status==='pending'));if(l)act('dad',rand()<.8?'loan.approve':'loan.reject',{id:l.id});break;
   case 9: l=pick(s.loans.filter(l=>l.status==='active'));if(l)repay(l,{all:true});break;
   case 10: l=pick(s.loans.filter(l=>l.status==='active'));if(l)repay(l,{amount:loanAmount()});break;
   case 11: act('dad','settings.update',{loanLimit:pick(['0','500','800']),loanAPR:pick(['0','5','25','100']),rate3:pick(['0','5','100'])});break;
   case 12: clock+=Math.floor(rand()*15*86400000);maintenance(s);break;
   case 13: act('dad','task.create',{name:'fold shirt',unit:'件',amount:(Math.floor(rand()*30+1)/10).toFixed(1)});act('kid','task.complete',{id:s.tasks[0].id,quantity:Math.floor(rand()*10)+1});act('dad','task.completion.approve',{id:s.taskCompletions[0].id});break;
   case 14: r=pick(s.purchaseRequests.filter(r=>['refunded','delivered'].includes(r.status)));if(r)act('dad','purchase.refund',{id:r.id});break;
  }
  const d=view(s,'kid').summary;
  assert.equal(s.cashCents,s.ledger.reduce((n,l)=>n+l.deltaCents,0),'cash equals ledger sum');
  let bal=0;for(const row of [...s.ledger].reverse()){bal+=row.deltaCents;assert.equal(row.cashAfterCents,bal);assert(bal>=0);}
  const reserved=s.purchaseRequests.filter(r=>r.status==='pending').reduce((n,r)=>n+r.reservedCents,0);
  assert.equal(d.availableCents,s.cashCents-reserved);assert(d.availableCents>=0);
  for(const r of s.purchaseRequests){assert.equal(s.ledger.filter(l=>l.type==='purchase.refund'&&l.description===`退货退款：${r.name}`).length,r.status==='refunded'?1:0,'refund occurs once only after approval');if(r.status!=='pending')assert.equal(r.reservedCents,0);}
  for(const l of s.loans){assert(Number.isSafeInteger(l.principalCents));assert(l.principalCents>=0);if(l.status==='repaid')assert.equal(l.interestMicroCents,0);}
  assert.equal(d.assetsCents,s.cashCents+s.fixed.filter(f=>f.status==='active').reduce((n,f)=>n+f.principalCents,0));
  assert.equal(d.netWorthCents,d.assetsCents-d.loanPrincipalCents-d.loanInterestCents);
  const oldCash=s.cashCents;maintenance(s);const afterCash=s.cashCents;maintenance(s);assert.equal(s.cashCents,afterCash,'maintenance idempotent');assert(s.cashCents>=oldCash);
 }
}
globalThis.Date=RealDate;
console.log(JSON.stringify({seeds:12,steps:9600,successfulActions:executed,expectedRejectedActions:expectedRejects,result:'All cash, reservation, loan, maturity and ledger invariants passed'},null,2));
