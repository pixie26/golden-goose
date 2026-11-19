import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, setup, runAction, view, validateKidAvatar } from '../lib/core.mjs';
const jpeg='data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/placeholder-avatar.jpg',import.meta.url)).toString('base64');
const largeJpeg='data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/large-avatar-test.jpg',import.meta.url)).toString('base64');
const key=(i)=>`v14-test-unique-id-${i}`;

test('Olivia uploads/replaces/removes her own avatar without parent approval, without mutating financial balances',()=>{
 const s=initialState();setup(s,'test-token','test-token','long-dad-password-here','123456');
 const before=view(s,'kid').summary;
 assert.equal(s.profile.kidAvatarData,null);
 assert.equal(validateKidAvatar(jpeg),jpeg);
 assert.equal(runAction(s,'kid','profile.avatar.set',{imageData:jpeg},key(1)).ok,true);
 assert.equal(view(s,'kid').profile.kidAvatarData,jpeg);
 assert.equal(view(s,'dad').profile.kidAvatarData,jpeg);
 assert.deepEqual(view(s,'kid').summary,before);
 assert.equal(s.ledger.length,0);
 assert.equal(runAction(s,'kid','profile.avatar.set',{imageData:jpeg},key(1)).duplicate,true);
 assert.throws(()=>runAction(s,'dad','profile.avatar.remove',{},key(2)),/只有 Olivia/);
 assert.throws(()=>runAction(s,'dad','profile.avatar.set',{imageData:jpeg},key(3)),/只有 Olivia/);
 assert.equal(runAction(s,'kid','profile.avatar.remove',{},key(4)).ok,true);
 assert.equal(view(s,'kid').profile.kidAvatarData,null);
 assert.deepEqual(view(s,'kid').summary,before);
});

test('rejects SVG, malformed JPEG, nonsquare images, overlarge data and preserves old V1.3 states',()=>{
 const s=initialState();delete s.profile;
 assert.equal(view(s,'kid').profile.kidAvatarData,null,'old data without profile field must still work');
 assert.throws(()=>validateKidAvatar('data:image/svg+xml;base64,PHN2Zz4='),/只能保存为 JPG/);
 assert.throws(()=>validateKidAvatar('data:image/jpeg;base64,'+'A'.repeat(300000)),/过大/);
 const broken='data:image/jpeg;base64,'+Buffer.alloc(1000,44).toString('base64');
 assert.throws(()=>validateKidAvatar(broken),/不是有效/);
 const x=Buffer.from(jpeg.split(',')[1],'base64');
 // Modify height field in a known SOF0 header to make the image non-square.
 let sof=-1;
 for(let i=2;i<x.length-8;i++)if(x[i]===255&&[0xc0,0xc1,0xc2].includes(x[i+1])){sof=i;break;}
 assert.ok(sof>=0);
 x.writeUInt16BE(128,sof+5);
 assert.throws(()=>validateKidAvatar('data:image/jpeg;base64,'+x.toString('base64')),/正方形/);
});

test('home page code renders stock mark-to-market, P&L, holding count and trade-date labels',()=>{
 const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/investmentSnapshot\(\)/);
 assert.match(app,/股票市值/);
 assert.match(app,/未实现盈亏/);
 assert.match(app,/持仓数量/);
 assert.match(app,/收盘价日期/);
 assert.match(app,/kid-avatar-file/);
 assert.match(app,/profile\.avatar\.set/);
});

test('API persists avatar JPEG with a request body larger than the previous 16 KiB limit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'goldengoose-v14-'));
 const oldFile=process.env.BANK_DATA_FILE;
 const oldToken=process.env.SETUP_TOKEN;
 process.env.BANK_DATA_FILE=join(dir,'data.json');process.env.SETUP_TOKEN='avatar-api-token';
 try{
  const {handleApi}=await import('../lib/api.mjs');
  const request=(path,method='GET',body,cookie)=>{const headers={};if(cookie)headers.cookie=cookie;if(body)headers['Content-Type']='application/json';return handleApi(new Request('http://localhost:3000'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})}));};
  let r=await request('/api/setup','POST',{token:'avatar-api-token',password:'strong-dad-password-123',pin:'123456'});assert.equal(r.status,200);
  r=await request('/api/login','POST',{role:'kid',password:'123456'});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
  assert.ok(largeJpeg.length>16384,'avatar API test must exceed old 16KB request limit');
  r=await request('/api/action','POST',{action:'profile.avatar.set',payload:{imageData:largeJpeg},idempotencyKey:key(9)},cookie);assert.equal(r.status,200);
  r=await request('/api/state','GET',null,cookie);assert.equal((await r.json()).profile.kidAvatarData,largeJpeg);
 }finally{if(oldFile===undefined)delete process.env.BANK_DATA_FILE;else process.env.BANK_DATA_FILE=oldFile;if(oldToken===undefined)delete process.env.SETUP_TOKEN;else process.env.SETUP_TOKEN=oldToken;await rm(dir,{recursive:true,force:true});}
});
