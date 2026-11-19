// Real PostgreSQL checks. Skipped unless TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL='postgresql://user:pw@host:5432/goose_test?sslmode=require' npm test
// Optional: TEST_DATABASE_CA_CERT (PEM) to also verify the certificate, and
// TEST_DATABASE_POOLER_URL (a transaction pooler in front of the same database).
// The database name must contain "test": the bank_state table there is reset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { initialState, setup, runAction } from '../lib/core.mjs';
import { databaseConfig } from '../lib/store.mjs';

const URL_TEST=process.env.TEST_DATABASE_URL||'';
const skip=!URL_TEST?'set TEST_DATABASE_URL to run real PostgreSQL checks':false;
let seq=0;
// Each store module instance is one "function instance" with its own pool. The pool
// reads DATABASE_URL / DATABASE_CA_CERT when it is created, so create it right away.
async function freshStore(databaseUrl=URL_TEST,ca=process.env.TEST_DATABASE_CA_CERT){
 process.env.DATABASE_URL=databaseUrl;
 if(ca)process.env.DATABASE_CA_CERT=ca;else delete process.env.DATABASE_CA_CERT;
 const store=await import('../lib/store.mjs?postgres-integration='+ ++seq);
 await store.readStore().catch(()=>{});
 return store;
}
async function adminClient(){const c=new pg.Client(databaseConfig({...process.env,DATABASE_URL:URL_TEST,DATABASE_CA_CERT:process.env.TEST_DATABASE_CA_CERT||''}));await c.connect();return c;}

test('real PostgreSQL: TLS as configured, ledger writes are serialized, same-key retries commit once, row locks time out cleanly',{skip,timeout:60000},async()=>{
 const dbName=decodeURIComponent(new URL(URL_TEST).pathname.slice(1));
 assert.match(dbName,/test/i,'refusing to reset a database whose name does not contain "test"');
 const admin=await adminClient();
 try{
  await admin.query('DROP TABLE IF EXISTS bank_state'); // reset before any instance initialises it
  const store=await freshStore();
  const mode=new URL(URL_TEST).searchParams.get('sslmode');
  const tls=(await admin.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl;
  if(mode&&mode!=='disable')assert.equal(tls,true,'connection is encrypted');

  // initialise and open the bank
  await store.mutateStore(s=>setup(s,'t','t','integration-password','123456'));
  // concurrent writes from separate pools (separate "function instances")
  const other=await freshStore();
  await Promise.all(Array.from({length:20},(_,i)=>(i%2?store:other).mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'1'},'pg-grant-'+i))));
  let state=await store.readStore();
  assert.equal(state.cashCents,2000);assert.equal(state.ledger.filter(x=>x.type==='cash.grant').length,20);
  // the same request key sent concurrently is applied exactly once
  const same=await Promise.all([store,other,store,other].map(st=>st.mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'5'},'pg-same-key'))));
  assert.equal(same.filter(r=>r.duplicate).length,3);
  state=await store.readStore();assert.equal(state.cashCents,2500);

  // a held ledger row lock makes the next write fail at the lock timeout (not hang), then recover
  // TEST_DATABASE_POOLER_URL decides its own TLS via sslmode (no CA for a local plain hop).
  const lockTarget=process.env.TEST_DATABASE_POOLER_URL?await freshStore(process.env.TEST_DATABASE_POOLER_URL,process.env.TEST_DATABASE_POOLER_CA_CERT||''):store;
  const holder=await adminClient();let waited;
  try{
   await holder.query('BEGIN');await holder.query('SELECT state FROM bank_state WHERE id=1 FOR UPDATE');
   const started=Date.now();
   await assert.rejects(lockTarget.mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'9'},'pg-locked')),e=>e.code==='BANK_STORE_UNAVAILABLE'&&e.cause?.code==='55P03');
   waited=Date.now()-started;
  }finally{await holder.query('COMMIT').catch(()=>{});await holder.end();}
  assert.ok(waited>=3500&&waited<6000,`lock wait ended by lock_timeout after ${waited} ms`);
  await lockTarget.mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'9'},'pg-locked'));
  state=await store.readStore();assert.equal(state.cashCents,3400);
  assert.equal(state.ledger.filter(x=>x.type==='cash.grant').length,22,'the timed-out attempt left nothing behind');

  // RGG-002: pool error handling alone does not cover a checked-out Client.
  // Terminate this test's own backend while the financial callback is awaiting
  // and no query is active on that connection. This must neither kill Node nor
  // commit or automatically replay the callback. No extra database package is needed.
  const recoveryUrl=new URL(URL_TEST),appName='goose_recovery_'+process.pid;
  recoveryUrl.searchParams.set('application_name',appName);
  const recovering=await freshStore(recoveryUrl.toString());let callbacks=0;
  const beforeRecovery=await recovering.readStore();
  await assert.rejects(recovering.mutateStore(async current=>{
   callbacks++;runAction(current,'dad','cash.grant',{amount:'3'},'pg-callback-disconnect');
   const backends=await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()',[appName]);
   assert.equal(backends.rows.length,1,'only the test connection may be terminated');
   const killed=await admin.query('SELECT pg_terminate_backend($1) AS terminated',[backends.rows[0].pid]);
   assert.equal(killed.rows[0].terminated,true);
   await delay(100); // allow the socket error to arrive before the callback returns
  }),{code:'BANK_STORE_UNAVAILABLE'});
  assert.equal(callbacks,1,'a failed financial callback is never automatically replayed');
  assert.deepEqual(await recovering.readStore(),beforeRecovery,'connection loss rolls back every ledger field');
  await recovering.mutateStore(current=>runAction(current,'dad','cash.grant',{amount:'3'},'pg-callback-disconnect'));
  const retried=await recovering.mutateStore(current=>runAction(current,'dad','cash.grant',{amount:'3'},'pg-callback-disconnect'));
  assert.equal(retried.duplicate,true);assert.equal((await recovering.readStore()).cashCents,3700);
 }finally{await admin.end();}
});

