import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// v1.0.1: `npm run dev` used --env-file-if-exists, which only exists from Node.js
// 22.9, so the launcher failed on earlier 22.x with "bad option". server.mjs now
// loads the project's .env itself, before the store resolves BANK_DATA_FILE.
const project=fileURLToPath(new URL('..',import.meta.url));
const dir=await fs.mkdtemp(join(tmpdir(),'goose-env-'));
after(()=>fs.rm(dir,{recursive:true,force:true}));
// A private copy keeps any mistake away from the real project's data/ folder.
await fs.cp(join(project,'lib'),join(dir,'app','lib'),{recursive:true});
await fs.copyFile(join(project,'server.mjs'),join(dir,'app','server.mjs'));
// 'junction' needs no admin rights on Windows; the type is ignored elsewhere.
await fs.symlink(join(project,'public'),join(dir,'app','public'),'junction');
await fs.writeFile(join(dir,'app','package.json'),'{"type":"module"}');

const freePort=()=>new Promise(resolve=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port));});});
async function start(extraEnv){
 const env={...process.env,HOST:'127.0.0.1',DISABLE_LOCAL_TIMER:'1',...extraEnv};
 for(const key of ['PORT','BANK_DATA_FILE','SETUP_TOKEN','DATABASE_URL','NETLIFY'])if(!(key in extraEnv))delete env[key];
 const child=spawn(process.execPath,[join(dir,'app','server.mjs')],{cwd:tmpdir(),env,stdio:['ignore','pipe','pipe']});
 let out='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
 for(let i=0;i<100&&!/http:\/\/localhost:(\d+)/.test(out);i++)await new Promise(r=>setTimeout(r,50));
 const port=Number(out.match(/http:\/\/localhost:(\d+)/)?.[1]);assert.ok(port,'server started: '+out);
 const setupWith=token=>fetch(`http://127.0.0.1:${port}/api/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:'local-parent-password',pin:'123456'})});
 return {port,setupWith,stop:()=>new Promise(r=>{child.once('exit',r);child.kill();})};
}

test('the server reads the project .env (port, setup token, ledger path) from any working directory',async()=>{
 const port=await freePort(),ledger=join(dir,'ledger-from-dotenv.json');
 await fs.writeFile(join(dir,'app','.env'),`PORT=${port}\nSETUP_TOKEN=token-from-dotenv-file\nBANK_DATA_FILE=${ledger}\n`);
 const s=await start({});
 try{
  assert.equal(s.port,port,'PORT from .env');
  assert.equal((await s.setupWith('local-setup')).status,400,'the .env token replaces the default local token');
  assert.equal((await s.setupWith('token-from-dotenv-file')).status,200);
  const saved=JSON.parse(await fs.readFile(ledger,'utf8'));assert.ok(saved.dadHash,'ledger written to BANK_DATA_FILE from .env');
 }finally{await s.stop();}
});

test('real environment variables take precedence over .env',async()=>{
 const port=await freePort(),ledger=join(dir,'ledger-from-env.json');
 const s=await start({PORT:String(port),SETUP_TOKEN:'token-from-real-env',BANK_DATA_FILE:ledger});
 try{
  assert.equal(s.port,port);
  assert.equal((await s.setupWith('token-from-dotenv-file')).status,400);
  assert.equal((await s.setupWith('token-from-real-env')).status,200);
  assert.ok(JSON.parse(await fs.readFile(ledger,'utf8')).dadHash);
 }finally{await s.stop();}
});

test('npm scripts no longer depend on a Node.js 22.9-only flag',async()=>{
 const pkg=JSON.parse(await fs.readFile(join(project,'package.json'),'utf8'));
 for(const name of ['dev','lan','start'])assert.doesNotMatch(pkg.scripts[name],/--env-file/,name);
});
