import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { initialState, setup, createSession, runAction } from '../lib/core.mjs';

// A driver fault must emit an asynchronous Client error, not merely reject a
// query. The latter missed RGG-002: real pg emits both on a lost connection.
// The same scenarios are also exercised against a real PostgreSQL wire proxy
// during release acceptance; this regression needs no database or extra package.
const RealPool=pg.Pool,savedDatabase=process.env.DATABASE_URL;
process.env.DATABASE_URL='postgresql://synthetic.invalid/goose_test';
let scenario,sequence=0;
class FaultPool extends EventEmitter {
  constructor(){super();this.client=null;this.ended=false;scenario.pools.push(this);}
  async connect(){
    if(!this.client||this.client.destroyed){
      this.client=new FaultClient(this);scenario.clients.push(this.client);
      this.emit('connect',this.client);
    }
    assert.equal(this.client.leased,false,'the test must release each checkout');
    this.client.leased=true;this.client.checkouts++;return this.client;
  }
  async query(...args){const client=await this.connect();try{return await client.query(...args);}finally{client.release();}}
  async end(){assert.ok(!this.client?.leased,'a failed initialization must release before pool.end');this.ended=true;}
}
class FaultClient extends EventEmitter {
  constructor(pool){super();this.pool=pool;this.tx=null;this.leased=false;this.destroyed=false;this.failed=false;this.checkouts=0;this.releases=0;}
  disconnect(){
    this.failed=true;
    const error=Object.assign(new Error('synthetic database connection lost'),{code:'ECONNRESET'});
    this.emit('error',error);return error;
  }
  async loseReply(){
    return new Promise((resolve,reject)=>setImmediate(()=>{
      this.failed=true;
      const error=Object.assign(new Error('synthetic database connection lost'),{code:'ECONNRESET'});
      reject(error);this.emit('error',error);
    }));
  }
  async query(sql,values=[]){
    if(this.failed)throw Object.assign(new Error('Client is not queryable after connection loss'),{code:'ECONNRESET'});
    if(scenario.failInitialization&&sql.startsWith('CREATE TABLE')){scenario.failInitialization=false;return this.loseReply();}
    if(sql==='BEGIN')this.tx=structuredClone(scenario.state);
    // V2.0.0 reads send the ledger only when its row version (xmin) changed.
    if(sql.startsWith('SELECT xmin')){const version=String(scenario.version);return {rows:[{version,state:values[0]===version?null:structuredClone(this.tx??scenario.state)}]};}
    if(sql.startsWith('UPDATE bank_state')){this.tx=JSON.parse(values[0]);this.updated=true;}
    if(sql==='COMMIT'){
      scenario.state=this.tx;this.tx=null;if(this.updated){scenario.version++;this.updated=false;}
      if(scenario.commitFault==='lost'){
        scenario.commitFault=null;return this.loseReply();
      }
      if(scenario.commitFault==='after-ack'){
        scenario.commitFault=null;queueMicrotask(()=>this.disconnect());
      }
    }
    if(sql==='ROLLBACK'){this.tx=null;this.updated=false;}
    return {rows:[]};
  }
  release(destroy=false){
    assert.equal(this.leased,true,'a client must not be released twice');
    this.leased=false;this.releases++;this.destroyed=!!destroy;
  }
}
pg.Pool=FaultPool;
after(()=>{pg.Pool=RealPool;if(savedDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=savedDatabase;});
function reset(){
  const state=initialState();setup(state,'setup','setup','recovery-parent-password','123456');
  createSession(state,'dad','recovery-session');
  scenario={state,version:1,pools:[],clients:[],failInitialization:false,commitFault:null};
}
async function bank(){reset();return import('../lib/store.mjs?database-recovery='+ ++sequence);}
const grant=(key,amount='3')=>state=>runAction(state,'dad','cash.grant',{amount},key);

test('a reused physical client keeps one error listener and every checkout is released once',async()=>{
  const store=await bank();await store.readStore();
  for(let i=0;i<12;i++){await store.mutateStore(grant('recovery-reuse-'+i));await store.readStore();}
  assert.equal(scenario.clients.length,1);
  const client=scenario.clients[0];
  assert.equal(client.listenerCount('error'),1,'listeners must not accumulate on every checkout');
  assert.equal(client.releases,client.checkouts);assert.equal(client.destroyed,false);
});

test('a Client error during initialization is controlled and destroys its client and pool before reconnecting',async()=>{
  const store=await bank();scenario.failInitialization=true;
  await assert.rejects(store.readStore(),error=>error.code==='BANK_STORE_UNAVAILABLE'&&error.cause?.code==='ECONNRESET');
  const failed=scenario.clients[0];
  // Startup checks out the client twice (ready check, then full initialization): each checkout is released exactly once.
  assert.equal(failed.destroyed,true);assert.equal(failed.releases,failed.checkouts);assert.equal(failed.checkouts,2);assert.equal(scenario.pools[0].ended,true);
  assert.equal((await store.readStore()).cashCents,0);assert.equal(scenario.pools.length,2);
});

test('a disconnect while the financial callback awaits kills no process, commits nothing, and does not replay the callback',async()=>{
  const store=await bank();await store.readStore();const before=structuredClone(scenario.state);
  let callbacks=0;
  await assert.rejects(store.mutateStore(async state=>{
    callbacks++;grant('recovery-callback-loss')(state);
    // No query is active while the business callback is awaiting this event.
    await new Promise(resolve=>setImmediate(()=>{scenario.clients.at(-1).disconnect();resolve();}));
  }),{code:'BANK_STORE_UNAVAILABLE'});
  assert.equal(callbacks,1);assert.deepEqual(scenario.state,before);
  assert.equal(scenario.clients[0].destroyed,true);
  await store.mutateStore(grant('recovery-callback-loss'));
  assert.equal((await store.readStore()).cashCents,300);
  assert.equal(scenario.pools.length,1,'the same application pool recovers with a fresh connection');
});

test('a committed write with a lost reply returns a controlled error and same-process same-key retry cannot credit twice',async()=>{
  const store=await bank();await store.readStore();scenario.commitFault='lost';let callbacks=0;
  const action=state=>{callbacks++;return grant('recovery-commit-loss')(state);};
  await assert.rejects(store.mutateStore(action),{code:'BANK_STORE_UNAVAILABLE'});
  assert.equal(callbacks,1,'never automatically replay an uncertain commit');
  assert.equal(scenario.state.cashCents,300);assert.ok(scenario.state.processed.includes('dad|recovery-commit-loss'));
  assert.equal(scenario.clients[0].destroyed,true);
  const retried=await store.mutateStore(action);
  assert.equal(retried.duplicate,true);assert.equal((await store.readStore()).cashCents,300);
  assert.equal(scenario.state.ledger.filter(row=>row.type==='cash.grant').length,1);
  assert.equal(scenario.pools.length,1);
});

test('a connection lost immediately after a successful COMMIT acknowledgement is destroyed even without rollback',async()=>{
  const store=await bank();await store.readStore();scenario.commitFault='after-ack';
  await store.mutateStore(grant('recovery-after-ack'));
  assert.equal(scenario.clients[0].destroyed,true,'an acknowledged write must not return its broken client to the pool');
  assert.equal((await store.readStore()).cashCents,300);
  assert.equal(scenario.clients.length,2);
});

test('the API returns private controlled JSON 503 for a lost COMMIT reply and accepts a same-process retry',async t=>{
  reset();t.mock.method(console,'error',()=>{});
  const {handleApi}=await import('../lib/api.mjs?database-recovery-api');
  const headers={'Content-Type':'application/json',cookie:'goldengoose_session=recovery-session'};
  const bootstrap=()=>handleApi(new Request('http://localhost/api/bootstrap',{headers}));
  assert.equal((await bootstrap()).status,200);
  const action=()=>handleApi(new Request('http://localhost/api/action',{method:'POST',headers,body:JSON.stringify({action:'cash.grant',payload:{amount:'3'},idempotencyKey:'recovery-api-commit-loss'})}));
  scenario.commitFault='lost';const failed=await action(),body=await failed.json();
  assert.equal(failed.status,503);assert.equal(body.code,'BANK_STORE_UNAVAILABLE');
  assert.equal(failed.headers.get('cache-control'),'no-store');assert.doesNotMatch(body.error,/synthetic|ECONNRESET|connection lost/);
  assert.equal((await bootstrap()).status,200);
  const retry=await action();assert.equal(retry.status,200);assert.equal((await retry.json()).duplicate,true);
  assert.equal(scenario.state.cashCents,300);
});
