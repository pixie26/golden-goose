/* 皇家金鹅银行 Royal Bank of the Golden Goose — front-end V2.0.3
   Plain ES2020, no build step. Runs as a module in the browser and as a classic script in tests. */
const root=document.getElementById('root');
const toastEl=document.getElementById('toast');

let initialized=false,role=null,data=null,tab='home',loginRole='kid',busy=false;
let authGeneration=0;
let stockSearchTerm='',stockSearchResults=[],stockSearchError='',stockSearchWarning='',stockSearchOffline=false,stockSearchBusy=false,selectedSymbol='',stockSearchTimer=null;
let pendingBuySelection=null,buySelectionVersion=0;
const sub={account:'fixed',parent:'inbox'};
const TABS=['home','account','stocks','tasks','wishes','history','parent'];
// The server calls the parent account role 'dad' (kept for data compatibility); every label says 家长.
const SUBS={account:['fixed','shopping','loan'],parent:['inbox','money','tasks','stocks','settings']};
let hideBalance=readPref('hideBalance')==='1';
let formDirty=false,firstBoot=true,artSeq=0,notificationReadPending=false;
let pendingStateRefresh=null;
const actionRetryKeys=new Map();
const REQUEST_TIMEOUT_MS=45000;
const ACTION_RETRY_STORAGE='rgg.pendingActions.v1';
const pendingActionKeys=readPendingActionKeys();

/* ---------- preferences (localStorage may be unavailable) ---------- */
function readPref(k){try{return globalThis.localStorage?.getItem('rgg.'+k)??null;}catch{return null;}}
function writePref(k,v){try{globalThis.localStorage?.setItem('rgg.'+k,v);}catch{}}
// Keep only SHA-256 fingerprints and opaque request keys across reloads of this tab.
// Never persist financial payloads, avatar data, passwords or PINs.
function readPendingActionKeys(){
 try{
  const rows=JSON.parse(globalThis.sessionStorage?.getItem(ACTION_RETRY_STORAGE)||'[]');
  if(!Array.isArray(rows))return new Map();
  return new Map(rows.filter(row=>Array.isArray(row)&&/^[a-f0-9]{64}$/.test(row[0])&&typeof row[1]?.id==='string'&&row[1].id.length>=8&&row[1].id.length<=100&&Number.isFinite(row[1].at)&&Date.now()-row[1].at<7*86400000).slice(-100));
 }catch{return new Map();}
}
function savePendingActionKeys(){
 try{
  if(pendingActionKeys.size)globalThis.sessionStorage?.setItem(ACTION_RETRY_STORAGE,JSON.stringify([...pendingActionKeys]));
  else globalThis.sessionStorage?.removeItem(ACTION_RETRY_STORAGE);
 }catch{/* Private mode / full storage: in-memory retry keys still work. */}
}
function clearActionRetryKeys(){actionRetryKeys.clear();pendingActionKeys.clear();savePendingActionKeys();}
async function actionFingerprintHash(fingerprint){
 if(!fingerprint||!globalThis.crypto?.subtle?.digest||typeof TextEncoder!=='function')return null;
 try{const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
 catch{return null;}
}

/* ---------- formatting ---------- */
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Monetary displays always have one decimal; exact cents and editable values stay intact.
const displayAmount=n=>{const cents=Number(n)||0,rounded=Math.round(Math.abs(cents)/10)/10;return rounded===0?0:Math.sign(cents)*rounded;};
// Spendable cash is shown rounded down to O$0.1, so a shown amount can always be spent in full.
const spendableCents=n=>Math.floor(Math.max(0,Number(n)||0)/10)*10;
// Debts are shown rounded up to O$0.1, so paying the shown amount always settles (the server charges the exact due).
const owedCents=n=>Math.ceil(Math.max(0,Number(n)||0)/10)*10;
const money=n=>'O$ '+displayAmount(n).toLocaleString('en-HK',{minimumFractionDigits:1,maximumFractionDigits:1});
const signedMoney=n=>{const shown=displayAmount(n);return (shown<0?'−':shown>0?'+':'')+money(Math.abs(n));};
// Normalize currency fragments in old notification/ledger text for display only.
// Plainer wording for ledger lines, including ones saved by earlier versions.
const ledgerText=l=>moneyInText(String(l.description??'').replace('（本金为负债）','').replace(/^确认购买并交付：/,'购买：').replace(/^提前赎回/,'提前取出')).replace('（利息 O$ 0.0）','');
const moneyInText=text=>String(text??'').replace(/O\$\s*([+-]?\d+(?:,\d{3})*(?:\.\d+)?)/g,(_,amount)=>{const formatted=money(Number(amount.replace(/,/g,''))*100);return amount.startsWith('+')?formatted.replace('O$ ','O$ +'):formatted;});
const pct=bps=>(Number(bps||0)/100).toLocaleString('en-HK',{maximumFractionDigits:2})+'%';
const pad=n=>String(n).padStart(2,'0');
// Timestamps are stored in UTC; show them in the viewer's local time (Hong Kong), not the UTC date.
function asLocal(s){const str=String(s||'');if(!str.includes('T'))return null;const d=new Date(str);return Number.isNaN(d.getTime())?null:d;}
const date=s=>{const d=asLocal(s);return d?`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`:String(s||'').slice(0,10);};
const dateTime=s=>{const d=asLocal(s);return d?`${date(s)} ${pad(d.getHours())}:${pad(d.getMinutes())}`:date(s);};
const todayLocal=()=>date(new Date().toISOString());
function friendlyDay(s){
 const d=asLocal(s);if(!d)return date(s);
 const now=new Date(),diff=Math.round((Date.UTC(now.getFullYear(),now.getMonth(),now.getDate())-Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()))/86400000);
 if(diff===0)return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
 if(diff===1)return '昨天';
 return d.getFullYear()===now.getFullYear()?`${d.getMonth()+1}月${d.getDate()}日`:date(s);
}
const qtyText=micro=>(Number(micro||0)/1e6).toFixed(6).replace(/\.?0+$/,'');
const priceText=milli=>(milli/1000).toLocaleString('en-HK',{minimumFractionDigits:1,maximumFractionDigits:1});
const signedPct=n=>{const r=Math.round(n*10)/10;return (r<0?'−':r>0?'+':'')+Math.abs(r).toFixed(1)+'%';};
// A holding's average buy price and latest close per share, in the quote currency (costs are
// kept in O$; USD × usdToO), plus unrealised gain in O$ and as a share of cost.
function positionFigures(p){
 const security=data.symbols.find(s=>s.symbol===p.symbol)||{},currency=p.quote?.currency||security.currency||'';
 const rate=currency==='USD'?(Number(data.settings?.usdToO)||8):1;
 const gain=p.quote?p.valueCents-p.costCents:null;
 return {currency,buyMilli:p.qtyMicro>0?Math.round(p.costCents*1e7/(p.qtyMicro*rate)):null,closeMilli:p.quote?.priceMilli??null,gain,gainPct:gain!==null&&p.costCents>0?gain/p.costCents*100:null};
}
const priceWithCurrency=(milli,currency)=>milli===null?'—':`${priceText(milli)} ${esc(currency)}`;
function gainLines(f){
 if(f.gain===null)return '<span class="muted">—</span>';
 const tone=f.gain>=0?'pos':'neg';
 return `<span class="num ${tone}">${signedMoney(f.gain)}</span>${f.gainPct===null?'':`<span class="num ${tone}">${signedPct(f.gainPct)}</span>`}`;
}
const quoteText=s=>s?.quote?.priceMilli?`${priceText(s.quote.priceMilli)} ${esc(s.quote.currency||s.currency||'')}`:'—';

/* ---------- icons (24px line set) ---------- */
const ICONS={
 home:'<path d="M3.8 10.6 12 4l8.2 6.6"/><path d="M5.8 9.3v9.5c0 .9.7 1.6 1.6 1.6h3v-5.5h3.2v5.5h3c.9 0 1.6-.7 1.6-1.6V9.3"/>',
 piggy:'<path d="M3.6 12.6c0-3.7 3.5-6.6 7.9-6.6 2.4 0 4.6.9 6 2.3l1.9-1.1v3.2c.4.6.7 1.2.8 1.9h1.2v3.3h-1.5c-.5.9-1.2 1.6-2 2.2V20h-2.8v-1.2c-.9.2-1.8.3-2.6.3s-1.7-.1-2.5-.3V20H5.2v-2.6c-1-1.2-1.6-2.8-1.6-4.8z"/><path d="M9.6 9.3h3.4"/><circle cx="16.1" cy="11.6" r=".8" fill="currentColor" stroke="none"/>',
 trend:'<path d="M3.5 17 9 11.5l3.6 3.6 7.9-7.9"/><path d="M15 7.2h5.5v5.5"/>',
 gift:'<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v7.3c0 .6.5 1.2 1.2 1.2h11.6c.7 0 1.2-.6 1.2-1.2V12"/><path d="M12 8v12.5"/><path d="M12 8c-.8-2.6-4.7-4.1-5.3-1.9C6.3 7.6 9 8 12 8zm0 0c.8-2.6 4.7-4.1 5.3-1.9.4 1.5-2.3 1.9-5.3 1.9z"/>',
 star:'<path d="m12 3.8 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/>',
 receipt:'<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8h6M9 11.5h6M9 15h3.5"/>',
 sliders:'<path d="M4 7h8M16 7h4M4 17h3M11 17h9"/><circle cx="14" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
 bell:'<path d="M18 8.8a6 6 0 0 0-12 0c0 6.7-2.7 7.4-2.7 8.9h17.4c0-1.5-2.7-2.2-2.7-8.9z"/><path d="M10 20c.4 1 1.1 1.5 2 1.5s1.6-.5 2-1.5"/>',
 logout:'<path d="M10 4.5H6.6c-.9 0-1.6.7-1.6 1.6v11.8c0 .9.7 1.6 1.6 1.6H10"/><path d="m15 8 4 4-4 4"/><path d="M19 12H9.5"/>',
 eye:'<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
 eyeOff:'<path d="M3 10c2.3 3 5.4 4.6 9 4.6s6.7-1.6 9-4.6"/><path d="m5.8 12.8-1.6 2.3M9.6 14.3l-.7 2.6M14.4 14.3l.7 2.6M18.2 12.8l1.6 2.3"/>',
 chevRight:'<path d="m9.5 6 6 6-6 6"/>',
 chevDown:'<path d="m6 9.5 6 6 6-6"/>',
 search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
 clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
 target:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
 layers:'<path d="M12 4 3.5 8.5 12 13l8.5-4.5z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.3 8.5 4.2 8.5-4.2"/>',
 bag:'<path d="M5.5 8.5h13l-1 11.2c-.1.8-.7 1.3-1.5 1.3H8c-.8 0-1.4-.5-1.5-1.3z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
 bank:'<path d="M3.5 9.3 12 4.5l8.5 4.8z"/><path d="M5.5 10.5v6.5M9.8 10.5v6.5M14.2 10.5v6.5M18.5 10.5v6.5"/><path d="M3.5 19.5h17"/>',
 coins:'<ellipse cx="9" cy="7" rx="5" ry="2.5"/><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"/><path d="M10 16.5c.9.6 2.3 1 4 1 2.8 0 5-1.1 5-2.5v-4c0-1.4-2.2-2.5-5-2.5"/><path d="M14 13c2.8 0 5-1.1 5-2.5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 check:'<path d="m5 12.5 4.5 4.5L19 7.5"/>',
 x:'<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
 refresh:'<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
 camera:'<path d="M4 8.6c0-.8.7-1.5 1.5-1.5h2.3L9.3 5h5.4l1.5 2.1h2.3c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-13c-.8 0-1.5-.7-1.5-1.5z"/><circle cx="12" cy="13" r="3.3"/>',
 trash:'<path d="M5 7h14M10 7V5h4v2"/><path d="m7 7 .9 12.2c.1.7.7 1.3 1.4 1.3h5.4c.7 0 1.3-.6 1.4-1.3L17 7"/>',
 lock:'<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
 alert:'<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.3M12 17.2v.2"/>',
 user:'<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6"/>',
 list:'<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".9" fill="currentColor"/><circle cx="4.8" cy="12" r=".9" fill="currentColor"/><circle cx="4.8" cy="17.5" r=".9" fill="currentColor"/>',
 crown:'<path d="M4.5 18.5h15M5.2 15.5 3.8 7.8l4.8 3.6L12 5.5l3.4 5.9 4.8-3.6-1.4 7.7z"/>',
 cart:'<path d="M3.5 4.5h2l2 10.5h10l2-7.5H6.6"/><circle cx="9" cy="19" r="1.4"/><circle cx="16.5" cy="19" r="1.4"/>',
 briefcase:'<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6c0-.8.7-1.5 1.5-1.5h3c.8 0 1.5.7 1.5 1.5v1.5M3.5 12.5h17"/>',
 percent:'<path d="m18 6-12 12"/><circle cx="7.5" cy="7.5" r="2.3"/><circle cx="16.5" cy="16.5" r="2.3"/>',
 inbox:'<path d="M4 13.5 6.5 5.5h11l2.5 8v5c0 .8-.7 1.5-1.5 1.5h-13c-.8 0-1.5-.7-1.5-1.5z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
 wallet:'<path d="M4 7.5c0-1.1.9-2 2-2h11.5v3"/><rect x="4" y="8.5" width="16.5" height="11" rx="2"/><path d="M16 14h1.5"/>',
 undo:'<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5h9a6 6 0 0 1 0 12H10"/>',
};
const icon=(n,cls='')=>`<svg class="i${cls?' '+cls:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||''}</svg>`;

