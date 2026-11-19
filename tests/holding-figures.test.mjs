import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {initialState,setup,view} from '../lib/core.mjs';

// Holdings show the average buy price and latest close per share in the quote currency,
// and the unrealised gain in O$ and as a percentage of cost.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function bank(){
 const s=initialState();setup(s,'t','t','holding-figures-parent-password','123456');
 // 2 × 0700.HK bought for O$796.0 (HK$398.0 each), close HK$402.0 → +O$8.0, +1.0%.
 // 0.5 × AAPL bought for O$920.0 (US$230.0 each × 8), close US$220.0 → −O$40.0, −4.3%.
 // 1 × 9988.HK bought for O$85.0 with no close yet.
 s.positions=[{symbol:'0700.HK',qtyMicro:2_000_000,costCents:79600},{symbol:'AAPL',qtyMicro:500_000,costCents:92000},{symbol:'9988.HK',qtyMicro:1_000_000,costCents:8500}];
 s.quotes={'0700.HK|2026-11-19':{symbol:'0700.HK',date:'2026-11-19',priceMilli:402000,currency:'HKD',final:true},
  'AAPL|2026-11-18':{symbol:'AAPL',date:'2026-11-18',priceMilli:220000,currency:'USD',final:true}};
 return s;
}
async function mount(s){
 const root={innerHTML:'',addEventListener(){},querySelectorAll:()=>[]};
 const ctx=vm.createContext({document:{getElementById:id=>id==='root'?root:id==='toast'?{textContent:'',className:''}:null},
  fetch:async()=>new Response(JSON.stringify({initialized:true,role:'kid',data:view(s,'kid')})),
  console,setTimeout:()=>0,clearTimeout(){},location:{hostname:'localhost'}});
 vm.runInContext(source,ctx);
 for(let i=0;i<6&&!root.innerHTML;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(root.innerHTML,'bootstrap rendered');
 return code=>vm.runInContext(code,ctx);
}
const holding=(html,symbol)=>html.split('<div class="holding">').find(x=>x.startsWith(`<div class="holding-main"><b>${symbol}</b>`));

test('home holdings show buy price, close, gain and gain %',async()=>{
 const html=(await mount(bank()))('investmentSnapshot()');
 const hk=holding(html,'0700.HK');
 assert.match(hk,/买入价 <b class="num">398\.0 HKD<\/b> · 收盘价 <b class="num">402\.0 HKD<\/b>/);
 assert.match(hk,/收盘价日期 2026-11-19/);
 assert.match(hk,/<span class="num pos">\+O\$ 8\.0<\/span><span class="num pos">\+1\.0%<\/span>/);
 const us=holding(html,'AAPL');
 assert.match(us,/买入价 <b class="num">230\.0 USD<\/b> · 收盘价 <b class="num">220\.0 USD<\/b>/,'USD prices are not shown in O$');
 assert.match(us,/<span class="num neg">−O\$ 40\.0<\/span><span class="num neg">−4\.3%<\/span>/);
 const missing=holding(html,'9988.HK');
 assert.match(missing,/买入价 <b class="num">85\.0 HKD<\/b> · 收盘价 <b class="num">—<\/b>/);
 assert.match(missing,/还没有收盘价 · 先按买入金额计算/);assert.match(missing,/<span class="muted">—<\/span>/);
});

test('stock page holdings show the same figures',async()=>{
 const html=(await mount(bank()))("holdingsCard(data.positions)");
 assert.match(html,/买入价 398\.0 HKD<\/span> · <span class="nw">收盘价 402\.0 HKD（2026-11-19）/);
 assert.match(html,/\+O\$ 8\.0<\/span><span class="num pos">\+1\.0%/);
 assert.match(html,/买入价 230\.0 USD<\/span> · <span class="nw">收盘价 220\.0 USD（2026-11-18）/);
 assert.match(html,/−O\$ 40\.0<\/span><span class="num neg">−4\.3%/);
 assert.match(html,/买入价 85\.0 HKD<\/span> · <span class="nw">暂缺收盘价/);
});

test('a flat holding shows zero gain without a sign',async()=>{
 const s=bank();s.quotes['0700.HK|2026-11-19'].priceMilli=398000;
 assert.match(holding((await mount(s))('investmentSnapshot()'),'0700.HK'),/<span class="num pos">O\$ 0\.0<\/span><span class="num pos">0\.0%<\/span>/);
});
