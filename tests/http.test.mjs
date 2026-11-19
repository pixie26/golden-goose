import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const folder=dirname(fileURLToPath(import.meta.url));
const root=join(folder,'..');
async function freePort(){return await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function waitReady(port){for(let i=0;i<70;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/bootstrap`);if(r.ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,75));}throw Error('Local HTTP server did not start');}
test('real local HTTP server forwards ?q= keyword to Yahoo search API',async()=>{
 const port=await freePort(),dir=await mkdtemp(join(tmpdir(),'goose-http-'));
 const proc=spawn(process.execPath,['--import',join(folder,'mock-yahoo.mjs'),'server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DISABLE_LOCAL_TIMER:'1',BANK_DATA_FILE:join(dir,'state.json'),SETUP_TOKEN:'http-test-setup'},stdio:'ignore'});
 try{
  await waitReady(port);
  const origin=`http://127.0.0.1:${port}`;
  let r=await fetch(origin+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({token:'http-test-setup',password:'strong-test-dad-password',pin:'654321'})});assert.equal(r.status,200);
  r=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({role:'kid',password:'654321'})});assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await fetch(origin+'/api/stocks/search?q=AAPL',{headers:{Cookie:cookie}});
  assert.equal(r.status,200);const payload=await r.json();assert.equal(payload.results[0].symbol,'AAPL');
 }finally{proc.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
});
