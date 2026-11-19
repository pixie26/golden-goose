import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,view} from '../lib/core.mjs';

const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
async function renderSnapshot({state=initialState(),role='kid',initialized=true}={}){
 const root={innerHTML:'',addEventListener(){}};
 const toastEl={textContent:'',className:''};
 const document={getElementById:id=>id==='root'?root:id==='toast'?toastEl:null};
 const fetch=async()=>new Response(JSON.stringify({initialized,role,data:role?view(state,role):null}),{status:200,headers:{'content-type':'application/json'}});
 vm.runInNewContext(js,{document,fetch,console,setTimeout,clearTimeout,location:{hostname:'localhost'}});
 await new Promise(r=>setTimeout(r,25));
 return root.innerHTML;
}

test('V1.9 login and first-time setup both use selected royal goose and new fairytale scene',async()=>{
 const login=await renderSnapshot({role:null});
 assert.match(login,/class="auth-world"/);
 assert.match(login,/src="\/assets\/images\/brand-goose\.png"/);
 assert.match(login,/data-login-role="kid"/);
 assert.match(login,/data-login-role="dad"/);
 assert.match(login,/name="password"/);
 assert.doesNotMatch(login,/class="auth-goose"/);
 const setup=await renderSnapshot({role:null,initialized:false});
 assert.match(setup,/src="\/assets\/images\/brand-goose\.png"/);
 assert.match(setup,/data-op="setup"/);
 assert.match(setup,/name="token"/);
 assert.match(setup,/name="pin"/);
});

test('V1.9 home displays the existing watchlist with price, market, date, 1D/1W/YTD',async()=>{
 const state=initialState();
 state.watchlist=['AAPL','0700.HK'];
 state.priceHistory['AAPL']=[
  {date:'2025-12-31',priceMilli:200000},
  {date:'2026-11-09',priceMilli:250000},
  {date:'2026-11-10',priceMilli:260000},
  {date:'2026-11-11',priceMilli:268000},
  {date:'2026-11-12',priceMilli:269000},
  {date:'2026-11-13',priceMilli:270000},
  {date:'2026-11-16',priceMilli:276000},
  {date:'2026-11-17',priceMilli:280000},
 ];
 state.quotes['AAPL|2026-11-17']={symbol:'AAPL',date:'2026-11-17',priceMilli:280000,currency:'USD'};
 const html=await renderSnapshot({state});
 assert.match(html,/我的自选股票/);
 assert.match(html,/home-watch-card/);
 assert.match(html,/home-stock-tile/);
 assert.match(html,/AAPL/);
 assert.match(html,/0700\.HK/);
 assert.match(html,/280\.0 USD/);
 assert.match(html,/收盘 2026-11-17/);
 assert.match(html,/1D/);
 assert.match(html,/1W/);
 assert.match(html,/YTD/);
 assert.match(html,/\+40\.0%/);
 assert.match(html,/管理自选 · 2\/10/);
 assert.match(html,/data-tab="stocks"/);
 assert.match(html,/最近一个交易日的收盘价/);
 // Homepage watchlist must be the final dashboard section, after investment.
 assert.ok(html.indexOf('我的自选股票') > html.indexOf('我的投资速览'));
 assert.ok(html.indexOf('我的自选股票') > html.indexOf('最近的交易'));
 assert.ok(html.indexOf('我的自选股票') > html.indexOf('我的资产'));
});

test('V1.9 empty watchlist has a clear add-stocks action and keeps the old investment snapshot',async()=>{
 const html=await renderSnapshot();
 assert.match(html,/还没有关注的股票/);
 assert.match(html,/去添加自选/);
 assert.match(html,/我的投资速览/);
 assert.match(html,/四个入口|存定期/);
});

test('V1.9 profile icons distinguish Olivia and parent while keeping avatar upload',async()=>{
 let html=await renderSnapshot();
 assert.match(html,/class="avatar avatar-olivia"/);
 assert.match(html,/avatar-mini-crown/);
 assert.match(html,/id="kid-avatar-file"/);
 html=await renderSnapshot({role:'dad'});
 assert.match(html,/class="avatar avatar-dad"/);
 assert.match(html,/家长的金鹅头像/);
 assert.match(html,/class="avatar-goose" src="\/assets\/images\/brand-goose\.png"/);
 assert.doesNotMatch(html,/avatar-dad-label|>爸<\/span>/);
 assert.doesNotMatch(html,/id="kid-avatar-file"/);
});

test('browser and mobile icons use the simplified avocado while the site keeps its goose brand',()=>{
 const fromPublic=name=>readFileSync(new URL('../public/'+name,import.meta.url));
 const icon=fromPublic('assets/images/brand-goose.png');
 assert.deepEqual([...icon.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 const ico=fromPublic('assets/icons/favicon.ico');
 assert.deepEqual([...ico.subarray(0,4)],[0,0,1,0]);
 const svg=fromPublic('assets/icons/favicon.svg').toString();
 assert.match(svg,/牛油果/);
 assert.match(svg,/<path/);
 assert.doesNotMatch(svg,/<image|data:image/);
 for(const name of ['assets/icons/favicon-32.png','assets/icons/apple-touch-icon.png','assets/icons/app-icon-192.png','assets/icons/app-icon-512.png']){
  const png=fromPublic(name);assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
 }
 assert.ok(fromPublic('assets/images/logo.svg').length>1000);
 const m=JSON.parse(fromPublic('site.webmanifest').toString());
 assert.equal(m.icons.length,2);
 const page=fromPublic('index.html').toString();
 const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
 assert.ok(page.includes(`favicon.ico?v=${version}`));
 assert.ok(page.includes(`site.webmanifest?v=${version}`));
 assert.ok(m.icons.every(x=>x.src.endsWith(`?v=${version}`)));
});
