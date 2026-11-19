import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import pg from 'pg';
import { initialState, setup, createSession, revokeSession, runAction as coreAction, view } from '../lib/core.mjs';

// Fewer Hong Kong ↔ US round trips and smaller responses: an action returns the updated state,
// a warm instance skips the separate session read, polls send the state version they hold,
// and API JSON is compressed. Runs against a controlled driver, not a real database.
const RealPool=pg.Pool,savedDatabase=process.env.DATABASE_URL;
process.env.DATABASE_URL='postgresql://speed.invalid/test';
const KID='kid-session-token-speed-0001',KID_ELSEWHERE='kid-session-token-speed-0002',DAD='dad-session-token-speed-0001';
const state=initialState();setup(state,'t','t','api-speed-parent-password','123456');
for(const [role,token] of [['kid',KID],['kid',KID_ELSEWHERE],['dad',DAD]])createSession(state,role,token);
const db={state,version:1,log:[]};
const row=(values,tx)=>({rows:[{version:String(db.version),state:values[0]===String(db.version)?null:structuredClone(tx??db.state)}]});
class FakePool extends EventEmitter {
  async connect(){return new FakeClient();}
  async query(sql,values=[]){db.log.push('read');return row(values);}
  async end(){}
}
class FakeClient {
  async query(sql,values=[]){
    if(sql.startsWith('SELECT c.relrowsecurity'))return {rows:[{rls:true,private:true}]};
    if(sql.startsWith('SELECT EXISTS'))return {rows:[{ready:true}]};
    db.log.push(sql.startsWith('SELECT xmin')?'lock':sql.split(/\s/)[0]);
    if(sql==='BEGIN')this.tx=structuredClone(db.state);
    if(sql.startsWith('SELECT xmin'))return row(values,this.tx);
    if(sql.startsWith('UPDATE bank_state'))this.tx=JSON.parse(values[0]);
    if(sql==='COMMIT'){db.state=this.tx;db.version++;}
    return {rows:[]};
  }
  release(){}
}
pg.Pool=FakePool;
after(()=>{pg.Pool=RealPool;if(savedDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=savedDatabase;});
const {handleApi}=await import('../lib/api.mjs');

let key=0;
const call=(path,{token=KID,body,encoding}={})=>handleApi(new Request('http://bank.test'+path,{method:body?'POST':'GET',
  headers:{cookie:`goldengoose_session=${token}`,...(body?{'content-type':'application/json'}:{}),...(encoding?{'accept-encoding':encoding}:{})},
  body:body?JSON.stringify(body):undefined}));
const action=(name,payload,token=KID)=>call('/api/action',{token,body:{action:name,payload,idempotencyKey:`api-speed-key-${++key}`}});
async function read(res){
  const raw=Buffer.from(await res.arrayBuffer()),encoding=res.headers.get('content-encoding');
  return JSON.parse((encoding==='br'?zlib.brotliDecompressSync(raw):encoding==='gzip'?zlib.gunzipSync(raw):raw).toString('utf8'));
}

test('an action returns the updated, versioned state with its result',async()=>{
  const before=await read(await call('/api/state'));assert.ok(before.stateVersion);
  const res=await action('loan.request',{amount:'10'}),body=await read(res);
  assert.equal(res.status,200);assert.equal(body.state.role,'kid');
  assert.equal(body.state.loans.length,1);assert.equal(body.state.loans[0].requestedCents,1000);
  assert.ok(body.state.stateVersion);assert.notEqual(body.state.stateVersion,before.stateVersion);
  const after=await read(await call('/api/state'));assert.equal(after.stateVersion,body.state.stateVersion,'same state, same version');
});

test('a warm instance runs a known session’s action as one transaction, without a separate read',async()=>{
  await call('/api/state');db.log=[];
  assert.equal((await action('loan.request',{amount:'5'})).status,200);
  assert.deepEqual(db.log,['BEGIN','SELECT','lock','UPDATE','COMMIT']);
  db.log=[];
  const stranger=await action('loan.request',{amount:'5'},'unknown-session-token-0001');
  assert.equal(stranger.status,403);assert.deepEqual(db.log,['read'],'an unknown session is checked by a plain read and takes no lock');
});

test('a session revoked by another instance is still refused inside the transaction',async()=>{
  await call('/api/state',{token:KID_ELSEWHERE});// this instance has seen the session
  revokeSession(db.state,KID_ELSEWHERE);db.version++;// logged out on another instance
  const loans=db.state.loans.length,res=await action('loan.request',{amount:'5'},KID_ELSEWHERE);
  assert.equal(res.status,403);assert.match((await read(res)).error,/登录已过期/);
  assert.equal(db.state.loans.length,loans,'nothing was written');
});

test('a poll holding the current version gets {unchanged:true}; any change sends the full state',async()=>{
  const current=await read(await call('/api/state'));
  assert.deepEqual(await read(await call('/api/state?since='+current.stateVersion)),{unchanged:true});
  assert.equal((await read(await call('/api/state?since=stale-version'))).stateVersion,current.stateVersion);
  await action('loan.request',{amount:'5'});
  const changed=await read(await call('/api/state?since='+current.stateVersion));
  assert.notEqual(changed.stateVersion,current.stateVersion);assert.ok(changed.loans);
  const dad=await read(await call('/api/state?since='+current.stateVersion,{token:DAD}));
  assert.equal(dad.role,'dad','a version never lets another account’s view pass as unchanged');
});

test('API JSON is compressed as the browser accepts, and small or uncompressible responses are left alone',async()=>{
  const plain=await call('/api/state');assert.equal(plain.headers.get('content-encoding'),null);
  const expected=await read(plain);
  for(const [accept,encoding] of [['gzip, deflate, br','br'],['gzip, deflate','gzip'],['br;q=0, gzip','gzip'],['identity',null]]){
    const res=await call('/api/state',{encoding:accept});
    assert.equal(res.headers.get('content-encoding'),encoding,accept);
    if(encoding)assert.equal(res.headers.get('vary'),'Accept-Encoding');
    assert.deepEqual(await read(res),expected);
  }
  const small=await call('/api/no-such-thing',{encoding:'br'});
  assert.equal(small.status,404);assert.equal(small.headers.get('content-encoding'),null);
  const login=await handleApi(new Request('http://bank.test/api/login',{method:'POST',headers:{'content-type':'application/json','accept-encoding':'br'},body:JSON.stringify({role:'kid',password:'123456'})}));
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/^goldengoose_session=[0-9a-f]{64};/,'cookies survive re-encoding');
});

