import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initialState } from './core.mjs';

const localFile=process.env.BANK_DATA_FILE||fileURLToPath(new URL('../data/bank.local.json',import.meta.url));
let queue=Promise.resolve();
let poolPromise=null;
const failedClients=new WeakSet();
const envDatabase=()=>process.env.DATABASE_URL;
function unavailableStore(cause){
  const error=new Error('账本数据库暂时不可用，请保留当前页面，稍后重试。',{cause});
  error.code='BANK_STORE_UNAVAILABLE';return error;
}
// Server logs only (never sent to the page): the underlying reason, with any
// credentials in a URL removed, so a 503 on Netlify can actually be diagnosed.
export function storeErrorDetail(error){
  const cause=error?.cause;if(!cause)return '';
  const text=String(cause.message||'').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/gi,'***@').slice(0,300);
  return ` | cause: ${cause.code||cause.name||'Error'} ${text}`;
}
// node-postgres 8.x treats sslmode=require/prefer/verify-ca in a connection URL as
// verify-full: the certificate must chain to Node's public CA list. Supabase signs
// its database and pooler certificates with its own CA, so the documented
// "...:6543/postgres?sslmode=require" URL failed every connection with
// SELF_SIGNED_CERT_IN_CHAIN. Apply PostgreSQL (libpq) sslmode semantics instead:
//   DATABASE_CA_CERT (PEM) set     → TLS, certificate chain verified against that CA
//                                    (plus hostname, except sslmode=verify-ca)
//   sslmode=verify-full|verify-ca  → TLS verified against Node's public CA list
//   sslmode=require|prefer|allow   → TLS without certificate verification (libpq "require")
//   no sslmode, remote host        → same as require: never send the ledger in plain text
//   no sslmode, localhost          → no TLS (local test database)
//   sslmode=disable                → no TLS
// Session timeouts are not passed as connection startup parameters: transaction
// poolers (Supabase Supavisor :6543) ignore them and PgBouncer rejects them.
// They are set per transaction instead (TX_TIMEOUTS).
export function databaseConfig(env=process.env){
  let url;
  try{url=new URL(String(env.DATABASE_URL||'').trim());}catch(cause){throw unavailableStore(new Error('DATABASE_URL is not a valid postgresql:// URL',{cause}));}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw unavailableStore(new Error('DATABASE_URL must start with postgresql://'));
  const mode=String(url.searchParams.get('sslmode')||'').toLowerCase();
  // These would make node-postgres replace the TLS settings chosen below.
  for(const key of ['sslmode','ssl','sslrootcert','sslcert','sslkey','uselibpqcompat','sslnegotiation'])url.searchParams.delete(key);
  const ca=String(env.DATABASE_CA_CERT||'').replace(/\\n/g,'\n').trim();
  let ssl;
  if(ca)ssl=mode==='verify-ca'?{ca,rejectUnauthorized:true,checkServerIdentity:()=>undefined}:{ca,rejectUnauthorized:true};
  else if(mode==='disable')ssl=false;
  else if(mode==='verify-full'||mode==='verify-ca')ssl={rejectUnauthorized:true};
  else if(mode||env.NETLIFY||!/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname))ssl={rejectUnauthorized:false};
  else ssl=false;
  return {connectionString:url.toString(),ssl,max:1,connectionTimeoutMillis:5000,query_timeout:6000};
}
const TX_TIMEOUTS="SELECT set_config('lock_timeout','4000',true),set_config('statement_timeout','5000',true)";
// Every page refresh (each open page polls every 30 s) used to resend the whole
// ledger row from the database, including price history and long-lived records.
// On Supabase that transfer is metered egress (Free plan: 5 GB a month). Keep the
// last row this process read and ask PostgreSQL to send the row again only when
// its version changed. Every UPDATE by any process gives the row a new xmin, so a
// stale copy can never be served; a rolled-back write leaves the old version. The
// server start time is part of the version so that a restore (which restarts the
// server and may reuse transaction ids) can never match a copy from before it.
const ROW_VERSION="xmin::text||'@'||extract(epoch from pg_postmaster_start_time())::text";
const LEDGER_ROW=`SELECT ${ROW_VERSION} AS version, CASE WHEN ${ROW_VERSION}=$1 THEN NULL ELSE state END AS state FROM bank_state WHERE id=1`;
let cachedLedger=null;
async function readLedgerRow(executor,lock=false){
  const known=cachedLedger; // capture: a concurrent read may replace the cache meanwhile
  const q=await databaseQuery(executor,lock?LEDGER_ROW+' FOR UPDATE':LEDGER_ROW,[known?.version??null]);
  const row=q.rows[0];
  if(!row?.version)throw unavailableStore(new Error('Missing ledger row'));
  if(row.state===null||row.state===undefined){
    // state is NOT NULL, so NULL only means "unchanged since the copy we sent".
    if(known?.version===row.version)return structuredClone(known.state);
    throw unavailableStore(new Error('Missing ledger row'));
  }
  cachedLedger={version:row.version,state:row.state};
  return structuredClone(row.state); // callers (and failed transactions) never alter the cache
}
// Read-only view of the ledger this warm process last read (null when cold). Callers must
// not modify it; it lets a request recognise a known session without a database round trip.
export function cachedLedgerState(){return cachedLedger?.state??null;}
// Cold start, existing ledger: confirm in two reads that the table is private and the row
// exists, instead of the nine-statement locked initialization. Anything unexpected (or a
// database without that table) returns false and the full initialization below runs.
const LEDGER_READY=`SELECT c.relrowsecurity AS rls,
  NOT has_table_privilege('public',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
    AND has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS private
  FROM pg_class c WHERE c.oid=to_regclass('bank_state')`;
