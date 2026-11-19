import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, setup, runAction, view } from '../lib/core.mjs';
const NativeDate=Date;
function at(iso,fn){
 globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[iso]));}static now(){return NativeDate.parse(iso);}};
 try{return fn();}finally{globalThis.Date=NativeDate;}
}
let seq=0;
const act=(s,role,name,payload)=>runAction(s,role,name,payload,'final-view-'+ ++seq);
function bank(){const s=initialState();setup(s,'t','t','final-view-test-password','123456');act(s,'dad','cash.grant',{amount:'1000'});return s;}
test('public cancellation permissions agree with the server at regular and half-day closes',()=>{
 for(const c of [
  {symbol:'0700.HK',before:'2026-11-19T07:59:00Z',after:'2026-11-19T08:00:00Z'},
  {symbol:'0700.HK',before:'2026-12-24T03:59:00Z',after:'2026-12-24T04:00:00Z'},
  {symbol:'AAPL',before:'2026-11-19T20:59:00Z',after:'2026-11-19T21:00:00Z'},
  {symbol:'AAPL',before:'2026-11-27T17:59:00Z',after:'2026-11-27T18:00:00Z'}
 ]){
  const s=at(c.before,()=>{const s=bank();act(s,'kid','stock.buy',{symbol:c.symbol,amount:'100'});return s;});
  const id=s.orders[0].id;
  at(c.before,()=>{
   const o=view(s,'kid').orders[0];assert.equal(o.canCancel,true);assert.equal(o.canParentCancel,false);
   assert.throws(()=>act(structuredClone(s),'dad','order.cancel',{id}),/收市前/);
   act(structuredClone(s),'kid','stock.cancel',{id});
  });
  at(c.after,()=>{
   const o=view(s,'dad').orders[0];assert.equal(o.canCancel,false);assert.equal(o.canParentCancel,true);
   assert.throws(()=>act(structuredClone(s),'kid','stock.cancel',{id}),/已收盘/);
   act(structuredClone(s),'dad','order.cancel',{id});
  });
  assert.equal('canCancel' in s.orders[0],false,'view does not persist derived flags');
 }
});
test('public bank date identifies maturity at Hong Kong midnight before scheduled settlement',()=>{
 const s=at('2026-08-19T03:00:00Z',()=>{const s=bank();act(s,'kid','fixed.open',{term:3,amount:'365'});return s;});
 at('2026-11-18T16:01:00Z',()=>{
  const v=view(s,'kid');assert.equal(v.bankDate,'2026-11-19');assert.equal(v.fixed[0].maturity,v.bankDate);assert.equal(v.fixed[0].status,'active');
  const before=s.cashCents;act(s,'kid','fixed.redeem',{id:s.fixed[0].id});
  assert.equal(s.fixed[0].status,'matured');assert.ok(s.cashCents>before+36500);assert.equal(s.ledger[0].type,'fixed.mature');
 });
});