// ---- the page ----
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
async function mount(s,serve){
  const intervals=[],reads=[],posts=[];
  const root={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}};
  const context=vm.createContext({document:{visibilityState:'visible',getElementById:id=>id==='root'?root:id==='toast'?{textContent:'',className:''}:null,addEventListener(){}},
    console,location:{hostname:'localhost'},confirm:()=>true,setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{intervals.push(fn);return intervals.length;},
    fetch:async(path,options)=>{
      if(path==='/api/bootstrap')return json({initialized:true,role:'kid',data:{...view(s,'kid'),stateVersion:'v1'}});
      const body=options?.body?JSON.parse(options.body):null;if(body)posts.push(body);else reads.push(path);
      return serve(path,body);
    }});
  vm.runInContext(source,context);
  for(let i=0;i<6&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(root.innerHTML);
  return {reads,posts,intervals,run:code=>vm.runInContext(code,context)};
}
function pageBank(){const s=initialState();setup(s,'t','t','api-speed-page-password','123456');return s;}

test('the page installs the state returned with an action instead of reading it again',async()=>{
  const s=pageBank();
  const m=await mount(s,(path,body)=>{coreAction(s,'kid',body.action,body.payload,body.idempotencyKey);return json({ok:true,state:{...view(s,'kid'),stateVersion:'v2'}});});
  await m.run("runAction('loan.request',{amount:'10'})");
  assert.equal(m.posts.length,1);assert.deepEqual(m.reads,[]);
  assert.equal(m.run('data.stateVersion'),'v2');assert.equal(m.run('data.loans.length'),1);
});

test('the page still reads the state when an older server returns none',async()=>{
  const s=pageBank();
  const m=await mount(s,(path,body)=>{if(body){coreAction(s,'kid',body.action,body.payload,body.idempotencyKey);return json({ok:true});}return json(view(s,'kid'));});
  await m.run("runAction('loan.request',{amount:'10'})");
  assert.deepEqual(m.reads,['/api/state']);assert.equal(m.run('data.loans.length'),1);
});

test('background polls send the held version and keep the page when nothing changed',async()=>{
  const s=pageBank();let next={unchanged:true};
  const m=await mount(s,()=>json(next));
  const before=m.run('data');await m.intervals[0]();
  assert.deepEqual(m.reads,['/api/state?since=v1']);assert.equal(m.run('data'),before,'the same object: no re-render work');
  coreAction(s,'kid','loan.request',{amount:'10'},'api-speed-page-key-1');next={...view(s,'kid'),stateVersion:'v3'};
  await m.intervals[0]();
  assert.equal(m.reads[1],'/api/state?since=v1');assert.equal(m.run('data.stateVersion'),'v3');assert.equal(m.run('data.loans.length'),1);
});