/* ---------- illustrations (original 3D-style vector art; ids unique per instance) ---------- */
// mini=true drops ground shadows and blur filters: used for the many small icons in transaction lists.
function art(name,mini=false){
 const u='a'+(++artSeq);let svg='';
 switch(name){
 case 'piggy':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <radialGradient id="${u}pBody" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#ffe6f0"/><stop offset=".45" stop-color="#ffb6d0"/><stop offset="1" stop-color="#ee77a4"/></radialGradient> <radialGradient id="${u}pSnout" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#ffd7e6"/><stop offset="1" stop-color="#f38ab3"/></radialGradient> <linearGradient id="${u}pLeg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffb0cc"/><stop offset="1" stop-color="#e46c9b"/></linearGradient> <radialGradient id="${u}pCoin" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff6b5"/><stop offset=".5" stop-color="#ffcf3f"/><stop offset="1" stop-color="#df9a14"/></radialGradient> <filter id="${u}pBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="47" cy="91" rx="32" ry="4.5" fill="#d47aa0" opacity=".35" filter="url(#${u}pBlur)"/><path d="M33 72h9v12a4.5 4.5 0 0 1-9 0z" fill="#db6496"/><path d="M60 72h9v12a4.5 4.5 0 0 1-9 0z" fill="#db6496"/><path d="M14 54c-7 0-8-8-3-9.5 4-1.2 6 3.5 2 5" fill="none" stroke="#f088b0" stroke-width="2.8" stroke-linecap="round"/><ellipse cx="46" cy="57" rx="34" ry="27" fill="url(#${u}pBody)"/><path d="M24 73h10v13a5 5 0 0 1-10 0z" fill="url(#${u}pLeg)"/><path d="M51 75h10v12a5 5 0 0 1-10 0z" fill="url(#${u}pLeg)"/><path d="M29 37l-4-14 14 8z" fill="#ee7aa8"/><path d="M44 33l3-15 11 12z" fill="url(#${u}pSnout)"/><path d="M47 29l1.5-7 5 5.5z" fill="#ffdbe8"/><ellipse cx="79" cy="59" rx="9.5" ry="11" fill="url(#${u}pSnout)"/><ellipse cx="77.5" cy="55.5" rx="1.7" ry="2.5" fill="#c4477c"/><ellipse cx="77.5" cy="63" rx="1.7" ry="2.5" fill="#c4477c"/><ellipse cx="64" cy="48" rx="2.8" ry="3.4" fill="#3e1630"/><circle cx="65" cy="47" r="1.1" fill="#fff"/><ellipse cx="66" cy="58" rx="5.5" ry="3" fill="#ff6c9b" opacity=".35"/><rect x="35" y="32.5" width="17" height="4.2" rx="2.1" fill="#c94981"/><ellipse cx="31" cy="45" rx="12" ry="6.5" fill="#fff" opacity=".6" transform="rotate(-25 31 45)" filter="url(#${u}pBlur)"/><ellipse cx="45" cy="21" rx="11" ry="11" fill="#c8850e"/><circle cx="43.5" cy="19.5" r="11" fill="url(#${u}pCoin)"/><circle cx="43.5" cy="19.5" r="7.4" fill="none" stroke="#fde58a" stroke-width="1.6"/><path d="M40 15.5c1-2.2 7-2.2 7 .8 0 3-6.8 2.2-6.8 5.4 0 3 6.3 2.8 7.2.4M43.5 12.5v14" fill="none" stroke="#c07d0b" stroke-width="1.6" stroke-linecap="round"/></svg>`;break;
 case 'bag':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <linearGradient id="${u}bFront" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e1bcff"/><stop offset=".5" stop-color="#b674f6"/><stop offset="1" stop-color="#8442da"/></linearGradient> <linearGradient id="${u}bTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a52e6"/><stop offset="1" stop-color="#7a36cc"/></linearGradient> <linearGradient id="${u}bHandle" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c58cff"/><stop offset=".5" stop-color="#9b55ea"/><stop offset="1" stop-color="#7434c6"/></linearGradient> <radialGradient id="${u}bHeart" cx=".4" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#fbf3ff"/><stop offset="1" stop-color="#ecd9ff"/></radialGradient> <filter id="${u}bBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="50" cy="92" rx="31" ry="4.5" fill="#9a72d4" opacity=".35" filter="url(#${u}bBlur)"/><path d="M33 36C33 12 67 12 67 36" fill="none" stroke="#6f30c0" stroke-width="5.5" stroke-linecap="round"/><path d="M19 33h62a4 4 0 0 1 4 4.3l-3.4 43.4A6 6 0 0 1 75.6 86H24.4a6 6 0 0 1-6-5.3L15 37.3A4 4 0 0 1 19 33z" fill="url(#${u}bFront)"/><path d="M19 33h62a4 4 0 0 1 4 4.3l-.2 2.2H15.2l-.2-2.2A4 4 0 0 1 19 33z" fill="url(#${u}bTop)"/><path d="M35 42C35 20 65 20 65 42" fill="none" stroke="url(#${u}bHandle)" stroke-width="5.5" stroke-linecap="round"/><circle cx="35" cy="43" r="2.6" fill="#6a2db8"/><circle cx="65" cy="43" r="2.6" fill="#6a2db8"/><path d="M50 77s-16-9.6-16-20a8.6 8.6 0 0 1 16-4.8 8.6 8.6 0 0 1 16 4.8c0 10.4-16 20-16 20z" fill="#7d3bd0" opacity=".35" transform="translate(1.5 2.5)" filter="url(#${u}bBlur)"/><path d="M50 77s-16-9.6-16-20a8.6 8.6 0 0 1 16-4.8 8.6 8.6 0 0 1 16 4.8c0 10.4-16 20-16 20z" fill="url(#${u}bHeart)"/><path d="M22 44l3.2 34" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".45" filter="url(#${u}bBlur)"/></svg>`;break;
 case 'wand':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <linearGradient id="${u}wStick" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe07a"/><stop offset=".5" stop-color="#f5b52b"/><stop offset="1" stop-color="#d48a10"/></linearGradient> <filter id="${u}wBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter> <filter id="${u}wGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs><ellipse class="sh" cx="36" cy="92" rx="22" ry="3.6" fill="#e2b24e" opacity=".35" filter="url(#${u}wBlur)"/><circle cx="60" cy="34" r="24" fill="#fff6b0" opacity=".55" filter="url(#${u}wGlow)"/><path d="M18 88 47 52" stroke="url(#${u}wStick)" stroke-width="7.5" stroke-linecap="round"/><path d="M20 84 44 54" stroke="#fff3b8" stroke-width="2" stroke-linecap="round" opacity=".8"/><g transform="translate(60 34)"> <path d="M0-26 7.6-10.5 24.7-8 12.4 4 15.3 21 0 13 -15.3 21 -12.4 4 -24.7-8 -7.6-10.5Z" fill="#f2a516"/> <path d="M0-26 7.6-10.5 0 0Z" fill="#ffe680"/><path d="M7.6-10.5 24.7-8 0 0Z" fill="#ffd23d"/> <path d="M24.7-8 12.4 4 0 0Z" fill="#f7b928"/><path d="M12.4 4 15.3 21 0 0Z" fill="#eea21a"/> <path d="M15.3 21 0 13 0 0Z" fill="#f2ab1f"/><path d="M0 13 -15.3 21 0 0Z" fill="#ffc93a"/> <path d="M-15.3 21 -12.4 4 0 0Z" fill="#ffd74e"/><path d="M-12.4 4 -24.7-8 0 0Z" fill="#ffe06a"/> <path d="M-24.7-8 -7.6-10.5 0 0Z" fill="#fff08f"/><path d="M-7.6-10.5 0-26 0 0Z" fill="#fff4a8"/> <ellipse cx="-6" cy="-12" rx="4" ry="2.4" fill="#fff" opacity=".85" transform="rotate(-30 -6 -12)"/></g><path d="M86 60q0 6 6 6-6 0-6 6 0-6-6-6 6 0 6-6z" fill="#ffd34d"/><path d="M22 22q0 5 5 5-5 0-5 5 0-5-5-5 5 0 5-5z" fill="#ffd34d"/><path d="M80 12q0 3.5 3.5 3.5-3.5 0-3.5 3.5 0-3.5-3.5-3.5 3.5 0 3.5-3.5z" fill="#ffe27a"/><circle cx="34" cy="44" r="2" fill="#ffe27a"/><circle cx="74" cy="78" r="1.6" fill="#ffe27a"/></svg>`;break;
 case 'gift':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <linearGradient id="${u}gfBox" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9b6ff"/><stop offset=".55" stop-color="#c47ef6"/><stop offset="1" stop-color="#9853e0"/></linearGradient> <linearGradient id="${u}gfSide" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a45fe6"/><stop offset="1" stop-color="#7f3ccc"/></linearGradient> <linearGradient id="${u}gfLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5d2ff"/><stop offset="1" stop-color="#d494fb"/></linearGradient> <linearGradient id="${u}gfRib" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffe684"/><stop offset=".5" stop-color="#ffc932"/><stop offset="1" stop-color="#e9a419"/></linearGradient> <radialGradient id="${u}gfBow" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff2a6"/><stop offset=".55" stop-color="#ffc93a"/><stop offset="1" stop-color="#df9614"/></radialGradient> <filter id="${u}gfBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="50" cy="92" rx="34" ry="4.5" fill="#8fb3e8" opacity=".45" filter="url(#${u}gfBlur)"/><path d="M18 46h64v36a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6z" fill="url(#${u}gfBox)"/><path d="M70 46h12v36a6 6 0 0 1-6 6h-6z" fill="url(#${u}gfSide)" opacity=".55"/><path d="M13 36a4 4 0 0 1 4-4h66a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4z" fill="url(#${u}gfLid)"/><rect x="44" y="32" width="12" height="56" fill="url(#${u}gfRib)"/><rect x="44" y="48" width="12" height="3" fill="#d18e12" opacity=".5"/><path d="M50 32c-4-12-20-17-22-8-1.4 6.4 11 8 22 8z" fill="url(#${u}gfBow)"/><path d="M50 32c4-12 20-17 22-8 1.4 6.4-11 8-22 8z" fill="url(#${u}gfBow)"/><path d="M33 25c3-1 8 1 11 4" fill="none" stroke="#fff6c4" stroke-width="2" stroke-linecap="round" opacity=".8"/><ellipse cx="50" cy="31.5" rx="5" ry="4" fill="#f0ad22"/><path d="M22 52v28" stroke="#fff" stroke-width="3.6" stroke-linecap="round" opacity=".45" filter="url(#${u}gfBlur)"/><path d="M86 18q0 4 4 4-4 0-4 4 0-4-4-4 4 0 4-4z" fill="#ffd34d"/><path d="M12 22q0 3 3 3-3 0-3 3 0-3-3-3 3 0 3-3z" fill="#ffe27a"/></svg>`;break;
 case 'chart':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <linearGradient id="${u}chA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8fe39a"/><stop offset=".6" stop-color="#43c26a"/><stop offset="1" stop-color="#2a9b52"/></linearGradient> <linearGradient id="${u}chT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c8f5c8"/><stop offset="1" stop-color="#8fe39a"/></linearGradient> <linearGradient id="${u}chArrow" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ffd84f"/><stop offset="1" stop-color="#f6a51c"/></linearGradient> <filter id="${u}chB" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="50" cy="91" rx="36" ry="4.5" fill="#7ac48a" opacity=".35" filter="url(#${u}chB)"/><path d="M14 62h16v26H14z" fill="url(#${u}chA)"/><path d="M14 62l4-3h16l-4 3z" fill="url(#${u}chT)"/><path d="M30 62l4-3v26l-4 3z" fill="#2a8a49"/><path d="M40 46h16v42H40z" fill="url(#${u}chA)"/><path d="M40 46l4-3h16l-4 3z" fill="url(#${u}chT)"/><path d="M56 46l4-3v42l-4 3z" fill="#2a8a49"/><path d="M66 30h16v58H66z" fill="url(#${u}chA)"/><path d="M66 30l4-3h16l-4 3z" fill="url(#${u}chT)"/><path d="M82 30l4-3v58l-4 3z" fill="#2a8a49"/><path d="M12 50 34 32l14 10L74 14" fill="none" stroke="url(#${u}chArrow)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M64 12h14v14" fill="none" stroke="#f6a51c" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 66v18M43 50v34M69 34v50" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".45"/></svg>`;break;
 case 'bank':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs> <linearGradient id="${u}bkRoof" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb8d6"/><stop offset="1" stop-color="#ef6fa6"/></linearGradient> <linearGradient id="${u}bkCol" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fffaf2"/><stop offset=".6" stop-color="#ffeedd"/><stop offset="1" stop-color="#f1d2b6"/></linearGradient> <linearGradient id="${u}bkBase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe082"/><stop offset="1" stop-color="#e9a91f"/></linearGradient> <radialGradient id="${u}bkCoin" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff6b5"/><stop offset=".5" stop-color="#ffcf3f"/><stop offset="1" stop-color="#df9a14"/></radialGradient> <filter id="${u}bkB" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="50" cy="92" rx="36" ry="4.5" fill="#d68fb0" opacity=".35" filter="url(#${u}bkB)"/><path d="M50 10 88 32v6H12v-6z" fill="url(#${u}bkRoof)"/><circle cx="50" cy="26" r="6.5" fill="url(#${u}bkCoin)"/><rect x="14" y="38" width="72" height="6" rx="2" fill="#f2b7cf"/><g fill="url(#${u}bkCol)"><rect x="19" y="44" width="10" height="34" rx="2"/><rect x="36" y="44" width="10" height="34" rx="2"/><rect x="54" y="44" width="10" height="34" rx="2"/><rect x="71" y="44" width="10" height="34" rx="2"/></g><rect x="10" y="78" width="80" height="10" rx="3" fill="url(#${u}bkBase)"/><path d="M22 46v28M39 46v28M57 46v28M74 46v28" stroke="#fff" stroke-width="2" opacity=".7" stroke-linecap="round"/></svg>`;break;
 case 'coins':svg=`<svg class="art" viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="${u}cnF" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#fff6b5"/><stop offset=".55" stop-color="#fcca3c"/><stop offset="1" stop-color="#e09a18"/></radialGradient><filter id="${u}cnB" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.8"/></filter></defs><ellipse class="sh" cx="50" cy="91" rx="34" ry="4.5" fill="#d9a050" opacity=".35" filter="url(#${u}cnB)"/><g><ellipse cx="42" cy="82" rx="26" ry="9" fill="#c98510"/><ellipse cx="42" cy="77" rx="26" ry="9" fill="url(#${u}cnF)"/><ellipse cx="40" cy="69" rx="26" ry="9" fill="#c98510"/><ellipse cx="40" cy="64" rx="26" ry="9" fill="url(#${u}cnF)"/><ellipse cx="44" cy="56" rx="26" ry="9" fill="#c98510"/><ellipse cx="44" cy="51" rx="26" ry="9" fill="url(#${u}cnF)"/><ellipse cx="44" cy="51" rx="17" ry="5.5" fill="none" stroke="#fde68a" stroke-width="2"/></g><g transform="rotate(14 72 50)"><ellipse cx="75" cy="50" rx="6" ry="20" fill="#c98510"/><ellipse cx="71" cy="50" rx="17" ry="20" fill="url(#${u}cnF)"/><ellipse cx="71" cy="50" rx="11" ry="13" fill="none" stroke="#fde68a" stroke-width="2"/></g></svg>`;break;
 case 'kid':svg=`<svg class="art kid" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs> <radialGradient id="${u}kdBg" cx=".5" cy=".35" r=".75"><stop offset="0" stop-color="#fff0f6"/><stop offset="1" stop-color="#ffd3e4"/></radialGradient> <radialGradient id="${u}kdSkin" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#ffeadc"/><stop offset=".7" stop-color="#ffd9c2"/><stop offset="1" stop-color="#f4bfa3"/></radialGradient> <linearGradient id="${u}kdHair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a4d33"/><stop offset="1" stop-color="#5b2e1e"/></linearGradient> <radialGradient id="${u}kdBow" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffc2dc"/><stop offset="1" stop-color="#f0468b"/></radialGradient></defs><rect width="100" height="100" fill="url(#${u}kdBg)"/><path d="M14 64C14 34 30 16 50 16s36 18 36 48v36H14z" fill="url(#${u}kdHair)"/><ellipse cx="50" cy="60" rx="25" ry="26" fill="url(#${u}kdSkin)"/><path d="M24 54c2-18 14-28 26-28 13 0 24 10 26 28-10-1-17-6-21-14-4 8-14 13-31 14z" fill="url(#${u}kdHair)"/><path d="M34 34c6-6 14-8 20-6" fill="none" stroke="#b07052" stroke-width="2.4" stroke-linecap="round" opacity=".7"/><ellipse cx="40" cy="62" rx="3.4" ry="4.4" fill="#3a1d16"/><ellipse cx="60" cy="62" rx="3.4" ry="4.4" fill="#3a1d16"/><circle cx="41.3" cy="60.3" r="1.3" fill="#fff"/><circle cx="61.3" cy="60.3" r="1.3" fill="#fff"/><ellipse cx="33" cy="71" rx="5" ry="3" fill="#ff8fb0" opacity=".55"/><ellipse cx="67" cy="71" rx="5" ry="3" fill="#ff8fb0" opacity=".55"/><path d="M44 74c3.5 3 8.5 3 12 0" fill="none" stroke="#c0505f" stroke-width="2.4" stroke-linecap="round"/><path d="M70 24l11-8v16zM70 24l-11-8v16z" fill="url(#${u}kdBow)"/><circle cx="70" cy="24" r="3.6" fill="#e83d83"/></svg>`;break;
 case 'crown':svg=`<svg class="art crown-art" viewBox="0 0 120 92" aria-hidden="true"><defs><linearGradient id="${u}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6b8"/><stop offset=".45" stop-color="#ffd54a"/><stop offset="1" stop-color="#e29c1a"/></linearGradient><linearGradient id="${u}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd85a"/><stop offset="1" stop-color="#d9900f"/></linearGradient><radialGradient id="${u}p" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffe0f0"/><stop offset=".5" stop-color="#ff5fa8"/><stop offset="1" stop-color="#c41f6d"/></radialGradient><radialGradient id="${u}v" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#eedcff"/><stop offset=".5" stop-color="#a064f2"/><stop offset="1" stop-color="#6430b8"/></radialGradient></defs><path d="M14 72 6 26l26 20 28-34 28 34 26-20-8 46c-30 10-62 10-92 0z" fill="url(#${u}g)"/><path d="M12 64c32 12 64 12 96 0l-1 13c-32 12-62 12-94 0z" fill="url(#${u}b)"/><circle cx="6" cy="25" r="6" fill="url(#${u}g)"/><circle cx="60" cy="10" r="6.5" fill="url(#${u}g)"/><circle cx="114" cy="25" r="6" fill="url(#${u}g)"/><path d="M60 31l10 12-10 12-10-12z" fill="url(#${u}p)"/><ellipse cx="33" cy="54" rx="5.5" ry="7" fill="url(#${u}v)"/><ellipse cx="87" cy="54" rx="5.5" ry="7" fill="url(#${u}v)"/><circle cx="38" cy="76" r="3.2" fill="#ff5f9e"/><circle cx="60" cy="78" r="3.2" fill="#6fd0ff"/><circle cx="82" cy="76" r="3.2" fill="#ff5f9e"/><path d="M20 40l-2-7M60 22v-5" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".85"/></svg>`;break;
 default:return '';
 }
 return mini?svg.replace(/<ellipse class="sh"[^>]*\/>/g,'').replace(/ filter="url\(#[^)]*\)"/g,''):svg;
}