async function ledgerReady(pool){
  const client=await databaseClient(pool);let destroy=false;
  try{
    const table=(await databaseQuery(client,LEDGER_READY)).rows[0];
    if(table?.rls!==true||table.private!==true)return false;
    return (await databaseQuery(client,'SELECT EXISTS (SELECT 1 FROM bank_state WHERE id=1) AS ready')).rows[0]?.ready===true;
  }catch(error){destroy=true;throw error;}
  finally{releaseDatabaseClient(client,destroy);}
}
async function databaseQuery(client,...args){try{return await client.query(...args);}catch(cause){throw unavailableStore(cause);}}
async function databaseClient(pool){try{return await pool.connect();}catch(cause){throw unavailableStore(cause);}}
function releaseDatabaseClient(client,destroy=false){client.release(destroy||failedClients.has(client));}
async function getPool(){
  if(!poolPromise){
    const pending=(async()=>{
      const config=databaseConfig();
      const {default:pg}=await import('pg');
      const pool=new pg.Pool(config);
      // pg removes its idle error listener while a client is checked out. Keep
      // one listener for that client's whole lifetime, including initialization
      // and gaps between transaction queries, so a lost socket cannot crash Node.
      // Queries still reject normally; the failed client is destroyed on release.
      pool.on('connect',client=>client.on('error',()=>failedClients.add(client)));
      // pg removes a failed idle client itself. Handle the event so a database
      // restart does not terminate an otherwise reusable serverless process.
      pool.on('error',error=>console.error('[bank-store] idle database connection closed',(error.code||'DATABASE_CONNECTION_ERROR')+storeErrorDetail({cause:error})));
      let client,destroy=false;
      try{
        if(await ledgerReady(pool))return pool;
        client=await databaseClient(pool);
        await databaseQuery(client,'BEGIN');
        await databaseQuery(client,TX_TIMEOUTS);
        // Concurrent cold starts must not race CREATE TABLE (IF NOT EXISTS
        // alone does not serialize PostgreSQL catalogue creation).
        await databaseQuery(client,'SELECT pg_advisory_xact_lock(1380403010)');
        await databaseQuery(client,'CREATE TABLE IF NOT EXISTS bank_state (id INTEGER PRIMARY KEY CHECK (id=1), state JSONB NOT NULL)');
        // Supabase may expose public-schema tables through its Data API. With
        // no public policies, RLS keeps the complete ledger private; the owner
        // connection used by these server functions still has normal access.
        await databaseQuery(client,'ALTER TABLE bank_state ENABLE ROW LEVEL SECURITY');
        await databaseQuery(client,'REVOKE ALL ON TABLE bank_state FROM PUBLIC');
        await databaseQuery(client,`DO $bank_acl$
          DECLARE web_role text;
          BEGIN
            FOR web_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
              EXECUTE format('REVOKE ALL ON TABLE bank_state FROM %I', web_role);
            END LOOP;
          END $bank_acl$`);
        await databaseQuery(client,'INSERT INTO bank_state (id,state) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING',[JSON.stringify(initialState())]);
        await databaseQuery(client,'COMMIT');
        return pool;
      }catch(error){
        if(client)try{await client.query('ROLLBACK');}catch{destroy=true;}
        if(client){releaseDatabaseClient(client,destroy);client=null;}
        await pool.end().catch(()=>{});
        throw error.code==='BANK_STORE_UNAVAILABLE'?error:unavailableStore(error);
      }finally{if(client)releaseDatabaseClient(client,destroy);}
    })();
    poolPromise=pending;
    // Failed initialization must release its pool and let the next request reconnect.
    pending.catch(()=>{if(poolPromise===pending)poolPromise=null;});
  }
  return poolPromise;
}
function unreadableStore(cause){
  const error=new Error('账本文件暂时无法读取，请稍后刷新；若持续出现，请保留原文件并检查账本备份。',{cause});
  error.code='BANK_STORE_UNREADABLE';return error;
}
async function getLocal(){
  // Retry only reading/parsing a snapshot, never the financial operation. An
  // external sync/older process can briefly expose incomplete JSON even though
  // this version writes by atomic rename. Persistent damage must not reset it.
  const waits=[0,25,75];
  for(let attempt=0;attempt<waits.length;attempt++){
    if(waits[attempt])await delay(waits[attempt]);
    try{return JSON.parse(await fs.readFile(localFile,'utf8'));}
    catch(e){
      if(e.code==='ENOENT'){
        if(attempt===0)return initialState();
        throw unreadableStore(e); // A previously malformed ledger is not a new bank.
      }
      if(!(e instanceof SyntaxError))throw e;
      if(attempt===waits.length-1)throw unreadableStore(e);
    }
  }
}
async function saveLocal(s){
  const serialized=JSON.stringify(s,null,2);
  await fs.mkdir(path.dirname(localFile),{recursive:true});
  const tmp=localFile+'.tmp-'+process.pid+'-'+randomUUID();
  let handle;
  try{
    handle=await fs.open(tmp,'wx',0o600);
    await handle.writeFile(serialized,'utf8');await handle.sync();
    await handle.close();handle=null;
    await fs.rename(tmp,localFile);
  }finally{
    if(handle)await handle.close().catch(()=>{});
    await fs.rm(tmp,{force:true}).catch(()=>{});
  }
}
export async function readStore(){
  if(envDatabase())return readLedgerRow(await getPool());
  if(process.env.NETLIFY)throw Error('Netlify 必须配置 DATABASE_URL，禁止使用临时本地文件保存资金账本');
  await queue; // A refresh observes local operations already queued before it.
  return getLocal();
}
async function updateStore(fn){
  if(envDatabase()){
    const pool=await getPool(),client=await databaseClient(pool);let destroy=false;
    try{
      await databaseQuery(client,'BEGIN');
      await databaseQuery(client,TX_TIMEOUTS);
      const state=await readLedgerRow(client,true),result=await fn(state);
      await databaseQuery(client,'UPDATE bank_state SET state=$1::jsonb WHERE id=1',[JSON.stringify(state)]);
      await databaseQuery(client,'COMMIT');return result;
    }catch(error){
      // Preserve the original error if a broken connection also prevents rollback.
      // Never replay a financial callback automatically after an uncertain COMMIT.
      try{await client.query('ROLLBACK');}catch{destroy=true;}
      throw error;
    }finally{releaseDatabaseClient(client,destroy);}
  }
  if(process.env.NETLIFY)throw Error('Netlify 未设置 DATABASE_URL');
  const s=await getLocal();const result=await fn(s);await saveLocal(s);return result;
}
export function mutateStore(fn){
  const job=queue.then(()=>updateStore(fn));
  queue=job.catch(()=>{});
  return job;
}
