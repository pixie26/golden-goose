import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,view} from '../lib/core.mjs';
const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const fixture='data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/placeholder-avatar.jpg',import.meta.url)).toString('base64');
async function htmlFor(s,role='kid'){
 const root={innerHTML:'',addEventListener:()=>{}};
 const toastEl={textContent:'',className:''};
 const document={getElementById:id=>id==='root'?root:id==='toast'?toastEl:null};
 const fetch=async path=>new Response(JSON.stringify({initialized:true,role,data:view(s,role)}),{status:200,headers:{'content-type':'application/json'}});
 vm.runInNewContext(js,{document,fetch,console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 await new Promise(r=>setTimeout(r,20));
 return root.innerHTML;
}
test('actual home HTML shows investment summary, exact holdings, quote dates and Olivia photo picker',async()=>{
 const s=initialState();s.cashCents=10000;s.positions=[{symbol:'AAPL',qtyMicro:1000000,costCents:100000},{symbol:'0700.HK',qtyMicro:1000000,costCents:20000}];
 s.quotes['AAPL|2026-11-16']={symbol:'AAPL',date:'2026-11-16',priceMilli:150000,currency:'USD',final:true};
 s.profile.kidAvatarData=fixture;
 const html=await htmlFor(s);
 assert.match(html,/我的投资速览/);
 assert.match(html,/股票总市值/);
 assert.match(html,/O\$ 1,400\.0(?![\d.])/,'AAPL marked at O$1200, HK shares without quote at cost O$200');
 assert.match(html,/未实现盈亏/);
 assert.match(html,/\+O\$ 200\.0(?![\d.])/,'only AAPL has a valid unrealized gain');
 assert.match(html,/收盘价日期 2026-11-16/);
 assert.match(html,/1 只持仓暂缺有效收盘价/);
 assert.match(html,/Olivia 的头像/);
 assert.match(html,/id="kid-avatar-file"/);
 assert.match(html,/data-act="profile.avatar.remove"/);
});
test('actual home HTML gracefully handles legacy account, no portfolio and dad role',async()=>{
 const s=initialState();delete s.profile;
 let html=await htmlFor(s);
 assert.match(html,/还没有股票持仓/);
 assert.match(html,/上传或更换 Olivia 的头像/);
 assert.doesNotMatch(html,/class="avatar-photo"/);
 html=await htmlFor(s,'dad');
 assert.match(html,/家长的金鹅头像/);
 assert.doesNotMatch(html,/id="kid-avatar-file"/);
});