/* ---------- small builders ---------- */
const field=(name,label,type='text',rest='')=>`<label class="field"><span>${label}</span><input name="${esc(name)}" type="${type}" ${rest}></label>`;
const moneyField=(name,label,rest='')=>field(name,label,'number',`inputmode="decimal" step="0.1" min="0.1" placeholder="0.0" ${rest}`);
function spendingField(label){
 const available=Math.max(0,Number(data.summary.availableCents)||0);
 // These forms accept tenths: never round a spending cap upward past usable cash.
 const displayCap=spendableCents(available);
 return `${moneyField('amount',label,`required max="${(available/100).toFixed(2)}" data-budget-amount`)}<p class="budget-note"><span>本次最多</span><b class="num">${money(displayCap)}</b></p>`;
}
const textArea=(name,label,ph='可选')=>`<label class="field"><span>${label}</span><textarea name="${esc(name)}" maxlength="240" placeholder="${esc(ph)}"></textarea></label>`;
const hiddenInput=(name,value)=>`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const opForm=(op,children,label='提交',{cls='',foot=''}={})=>`<form class="form ${cls}" data-op="${esc(op)}" novalidate>${children}<button class="btn btn-primary" type="submit">${label}</button>${foot}</form>`;
/* ---------- Chinese form validation (V1.9.7) ---------- */
function controlLabel(el){
 const label=el?.getAttribute?.('aria-label')||el?.labels?.[0]?.querySelector?.('span')?.textContent||el?.closest?.('label')?.querySelector?.('span')?.textContent||el?.labels?.[0]?.textContent;
 const names={name:'名称',amount:'金额',loanLimit:'借款额度',qty:'股数',quantity:'数量',price:'价格',pin:'PIN',password:'密码',newPassword:'新密码',oldPassword:'旧密码',unit:'单位',symbol:'股票',date:'日期',link:'链接',token:'初始化密钥'};
 return String(label||names[el?.name]||'此项').replace(/\s+/g,' ').trim();
}
function clearFieldValidity(el){
 if(typeof el?.setCustomValidity==='function')el.setCustomValidity('');
}
function validationMessageZh(el){
 const v=el?.validity;if(!v||v.valid)return '';
 const label=controlLabel(el),type=String(el.type||'').toLowerCase(),name=el.name||'';
 const amount=name==='amount'||name==='loanLimit'||/O\$/.test(label);
 const subject=amount?(name==='loanLimit'?'借款额度':'金额'):name==='quantity'?'数量':name==='qty'?'股数':name==='price'?'价格':label;
 const attr=key=>el.getAttribute?.(key)??el[key];
 const bound=key=>{const raw=attr(key);return raw!==null&&raw!==undefined&&raw!==''&&Number.isFinite(Number(raw))?Number(raw):null;};
 if(v.badInput)return /^(date|datetime-local|month|week|time)$/.test(type)?'请输入有效的日期或时间。':'请输入有效的数字。';
 if(v.valueMissing){
  if(type==='checkbox')return '请勾选此项后再提交。';
  if(type==='file')return '请选择文件。';
  return `${type==='radio'||String(el.tagName||'').toLowerCase()==='select'?'请选择':'请填写'}「${label}」。`;
 }
 if(v.typeMismatch)return type==='url'?'请输入完整的网址，例如 https://example.com。':type==='email'?'请输入有效的邮箱地址。':`请检查「${label}」的格式。`;
 if(v.patternMismatch)return name==='pin'||attr('pattern')==='[0-9]{6,10}'?'PIN 需要填写 6–10 位数字。':`请按要求填写「${label}」。`;
 if(v.tooShort){const n=Number(el.minLength??attr('minlength'));return Number.isFinite(n)&&n>0?`${label}至少需要 ${n} 个字符。`:`「${label}」填写的内容太短。`;}
 if(v.tooLong){const n=Number(el.maxLength??attr('maxlength'));return Number.isFinite(n)&&n>=0?`${label}最多填写 ${n} 个字符。`:`「${label}」填写的内容太长。`;}
 if(v.rangeOverflow||v.rangeUnderflow){
  const over=v.rangeOverflow,key=over?'max':'min',limit=bound(key);
  if(limit!==null){
   if(amount){
    // A fractional-cent/one-cent constraint must not become a misleading rounded
    // money bound. Show exact tenths as O$; keep finer native bounds descriptive.
    const tenths=limit*10;
    if(Math.abs(tenths-Math.round(tenths))<1e-7)return `${subject}不能${over?'超过':'少于'} O$ ${limit.toLocaleString('en-HK',{minimumFractionDigits:1,maximumFractionDigits:1})}。`;
    return over?`${subject}超过本次允许的上限，请减少金额。`:`${subject}低于允许的最小值，请增加金额。`;
   }
   return `${subject}不能${over?'超过':'少于'} ${limit}。`;
  }
  if(/^(date|datetime-local|month|week|time)$/.test(type)){const dateBound=attr(key);return `日期或时间不能${over?'晚于':'早于'}${dateBound?` ${dateBound}`:'允许的范围'}。`;}
  return `${subject}${over?'超过允许的最大值':'低于允许的最小值'}。`;
 }
 if(v.stepMismatch){
  const step=Number(attr('step'));
  if(step===1)return `${subject}必须是整数。`;
  if(step>0&&step<1){
   const [base,exponent='0']=String(step).toLowerCase().split('e'),places=Math.max(0,(base.split('.')[1]||'').length-Number(exponent));
   if(Math.abs(step-10**(-places))<Number.EPSILON)return `${subject}最多保留 ${places} 位小数。`;
  }
  return Number.isFinite(step)&&step>0?`请按 ${step} 的步长填写${subject}。`:`请按允许的精度填写${subject}。`;
 }
 return `请检查「${label}」的填写内容。`;
}
function localizeFieldValidity(el){
 if(!el||typeof el.setCustomValidity!=='function')return '';
 // setCustomValidity persists across attempts. Re-read the live native validity
 // only after clearing it, including values changed by autofill or code.
 clearFieldValidity(el);
 if(el.willValidate===false||el.disabled||el.type==='hidden')return '';
 const message=validationMessageZh(el);
 if(message)el.setCustomValidity(message);
 return message;
}
function validateFormInChinese(form){
 const fields=form?.querySelectorAll?.('input, select, textarea')||form?.elements||[];
 let first=null;
 for(const field of fields)if(localizeFieldValidity(field)&&!first)first=field;
 if(!first)return true;
 first.focus?.();
 first.reportValidity?.();
 return false;
}
const btn=(act,label,id,kind='ghost')=>`<button type="button" class="btn btn-sm btn-${kind}" data-act="${esc(act)}"${id?` data-id="${esc(id)}"`:''}>${label}</button>`;
const empty=t=>`<div class="empty">${t}</div>`;
const card=(title,ic,body,{right='',cls='',id=''}={})=>`<section class="card${cls?' '+cls:''}"${id?` id="${id}"`:''}><header class="card-h"><h3>${icon(ic)}<span>${title}</span></h3>${right}</header>${body}</section>`;
const more=(t,label='全部',sb='')=>`<button type="button" class="more" data-tab="${t}"${sb?` data-go-sub="${sb}"`:''}>${label}${icon('chevRight')}</button>`;
const stat=(label,value,cls='')=>`<div class="stat"><span>${label}</span><b class="num${cls?' '+cls:''}">${value}</b></div>`;
const pageHead=(title,ic,right)=>`<div class="pagehead"><h1>${icon(ic)}<span>${title}</span></h1>${right??`<div class="pill">可用 <b class="num">${money(spendableCents(data.summary.availableCents))}</b></div>`}</div>`;
const seg=(group,items)=>`<div class="seg" role="tablist">${items.map(([k,l])=>`<button type="button" role="tab" data-seg="${group}" data-sub="${k}" class="${sub[group]===k?'active':''}" aria-selected="${sub[group]===k}">${l}</button>`).join('')}</div>`;
const hid=(g,k)=>sub[g]===k?'':' hidden';
const list=rows=>`<ul class="list">${rows}</ul>`;
const meta=(...parts)=>parts.filter(Boolean).map(x=>`<span class="nw">${x}</span>`).join(' · ');

const STATUS={
 purchase:{pending:['等待家长确认','pending'],approved:['已购买','ok'],delivered:['已购买','ok'],return_pending:['退款待处理','pending'],rejected:['未通过','no'],refunded:['已退款','info']},
 fixed:{active:['存款中','live'],matured:['已到期','ok'],early:['已提前取出','info']},
 loan:{pending:['等待家长批准','pending'],active:['待还清','live'],repaid:['已还清','ok'],rejected:['未通过','no']},
 order:{pending:['待成交','pending'],filled:['已成交','ok'],cancelled:['已取消','info']},
 proposal:{pending:['等待家长批准','pending'],approved:['已加入任务清单','ok'],rejected:['未通过','no']},
 completion:{pending:['等待家长验收','pending'],approved:['奖励已入账','ok'],rejected:['未通过','no']},
};
const statusBadge=(kind,s)=>{const [t,tone]=STATUS[kind]?.[s]||[s,'info'];return `<span class="badge ${tone}">${esc(t)}</span>`;};
const LEDGER_ART={'cash.grant':'piggy','deposit.approve':'piggy','purchase.approve':'bag','purchase.refund':'bag','stock.buy':'chart','stock.sell':'chart','task.earn':'gift','fixed.open':'bank','fixed.mature':'bank','fixed.early':'bank','loan.approve':'coins','loan.repay':'coins'};
const ledgerIcon=type=>`<span class="ico-art">${art(LEDGER_ART[type]||'piggy',true)}</span>`;

/* ---------- record filters and pagination (V1.9.8) ---------- */
const RECORD_PAGE_SIZE=10,recordStates=new Map(),recordViews=new Map();
// 全部时间 by default: deposits, loans and wishes (V1.9.8), every list on the parent's
// 待处理 page (inbox-*, V1.9.10) so a pending request is never hidden while the badge counts it,
// and (V2.0.0) the parent's standing task catalogue and pending-order queue: a task made
// 31 days ago is still open, and an unsettled order is still waiting for the parent.
const ALL_TIME_LISTS=['fixed','loans','wishes','parent-tasks','parent-orders'];
const recordDefaultPeriod=key=>ALL_TIME_LISTS.includes(key)||key.startsWith('inbox-')?'all':'30';
const recordStatusCategories=kind=>Object.entries(STATUS[kind]||{}).map(([value,[label]])=>[value,label]);
const recordDate=x=>x.at||x.createdAt||x.submittedAt||x.start||'';
function recordTime(value){
 const raw=String(value||'');
 const stamp=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw)?raw+'T00:00:00':raw);
 return Number.isFinite(stamp)?stamp:0;
}
function recordState(key){
 const scoped=String(role||'guest')+':'+key;
 if(!recordStates.has(scoped))recordStates.set(scoped,{category:'all',period:recordDefaultPeriod(key),order:'newest',page:1,drafts:new Map()});
 return recordStates.get(scoped);
}
function recordsPage(key,items,options={},now=new Date()){
 const state=recordState(key),categories=options.categories||[],getDate=options.date||recordDate;
 if(options.filters===false||(state.category!=='all'&&!categories.some(([value])=>value===state.category)))state.category='all';
 if(options.time===false||options.filters===false)state.period='all';
 else if(!['all','today','7','30','month','year'].includes(state.period))state.period=recordDefaultPeriod(key);
 if(!['newest','oldest'].includes(state.order))state.order='newest';
 const start=new Date(now);start.setHours(0,0,0,0);
 if(state.period==='year')start.setMonth(0,1);
 else if(state.period==='month')start.setDate(1);
 else if(state.period==='7'||state.period==='30')start.setDate(start.getDate()-Number(state.period)+1);
 const end=new Date(now);end.setHours(24,0,0,0);
 let rows=(items||[]).map((item,index)=>({item,index,time:recordTime(getDate(item))}));
 if(state.category!=='all')rows=rows.filter(({item})=>String((options.category||((x)=>x.status))(item))===state.category);
 const categoryCount=rows.length;
 if(state.period!=='all')rows=rows.filter(x=>x.time>=start.getTime()&&x.time<end.getTime());
 const hiddenByTime=categoryCount-rows.length;
 if(options.order!==false)rows.sort((a,b)=>(state.order==='oldest'?a.time-b.time:b.time-a.time)||a.index-b.index);
 const total=rows.length,pages=Math.max(1,Math.ceil(total/RECORD_PAGE_SIZE));
 state.page=Math.min(pages,Math.max(1,Math.trunc(Number(state.page))||1));
 const offset=(state.page-1)*RECORD_PAGE_SIZE;
 return {items:rows.slice(offset,offset+RECORD_PAGE_SIZE).map(x=>x.item),state,total,pages,from:total?offset+1:0,to:Math.min(offset+RECORD_PAGE_SIZE,total),allCount:(items||[]).length,hiddenByTime};
}
function recordsContent(key,items,row,options={}){
 const page=recordsPage(key,items,options),s=page.state,label=options.label||'记录';
 const select=(name,title,choices,value)=>`<label class="record-filter"><span>${title}</span><select data-record-key="${esc(key)}" data-record-filter="${name}" aria-label="${esc(label+' · '+title)}">${choices.map(([v,l])=>`<option value="${esc(v)}"${v===value?' selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
 const filters=(options.categories?.length?select('category','分类',[['all','全部分类'],...options.categories],s.category):'')+(options.time===false?'':select('period','时间',[['today','今日'],['7','最近 7 天'],['30','最近 30 天'],['month','本月'],['year','今年'],['all','全部时间']],s.period))+(options.order===false?'':select('order','排序',[['newest','最新在前'],['oldest','最早在前']],s.order));
 const toolbar=options.filters===false?'':`<div class="record-toolbar">${filters}<span class="record-count" aria-live="polite">${page.total===page.allCount?'共 '+page.total+' 条':'筛选 '+page.total+' / '+page.allCount+' 条'}</span></div>`;
 const timeHint=page.hiddenByTime?`<div class="record-time-hint"><span>有 ${page.hiddenByTime} 条记录未显示；较早和未标日期的记录可在全部时间查看。</span><button type="button" class="btn btn-sm btn-soft" data-record-key="${esc(key)}" data-record-all-time>查看全部时间</button></div>`:'';
 const rows=page.items.map(row).join(''),body=rows?(options.wrap?options.wrap(rows):`<ul class="${esc(options.listClass||'list')}">${rows}</ul>`):empty(page.allCount?(page.hiddenByTime?'当前时间范围内没有记录':'没有符合筛选条件的记录'):esc(options.empty||'还没有记录'));
 const nav=page.pages>1?`<nav class="record-pagination" aria-label="${esc(label+'分页')}"><span>${page.from}–${page.to} / ${page.total} 条<span class="record-page-size"> · 每页 10 条</span></span><div><button type="button" class="btn btn-sm btn-ghost" data-record-key="${esc(key)}" data-record-page="${s.page-1}"${s.page===1?' disabled':''} aria-label="${esc(label+'上一页')}">上一页</button><span class="record-page-number" aria-live="polite">${s.page} / ${page.pages}</span><button type="button" class="btn btn-sm btn-ghost" data-record-key="${esc(key)}" data-record-page="${s.page+1}"${s.page===page.pages?' disabled':''} aria-label="${esc(label+'下一页')}">下一页</button></div></nav>`:'';
 return toolbar+timeHint+body+nav;
}
function recordsList(key,items,row,options={}){
 // A full page render follows navigation or a business update; old inline drafts must not override it.
 recordState(key).drafts.clear();
 recordViews.set(String(role||'guest')+':'+key,{items,row,options});
 return `<div class="record-list" data-record-list="${esc(key)}" role="region" aria-label="${esc(options.label||'记录')}">${recordsContent(key,items,row,options)}</div>`;
}
function updateRecords(key,change,focusField=''){
 const scope=Array.from(root.querySelectorAll('[data-record-list]')).find(x=>x.dataset.recordList===key);
 const view=recordViews.get(String(role||'guest')+':'+key);if(!scope||!view)return;
 const state=recordState(key);
 if(typeof captureFormDrafts==='function')captureFormDrafts(scope,state.drafts);
 Object.assign(state,change);
 scope.innerHTML=recordsContent(key,view.items,view.row,view.options);
 if(typeof restoreFormDrafts==='function')restoreFormDrafts(scope,state.drafts);
 if(focusField)scope.querySelector(`[data-record-filter="${focusField}"]`)?.focus();
}

// Update just the selected list: filters never rebuild the purchase, wish, or login form.
root.addEventListener('click',e=>{
 const showAll=e.target.closest?.('[data-record-all-time]');
 if(showAll){if(showAll.disabled||busy)return;e.preventDefault();updateRecords(showAll.dataset.recordKey,{period:'all',page:1},'period');return;}
 const button=e.target.closest?.('[data-record-page]');if(!button||button.disabled||busy)return;
 e.preventDefault();updateRecords(button.dataset.recordKey,{page:Number(button.dataset.recordPage)});
});
root.addEventListener('change',e=>{
 const select=e.target;if(!select.dataset?.recordFilter||busy)return;
 const field=select.dataset.recordFilter;if(!['category','period','order'].includes(field))return;
 updateRecords(select.dataset.recordKey,{[field]:select.value,page:1},field);
});

function pendingCount(){
 if(!data)return 0;
 return data.purchaseRequests.filter(x=>x.status==='pending'||x.status==='return_pending').length
  +data.loans.filter(x=>x.status==='pending').length
  +(data.taskProposals||[]).filter(x=>x.status==='pending').length
  +(data.taskCompletions||[]).filter(x=>x.status==='pending').length;
}

/* ---------- network ---------- */
function toast(msg,error=false){toastEl.textContent=msg;toastEl.className='show'+(error?' error':'');clearTimeout(toastEl.timer);toastEl.timer=setTimeout(()=>toastEl.className='',3600);}
async function req(path,method='GET',body=null){
 const requestGeneration=authGeneration;
 const options={method,credentials:'same-origin',headers:{}};
 if(body!==null){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
 const controller=typeof AbortController==='function'?new AbortController():null;
 if(controller)options.signal=controller.signal;
 const timeout=controller?setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS):null;
 try{
  const r=await fetch(path,options);
  const d=await r.json().catch(err=>{if(controller?.signal.aborted)throw err;return {error:'服务器无法返回有效结果'};});
  // A read from an earlier login must not replace or expire a newer session,
  // including logging out and back into the same role while it was in flight.
  if(requestGeneration!==authGeneration)throw Error('登录状态已更新，请重试');
  if(!r.ok||d.error){
   const msg=d.error||`HTTP ${r.status}`;
   // Session revoked (PIN / password changed) or expired: go back to the login screen.
   if((r.status===401||r.status===403)&&/登录已过期|请先登录|登录账户已切换/.test(msg)&&role){sessionExpired();throw Error(/账户已切换/.test(msg)?'登录账户已切换，请重新登录':'登录已过期，请重新登录');}
   throw Error(msg);
  }
  // Cookies are shared by tabs. Never install another account's snapshot into
  // the current account's page when another tab has just switched logins.
  if(path.startsWith('/api/state')&&role&&d.role&&d.role!==role){sessionExpired();throw Error('登录账户已切换，请重新登录');}
  return d;
 }catch(err){
  if(controller?.signal.aborted)throw Error(method==='GET'?'连接超时，请检查网络后重试。':'连接超时，尚未确认操作结果。请保留当前页面后重试，系统会避免重复提交。');
  throw err;
 }finally{if(timeout!==null)clearTimeout(timeout);}
}
function sessionExpired(){authGeneration++;loginRole=role==='dad'?'dad':'kid';role=null;data=null;pendingStateRefresh=null;resetBuySelection();render();}
async function boot(){
 const generation=authGeneration;
 try{
  const b=await req('/api/bootstrap');
  if(generation!==authGeneration)return;
  if(role!==b.role){authGeneration++;resetBuySelection();}
  initialized=b.initialized;role=b.role;data=b.data;
  if(firstBoot){firstBoot=false;applyHash();}
  render();
 }catch(e){
  if(generation!==authGeneration)return;
  root.innerHTML=authShell('暂时打不开银行',esc(e.message),'<button type="button" class="btn btn-primary btn-block" id="retry">重试</button>');
  document.getElementById('retry')?.addEventListener('click',boot);
 }
}
async function refresh(){const fresh=await req('/api/state');data=fresh;pendingStateRefresh=null;render();}
// Background reads send the version the page holds; an unchanged state comes back as {unchanged:true}.
const statePath=()=>data?.stateVersion?`/api/state?since=${encodeURIComponent(data.stateVersion)}`:'/api/state';
function keepUnchangedState(){if(pendingStateRefresh){pendingStateRefresh=null;render();}}
function stateRefreshNotice(){
 if(!pendingStateRefresh)return '';
 return `<section class="state-refresh-notice" role="status"><div><b>${esc(pendingStateRefresh.message)}</b><p>操作已完成，账户数据暂未刷新。请刷新查看最新余额。</p></div><button type="button" class="btn btn-soft" data-refresh-state>${icon('refresh')}刷新账户</button></section>`;
}
async function refreshConfirmedState(){
 const message=pendingStateRefresh?.message||'账户数据',drafts=captureFormDrafts(root),dirty=formDirty;
 try{await refresh();restoreFormDrafts(root,drafts);formDirty=dirty;toast(message+'；账户已更新');return true;}
 catch(err){if(role)toast('账户暂时无法刷新，请稍后再试。已完成的操作不会重复提交。',true);else toast(message+'；请重新登录查看账户');return false;}
}
const SUCCESS={'fixed.open':'定期已开立','fixed.redeem':'定期资金已转回活期','purchase.request':'已发给家长','purchase.approve':'已扣款，订单完成','purchase.reject':'已拒绝','purchase.return.request':'退款申请已提交，等待家长处理','purchase.refund':'已退款到活期','purchase.return.reject':'已拒绝退款申请','loan.request':'借款申请已提交','loan.approve':'借款已发放','loan.reject':'已拒绝','loan.repay':'还款成功','stock.buy':'买入单已提交','stock.sell':'卖出单已提交','stock.cancel':'已撤单','watch.add':'已加入自选','watch.remove':'已移出自选','security.register':'已加入交易列表','wish.purchase':'购买申请已发给家长，金额已预留','wish.add':'心愿已添加','wish.remove':'心愿已删除','task.complete':'已提交给家长验收','task.propose':'提议已发给家长','task.create':'任务已添加','task.update':'任务已保存','task.proposal.approve':'已加入任务清单','task.completion.approve':'奖励已入账','cash.grant':'已存入 Olivia 的活期','settings.update':'账户设置已保存','pin.change':'PIN 已更新','profile.avatar.set':'头像已更新','profile.avatar.remove':'已恢复默认头像','order.retarget':'已重算目标交易日','order.roll':'已顺延到下一交易日','order.cancel':'订单已撤销，Olivia 会收到通知','maintenance.run':'计息与到期结算完成'};
async function runAction(action,payload){
 const requestRole=role;
 const fingerprint=['pin.change','password.change'].includes(action)?null:JSON.stringify([requestRole,action,payload]);
 // A successful mutation followed by a failed read must never become a second mutation.
 if(pendingStateRefresh){
  const sameRequest=!!fingerprint&&pendingStateRefresh.fingerprint===fingerprint,refreshed=await refreshConfirmedState();
  if(refreshed&&!sameRequest)toast('账户已刷新，请核对后重新提交本次操作');
  return {refreshOnly:true,submitted:false,refreshed};
 }
 if(action==='stock.buy'&&pendingBuySelection)throw Error(`请先确认 ${pendingBuySelection.symbol} 的交易信息，或明确选择另一只股票`);
 const digest=await actionFingerprintHash(fingerprint);
 if(!requestRole||role!==requestRole)throw Error('登录账户已切换，请重新登录');
 let id=fingerprint?actionRetryKeys.get(fingerprint):null;
 if(!id&&digest)id=pendingActionKeys.get(digest)?.id;
 if(!id)id=globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now().toString(36);
 if(fingerprint){actionRetryKeys.set(fingerprint,id);if(actionRetryKeys.size>100)actionRetryKeys.delete(actionRetryKeys.keys().next().value);}
 if(digest){pendingActionKeys.set(digest,{id,at:Date.now()});if(pendingActionKeys.size>100)pendingActionKeys.delete(pendingActionKeys.keys().next().value);savePendingActionKeys();}
 if(action==='password.change')authGeneration++;
 const r=await req('/api/action','POST',{action,payload,idempotencyKey:id,expectedRole:requestRole});
 // A confirmed response clears recovery state before refreshing balances. A later
 // intentional operation with the same amount gets its own, new request key.
 actionRetryKeys.delete(fingerprint);
 if(digest){pendingActionKeys.delete(digest);savePendingActionKeys();}
 if(action==='password.change'){role=null;data=null;resetBuySelection();clearActionRetryKeys();loginRole='dad';render();toast('家长密码已修改，请重新登录');return r;}
 let msg=r.duplicate?'这个请求已经处理过了':(SUCCESS[action]||'操作成功');
 if(!r.duplicate&&action==='fixed.redeem'&&fixedAtMaturity(data.fixed.find(f=>f.id===payload.id)))msg='定期已到期，本金和利息已转回活期';
 if(r.quotesFetched!==undefined)msg=`取得 ${r.quotesFetched} 条日线并完成结算`+(r.errors?.length?`；${r.errors.length} 只暂时失败`:'');
 if(r.warning)msg+='；'+r.warning;
 pendingStateRefresh={message:msg,fingerprint};
 try{
  // The action response carries the updated state, saving a second round trip; otherwise read it.
  if(r.state&&r.state.role===role){data=r.state;pendingStateRefresh=null;render();}else await refresh();
  toast(msg,!!r.warning||!!r.errors?.length);
 }
 catch(err){
  if(role&&data){render();toast(msg+'；请点“刷新账户”查看最新结果');}
  else toast(msg+'；请重新登录查看账户');
 }
 return r;
}

/* ---------- routing (#/tab/sub) ---------- */
function applyHash(){
 try{
  const h=typeof location!=='undefined'&&typeof location.hash==='string'?location.hash:'';
  let [t,sb]=h.replace(/^#\/?/,'').split('/');
  const legacy=t==='dad';if(legacy)t='parent'; // V1.7 bookmarks
  if(!TABS.includes(t))return;
  if(t==='parent'&&role!=='dad')return;
  tab=t;if(sb&&SUBS[t]?.includes(sb))sub[t]=sb;
  if(legacy)writeHash(true);
 }catch{}
}
function writeHash(replace=false){
 try{
  if(typeof location==='undefined'||typeof location.hash!=='string')return;
  const h='#/'+tab+(SUBS[tab]?'/'+sub[tab]:'');
  if(location.hash===h)return;
  if(replace&&typeof location.replace==='function')location.replace(h);else location.hash=h;
 }catch{}
}
const scrollTop=()=>{try{if(typeof globalThis.scrollTo==='function')globalThis.scrollTo({top:0});}catch{}};
function go(t,sb){
 if(!TABS.includes(t)||(t==='parent'&&role!=='dad'))t='home';
 tab=t;if(sb&&SUBS[t]?.includes(sb))sub[t]=sb;
 writeHash();render();scrollTop();
}
function switchSub(group,name){
 if(!SUBS[group]?.includes(name))return;
 sub[group]=name;
 root.querySelectorAll(`[data-panel^="${group}:"]`).forEach(p=>{p.hidden=p.dataset.panel!==`${group}:${name}`;});
 root.querySelectorAll(`[data-seg="${group}"]`).forEach(b=>{const on=b.dataset.sub===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});
 writeHash(true);
}

/* ---------- layout ---------- */
function navItems(){
 const items=[['home','home','首页','首页'],['account','piggy','我的账户','账户'],['stocks','trend','投资','投资'],['tasks','gift','任务赚钱','任务'],['wishes','star','我的心愿','心愿'],['history','receipt','交易记录','记录']];
 if(role==='dad')items.push(['parent','sliders','家长后台','后台']);
 return items;
}
function unreadNotifications(){return (data?.notifications||[]).filter(n=>!n.readAt).length;}
function notificationsMenu(){
 if(role!=='kid')return '';
 const notes=(data?.notifications||[]).slice(0,30),unread=unreadNotifications();
 const items=notes.map(n=>`<button type="button" class="notice-item${n.readAt?'':' is-unread'}" data-notice-go="${esc(n.target||'account')}"${n.sub?` data-notice-sub="${esc(n.sub)}"`:''}><span class="notice-symbol notice-symbol-${n.tone==='ok'?'ok':n.tone==='no'?'no':'info'}">${icon(n.tone==='ok'?'check':n.tone==='no'?'x':'bell')}</span><span class="notice-copy"><span class="notice-title">${esc(n.title)}${n.readAt?'':'<i class="notice-new" aria-label="未读">新</i>'}</span><small>${esc(moneyInText(n.detail))}</small><time>${friendlyDay(n.at)}</time></span>${icon('chevRight','notice-arrow')}</button>`).join('');
 return `<details class="notifications"><summary data-notice-toggle aria-label="消息通知${unread?'，'+unread+'条未读':''}" title="消息通知">${icon('bell')}${unread?`<em class="notice-count" aria-hidden="true">${unread>9?'9+':unread}</em>`:''}</summary><section class="notice-panel" aria-label="Olivia 的通知"><div class="notice-panel-head"><b>我的消息</b><small>${unread?unread+' 条新消息':'已读全部消息'}</small></div><div class="notice-feed">${items||'<div class="notice-empty">还没有新消息<br><small>家长处理申请后，结果会出现在这里</small></div>'}</div><div class="notice-panel-foot">最近的申请结果会保存在这里 · 点击消息查看详情</div></section></details>`;
}
async function markNotificationsRead(){
 if(role!=='kid'||notificationReadPending||!unreadNotifications())return;
 notificationReadPending=true;
 try{
  const id=globalThis.crypto?.randomUUID?.()||'notify-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const requestRole=role;
  await req('/api/action','POST',{action:'notifications.read',payload:{},idempotencyKey:id,expectedRole:requestRole});
  if(role!==requestRole)return;
  const now=new Date().toISOString();
  // Only change the bell/panel, never replace the page while a form is being edited.
  for(const n of (data?.notifications||[]))if(!n.readAt)n.readAt=now;
  const node=root.querySelector('details.notifications');
  if(node){node.querySelector('.notice-count')?.remove();node.querySelector('summary')?.setAttribute('aria-label','消息通知');node.querySelector('.notice-panel-head small')?.replaceChildren('已读全部消息');node.querySelectorAll('.notice-item.is-unread').forEach(item=>{item.classList.remove('is-unread');item.querySelector('.notice-new')?.remove();});}
 }catch(err){toast(err.message,true);}finally{notificationReadPending=false;}
}
function userMenu(){
 const kid=role==='kid',photo=data?.profile?.kidAvatarData;
 // The profile image belongs to the account; the goose badge remains the site's separate brand mark.
 const face=kid
  ?`<span class="avatar avatar-olivia" aria-label="Olivia 的头像">${photo?`<img class="avatar-photo" src="${esc(photo)}" alt="Olivia 的头像">`:`<span class="avatar-initial" aria-hidden="true">O</span><span class="avatar-mini-crown">${icon('crown')}</span>`}</span>`
  :`<span class="avatar avatar-dad" aria-label="家长的金鹅头像"><img class="avatar-goose" src="/assets/images/brand-goose.png" alt="戴皇冠的金鹅"></span>`;
 return `<details class="user"><summary aria-label="账户菜单">${face}<span class="user-name"><b>${kid?'Olivia':'家长'}</b><small>我的账户</small></span>${icon('chevDown','chev')}</summary><div class="menu">${kid?`<label class="menu-item">${icon('camera')}<span>${photo?'更换头像':'上传头像'}</span><input id="kid-avatar-file" type="file" accept="image/*" aria-label="上传或更换 Olivia 的头像"></label>`:''}${kid&&photo?`<button type="button" class="menu-item" data-act="profile.avatar.remove">${icon('trash')}<span>恢复默认头像</span></button>`:''}<button type="button" class="menu-item" data-logout>${icon('logout')}<span>退出登录</span></button></div></details>`;
}
function header(){
 const n=pendingCount(),count=t=>t==='parent'&&n?`<em class="count">${n}</em>`:'';
 return `<header class="topbar${role==='dad'?' nav-compact':''}"><button type="button" class="brand" data-tab="home" aria-label="皇家金鹅银行首页"><img class="brand-logo" src="/assets/images/logo.svg" alt=""><span class="brand-text"><b>皇家金鹅银行</b><small>Royal Bank of the Golden Goose</small></span></button><nav class="nav" aria-label="主导航">${navItems().map(([t,ic,long,short])=>`<button type="button" data-tab="${t}" class="nav-btn${tab===t?' active':''}"${tab===t?' aria-current="page"':''}>${icon(ic)}<span class="l-long">${long}</span><span class="l-short">${short}</span>${count(t)}</button>`).join('')}</nav>${notificationsMenu()}${userMenu()}</header>`;
}
function tabbar(){
 const n=pendingCount();
 return `<nav class="tabbar" aria-label="主导航">${navItems().map(([t,ic,,short])=>`<button type="button" data-tab="${t}" class="tab-btn${tab===t?' active':''}"${tab===t?' aria-current="page"':''}>${icon(ic)}<span>${short}</span>${t==='parent'&&n?`<em class="count">${n}</em>`:''}</button>`).join('')}</nav>`;
}
function render(){
 formDirty=false;
 if(!role||!data){loginPage();return;}
 reconcileBuySelection();
 if(tab==='parent'&&role!=='dad')tab='home';
 const page={home,account,stocks,tasks,wishes,history,parent:parentPage}[tab]||home;
 const isHome=tab==='home';
 root.innerHTML=`<div class="app${isHome?' is-home':''}">${header()}${isHome?heroBanner():''}<main class="page" id="main">${stateRefreshNotice()}${page()}</main>${tabbar()}</div>`;
}

/* ---------- login / setup ---------- */
function authShell(title,subtitle,contents,{setup=false}={}){
 return `<main class="auth${setup?' auth-setup':''}"><div class="auth-world" aria-hidden="true"></div><div class="auth-layout"><section class="auth-card" aria-labelledby="auth-heading"><img class="auth-emblem" src="/assets/images/brand-goose.png" alt="皇冠金鹅徽章"><div class="auth-kicker">ROYAL BANK OF THE GOLDEN GOOSE</div><h1 id="auth-heading">${title}</h1><p class="sub">${subtitle}</p>${contents}<p class="auth-footer">皇家金鹅银行 · 存下每一个小梦想</p></section></div></main>`;
}
function loginPage(){
 if(!initialized){
  const local=typeof location!=='undefined'&&['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  root.innerHTML=authShell('欢迎来到皇家金鹅银行','首次使用：设置家长密码和 Olivia 的 PIN',opForm('setup',`${field('token','初始化密钥','text','required autocomplete="off" autocapitalize="off" spellcheck="false"')}${field('password','家长密码（至少 12 位）','password','required minlength="12" autocomplete="new-password"')}${field('pin','Olivia 的 PIN（6–10 位数字）','password','required pattern="[0-9]{6,10}" inputmode="numeric" autocomplete="new-password"')}`,'创建家庭银行',{foot:local?'<p class="hint center">本地测试密钥：<b>local-setup</b></p>':''}),{setup:true});
  return;
 }
 const kid=loginRole==='kid';
 const roles=`<div class="seg seg-auth" role="tablist"><button type="button" role="tab" data-login-role="kid" class="${kid?'active':''}" aria-selected="${kid}">Olivia</button><button type="button" role="tab" data-login-role="dad" class="${kid?'':'active'}" aria-selected="${!kid}">家长</button></div>`;
 const form=opForm('login',`${hiddenInput('role',loginRole)}<label class="field"><span>${kid?'我的 PIN':'家长密码'}</span><input name="password" type="password" required ${kid?'class="pin" inputmode="numeric" autocomplete="off"':'autocomplete="current-password"'}></label>`,'进入银行');
 root.innerHTML=authShell('皇家金鹅银行','欢迎回来，选择账户进入你的金鹅银行',roles+form);
}

/* ---------- 首页 ---------- */
function home(){
 return `<section class="quick" aria-label="快捷入口">${quick('green','piggy','存定期','存起来赚利息','account','fixed')}${quick('purple','bag','花钱','申请买想要的东西','account','shopping')}${quick('yellow','wand','我的心愿','设置目标慢慢攒','wishes')}${quick('blue','gift','任务赚钱','完成任务赚 O$','tasks')}</section>
 <section class="dash">${assetsCard()}${wishCard()}${recentCard()}</section>
 ${investmentSnapshot()}
 ${homeWatchlist()}`;
}
const sparkle=cls=>`<svg class="spark ${cls}" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 0Q10 10 20 10Q10 10 10 20Q10 10 0 10Q10 10 10 0Z"/></svg>`;
function heroBanner(){
 const s=data.summary;
 return `<section class="hero" aria-label="账户总览"><div class="scene" aria-hidden="true"></div><div class="hero-inner"><div class="hero-goose"><img src="/assets/images/goose.svg" alt="戴皇冠的金鹅">${sparkle('s1')}${sparkle('s2')}</div><div class="hero-card"><button type="button" class="hero-account-link" data-tab="account" aria-label="${role==='dad'?'查看 Olivia 的账户':'查看我的账户'}" title="进入我的账户"></button><div class="hero-title">${art('crown')}<span>${role==='dad'?'Olivia 的金鹅账户':'我的金鹅账户'}</span><button type="button" class="eye" data-eye aria-pressed="${hideBalance}" aria-label="${hideBalance?'显示金额':'隐藏金额'}">${icon(hideBalance?'eyeOff':'eye')}</button></div><div class="hero-amount num">${hideBalance?'O$ ••••••':money(s.netWorthCents)}</div><div class="hero-sub">净资产 · 可用 <b class="num">${hideBalance?'••••':money(spendableCents(s.availableCents))}</b></div></div><div class="hero-coin"><img src="/assets/images/coin.svg" alt="">${sparkle('s3')}${sparkle('s4')}</div></div></section>`;
}
const quick=(tone,a,title,subtitle,t,sb)=>`<button type="button" class="qa qa-${tone}" data-tab="${t}"${sb?` data-go-sub="${sb}"`:''}>${art(a)}<span class="qa-text"><b>${title}</b><small>${subtitle}</small></span>${icon('chevRight','chev')}</button>`;
function assetsCard(){
 const s=data.summary,total=s.assetsCents,debt=s.loanPrincipalCents+s.loanInterestCents;
 const parts=[['活期账户',s.cashCents,'var(--c-cash)'],['定期存款',s.fixedPrincipalCents,'var(--c-fixed)'],['股票投资',s.stocksValueCents,'var(--c-stock)']];
 let acc=0;
 const stops=total>0?parts.map(([,v,c])=>{const a=acc;acc+=Math.max(0,v);return `${c} ${(a/total*100).toFixed(2)}% ${(acc/total*100).toFixed(2)}%`;}).join(','):'var(--c-empty) 0% 100%';
 return card('我的资产','layers',`<div class="assets"><div class="donut" style="background:conic-gradient(${stops})"><div class="donut-hole"><small>总资产</small><b class="num">${money(total)}</b></div></div><ul class="legend">${parts.map(([l,v,c])=>`<li><span><i style="background:${c}"></i>${l}</span><b class="num">${money(v)}</b></li>`).join('')}${debt?`<li><span><i class="ring"></i>欠家长</span><b class="num neg">−${money(owedCents(debt))}</b></li>`:''}<li class="legend-total"><span>现在可用</span><b class="num pinktext">${money(spendableCents(s.availableCents))}</b></li></ul></div>`,{right:more('account'),cls:'assets-card'});
}
function wishState(w){
 const linked=(data.purchaseRequests||[]).filter(r=>r.wishId===w.id);
 const purchase=linked.find(r=>['pending','approved','delivered','return_pending'].includes(r.status));
 if(purchase?.status==='pending')return {key:'waiting',label:'等待家长确认',tone:'pending',description:'已提交购买申请，金额已预留',purchase};
 if(purchase?.status==='return_pending')return {key:'returning',label:'退货处理中',tone:'pending',description:'等待家长处理退货申请',purchase};
 if(purchase)return {key:'achieved',label:'心愿已实现',tone:'ok',description:'已经买到啦！',purchase};
 const ready=data.summary.availableCents>=w.goalCents;
 // A shortfall is rounded UP to O$0.1: a few cents short must never read "还差 O$ 0.0".
 const short=Math.ceil(Math.max(0,w.goalCents-data.summary.availableCents)/10)*10;
 return {key:ready?'ready':'saving',label:ready?'可以购买':'攒钱中',tone:ready?'ok':'live',description:ready?'钱够啦！':'还差 '+money(short),previous:linked[0]};
}
function wishProgress(w){
 const state=wishState(w),avail=data.summary.availableCents;
 if(state.purchase)return {p:100,left:0};
 const p=Math.min(100,Math.max(0,avail/w.goalCents*100));return {p,left:Math.max(0,w.goalCents-avail)};
}
// 100% is shown only once the goal is actually reached (99.95% must not round up to 100%).
const wishPercent=p=>(p>=100?100:Math.min(99,Math.round(p)))+'%';
function wishAction(w,state=wishState(w)){
 if(state.purchase)return `<div class="wish-actions"><button type="button" class="btn btn-sm btn-soft" data-purchase-record="${esc(state.purchase.id)}">查看购买记录${icon('chevRight')}</button></div>`;
 if(role!=='kid')return '';
 const retry=state.previous?.status==='rejected'?'上次申请未通过，可以重新申请':state.previous?.status==='refunded'?'上次购买已退款，可以重新申请':'';
 return `<div class="wish-actions">${state.key==='ready'?btn('wish.purchase',`${icon('bag')}申请购买`,w.id,'primary'):'<button type="button" class="btn btn-sm btn-ghost" disabled>攒够后申请购买</button>'}${retry?`<small>${retry}</small>`:''}</div>`;
}
function openPurchaseRecord(id){
 const ordered=(data.purchaseRequests||[]).slice().sort((a,b)=>recordTime(recordDate(b))-recordTime(recordDate(a)));
 const index=ordered.findIndex(r=>r.id===id);
 Object.assign(recordState('purchases'),{category:'all',period:'all',order:'newest',page:Math.floor(Math.max(0,index)/RECORD_PAGE_SIZE)+1});
 go('account','shopping');
}
function wishCard(){
 const w=data.wishes[0];
 let body=`<div class="empty">还没有心愿目标<br><button type="button" class="btn btn-sm btn-soft" data-tab="wishes">添加心愿</button></div>`;
 if(w){const {p}=wishProgress(w),state=wishState(w);body=`<div class="wish">${art('wand')}<div class="wish-body"><b class="wish-name">${esc(w.name)}</b><small>目标 ${money(w.goalCents)}</small><div class="progress-row"><div class="progress"><i style="width:${p.toFixed(1)}%"></i></div><b class="num">${wishPercent(p)}</b></div><small>${state.description}</small>${wishAction(w,state)}</div></div>`;}
 return card('我的心愿目标','target',body,{right:more('wishes')});
}
function recentCard(){
 const rows=data.ledger.slice(0,3).map(l=>`<li class="row">${ledgerIcon(l.type)}<div class="row-main"><b>${esc(ledgerText(l))}</b><small>${friendlyDay(l.at)}</small></div><b class="num ${l.deltaCents>=0?'pos':'neg'}">${signedMoney(l.deltaCents)}</b></li>`).join('');
 return card('最近的交易','clock',rows?list(rows):empty('还没有交易'),{right:`<button type="button" class="more" data-tab="history">全部${icon('chevRight')}</button>`});
}
function investmentSnapshot(){
 const holdings=(data.positions||[]).filter(p=>p.qtyMicro>0).sort((a,b)=>b.valueCents-a.valueCents);
 const pnl=holdings.reduce((sum,p)=>sum+(p.quote?p.valueCents-p.costCents:0),0);
 const missing=holdings.filter(p=>!p.quote).length;
 const pending=data.orders.filter(o=>o.status==='pending').length;
 const name=p=>data.symbols.find(s=>s.symbol===p.symbol)?.name||p.symbol;
 const stats=`<div class="mini-stats"><div><span>股票市值</span><b class="num">${money(data.summary.stocksValueCents)}</b></div><div><span>未实现盈亏</span><b class="num ${pnl>=0?'pos':'neg'}">${signedMoney(pnl)}</b></div><div><span>持仓数量</span><b class="num">${holdings.length} 只</b></div><div><span>待成交</span><b class="num">${pending} 笔</b></div></div>`;
 const rows=holdings.length?`<div class="holdings">${holdings.slice(0,3).map(p=>{const f=positionFigures(p);return `<div class="holding"><div class="holding-main"><b>${esc(p.symbol)}</b><span>${esc(name(p))}</span><small class="holding-prices">买入价 <b class="num">${priceWithCurrency(f.buyMilli,f.currency)}</b> · 收盘价 <b class="num">${priceWithCurrency(f.closeMilli,f.currency)}</b></small><small>${p.quote?`收盘价日期 ${esc(p.quote.date)}`:'还没有收盘价 · 先按买入金额计算'}</small></div><div class="holding-side"><b class="num">${money(p.valueCents)}</b>${gainLines(f)}</div></div>`;}).join('')}</div>`:'<p class="hint invest-empty">还没有股票持仓</p>';
 const warn=missing?`<p class="hint warn-text">${missing} 只股票还没有收盘价，先按买入金额计算，不算盈亏。</p>`:'';
 return card('我的投资速览','trend',stats+rows+warn,{right:more('stocks','查看投资'),cls:'invest'});
}

/* Read-only homepage mirror of the existing /stocks watchlist. No quote fetches or trading rules added. */
function homeWatchlist(){
 const stocks=Array.isArray(data.watchlist)?data.watchlist.slice(0,10):[];
 const percentage=n=>n===null||n===undefined||!Number.isFinite(Number(n))?'<span class="muted">—</span>':`<b class="${Number(n)>=0?'pos':'neg'}">${Number(n)>=0?'+':''}${Number(n).toFixed(1)}%</b>`;
 const tiles=stocks.map(s=>{
  const quote=s.quote;
  return `<article class="home-stock-tile"><div class="home-stock-head"><div class="home-stock-symbol"><span class="stock-spark">${icon('star')}</span><div><b>${esc(s.symbol)}</b><small title="${esc(s.name||'')}">${esc(s.name||s.symbol)}</small></div></div><span class="stock-market">${esc(s.market||'')}</span></div><div class="home-stock-price"><b class="num">${quoteText(s)}</b><span>${quote?.date?'收盘 '+esc(quote.date):'暂无可用收盘价'}</span></div><div class="home-stock-returns"><div><small>1D</small>${percentage(s.performance?.day)}</div><div><small>1W</small>${percentage(s.performance?.week)}</div><div><small>YTD</small>${percentage(s.performance?.ytd)}</div></div></article>`;
 }).join('');
 const body=stocks.length
  ?`<div class="home-stock-grid">${tiles}</div><p class="home-stock-note">价格是最近一个交易日的收盘价，涨跌只算股价变化。</p>`
  :`<div class="home-stock-empty"><span class="home-stock-empty-icon">${icon('star')}</span><div><b>还没有关注的股票</b><small>在投资页搜索股票并加入自选，就会显示在这里（最多 10 只）。</small></div><button type="button" class="btn btn-sm btn-soft" data-tab="stocks">去添加自选</button></div>`;
 return card('我的自选股票','star',body,{right:more('stocks',stocks.length?`管理自选 · ${stocks.length}/10`:'查看投资'),cls:'home-watch-card'});
}

/* ---------- 我的账户 ---------- */
function account(){
 const s=data.summary,debt=s.loanPrincipalCents+s.loanInterestCents;
 return `${pageHead('我的账户','piggy')}
 <div class="stats">${stat('活期现金',money(s.cashCents))}${stat('预留资金',money(s.reservedCents))}${stat('定期本金',money(s.fixedPrincipalCents))}${stat('欠家长',money(owedCents(debt)),debt?'neg':'')}</div>
 ${s.reservedCents?`<p class="reservation-summary">购物 ${money(s.purchaseReservedCents||0)} · 股票买单 ${money(s.stockReservedCents??s.reservedCents)} 正在等待处理，这部分钱暂时不能用。</p>`:''}
 ${seg('account',[['fixed','定期存款'],['shopping','购物'],['loan','借款']])}
 <div class="panel" id="fixed" data-panel="account:fixed"${hid('account','fixed')}>${fixedPanel()}</div>
 <div class="panel" id="shopping" data-panel="account:shopping"${hid('account','shopping')}>${shoppingPanel()}</div>
 <div class="panel" id="loan" data-panel="account:loan"${hid('account','loan')}>${loanPanel()}</div>`;
}
function fixedAtMaturity(f){return !!f&&f.status==='active'&&f.maturity<=(data?.bankDate||exchangeToday('HK'));}
function fixedPanel(){
 const rates=data.settings.fixedRates;
 const rows=recordsList('fixed',data.fixed,f=>{
  const est=Math.round(f.principalCents*f.rateBps*(Date.parse(f.maturity)-Date.parse(f.start))/86400000/3650000);
  const matured=fixedAtMaturity(f),interest=f.status==='active'?`${matured?'到期利息':'预计利息'} ${money(est)}`:f.status==='matured'?`利息 ${money(f.interestCents)}`:'不计利息';
  return `<li class="row"><div class="row-main"><b>${f.term}个月 · <span class="num">${money(f.principalCents)}</span></b><small>${meta(`${esc(f.start)} → ${esc(f.maturity)}`,`年息 ${pct(f.rateBps)}`)}</small></div><div class="row-side">${matured?'<span class="badge pending">已到期，待入账</span>':statusBadge('fixed',f.status)}<small class="num">${interest}</small></div>${f.status==='active'?`<div class="row-actions">${btn('fixed.redeem',matured?'到期取回':'提前取出',f.id,matured?'soft':'danger')}</div>`:''}</li>`;
 },{label:'我的定期',categories:recordStatusCategories('fixed'),empty:'还没有定期存款'});
 const terms=`<div class="choices" role="radiogroup" aria-label="存款期限">${[3,6,12].map((m,i)=>`<label class="choice"><input type="radio" name="term" value="${m}"${i===0?' checked':''}><span><b>${m}个月</b><em>${pct(rates[m])}</em><small>年利率</small></span></label>`).join('')}</div>`;
 return `<div class="cols">${card('开立定期','bank',opForm('fixed.open',`${terms}${spendingField('存入金额 O$')}`,'存入定期',{foot:'<p class="hint">到期后本金和利息自动回到活期；提前取出只拿回本金，没有利息。</p>'}))}${card('我的定期','list',rows)}</div>`;
}
function purchaseReturnInfo(r){
 if(r.status==='return_pending')return '';// the 退款待处理 badge says it
 if(r.status==='refunded')return '已退回活期账户';
 if(r.returnRejectedAt)return '退款申请未通过；每笔订单只能申请一次';
 if(r.returnCancelledAt)return '已使用本次退款申请机会，不能再次申请';
 if(!['delivered','approved'].includes(r.status))return '';
 if(r.returnEligible&&r.returnDeadlineAt)return '退款申请截止 '+dateTime(r.returnDeadlineAt);
 return r.returnBlockedReason||'这笔订单暂时不能申请退款';
}
function shoppingPanel(){
 const kid=role==='kid';
 const rows=recordsList('purchases',data.purchaseRequests,r=>{
  let actions='';
  // The server supplies deadline and single-attempt eligibility; it also enforces both on submit.
  if(kid&&r.returnEligible)actions=`<details class="inline row-actions"><summary class="btn btn-sm btn-ghost">申请退款</summary>${opForm('purchase.return.request',`${hiddenInput('id',r.id)}${field('reason','退款原因','text','maxlength="200" placeholder="可选，例如：尺寸不合适"')}`,'提交退款申请',{cls:'form-inline',foot:'<p class="hint">每笔订单只能申请一次，提交后不能撤回。</p>'})}</details>`;
  const info=[`<span class="nw">${date(r.at)}</span>`,r.status==='pending'&&r.reservedCents?'已预留 '+money(r.reservedCents):'',r.wishId?'来自心愿':'',r.note?esc(r.note):'',r.returnReason?'退款原因：'+esc(r.returnReason):'',esc(purchaseReturnInfo(r))].filter(Boolean).join(' · ');
  return `<li class="row"><div class="row-main"><b>${esc(r.name)}</b><small>${info}</small></div><div class="row-side"><b class="num">${money(r.approvedCents??r.amountCents)}</b>${statusBadge('purchase',r.status)}</div>${actions}</li>`;
 },{label:'我的购买',categories:[['pending','待购买'],['bought','已购买'],['return_pending','退款待处理'],['refunded','已退款'],['rejected','未通过']],category:x=>['approved','delivered'].includes(x.status)?'bought':x.status,empty:'还没有购买申请'});
 return `<div class="cols">${card('申请购买','bag',opForm('purchase.request',`${field('name','想买什么','text','required maxlength="90" placeholder="例如：鞋 / LEGO 城堡"')}${spendingField('价格 O$')}${field('link','商品链接','url','placeholder="可选 https://…"')}${textArea('note','为什么想买')}`,kid?'发给家长':'提交申请',{foot:'<p class="hint">提交后先把这笔钱留出来；家长买好才扣钱，不同意就把钱还给你。</p>'}))}${card('我的购买','list','<p class="hint return-policy">买到后 7 天内可以申请退款，每笔只能申请一次。</p>'+rows)}</div>`;
}
function loanPanel(){
 const limit=data.summary.loanLimitCents??data.settings.loanLimitCents??50000,pending=data.summary.loanPendingCents??data.loans.filter(l=>l.status==='pending').reduce((n,l)=>n+l.requestedCents,0),available=Math.max(0,data.summary.loanAvailableCents??(limit-data.summary.loanPrincipalCents-pending));
 const rows=recordsList('loans',data.loans,l=>{
  const interest=Math.round(l.interestMicroCents/1e6),due=l.principalCents+interest,active=l.status==='active';
  // Shown parts add up to the shown (rounded-up) due; principal is listed once it differs from the loan.
  const shownInterest=owedCents(due)-Math.round(l.principalCents/10)*10;
  const info=active?meta(l.principalCents!==l.requestedCents?`还剩本金 ${money(l.principalCents)}`:'',`利息 ${money(shownInterest)}`,`年息 ${pct(l.aprBps)}`):meta(date(l.createdAt),`年息 ${pct(l.aprBps)}`);
  const repay=active?`<div class="row-actions repay">${opForm('loan.repay',`${hiddenInput('id',l.id)}<label class="field"><span>还款 O$</span><input name="amount" type="number" inputmode="decimal" required min="0.1" step="0.1" max="${(owedCents(due)/100).toFixed(2)}" placeholder="0.0"></label>`,'还款',{cls:'form-inline'})}${btn('loan.payoff','全部还清',l.id,'soft')}</div>`:'';
  return `<li class="row"><div class="row-main"><b>借款 <span class="num">${money(l.requestedCents)}</span></b><small>${info}</small></div><div class="row-side">${active?`<b class="num neg">${money(owedCents(due))}</b>`:''}${statusBadge('loan',l.status)}</div>${repay}</li>`;
 },{label:'我的借款',categories:recordStatusCategories('loan'),empty:'暂无借款'});
 const request=role!=='kid'?'<p class="hint">Olivia 可以登录自己的账户申请借款。</p>':spendableCents(available)>0?opForm('loan.request',field('amount','借多少 O$','number',`inputmode="decimal" required min="0.1" step="0.1" max="${(spendableCents(available)/100).toFixed(2)}" placeholder="0.0"`),'申请借钱'):`<p class="loan-limit-message">${limit===0?'家长已暂停新增借款。':'当前没有可申请的额度，还款或待处理申请被拒绝后会释放额度。'}</p>`;
 return `<div class="cols">${card('向家长借钱','coins',`<p class="hint lead">借款总额度 ${money(limit)} · 年息 ${pct(data.settings.loanAprBps)} · 按天计息 · 需家长批准</p><div class="budget-note"><span>本次最多可申请</span><b class="num">${money(spendableCents(available))}</b><small>未还本金 ${money(data.summary.loanPrincipalCents)} · 待批申请 ${money(pending)}</small></div>${request}`)}${card('我的借款','list',rows)}</div>`;
}

/* ---------- 投资 ---------- */
function resetBuySelection(){buySelectionVersion++;pendingBuySelection=null;selectedSymbol='';}
function chooseBuySymbol(symbol){buySelectionVersion++;pendingBuySelection=null;selectedSymbol=symbol;}
function buySecurity(symbol){return (data?.symbols||[]).find(s=>s.symbol===symbol&&s.tradable&&['HK','US'].includes(s.market));}
function reconcileBuySelection(){
 const pending=pendingBuySelection;if(!pending)return;
 if(pending.role!==role){resetBuySelection();return;}
 // Only confirmed account data can enable the requested security's buy form.
 // A later explicit choice clears this intent, so old responses cannot restore it.
 if(buySecurity(pending.symbol)){selectedSymbol=pending.symbol;pendingBuySelection=null;}
}
function stocks(){
 const tradable=(data.symbols||[]).filter(s=>s.tradable&&['HK','US'].includes(s.market));
 if(!selectedSymbol&&!pendingBuySelection)selectedSymbol=tradable[0]?.symbol||'';
 const holdings=data.positions.filter(p=>p.qtyMicro>0);
 const pnl=holdings.reduce((n,p)=>n+(p.quote?p.valueCents-p.costCents:0),0);
 const pending=data.orders.filter(o=>o.status==='pending').length;
 return `${pageHead('投资','trend')}
 <div class="stats">${stat('股票市值',money(data.summary.stocksValueCents))}${stat('未实现盈亏',signedMoney(pnl),pnl>=0?'pos':'neg')}${stat('持仓',holdings.length+' 只')}${stat('待成交',pending+' 笔')}</div>
 <div class="cols cols-main"><div class="stack">${searchCard()}${watchCard()}</div><div class="stack">${buyCard(tradable)}</div></div>
 <div class="cols even">${holdingsCard(holdings)}${ordersCard()}</div>`;
}
function searchCard(){
 return `<section class="card search-card"><label class="search">${icon('search')}<input id="stock-search-field" type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="70" placeholder="搜索 Apple、腾讯、0700.HK" value="${esc(stockSearchTerm)}" aria-label="搜索股票"></label><div id="stock-search-results" class="results" aria-live="polite">${searchResultsHtml()}</div></section>`;
}
function searchResultsHtml(){
 if(!stockSearchTerm)return '';
 if(stockSearchBusy)return '<div class="result-note">正在搜索…</div>';
 if(stockSearchError)return `<div class="result-note neg">${esc(stockSearchError)}</div>`;
 const warn=stockSearchOffline?`<div class="result-warn">${icon('alert')}<span>${esc(stockSearchWarning)}</span></div>`:'';
 if(!stockSearchResults.length)return warn+'<div class="result-note">没有找到匹配的股票</div>';
 return warn+stockSearchResults.map(x=>{
  const watched=(data?.watchlist||[]).some(w=>w.symbol===x.symbol);
  const canTrade=x.tradeHint==='HK'||x.tradeHint==='US';
  return `<div class="result"><div class="result-main"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span><small>${esc(x.exchange||x.tradeHint)} · ${esc(x.type)}</small></div><div class="result-act">${watched?'<span class="badge ok">已自选</span>':`<button type="button" class="btn btn-sm btn-ghost" data-watch-symbol="${esc(x.symbol)}">${icon('star')}自选</button>`}${canTrade?`<button type="button" class="btn btn-sm btn-primary" data-buy-symbol="${esc(x.symbol)}">买入</button>`:'<span class="badge info">仅观察</span>'}</div></div>`;
 }).join('');
}
function watchCard(){
 const rows=data.watchlist.map(s=>{
  const perf=(n,l)=>`<span class="wl-p" data-l="${l}">${n===null||n===undefined?'<i class="muted">—</i>':`<b class="${n>=0?'pos':'neg'}">${n>=0?'+':''}${Number(n).toFixed(1)}%</b>`}</span>`;
  const canBuy=s.tradable&&['HK','US'].includes(s.market);
  return `<div class="wl-row"><div class="wl-name"><b>${esc(s.symbol)}</b><small>${esc(s.name||'')}</small></div><div class="wl-price"><b class="num">${quoteText(s)}</b><small>${s.quote?esc(s.quote.date):'等待行情'}</small></div><div class="wl-perf">${perf(s.performance?.day,'1D')}${perf(s.performance?.week,'1W')}${perf(s.performance?.ytd,'YTD')}</div><div class="wl-act">${canBuy?`<button type="button" class="btn btn-sm btn-soft" data-buy-symbol="${esc(s.symbol)}">买入</button>`:''}<button type="button" class="icon-btn" data-watch-remove="${esc(s.symbol)}" aria-label="把 ${esc(s.symbol)} 移出自选">${icon('x')}</button></div></div>`;
 }).join('');
 const body=rows?`<div class="wl"><div class="wl-row wl-head"><span>股票</span><span class="wl-price">收盘价</span><span class="wl-perf"><span class="wl-p">1D</span><span class="wl-p">1W</span><span class="wl-p">YTD</span></span><span class="wl-act"></span></div>${rows}</div><p class="hint">1D 比前一个交易日，1W 比一周前，YTD 比今年年初；只算股价变化。</p>`:empty('还没有自选股。搜索后点「自选」，最多 10 只。');
 return card('我的自选','star',body,{right:`<span class="badge info">${data.watchlist.length}/10</span>`});
}
const buyQuote=s=>s?.quote?`最新收盘 <b class="num">${quoteText(s)}</b> · ${esc(s.quote.date)}`:'还没有收盘价，按成交日的收盘价成交';
function buyCard(tradable){
 if(pendingBuySelection){
  const pending=pendingBuySelection,message=pending.error||`正在确认 ${pending.symbol} 的交易信息。账户更新后才能填写买入金额。`;
  return card('买入','cart',`<div role="status"><b>已选择 ${esc(pending.symbol)}</b><p class="hint">${esc(message)}</p></div><div class="btn-row"><button type="button" class="btn btn-soft" data-refresh-state>${icon('refresh')}刷新账户</button><button type="button" class="btn btn-ghost" data-buy-symbol="${esc(pending.symbol)}">重试选择</button></div>`,{id:'buy'});
 }
 if(!tradable.length)return card('买入','cart',empty('先搜索港股或美股，点「买入」添加。'),{id:'buy'});
 const sel=tradable.find(s=>s.symbol===selectedSymbol);
 if(!sel)return card('买入','cart',empty('所选股票暂时无法交易，请重新搜索并选择。'),{id:'buy'});
 return card('买入','cart',opForm('stock.buy',`<label class="field"><span>股票</span><select name="symbol" id="buy-symbol">${tradable.map(x=>`<option value="${esc(x.symbol)}"${x.symbol===sel.symbol?' selected':''}>${esc(x.symbol)} · ${esc(x.name)}</option>`).join('')}</select></label><div class="quote-line" id="buy-quote">${buyQuote(sel)}</div>${spendingField('投入金额 O$')}`,'提交买入单',{foot:`<p class="hint">提交后先留出这笔钱，成交时才扣。收盘前下单按当天收盘价成交，收盘后下单按下一个交易日的收盘价。美股 USD 1.0 = ${money((data.settings.usdToO||8)*100)}。</p>`}),{id:'buy'});
}
function holdingsCard(holdings){
 const name=sym=>data.symbols.find(s=>s.symbol===sym)?.name||'';
 const reservedSell=sym=>data.orders.filter(o=>o.side==='sell'&&o.symbol===sym&&o.status==='pending').reduce((n,o)=>n+o.qtyMicro,0);
 const rows=recordsList('holdings',holdings,p=>{
  const avail=Math.max(0,p.qtyMicro-reservedSell(p.symbol)),f=positionFigures(p);
  const sell=avail>0?`<details class="inline row-actions"><summary class="btn btn-sm btn-ghost">卖出</summary>${opForm('stock.sell',`${hiddenInput('symbol',p.symbol)}<label class="field"><span>卖出股数（可卖 ${qtyText(avail)}）</span><input name="qty" type="number" inputmode="decimal" required step="0.000001" min="0.000001" max="${avail/1e6}"></label><button type="button" class="btn btn-sm btn-soft" data-fill="${avail/1e6}">全部</button>`,'提交卖出单',{cls:'form-inline'})}</details>`:'';
  return `<li class="row"><div class="row-main"><b>${esc(p.symbol)} <span class="muted">${esc(name(p.symbol))}</span></b><small>${meta(`${qtyText(p.qtyMicro)} 股`,`投入 ${money(p.costCents)}`,`买入价 ${priceWithCurrency(f.buyMilli,f.currency)}`,p.quote?`收盘价 ${priceWithCurrency(f.closeMilli,f.currency)}（${esc(p.quote.date)}）`:'暂缺收盘价')}</small></div><div class="row-side"><b class="num">${money(p.valueCents)}</b>${f.gain===null?'':gainLines(f)}</div>${sell}</li>`;
 },{label:'我的持仓',categories:[['HK','港股'],['US','美股']],category:p=>data.symbols.find(s=>s.symbol===p.symbol)?.market,time:false,order:false,empty:'还没有股票持仓'});
 return card('我的持仓','briefcase',rows);
}
// Shown when the planned session had no close and the order moved to the next one.
// Its own line: the target-date line does not wrap on narrow phones.
const rolledNote=o=>o.rolledFrom&&o.rolledFrom!==o.targetDate?`原定 ${esc(o.rolledFrom)} 休市或无收盘价，已顺延`:'';
function ordersCard(){
 const session={preopen:'开盘前',intraday:'盘中',afterclose:'收盘后',closed:'休市'};
 const rows=recordsList('orders',data.orders,o=>{
  const lines=[meta(`成交日 ${esc(o.targetDate)}`,o.side==='buy'?'预留 '+money(o.budgetCents):qtyText(o.qtyMicro)+' 股')];
  if(rolledNote(o))lines.push(rolledNote(o));
  if(o.status==='filled')lines.push(meta(`${esc(o.priceDate)} 收盘价 ${priceText(o.priceMilli)} 成交`,money(o.filledCents)));
  if(o.reason)lines.push(`<span class="neg">${esc(o.reason)}</span>`);
  return `<li class="row"><div class="row-main"><b>${o.side==='buy'?'买入':'卖出'} ${esc(o.symbol)}</b><small>${lines.join('<br>')}</small><small class="faint">下单 ${dateTime(o.submittedAt)}${o.targetSession?' · '+(session[o.targetSession]||''):''}</small></div><div class="row-side">${statusBadge('order',o.status)}${o.status==='pending'&&o.canCancel!==false?btn('stock.cancel','撤单',o.id,'danger'):''}</div></li>`;
 },{label:'股票订单',categories:recordStatusCategories('order'),empty:'还没有股票订单'});
 return card('股票订单','clock',rows);
}

/* ---------- 任务 ---------- */
function tasks(){
 const all=(data.tasks||[]).filter(t=>t.active),proposals=data.taskProposals||[],completions=data.taskCompletions||[];
 const earned=completions.filter(c=>c.status==='approved').reduce((n,c)=>n+c.amountCents,0);
 const waiting=completions.filter(c=>c.status==='pending').reduce((n,c)=>n+c.amountCents,0);
 const head=`${pageHead('任务赚钱','gift')}<div class="stats">${stat('累计奖励',money(earned))}${stat('待验收',money(waiting))}${stat('可做任务',all.length+' 项')}${stat('待批提议',proposals.filter(x=>x.status==='pending').length+' 项')}</div>`;
 if(role==='dad')return head+card('任务清单','list',recordsList('tasks',all,t=>`<li class="row"><div class="row-main"><b>${esc(t.name)}</b><small>每${esc(t.unit)} ${money(t.rewardCents)}</small></div></li>`,{label:'任务清单',filters:false,time:false,empty:'还没有任务'}),{right:`<button type="button" class="btn btn-sm btn-soft" data-tab="parent" data-go-sub="tasks">管理任务</button>`});
 const taskRows=recordsList('tasks',all,t=>`<li class="task"><div class="task-info"><b>${esc(t.name)}</b><small>每${esc(t.unit)} ${money(t.rewardCents)}</small></div><form class="task-form" data-op="task.complete" novalidate>${hiddenInput('id',t.id)}<div class="stepper"><button type="button" data-step="-1" aria-label="减少">−</button><input name="quantity" type="number" inputmode="numeric" required min="1" max="500" step="1" value="1" data-price="${t.rewardCents}" aria-label="完成了多少${esc(t.unit)}"><button type="button" data-step="1" aria-label="增加">+</button></div><span class="task-total num" data-total>= ${money(t.rewardCents)}</span><input class="input task-note" name="notes" type="text" maxlength="240" placeholder="备注（可选）"><button class="btn btn-primary btn-sm" type="submit">提交验收</button></form></li>`,{label:'任务清单',filters:false,time:false,listClass:'list tasks',empty:'暂时没有任务，可以向家长提议一个！'});
 const myProposals=recordsList('task-proposals',proposals,p=>`<li class="row"><div class="row-main"><b>${esc(p.name)}</b><small>每${esc(p.unit)} ${money(p.rewardCents)} · ${date(p.at)}${p.reason?' · '+esc(p.reason):''}</small></div>${statusBadge('proposal',p.status)}</li>`,{label:'我的提议',categories:recordStatusCategories('proposal'),empty:'还没有任务提议'});
 const records=recordsList('task-completions',completions,c=>`<li class="row">${ledgerIcon('task.earn')}<div class="row-main"><b>${esc(c.taskName)} × ${c.quantity}${esc(c.unit)}</b><small>${date(c.at)}${c.notes?' · '+esc(c.notes):''}</small></div><div class="row-side"><b class="num ${c.status==='approved'?'pos':''}">${money(c.amountCents)}</b>${statusBadge('completion',c.status)}</div></li>`,{label:'任务收入记录',categories:recordStatusCategories('completion'),empty:'还没有任务记录'});
 return `${head}<div class="cols cols-main">${card('任务清单','list',taskRows)}${card('提议新任务','plus',`${opForm('task.propose',`${field('name','做什么任务','text','required maxlength="80" placeholder="例如：整理书架"')}<div class="form-row">${field('unit','单位','text','required maxlength="24" placeholder="次 / 件 / 本"')}${moneyField('amount','每单位 O$','required max="10000"')}</div>${field('reason','理由','text','maxlength="240" placeholder="可选"')}`,'发给家长')}<h4 class="sub-h">我的提议</h4>${myProposals}`)}</div>${card('任务收入记录','receipt',records)}`;
}

/* ---------- 心愿 ---------- */
function wishes(){
 const renderWish=w=>{const {p}=wishProgress(w),state=wishState(w);return `<section class="card wish-card"><div class="wish">${art('wand')}<div class="wish-body"><div class="wish-top"><b class="wish-name">${esc(w.name)}</b><button type="button" class="icon-btn" data-act="wish.remove" data-id="${esc(w.id)}" aria-label="删除心愿 ${esc(w.name)}">${icon('trash')}</button></div><span class="badge ${state.tone}">${state.label}</span><small>目标 ${money(w.goalCents)}</small><div class="progress-row"><div class="progress"><i style="width:${p.toFixed(1)}%"></i></div><b class="num">${wishPercent(p)}</b></div><small>${state.description}</small>${wishAction(w,state)}</div></div></section>`;};
 const cards=recordsList('wishes',data.wishes,renderWish,{label:'心愿',categories:[['saving','攒钱中'],['ready','可购买'],['waiting','待家长确认'],['achieved','已实现'],['returning','退货处理中']],category:w=>wishState(w).key,date:w=>w.at,empty:'还没有心愿，先定一个小目标吧！',wrap:rows=>`<div class="wish-grid">${rows}</div>`});
 return `${pageHead('我的心愿','star')}<section class="card">${opForm('wish.add',`${field('name','想要什么','text','required maxlength="100" placeholder="例如：鞋 / LEGO 城堡"')}${moneyField('amount','需要多少 O$','required')}`,'添加心愿',{cls:'form-inline wish-form'})}</section><div class="spaced wish-records">${cards}</div>`;
}

/* ---------- 交易记录 ---------- */
function history(){
 const categories=[['cash','存入零花钱'],['purchase','购买与退款'],['stock','股票买卖'],['task','任务奖励'],['fixed','定期存款'],['loan','借款与还款'],['other','其他']];
 const category=x=>{const group=String(x.type||'').split('.')[0];return group==='deposit'?'cash':categories.some(([key])=>key===group)?group:'other';};
 const rows=recordsList('ledger',data.ledger,l=>`<li class="row">${ledgerIcon(l.type)}<div class="row-main"><b>${esc(ledgerText(l))}</b><small>${dateTime(l.at)}</small></div><div class="row-side"><b class="num ${l.deltaCents>=0?'pos':'neg'}">${signedMoney(l.deltaCents)}</b><small class="num">余额 ${money(l.cashAfterCents)}</small></div></li>`,{label:'现金流水',categories,category,empty:'还没有交易记录'});
 return `${pageHead('交易记录','receipt')}${card('现金流水','list',rows)}`;
}

/* ---------- 家长后台 ---------- */
function parentPage(){
 if(role!=='dad')return empty('只有家长可以查看');
 const s=data.summary,n=pendingCount();
 return `${pageHead('家长后台','sliders')}
 <div class="stats">${stat('总资产',money(s.assetsCents))}${stat('净资产',money(s.netWorthCents))}${stat('借款本金',money(s.loanPrincipalCents))}${stat('待处理',n+' 项',n?'pinktext':'')}</div>
 ${seg('parent',[['inbox',`待处理${n?` <em class="count">${n}</em>`:''}`],['money','资金'],['tasks','任务'],['stocks','股票'],['settings','设置']])}
 <div class="panel" id="parent-inbox" data-panel="parent:inbox"${hid('parent','inbox')}>${parentInbox()}</div>
 <div class="panel" id="parent-money" data-panel="parent:money"${hid('parent','money')}>${parentMoney()}</div>
 <div class="panel" id="parent-tasks" data-panel="parent:tasks"${hid('parent','tasks')}>${parentTasks()}</div>
 <div class="panel" id="parent-stocks" data-panel="parent:stocks"${hid('parent','stocks')}>${parentStocks()}</div>
 <div class="panel" id="parent-settings" data-panel="parent:settings"${hid('parent','settings')}>${parentSettings()}</div>`;
}
function parentInbox(){
 const pr=data.purchaseRequests,purchases=pr.filter(x=>x.status==='pending'),returns=pr.filter(x=>x.status==='return_pending'),loans=data.loans.filter(x=>x.status==='pending'),props=(data.taskProposals||[]).filter(x=>x.status==='pending'),comps=(data.taskCompletions||[]).filter(x=>x.status==='pending');
 const link=r=>r.link?` · <a href="${esc(/^https?:\/\//i.test(r.link)?r.link:'#')}" target="_blank" rel="noopener noreferrer">商品链接</a>`:'';
 const blocks=[];
 if(purchases.length)blocks.push(card('购物确认','bag',recordsList('inbox-purchases',purchases,r=>`<li class="row"><div class="row-main"><b>${esc(r.name)}</b><small>${date(r.at)}${r.note?' · '+esc(r.note):''}${link(r)}${r.reservedCents?' · 已预留 '+money(r.reservedCents):''}</small></div><div class="row-side"><b class="num">${money(r.amountCents)}</b></div><div class="row-actions">${btn('purchase.approve','确认购买并交付（扣款）',r.id,'primary')}${btn('purchase.reject','拒绝',r.id,'danger')}</div></li>`,{label:'购物确认'}),{right:'<span class="hint">买好交给她后点一次</span>'}));
 if(returns.length)blocks.push(card('退款申请','undo',recordsList('inbox-returns',returns,x=>`<li class="row"><div class="row-main"><b>${esc(x.name)}</b><small>${x.returnReason?'原因：'+esc(x.returnReason):'未填写原因'}</small></div><div class="row-side"><b class="num">${money(x.approvedCents)}</b></div><div class="row-actions">${btn('purchase.refund','同意退款',x.id,'primary')}${btn('purchase.return.reject','拒绝退款',x.id,'danger')}</div></li>`,{label:'退款申请',date:x=>x.returnRequestedAt||x.at})));
 if(loans.length)blocks.push(card('借款审批','coins',recordsList('inbox-loans',loans,l=>`<li class="row"><div class="row-main"><b>借款申请</b><small>${date(l.createdAt)} · 年息 ${pct(l.aprBps)}</small></div><div class="row-side"><b class="num">${money(l.requestedCents)}</b></div><div class="row-actions">${btn('loan.approve','批准',l.id,'primary')}${btn('loan.reject','拒绝',l.id,'danger')}</div></li>`,{label:'借款审批'}),{right:`<span class="hint">借款总额度 ${money(data.settings.loanLimitCents??50000)}</span>`}));
 if(props.length)blocks.push(card('任务提议','gift',recordsList('inbox-proposals',props,p=>`<li class="row"><div class="row-main"><b>${esc(p.name)}</b><small>每${esc(p.unit)} ${money(p.rewardCents)}${p.reason?' · '+esc(p.reason):''}</small></div><div class="row-actions">${btn('task.proposal.approve','批准并加入任务',p.id,'primary')}${btn('task.proposal.reject','拒绝',p.id,'danger')}</div></li>`,{label:'任务提议'})));
 if(comps.length)blocks.push(card('任务验收','check',recordsList('inbox-completions',comps,c=>`<li class="row"><div class="row-main"><b>${esc(c.taskName)} × ${c.quantity}${esc(c.unit)}</b><small>每${esc(c.unit)} ${money(c.unitRewardCents)}${c.notes?' · '+esc(c.notes):''}</small></div><div class="row-side"><b class="num">${money(c.amountCents)}</b></div><div class="row-actions">${btn('task.completion.approve','验收通过并发钱',c.id,'primary')}${btn('task.completion.reject','未完成',c.id,'danger')}</div></li>`,{label:'任务验收'})));
 return blocks.length?`<div class="cols even">${blocks.join('')}</div>`:empty('没有待处理的事项');
}
function parentMoney(){
 const bought=data.purchaseRequests.filter(x=>['approved','delivered'].includes(x.status));
 return `<div class="cols">${card('直接入账','piggy',opForm('cash.grant',`${moneyField('amount','金额 O$','required')}${field('note','备注','text','maxlength="200" placeholder="例如：零花钱 / 生日红包"')}`,'存入 Olivia 的活期',{foot:'<p class="hint">只在已收到或准备好对应现金时入账。</p>'}))}${card('已购买订单','bag',recordsList('parent-purchases',bought,x=>`<li class="row"><div class="row-main"><b>${esc(x.name)}</b><small>${date(x.deliveredAt||x.reviewAt||x.at)} · ${esc(purchaseReturnInfo(x))}</small></div><div class="row-side"><b class="num">${money(x.approvedCents)}</b></div></li>`,{label:'已购买订单',date:x=>x.deliveredAt||x.reviewAt||x.at,empty:'暂无已购买订单'}))}</div>`;
}
function parentTasks(){
 const all=data.tasks||[];
 const editor=t=>`<li class="row task-edit"><details class="inline grow"><summary class="edit-sum"><span class="row-main"><b>${esc(t.name)}</b><small>每${esc(t.unit)} ${money(t.rewardCents)}</small></span>${t.active?'<span class="badge ok">开放</span>':'<span class="badge info">已暂停</span>'}${icon('chevDown','chev')}</summary>${opForm('task.update',`${hiddenInput('id',t.id)}<div class="form-row">${field('name','任务名称','text',`required maxlength="80" value="${esc(t.name)}"`)}${field('unit','单位','text',`required maxlength="24" value="${esc(t.unit)}"`)}</div><div class="form-row">${field('amount','每单位奖励 O$','number',`inputmode="decimal" required min="0.1" max="10000" step="0.1" value="${t.rewardCents/100}"`)}<label class="field"><span>状态</span><select name="active"><option value="true"${t.active?' selected':''}>开放</option><option value="false"${t.active?'':' selected'}>暂停</option></select></label></div>`,'保存修改')}</details></li>`;
 return `<div class="cols">${card('新增任务','plus',opForm('task.create',`${field('name','任务名称','text','required maxlength="80" placeholder="例如：叠衬衫"')}<div class="form-row">${field('unit','单位','text','required maxlength="24" placeholder="件 / 次 / 本"')}${moneyField('amount','每单位奖励 O$','required max="10000"')}</div>`,'添加任务',{foot:'<p class="hint">改价不影响已提交的记录。</p>'}))}${card('现有任务','list',recordsList('parent-tasks',all,editor,{label:'现有任务',categories:[['active','开放'],['paused','已暂停']],category:t=>t.active?'active':'paused',empty:'还没有任务'}))}</div>`;
}
// Order target dates are exchange-local trading days. After midnight in Hong Kong a US
// session is still running, so "overdue" must be judged on that exchange's own calendar.
const EXCHANGE_ZONES={HK:'Asia/Hong_Kong',US:'America/New_York'};
function exchangeToday(market){
 const zone=EXCHANGE_ZONES[market];if(!zone)return todayLocal();
 try{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
 catch{return todayLocal();}
}
function parentStocks(){
 const pending=data.orders.filter(x=>x.status==='pending'),today=todayLocal();
 const sessionPassed=o=>o.targetDate<exchangeToday(data.symbols.find(s=>s.symbol===o.symbol)?.market);
 const canCancel=o=>typeof o.canParentCancel==='boolean'?o.canParentCancel:sessionPassed(o);
 // Manual closes are entered oldest first: a later close also settles earlier
 // orders that have none, so start the form at the earliest overdue session.
 const overdue=pending.filter(canCancel).sort((a,b)=>a.targetDate.localeCompare(b.targetDate))[0];
 const quoteForm=opForm('quote.set',`<label class="field"><span>股票</span><select name="symbol">${data.symbols.filter(s=>s.tradable).map(s=>`<option value="${esc(s.symbol)}"${s.symbol===overdue?.symbol?' selected':''}>${esc(s.symbol)} · ${esc(s.name)}</option>`).join('')}</select></label><div class="form-row">${field('date','交易日','date',`required value="${esc(overdue?.targetDate||today)}"`)}${field('price','收盘价（原币）','number','inputmode="decimal" required step="0.001" min="0.001"')}</div>`,'手动登记收盘价',{foot:'<p class="hint">只在 Yahoo 长时间抓取失败时使用，并从最早缺价的交易日开始逐日登记：登记较晚日期后，更早缺价的订单会按这个较晚的收盘价成交。</p>'});
 const rows=recordsList('parent-orders',pending,o=>`<li class="row"><div class="row-main"><b>${o.side==='buy'?'买入':'卖出'} ${esc(o.symbol)}</b><small>目标交易日 ${esc(o.targetDate)} · ${o.side==='buy'?'预留 '+money(o.budgetCents):qtyText(o.qtyMicro)+' 股'}</small>${rolledNote(o)?`<small>${rolledNote(o)}</small>`:''}${o.reason?`<small class="neg">${esc(o.reason)}</small>`:''}</div>${o.scheduleBasis!=='session-close-v1.2'||canCancel(o)?`<div class="row-actions">${o.scheduleBasis==='session-close-v1.2'?'':btn('order.retarget','按原提交时间重算',o.id)}${canCancel(o)?btn('order.cancel','撤销订单',o.id,'danger'):''}</div>`:''}</li>`,{label:'待成交订单',categories:[['buy','买入'],['sell','卖出']],category:o=>o.side,empty:'没有待成交订单'});
 return `<div class="cols">${card('行情与结算','refresh',`<div class="btn-row">${btn('quote.refresh','抓取日线并结算',null,'primary')}${btn('maintenance.run','只运行计息 / 到期',null)}</div><p class="hint">Yahoo 为非官方接口；收盘 1 小时后才确认当日收盘价。正式网站每天 17:30、06:30（香港时间）自动抓取并结算。</p><hr class="sep">${quoteForm}`)}${card('待成交订单','clock',`${rows}${pending.length?'<p class="hint">成交日没有收盘价（休市或停牌）时，一旦之后出现收盘价，订单自动按之后第一个收盘价成交。股票退市或长期停牌、一直没有收盘价时，可在成交日过后撤销订单。</p>':''}`)}</div>`;
}
function parentSettings(){
 const r=data.settings.fixedRates;
 const rate=(name,label,bps)=>field(name,label,'number',`inputmode="decimal" required min="0" max="100" step="0.01" value="${bps/100}"`);
 const borrowing=field('loanLimit','Olivia 借款总额度 O$','number',`inputmode="decimal" required min="0" max="99999999.99" step="0.01" value="${(data.settings.loanLimitCents??50000)/100}"`);
 return `<div class="cols even">${card('利率与借款额度','percent',opForm('settings.update',`<div class="form-row">${rate('rate3','3个月定期',r[3])}${rate('rate6','6个月定期',r[6])}</div><div class="form-row">${rate('rate12','12个月定期',r[12])}${rate('loanAPR','借款年息 %',data.settings.loanAprBps)}</div>${borrowing}<p class="hint">默认 O$ 500.0；设为 0 暂停新增借款。未还本金与待批申请共用额度。</p>`,'保存设置',{foot:'<p class="hint">利率影响之后的新定期和新借款申请；额度调整不改变已有欠款，降低额度后超额的待批借款无法批准。</p>'}))}<div class="stack">${card('Olivia 的 PIN','lock',opForm('pin.change',field('pin','新 PIN（6–10 位数字）','password','required pattern="[0-9]{6,10}" inputmode="numeric" autocomplete="new-password"'),'更新 PIN'))}${card('家长密码','lock',opForm('password.change',`${field('oldPassword','旧密码','password','required autocomplete="current-password"')}${field('newPassword','新密码（至少 12 位）','password','required minlength="12" autocomplete="new-password"')}`,'更改密码'))}</div></div>`;
}

/* ---------- avatar ---------- */
async function imageToAvatar(file){
 if(!file)throw Error('请选择一张图片');
 if(!file.type.startsWith('image/'))throw Error('请选择照片文件');
 if(file.size>10*1024*1024)throw Error('图片原文件不能超过10MB');
 const objectUrl=URL.createObjectURL(file);
 try{
  const image=await new Promise((resolve,reject)=>{const item=new Image();item.onload=()=>resolve(item);item.onerror=()=>reject(Error('无法读取图片，请改用 JPG 或 PNG 照片'));item.src=objectUrl;});
  if(!image.naturalWidth||!image.naturalHeight)throw Error('图片内容无效');
  const side=Math.min(image.naturalWidth,image.naturalHeight),x=(image.naturalWidth-side)/2,y=(image.naturalHeight-side)/2;
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
  const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('此浏览器无法处理图片');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,256,256);ctx.drawImage(image,x,y,side,side,0,0,256,256);
  const jpg=canvas.toDataURL('image/jpeg',0.84);
  if(!jpg.startsWith('data:image/jpeg;base64,')||jpg.length>270000)throw Error('头像转换失败或图片过大');
  return jpg;
 }finally{URL.revokeObjectURL(objectUrl);}
}

/* ---------- interactions ---------- */
function refreshSearchResults(){const el=document.getElementById('stock-search-results');if(el)el.innerHTML=searchResultsHtml();}
function onSearchInput(el){
 stockSearchTerm=el.value.trim();stockSearchResults=[];stockSearchError='';stockSearchWarning='';stockSearchOffline=false;stockSearchBusy=!!stockSearchTerm;refreshSearchResults();
 clearTimeout(stockSearchTimer);if(!stockSearchTerm)return;
 const term=stockSearchTerm;
 stockSearchTimer=setTimeout(async()=>{
  try{const r=await req('/api/stocks/search?q='+encodeURIComponent(term));if(term!==stockSearchTerm)return;stockSearchResults=r.results||[];stockSearchOffline=!!r.offline;stockSearchWarning=r.warning||'';}
  catch(err){if(term!==stockSearchTerm)return;stockSearchError=err.message;}
  finally{if(term===stockSearchTerm){stockSearchBusy=false;refreshSearchResults();}}
 },350);
}
// Pagination keeps only editable, non-secret fields in memory while its own list
// is replaced. Identity fields are read for matching, never restored as inputs.
function formDraftKey(form){
 const op=form.dataset?.op;
 if(!op||['setup','login','pin.change','password.change'].includes(op))return null;
 return JSON.stringify([op,form.querySelector('[name="id"]')?.value||'',form.querySelector('[name="symbol"]')?.value||'',form.id||'']);
}
function formDraftFields(form){
 return [...form.querySelectorAll('input[name],select[name],textarea[name]')].filter(el=>!el.disabled&&!['hidden','password','file','submit','button','reset'].includes(el.type)&&!/(?:password|current-password|new-password|one-time-code)/i.test(el.autocomplete||''));
}
function captureFormDrafts(container,drafts=new Map()){
 for(const form of container.querySelectorAll('form[data-op]')){
  const key=formDraftKey(form);if(key===null)continue;
  const fields=formDraftFields(form).map(el=>({name:el.name,type:el.type,value:el.value,checked:!!el.checked,selected:el.multiple?[...el.options].filter(o=>o.selected).map(o=>o.value):null}));
  drafts.set(key,{fields,open:!!form.closest('details')?.open});
 }
 return drafts;
}
function restoreFormDrafts(container,drafts){
 for(const form of container.querySelectorAll('form[data-op]')){
  const draft=drafts.get(formDraftKey(form));if(!draft)continue;
  const fields=formDraftFields(form);
  fields.forEach((el,i)=>{
   const saved=draft.fields[i];if(!saved||saved.name!==el.name||saved.type!==el.type)return;
   if(el.type==='checkbox'||el.type==='radio')el.checked=saved.checked;
   else if(el.multiple&&saved.selected)for(const option of el.options)option.selected=saved.selected.includes(option.value);
   else el.value=saved.value;
   if(el.name==='quantity'&&el.dataset?.price)updateTaskTotal(el);
  });
  const disclosure=form.closest('details');if(disclosure)disclosure.open=draft.open;
 }
}
// Recheck after awaiting: a child may start typing while this request is in
// flight, or another action may already have installed a newer state.
function editingForm(){
 const active=document.activeElement;
 return formDirty||!!active?.closest?.('form[data-op]')||active?.id==='stock-search-field';
}
async function refreshWhenIdle(){
 const idle=()=>document.visibilityState==='visible'&&role&&data&&!busy&&!editingForm()&&!notificationReadPending&&!root.querySelector?.('details.notifications[open]');
 if(!idle())return;
 const startRole=role,startData=data,startTab=tab,startSub=sub[tab];
 try{
  const fresh=await req(statePath());
  if(!idle()||role!==startRole||data!==startData||tab!==startTab||sub[tab]!==startSub)return;
  if(fresh.unchanged)return keepUnchangedState();
  data=fresh;pendingStateRefresh=null;render();
 }catch{/* Keep the current page if the network is unavailable. */}
}
function updateTaskTotal(input){const out=input.closest('form')?.querySelector('[data-total]');if(!out)return;const q=Number(input.value);out.textContent=Number.isInteger(q)&&q>=1&&q<=500?'= '+money(q*Number(input.dataset.price)):'= —';}
function stepQty(b){const input=b.parentElement.querySelector('input');input.value=String(Math.min(500,Math.max(1,(parseInt(input.value,10)||0)+Number(b.dataset.step))));updateTaskTotal(input);formDirty=true;}
async function selectForBuy(symbol){
 // Registering re-verifies exchange/currency on the server; only HK (HKD) and US (USD) are tradable.
 const requestRole=role,version=++buySelectionVersion;
 selectedSymbol=symbol;
 pendingBuySelection=buySecurity(symbol)?null:{symbol,role:requestRole,error:''};
 if(tab!=='stocks'){tab='stocks';writeHash();}
 render();
 if(pendingBuySelection){
  try{await runAction('security.register',{symbol});}
  catch(err){
   if(version===buySelectionVersion&&role===requestRole&&pendingBuySelection){pendingBuySelection.error=err.message;render();}
   throw err;
  }
 }
 if(version!==buySelectionVersion||role!==requestRole)return;
 reconcileBuySelection();
 if(pendingBuySelection){render();return;}
 stockSearchTerm='';stockSearchResults=[];stockSearchOffline=false;stockSearchWarning='';
 render();
 const buy=document.getElementById('buy');
 if(buy){buy.scrollIntoView?.({behavior:'smooth',block:'center'});buy.classList.add('flash');setTimeout(()=>buy.classList.remove('flash'),1200);}
}
const CONFIRM={'fixed.redeem':'提前取出只拿回本金，没有利息。确定吗？','purchase.approve':'确认已经买好并交给 Olivia？将从她的活期扣款。','purchase.refund':'同意这次退款申请，并将全部购买金额退回 Olivia 的活期账户？','purchase.return.reject':'拒绝这次退款申请？每笔订单只能申请一次，拒绝后不能重新申请。','purchase.reject':'拒绝这个购买申请？','loan.reject':'拒绝这笔借款申请？','loan.payoff':'按今天的利息全部还清这笔借款？','wish.remove':'删除这个心愿？','order.roll':'仅在交易所临时休市时使用：把这笔订单顺延到下一交易日。确定吗？','order.cancel':'撤销这笔订单？只用于退市或长期停牌、一直没有收盘价的订单。买单预留的资金会退回 Olivia 的活期，她会收到通知。','task.completion.approve':'验收通过，把奖励存入 Olivia 的活期？','task.completion.reject':'这次任务验收不通过？','task.proposal.reject':'拒绝这个任务提议？','stock.cancel':'确定撤单吗？买单冻结的资金会退回。'};
const SUBMIT_CONFIRM={'loan.repay':'确定还款吗？','purchase.return.request':'每笔订单只能申请一次退款，提交后不能撤回。确定提交？'};

root.addEventListener('click',async e=>{
 const t=e.target.closest('[data-tab],[data-seg],[data-login-role],[data-logout],[data-act],[data-watch-symbol],[data-buy-symbol],[data-watch-remove],[data-eye],[data-step],[data-fill],[data-notice-toggle],[data-notice-go],[data-purchase-record],[data-refresh-state]');
 if(!t)return;
 if(t.hasAttribute('data-notice-toggle')){
  // Native <details> opens without rerendering; reading a notification must never erase form input.
  if(!t.closest('details.notifications')?.open)void markNotificationsRead();
  return;
 }
 if(t.dataset.noticeGo){go(t.dataset.noticeGo,t.dataset.noticeSub);return;}
 if(t.dataset.step){stepQty(t);return;}
 if(t.dataset.fill!==undefined){const input=t.closest('form')?.querySelector('input[name="qty"]');if(input){input.value=t.dataset.fill;formDirty=true;}return;}
 if(t.dataset.seg){switchSub(t.dataset.seg,t.dataset.sub);return;}
 if(t.hasAttribute('data-eye')){hideBalance=!hideBalance;writePref('hideBalance',hideBalance?'1':'0');render();return;}
 if(busy)return;
 if(t.dataset.purchaseRecord){openPurchaseRecord(t.dataset.purchaseRecord);return;}
 if(t.dataset.tab){go(t.dataset.tab,t.dataset.goSub);return;}
 if(t.dataset.loginRole){loginRole=t.dataset.loginRole;render();return;}
 busy=true;
 try{
  if(t.hasAttribute('data-refresh-state')){await refreshConfirmedState();return;}
  if(t.hasAttribute('data-logout')){authGeneration++;await req('/api/logout','POST',{});role=null;data=null;pendingStateRefresh=null;resetBuySelection();clearActionRetryKeys();loginRole='kid';tab='home';render();return;}
  if(t.dataset.buySymbol){await selectForBuy(t.dataset.buySymbol);return;}
  if(t.dataset.watchSymbol){await runAction('watch.add',{symbol:t.dataset.watchSymbol});return;}
  if(t.dataset.watchRemove){await runAction('watch.remove',{symbol:t.dataset.watchRemove});return;}
  const key=t.dataset.act;let action=key;const payload=t.dataset.id?{id:t.dataset.id}:{};
  if(key==='loan.payoff'){action='loan.repay';payload.all=true;}
  if(key==='order.roll')payload.confirmExceptionalClosure=true;
  const confirmation=key==='fixed.redeem'&&fixedAtMaturity(data.fixed.find(f=>f.id===payload.id))?'这笔定期已到期，本金和利息将转回活期。确定取回吗？':CONFIRM[key];
  if(confirmation&&!confirm(confirmation))return;
  await runAction(action,payload);
 }catch(err){toast(err.message,true);}finally{busy=false;}
});
root.addEventListener('submit',async e=>{
 const form=e.target.closest('form[data-op]');if(!form)return;
 e.preventDefault(); // always: a second submit while busy must never fall back to a native GET (it would put the PIN in the URL)
 if(busy)return;
 if(!validateFormInChinese(form))return;
 const action=form.dataset.op,payload=Object.fromEntries(new FormData(form).entries());
 if(SUBMIT_CONFIRM[action]&&!confirm(SUBMIT_CONFIRM[action]))return;
 busy=true;const button=form.querySelector('button[type="submit"]');if(button)button.disabled=true;
 try{
  if(action==='setup'){await req('/api/setup','POST',{token:payload.token,password:payload.password,pin:payload.pin});initialized=true;loginRole='dad';render();toast('银行已创建，请用家长密码登录');}
  else if(action==='login'){authGeneration++;const r=await req('/api/login','POST',payload);resetBuySelection();role=r.role;tab=role==='dad'?'parent':'home';sub.parent='inbox';await boot();writeHash(true);toast(`欢迎回来，${role==='dad'?'家长':'Olivia'}！`);}
  else await runAction(action,payload);
 }catch(err){toast(err.message,true);}
 finally{busy=false;if(button?.isConnected)button.disabled=false;}
});
root.addEventListener('invalid',e=>{localizeFieldValidity(e.target);},true);
root.addEventListener('input',e=>{
 const el=e.target;
 clearFieldValidity(el);
 if(el.id==='stock-search-field'){onSearchInput(el);return;}
 if(el.name==='quantity'&&el.dataset.price)updateTaskTotal(el);
 if(el.closest?.('form[data-op]'))formDirty=true;
});
root.addEventListener('change',async e=>{
 clearFieldValidity(e.target);
 if(e.target.closest?.('form[data-op]'))formDirty=true;
 if(e.target.id==='buy-symbol'){chooseBuySymbol(e.target.value);const q=document.getElementById('buy-quote');if(q)q.innerHTML=buyQuote(data.symbols.find(x=>x.symbol===selectedSymbol));return;}
 if(e.target.id!=='kid-avatar-file')return;
 const input=e.target,file=input.files?.[0];if(!file||busy)return;
 busy=true;input.disabled=true;
 try{const imageData=await imageToAvatar(file);await runAction('profile.avatar.set',{imageData});}
 catch(err){toast(err.message,true);}
 finally{busy=false;if(input.isConnected){input.disabled=false;input.value='';}}
});
if(typeof document.addEventListener==='function'){
 // Close the account menu when tapping elsewhere; Esc closes any open disclosure.
 document.addEventListener('click',e=>{root.querySelectorAll('details.user[open],details.notifications[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;});});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')root.querySelectorAll('details.user[open],details.notifications[open]').forEach(d=>{d.open=false;});});
 // Coming back to the tab (e.g. after Dad approved on his phone): reload balances unless a form is being filled in.
 document.addEventListener('visibilitychange',()=>{void refreshWhenIdle();});
 // Refresh child decisions and the parent's inbox every 30 seconds while idle.
 // A form edited while the request is in flight always wins over the background refresh.
 if(typeof globalThis.setInterval==='function')globalThis.setInterval(async()=>{
  const idle=()=>role&&data&&!busy&&!editingForm()&&!notificationReadPending&&document.visibilityState!=='hidden'&&!root.querySelector?.('details.notifications[open]');
  if(!idle())return;
  const startData=data,startRole=role;
  try{
   const fresh=await req(statePath());
   if(!idle()||role!==startRole||data!==startData)return;
   if(fresh.unchanged)return keepUnchangedState();
   // A task, interest rate, watchlist quote or order can change without changing
   // balances or notifications. Compare the full public view so every page updates.
   const changed=!!pendingStateRefresh||JSON.stringify(data)!==JSON.stringify(fresh);
   data=fresh;pendingStateRefresh=null;if(changed)render();
  }catch{/* Offline: show cached data; try again later. */}
 },30000);
}
if(typeof globalThis.addEventListener==='function')globalThis.addEventListener('hashchange',()=>{
 if(!role||!data)return;
 const before=tab+'/'+(sub[tab]||'');applyHash();
 if(before!==tab+'/'+(sub[tab]||'')){render();scrollTop();}
});
boot();