test('real PostgreSQL (V2.0.0): unchanged reads carry no ledger body, other instances see every commit, jsonb-safe text commits',{skip,timeout:60000},async()=>{
 const admin=await adminClient();
 try{
  await admin.query('DROP TABLE IF EXISTS bank_state');
  const a=await freshStore(),b=await freshStore();
  await a.mutateStore(s=>setup(s,'t','t','integration-password','123456'));
  // The row-version query on the real server: no ledger body when unchanged.
  const rowVersion="xmin::text||'@'||extract(epoch from pg_postmaster_start_time())::text";
  const probe=version=>admin.query(`SELECT ${rowVersion} AS version, CASE WHEN ${rowVersion}=$1 THEN NULL ELSE state END AS state FROM bank_state WHERE id=1`,[version]);
  const head=(await probe(null)).rows[0];
  assert.ok(head.state.dadHash,'no known version returns the full row');
  assert.equal((await probe(head.version)).rows[0].state,null,'an unchanged row returns no ledger body');
  // A commit by another instance is visible to the next read and to the next locked write.
  const before=await a.readStore();
  await b.mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'7'},'pg-cache-cross-instance'));
  assert.notEqual((await probe(null)).rows[0].version,head.version,'every UPDATE gives the row a new xmin');
  assert.match(head.version,/^\d+@\d+(?:\.\d+)?$/,'xmin plus the server start time');
  assert.equal((await a.readStore()).cashCents,before.cashCents+700);
  await a.mutateStore(s=>runAction(s,'dad','cash.grant',{amount:'1'},'pg-cache-after-cross'));
  assert.equal((await b.readStore()).cashCents,before.cashCents+800);
  assert.equal((await a.readStore()).ledger.filter(x=>x.type==='cash.grant').length,2);
  // NUL and an emoji cut by the length limit are normalized instead of failing the whole write.
  await a.mutateStore(s=>runAction(s,'kid','purchase.request',{name:'小'.repeat(89)+'🦄',amount:'1',note:'x\u0000y'},'pg-jsonb-text'));
  const stored=(await admin.query("SELECT state->'purchaseRequests'->0->>'name' AS name, state->'purchaseRequests'->0->>'note' AS note FROM bank_state WHERE id=1")).rows[0];
  assert.equal(stored.name,'小'.repeat(89));assert.equal(stored.note,'xy');
 }finally{await admin.end();}
});
