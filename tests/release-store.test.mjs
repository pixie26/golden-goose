import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { initialState, setup, runAction } from '../lib/core.mjs';

// This controlled driver exercises connection failures and ambiguous COMMITs
// without connecting to or altering an external database.
const RealPool=pg.Pool;
const savedDatabase=process.env.DATABASE_URL;
process.env.DATABASE_URL='postgresql://test.invalid/test';
let scenario,sequence=0;
class FakePool extends EventEmitter {
  constructor(config){super();this.config=config;this.ended=false;this.index=scenario.pools.length;scenario.pools.push(this);}
  async connect(){const client=new FakeClient(this);scenario.clients.push(client);return client;}
  async query(sql,values=[]){
    scenario.sql.push(sql);scenario.reads.push(values[0]??null);
    const version=String(scenario.version);
    return {rows:[{version,state:values[0]===version?null:structuredClone(scenario.state)}]};
  }
  async end(){this.ended=true;}
}
class FakeClient {
  constructor(pool){this.pool=pool;this.tx=null;this.released=false;this.destroyed=false;}
  async query(sql,values=[]){
    scenario.sql.push(sql);
    if(scenario.failInit&&sql.startsWith('CREATE TABLE')){scenario.failInit=false;throw Object.assign(new Error('secret database-user@private-host'),{code:'ECONNRESET'});}
    if(sql==='ROLLBACK'&&scenario.failRollback)throw Error('rollback connection unavailable');
    if(sql==='BEGIN'){this.tx=structuredClone(scenario.state);return {rows:[]};}
    if(sql.startsWith('SELECT xmin')){scenario.reads.push(values[0]??null);const version=String(scenario.version);return {rows:[{version,state:values[0]===version?null:structuredClone(this.tx??scenario.state)}]};}
    if(sql.startsWith('UPDATE bank_state')){this.tx=JSON.parse(values[0]);this.updated=true;return {rowCount:1,rows:[]};}
    if(sql==='COMMIT'){
      scenario.state=this.tx;this.tx=null;if(this.updated){scenario.version++;this.updated=false;}
      if(scenario.failCommit){scenario.failCommit=false;throw Object.assign(new Error('commit acknowledgement connection lost'),{code:'ECONNRESET'});}
    }
    if(sql==='ROLLBACK'){this.tx=null;this.updated=false;}
    return {rows:[]};
  }
  release(destroy=false){this.released=true;this.destroyed=!!destroy;}
}
pg.Pool=FakePool;
after(()=>{pg.Pool=RealPool;if(savedDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=savedDatabase;});
async function bank(){
  const state=initialState();setup(state,'setup','setup','store-release-password','123456');
  scenario={state,version:1,pools:[],clients:[],sql:[],reads:[],failInit:false,failRollback:false,failCommit:false};
  return import('../lib/store.mjs?release-store='+ ++sequence);
}

test('database initialization failure closes its pool and the next request reconnects without leaking details',async()=>{
  const {readStore}=await bank();scenario.failInit=true;
  await assert.rejects(readStore(),error=>{assert.equal(error.code,'BANK_STORE_UNAVAILABLE');assert.doesNotMatch(error.message,/private-host|database-user/);return true;});
  assert.equal(scenario.pools[0].ended,true);assert.equal(scenario.clients[0].released,true);
  const state=await readStore();assert.equal(state.cashCents,0);assert.equal(scenario.pools.length,2);
  assert.ok(scenario.sql.includes('SELECT pg_advisory_xact_lock(1380403010)'));
  assert.ok(scenario.sql.includes('ALTER TABLE bank_state ENABLE ROW LEVEL SECURITY'));
  assert.ok(scenario.sql.includes('REVOKE ALL ON TABLE bank_state FROM PUBLIC'));
  assert.ok(scenario.sql.some(sql=>sql.includes("rolname IN ('anon','authenticated')")));
  assert.ok(scenario.pools[1].config.connectionTimeoutMillis<=5000);
  // v1.0.1: transaction poolers (Supavisor :6543) drop startup GUCs and PgBouncer
  // rejects them, so timeouts are set inside each transaction instead.
  assert.equal(scenario.pools[1].config.statement_timeout,undefined);
  assert.equal(scenario.pools[1].config.lock_timeout,undefined);
  const timeouts="SELECT set_config('lock_timeout','4000',true),set_config('statement_timeout','5000',true)";
  assert.equal(scenario.sql[scenario.sql.indexOf('BEGIN')+1],timeouts,'initialization transaction sets its timeouts first');
});

test('every ledger write transaction applies its lock and statement timeouts before locking the row',async()=>{
  const {readStore,mutateStore}=await bank();await readStore();
  const before=scenario.sql.length;await mutateStore(state=>{state.cashCents+=0;});
  const tx=scenario.sql.slice(before);
  assert.deepEqual(tx.slice(0,3),['BEGIN',"SELECT set_config('lock_timeout','4000',true),set_config('statement_timeout','5000',true)","SELECT xmin::text||'@'||extract(epoch from pg_postmaster_start_time())::text AS version, CASE WHEN xmin::text||'@'||extract(epoch from pg_postmaster_start_time())::text=$1 THEN NULL ELSE state END AS state FROM bank_state WHERE id=1 FOR UPDATE"]);
});

test('an idle database disconnect is handled and the existing pool remains usable',async t=>{
  const {readStore}=await bank();await readStore();t.mock.method(console,'error',()=>{});
  assert.doesNotThrow(()=>scenario.pools[0].emit('error',Object.assign(Error('idle socket closed'),{code:'ECONNRESET'})));
  assert.equal((await readStore()).cashCents,0);assert.equal(scenario.pools.length,1);
});

test('failed business operations roll back; a rollback failure destroys the client and preserves the original error',async()=>{
  const {readStore,mutateStore}=await bank();await readStore();
  await assert.rejects(mutateStore(state=>{state.cashCents=999;throw Error('业务校验失败');}),/业务校验失败/);
  assert.equal(scenario.state.cashCents,0);
  assert.equal(scenario.clients.at(-1).destroyed,false);
  scenario.failRollback=true;
  await assert.rejects(mutateStore(state=>{state.cashCents=123;throw Error('保留这个原始错误');}),/保留这个原始错误/);
  assert.equal(scenario.clients.at(-1).released,true);assert.equal(scenario.clients.at(-1).destroyed,true);
  assert.equal(scenario.state.cashCents,0);
});

test('an ambiguous COMMIT never replays automatically; an explicit same-key retry does not credit twice',async()=>{
  const {readStore,mutateStore}=await bank();await readStore();scenario.failCommit=true;
  let callbacks=0;
  const grant=state=>{callbacks++;return runAction(state,'dad','cash.grant',{amount:'10.0'},'release-ambiguous-commit');};
  await assert.rejects(mutateStore(grant),{code:'BANK_STORE_UNAVAILABLE'});
  assert.equal(callbacks,1);assert.equal(scenario.state.cashCents,1000);
  const result=await mutateStore(grant);assert.equal(result.duplicate,true);
  assert.equal(scenario.state.cashCents,1000);assert.equal(scenario.state.ledger.filter(row=>row.type==='cash.grant').length,1);
});

test('V2.0.0: an unchanged ledger row is not resent; any write (any process) is seen at the next read',async()=>{
  const {readStore,mutateStore}=await bank();
  const first=await readStore();assert.equal(scenario.reads.at(-1),null,'the first read asks for the full row');
  const resent=()=>scenario.sql.length; // FakePool.query returns null state when the version matches
  const again=await readStore();assert.equal(scenario.reads.at(-1),'1');assert.deepEqual(again,first);
  again.cashCents=-1;again.ledger.push({poisoned:true});
  assert.equal((await readStore()).cashCents,0,'a caller changing its copy cannot alter the cache');
  // Another function instance commits: the version changes and the next read returns the new row.
  scenario.state={...structuredClone(scenario.state),cashCents:4200};scenario.version++;
  assert.equal((await readStore()).cashCents,4200);
  // The locked read inside a write also reuses the unchanged row, and a failed write leaves no trace.
  await assert.rejects(mutateStore(state=>{state.cashCents=1;throw Error('业务校验失败');}),/业务校验失败/);
  assert.equal(scenario.reads.at(-1),'2','the FOR UPDATE read sent the known version');
  assert.equal((await readStore()).cashCents,4200);
  await mutateStore(state=>{state.cashCents+=100;});
  assert.equal(scenario.state.cashCents,4300);assert.equal(scenario.version,3);
  assert.equal((await readStore()).cashCents,4300);
  assert.ok(resent()>0);
});
