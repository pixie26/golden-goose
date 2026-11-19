import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, storeErrorDetail } from '../lib/store.mjs';

// v1.0.1 launch blocker: node-postgres 8.x treats sslmode=require as verify-full, so
// the documented Supabase URL (private CA) failed every connection. These cases pin
// PostgreSQL (libpq) sslmode semantics. Real TLS behaviour: postgres-integration.test.mjs.
const URL_BASE='postgresql://postgres.ref:p%40ss%23word@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
const CA='-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const cfg=(query='',extra={})=>databaseConfig({DATABASE_URL:URL_BASE+query,...extra});

test('the documented Supabase URL (sslmode=require) encrypts without failing on Supabase\'s own CA',()=>{
 const c=cfg('?sslmode=require');
 assert.deepEqual(c.ssl,{rejectUnauthorized:false});
 assert.equal(c.connectionString,URL_BASE,'TLS keys are removed so pg cannot override the TLS settings');
 assert.equal(cfg('?sslmode=prefer').ssl.rejectUnauthorized,false);
});

test('DATABASE_CA_CERT turns on full verification, including a one-line value with literal \\n',()=>{
 for(const value of [CA,CA.replace(/\n/g,'\\n')]){
  const c=cfg('?sslmode=require',{DATABASE_CA_CERT:value});
  assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(c.ssl.ca,CA);assert.equal(c.ssl.checkServerIdentity,undefined,'hostname is verified');
 }
 const ca=cfg('?sslmode=verify-ca',{DATABASE_CA_CERT:CA}).ssl;
 assert.equal(ca.rejectUnauthorized,true);assert.equal(typeof ca.checkServerIdentity,'function','verify-ca skips only the hostname check');
});

test('verify-full without a CA uses the public CA list; a remote host defaults to TLS; local and explicit disable stay plain',()=>{
 assert.deepEqual(cfg('?sslmode=verify-full').ssl,{rejectUnauthorized:true});
 assert.deepEqual(cfg('').ssl,{rejectUnauthorized:false},'Supabase URL pasted without sslmode is still encrypted');
 assert.equal(cfg('?sslmode=disable').ssl,false,'an explicit disable is respected');
 for(const host of ['localhost','127.0.0.1','[::1]'])assert.equal(databaseConfig({DATABASE_URL:`postgresql://u:p@${host}:5432/db`}).ssl,false,host);
 assert.deepEqual(databaseConfig({DATABASE_URL:'postgresql://u:p@localhost:5432/db',NETLIFY:'true'}).ssl,{rejectUnauthorized:false});
});

test('timeouts are never sent as connection startup parameters; other URL options are kept',()=>{
 const c=cfg('?sslmode=require&application_name=goose&uselibpqcompat=true&sslrootcert=/x.crt');
 assert.equal(c.statement_timeout,undefined);assert.equal(c.lock_timeout,undefined);
 assert.equal(c.connectionString,URL_BASE+'?application_name=goose');
 assert.equal(c.max,1);assert.ok(c.connectionTimeoutMillis<=5000);assert.ok(c.query_timeout>0);
});

test('a malformed DATABASE_URL is a store-unavailable error with a readable cause',()=>{
 for(const bad of ['not a url','https://example.com/db','']){
  assert.throws(()=>databaseConfig({DATABASE_URL:bad}),e=>e.code==='BANK_STORE_UNAVAILABLE'&&/DATABASE_URL/.test(storeErrorDetail(e)));
 }
});

test('server logs name the root cause but never a credential embedded in a URL',()=>{
 const err=Object.assign(new Error('账本数据库暂时不可用'),{cause:Object.assign(new Error('connect failed for postgresql://user:secret@db.host:6543/postgres'),{code:'SELF_SIGNED_CERT_IN_CHAIN'})});
 const line=storeErrorDetail(err);
 assert.match(line,/SELF_SIGNED_CERT_IN_CHAIN/);assert.doesNotMatch(line,/secret|user:/);assert.match(line,/\*\*\*@db\.host/);
 assert.equal(storeErrorDetail(new Error('no cause')),'');
});
