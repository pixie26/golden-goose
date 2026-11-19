import { randomUUID, scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { orderTarget, orderCanCancel, closeIsFinal, tradingDay, nextMarketDay, validMarketDate as validDate } from './market.mjs';

const DAY_MS = 86400000;
const SYMBOLS = [
  {symbol:'0700.HK', name:'腾讯控股', market:'HK', currency:'HKD'},
  {symbol:'9988.HK', name:'阿里巴巴', market:'HK', currency:'HKD'},
  {symbol:'2800.HK', name:'盈富基金', market:'HK', currency:'HKD'},
  {symbol:'AAPL', name:'Apple 苹果', market:'US', currency:'USD'},
  {symbol:'MSFT', name:'Microsoft 微软', market:'US', currency:'USD'},
  {symbol:'DIS', name:'Disney 迪士尼', market:'US', currency:'USD'},
  {symbol:'VOO', name:'Vanguard S&P 500 ETF', market:'US', currency:'USD'},
];
export { SYMBOLS };
// Yahoo quote units are case-sensitive: GBp is pence, while GBP is pounds.
// Preserve the provider's unit without changing the numerical price series.
export function quoteCurrency(value){const raw=String(value||'').trim();return raw==='GBp'||raw==='ZAc'?raw:raw.toUpperCase();}
export function quoteCurrencyMatches(security,value){
 const actual=quoteCurrency(value),expected=quoteCurrency(security.currency);
 if(!actual||!expected||actual===expected)return true;
 // Before V2.0.3, registration uppercased these units. An authoritative refresh
 // can repair that label once; subsequently, a unit change is an identity error.
 return security.market==='OTHER'&&!security.quoteUnitVerified&&((expected==='GBP'&&actual==='GBp')||(expected==='ZAC'&&actual==='ZAc'));
}
// PostgreSQL jsonb rejects NUL and unpaired UTF-16 surrogates. One such character
// (or an emoji cut in half by the length limit) would fail the whole ledger write
// and surface as "database unavailable", so stored text is normalized first.
const UNPAIRED_SURROGATE=/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const storableText=v=>String(v??'').replace(/\u0000/g,'').replace(UNPAIRED_SURROGATE,'');
const clampText=(v,max=200)=>storableText(storableText(v).trim().slice(0,max)).trim();
export const cents=(v)=>{ const s=String(v??'').trim();if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(s))throw Error('请输入正确金额（最多两位小数）');const [a,b='']=s.split('.'); const n=Number(a)*100+Number((b+'00').slice(0,2));if(!Number.isSafeInteger(n)||n<=0)throw Error('金额必须大于零');return n;};
const validCents=(n)=>Number.isSafeInteger(n)&&n>=0;
const must=(v,msg)=>{if(!v)throw Error(msg);};
const dateISO=(at=new Date())=>new Date(at).toISOString().slice(0,10);
// Keep fractional-share arithmetic exact before converting back to integer cents.
// Cash out is rounded down and cash in is rounded up, so splitting a trade into
// tiny orders cannot create money through repeated half-cent rounding.
function integerRatio(factors,denominator,rounding='nearest'){
  must(factors.every(validCents)&&Number.isSafeInteger(denominator)&&denominator>0,'交易金额或股数精度不正确');
  const product=factors.reduce((n,value)=>n*BigInt(value),1n),divisor=BigInt(denominator);
  const result=rounding==='up'?(product+divisor-1n)/divisor:rounding==='down'?product/divisor:(product+divisor/2n)/divisor;
  must(result<=BigInt(Number.MAX_SAFE_INTEGER),'交易金额或股数超出安全范围');
  return Number(result);
}
const dateInZone=(date,zone)=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(date));const by=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${by.year}-${by.month}-${by.day}`;};
// V1.9.9: fixed-deposit and loan calendar days follow the family's Hong Kong
// calendar. A UTC date booked 00:00–08:00 HKT as the previous day, so a deposit
// opened that morning showed yesterday's start date and matured a day early.
export const BANK_TIME_ZONE='Asia/Hong_Kong';
export const bankDate=(at=new Date())=>dateInZone(at,BANK_TIME_ZONE);
export function nextWeekday(date){let d=new Date(date+'T12:00:00Z');do{d=new Date(d.getTime()+DAY_MS);}while([0,6].includes(d.getUTCDay()));return d.toISOString().slice(0,10);}
function nextTarget(s,symbol,at){return orderTarget(getSymbol(s,symbol).market,at);}
function addMonths(date,n){const d=new Date(date+'T00:00:00Z'), day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.toISOString().slice(0,10);}
function diffDays(a,b){return Math.max(0,Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/DAY_MS));}
function depositInterest(principal,bps,start,end){return Math.round(principal*bps*diffDays(start,end)/3650000);}
// Never accept SVG/HTML in user-uploaded avatars. The browser crops/resizes to JPEG;
// validate actual JPEG structure and square dimensions again on the server.
export function validateKidAvatar(value){
  must(typeof value==='string','请选择 JPG 或 PNG 图片');
  const prefix='data:image/jpeg;base64,';
  must(value.startsWith(prefix),'头像只能保存为 JPG 图片');
  const raw=value.slice(prefix.length);
  must(raw.length>=64&&raw.length<=270000&&raw.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(raw),'头像数据不正确或过大');
  const bytes=Buffer.from(raw,'base64');
  must(bytes.length>=100&&bytes.length<=192*1024&&bytes.toString('base64')===raw,'头像不能超过192KB');
  must(bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9,'头像不是有效的 JPEG 文件');
  let cursor=2,dimensions=null;
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while(cursor+4<=bytes.length){
    if(bytes[cursor]!==0xff)break;
    while(bytes[cursor]===0xff)cursor++;
    const marker=bytes[cursor++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    must(cursor+2<=bytes.length,'JPEG文件不完整');
    const length=bytes.readUInt16BE(cursor);
    must(length>=2&&cursor+length<=bytes.length,'JPEG文件不完整');
    if(sof.has(marker)){
      must(length>=7,'头像格式错误');
      dimensions={height:bytes.readUInt16BE(cursor+3),width:bytes.readUInt16BE(cursor+5)};
    }
    cursor+=length;
  }
  must(dimensions&&dimensions.width===dimensions.height&&dimensions.width>=64&&dimensions.width<=512,'头像必须是正方形，尺寸不超过512像素');
  return prefix+raw;
}
const hashSecret=(str)=>{const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${scryptSync(str,salt,64).toString('hex')}`;};
export function checkSecret(str,stored){if(!stored||typeof stored!=='string')return false;const a=stored.split('$');if(a.length!==3||a[0]!=='scrypt')return false;const actual=scryptSync(String(str),a[1],64),known=Buffer.from(a[2],'hex');return known.length===actual.length&&timingSafeEqual(actual,known);}
export const secretHash=(token)=>createHash('sha256').update(token).digest('hex');
export function initialState(){return {schema:2,securities:Object.fromEntries(SYMBOLS.map(x=>[x.symbol,{...x,quoteType:x.symbol==='VOO'||x.symbol==='2800.HK'?'ETF':'EQUITY',tradable:true}])),watchlist:[],notifications:[],priceHistory:{},tasks:[],taskProposals:[],taskCompletions:[],createdAt:new Date().toISOString(),dadHash:null,kidHash:null,profile:{kidAvatarData:null},settings:{fixedRates:{3:500,6:800,12:1000},loanAprBps:2500,loanLimitCents:50000,usdToO:8},cashCents:0,reservedCents:0,fixed:[],loans:[],depositRequests:[],purchaseRequests:[],orders:[],positions:[],quotes:{},wishes:[],ledger:[],audit:[],sessions:[],authLocks:{},processed:[]};}
const id=()=>randomUUID();
function audit(s,role,type,summary=''){s.audit.unshift({id:id(),at:new Date().toISOString(),role,type,summary:clampText(summary)});}
// Parent decisions create durable, Olivia-only in-app notifications in the same database transaction.
// Existing V1.9.1 accounts without this field remain fully compatible.
const notifyMoney=cents=>'O$ '+(Number(cents||0)/100).toLocaleString('en-HK',{minimumFractionDigits:1,maximumFractionDigits:1});
// A remaining allowance is a cap: show it rounded down so the one-decimal text never exceeds what is accepted.
// Loans are borrowed and repaid in O$0.1 units (one display decimal); see loan.request and loan.repay.
const LOAN_UNIT_CENTS=10;
const notifyMoneyFloor=cents=>notifyMoney(Math.floor(Math.max(0,Number(cents)||0)/10)*10);
function notifyKid(s,title,detail,tone='info',target='account',sub=''){
  s.notifications??=[];
  s.notifications.unshift({id:id(),recipient:'kid',title:clampText(title,90),detail:clampText(detail,240),tone,at:new Date().toISOString(),readAt:null,target,sub});
  s.notifications=s.notifications.slice(0,120);
}

function ledger(s,type,delta,description){must(Number.isSafeInteger(delta)&&validCents(s.cashCents+delta),'余额出现错误');s.cashCents+=delta;s.ledger.unshift({id:id(),at:new Date().toISOString(),type,deltaCents:delta,cashAfterCents:s.cashCents,description:clampText(description)});}
function allSecurities(s){return s.securities||Object.fromEntries(SYMBOLS.map(x=>[x.symbol,{...x,tradable:true}]));}
function getSymbol(s,symbol){const out=allSecurities(s)[String(symbol).trim().toUpperCase()];must(out,'股票尚未添加，请先使用 Yahoo 股票搜索并选择该股票');return out;}
function cleanSecurity(x){must(x&&typeof x==='object','请通过 Yahoo 搜索验证证券');const symbol=String(x.symbol||'').toUpperCase(),market=String(x.market||'');must(/^[A-Z0-9][A-Z0-9.\-^=]{0,24}$/.test(symbol),'股票代码格式不正确');must(['HK','US','OTHER'].includes(market),'市场信息不正确');const currency=quoteCurrency(x.currency);must(/^(?:[A-Z]{3}|GBp|ZAc)$/.test(currency),'货币信息缺失');must(['EQUITY','ETF','FUND','MUTUALFUND'].includes(String(x.quoteType||'').toUpperCase()),'只能添加股票或基金');return {symbol,name:clampText(x.name||symbol,140),market,currency,quoteUnitVerified:x.quoteUnitVerified===true,quoteType:x.quoteType,exchange:clampText(x.exchange,60),zone:clampText(x.zone,80),tradable:['EQUITY','ETF'].includes(String(x.quoteType||'').toUpperCase())&&((market==='HK'&&currency==='HKD')||(market==='US'&&currency==='USD'))};}
// Fetch priority: pending orders → holdings → watchlist → defaults (matters when the time budget runs out).
export function trackedSecurities(s){const syms=new Set([...s.orders.filter(x=>x.status==='pending').map(x=>x.symbol),...s.positions.filter(x=>x.qtyMicro>0).map(x=>x.symbol),...(s.watchlist||[]),...SYMBOLS.map(x=>x.symbol)]);return [...syms].map(k=>allSecurities(s)[k]).filter(Boolean);}
function daysBefore(iso,n){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10);}
function historicalPerformance(s,symbol){const rows=(s.priceHistory?.[symbol]||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));if(!rows.length)return {day:null,week:null,ytd:null};const end=rows.at(-1);const day=rows.length>1?rows.at(-2):null;const week=rows.length>5?rows.at(-6):null;const prevYear=`${Number(end.date.slice(0,4))-1}-12-31`;const baseline=rows.filter(x=>x.date<=prevYear).at(-1);const perf=base=>base?.priceMilli>0?Math.round((end.priceMilli/base.priceMilli-1)*10000)/100:null;return {day:perf(day),week:perf(week),ytd:perf(baseline)};}
export function ingestHistories(s,histories,now=new Date()){
 s.securities??=allSecurities(s);s.priceHistory??={};
 const minDate=daysBefore(dateISO(now),125);
 for(const h of histories){const sec=allSecurities(s)[h.symbol];if(!sec)continue;const existing=new Map((s.priceHistory[h.symbol]||[]).map(x=>[x.date,x]));
  if(h.currency){
   const currency=quoteCurrency(h.currency);
   must(/^(?:[A-Z]{3}|GBp|ZAc)$/.test(currency)&&quoteCurrencyMatches(sec,currency),'行情币种与已登记币种不一致，请家长核对后处理');
   const previous=sec.currency;sec.currency=currency;sec.quoteUnitVerified=true;
   // Old prices already contain the provider's raw numbers. Repair only their
   // labels, including a suspended stock's older latest quote; never rescale.
   if(previous!==currency)for(const q of Object.values(s.quotes))if(q.symbol===h.symbol&&q.currency===previous)q.currency=currency;
  }
  for(const row of (h.rows||[])){if(!validDate(row.date)||!Number.isSafeInteger(row.priceMilli)||row.priceMilli<=0)continue;
   // Validate here as well as in the Yahoo parser. Otherwise an incomplete bar
   // can be saved as final and filled later when the next quote refresh fails.
   if(['HK','US'].includes(sec.market)&&!closeIsFinal(sec.market,row.date,now))continue;
   existing.set(row.date,{date:row.date,priceMilli:row.priceMilli});
   const pendingDate=s.orders.some(o=>o.status==='pending'&&o.symbol===h.symbol&&o.targetDate===row.date);
   if(row.date>=minDate||pendingDate)s.quotes[h.symbol+'|'+row.date]={symbol:h.symbol,date:row.date,priceMilli:row.priceMilli,currency:sec.currency,final:true,source:'Yahoo Finance 日线（非官方接口）',updatedAt:new Date(now).toISOString()};
  }
  s.priceHistory[h.symbol]=[...existing.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-560);
 }
 settleOrders(s,now);
 pruneQuotes(s,minDate);
}
// Settlement quotes were only ever added, so the ledger row grew by about one
// entry per tracked security per trading day forever. Keep the same 125-day
// window used for ingestion, plus every quote a pending order still targets and
// the latest close of each security (valuation and display). priceHistory keeps
// the separate, already bounded series for 1D / 1W / YTD performance.
export function pruneQuotes(s,minDate){
 if(!s.quotes||typeof s.quotes!=='object')return 0;
 const pendingTargets=new Set(s.orders.filter(o=>o.status==='pending').map(o=>o.symbol+'|'+o.targetDate));
 const latest=new Map();
 for(const q of Object.values(s.quotes)){if(validDate(q?.date)&&(!latest.has(q.symbol)||q.date>latest.get(q.symbol).date))latest.set(q.symbol,q);}
 let removed=0;
 for(const [key,q] of Object.entries(s.quotes)){
  if(!validDate(q?.date)||q.date>=minDate||pendingTargets.has(key)||latest.get(q.symbol)===q)continue;
  delete s.quotes[key];removed++;
 }
 return removed;
}

export function requireReady(s){must(!!(s.dadHash&&s.kidHash),'请先完成家长账户初始化');}
export function setup(s,token,expectedToken,dadPassword,kidPin){must(!s.dadHash,'已经初始化，不能再次重置');must(expectedToken&&token===expectedToken,'初始化密钥不正确');must(typeof dadPassword==='string'&&dadPassword.length>=12&&dadPassword.length<=128,'家长密码至少12位');must(/^\d{6,10}$/.test(String(kidPin)),'Olivia PIN 需要6至10位数字');s.dadHash=hashSecret(dadPassword);s.kidHash=hashSecret(String(kidPin));audit(s,'system','setup','初始化家长及Olivia账户');return {ok:true};}
export function authenticate(s,role,password){requireReady(s);must(['dad','kid'].includes(role),'账户不正确');const key=role;const lock=s.authLocks[key]||{count:0,until:0};const now=Date.now();if(lock.until>now)throw Error('尝试次数过多，请15分钟后再试');const ok=checkSecret(password,role==='dad'?s.dadHash:s.kidHash);if(!ok){lock.count+=1;if(lock.count>=8){lock.until=now+15*60*1000;lock.count=0;}s.authLocks[key]=lock;return null;}s.authLocks[key]={count:0,until:0};audit(s,role,'login');return role;}
export function createSession(s,role,token){const now=Date.now();s.sessions=s.sessions.filter(x=>x.expires>now).slice(-25);s.sessions.push({hash:secretHash(token),role,expires:now+7*24*3600*1000});}
export function sessionRole(s,token){if(!token)return null;const found=s.sessions.find(x=>x.hash===secretHash(token));return found&&found.expires>Date.now()?found.role:null;}
export function revokeSession(s,token){if(token)s.sessions=s.sessions.filter(x=>x.hash!==secretHash(token));}
const quoteValue=(p,q)=>integerRatio([p.qtyMicro,q.priceMilli,q.currency==='USD'?8:1],1e7);
// V1.9.3 shopping holds are explicit per request. Older pending requests had no
// hold; keep them readable and recheck funds on approval instead of reserving
// historical requests retroactively. s.reservedCents remains stock-only storage.
const purchaseReservation=r=>r.status==='pending'&&validCents(r.reservedCents)?r.reservedCents:0;
const loanLimit=s=>validCents(s.settings?.loanLimitCents)?s.settings.loanLimitCents:50000;
// Old orders keep their original purchase dates and return history. A legacy
// delivery confirmation must not restart the seven-day window after purchase.
function purchaseReturnState(r,now=Date.now()){
  const paid=validCents(r.approvedCents)&&r.approvedCents>0;
  const dates=paid?[r.reviewAt,r.deliveredAt].filter(x=>typeof x==='string').map(Date.parse).filter(Number.isFinite):[];
  const purchasedAt=dates.length?Math.min(...dates):null;
  const deadline=purchasedAt===null?null:purchasedAt+7*DAY_MS;
  const requested=!!(r.returnRequestUsed||r.returnRequestedAt||r.returnRejectedAt||r.returnCancelledAt||r.refundAt||['return_pending','refunded'].includes(r.status));
  let reason='';
  if(requested)reason=r.status==='return_pending'?'退款申请已提交，等待家长处理':'每笔订单只能申请退款一次，不能再次申请';
  else if(!['approved','delivered'].includes(r.status))reason='只有已购买的订单可以申请退款';
  else if(!paid)reason='原购买金额不完整，请联系家长核对';
  else if(deadline===null||purchasedAt>now)reason='购买时间不完整，请联系家长核对';
  else if(now>deadline)reason='已超过购买后 7 天的退款申请期限';
  return {returnEligible:!reason,returnDeadlineAt:deadline===null?null:new Date(deadline).toISOString(),returnBlockedReason:reason,returnRequested:requested};
}
export function derived(s){const fixedPrincipal=s.fixed.filter(x=>x.status==='active').reduce((n,x)=>n+x.principalCents,0);const stockValue=s.positions.reduce((sum,p)=>{const q=lastQuote(s,p.symbol);return sum+(q?quoteValue(p,q):p.costCents);},0);const loanPrincipal=s.loans.reduce((n,l)=>n+l.principalCents,0), loanInterest=s.loans.reduce((n,l)=>n+Math.round(l.interestMicroCents/1e6),0),loanPending=s.loans.filter(l=>l.status==='pending').reduce((n,l)=>n+(validCents(l.requestedCents)?l.requestedCents:0),0),limit=loanLimit(s);const purchaseReservedCents=s.purchaseRequests.reduce((sum,r)=>sum+purchaseReservation(r),0),stockReservedCents=s.reservedCents,reservedCents=stockReservedCents+purchaseReservedCents;return {cashCents:s.cashCents,availableCents:s.cashCents-reservedCents,reservedCents,stockReservedCents,purchaseReservedCents,fixedPrincipalCents:fixedPrincipal,stocksValueCents:stockValue,loanPrincipalCents:loanPrincipal,loanInterestCents:loanInterest,loanLimitCents:limit,loanPendingCents:loanPending,loanAvailableCents:Math.max(0,limit-loanPrincipal-loanPending),assetsCents:s.cashCents+fixedPrincipal+stockValue,netWorthCents:s.cashCents+fixedPrincipal+stockValue-loanPrincipal-loanInterest};}
export function lastQuote(s,symbol){return Object.values(s.quotes).filter(q=>q.symbol===symbol).sort((a,b)=>b.date.localeCompare(a.date))[0]??null;}
// Read-only: show loan interest accrued through today (the same arithmetic loan.repay
// applies first), so the displayed amount due equals what "全部还清" charges even
// before the next maintenance run books it. Nothing is written here.
export function view(s,role){
 const today=bankDate(),loans=s.loans.map(l=>({...l,interestMicroCents:loanInterestThrough(l,today)})),d=derived({...s,loans}),registry=allSecurities(s),now=Date.now();
 // Display permissions use exactly the same exchange clock and half-day rules
 // as the action handlers. They are read-only hints; every action rechecks them.
 const orders=s.orders.map(o=>{
  const market=registry[o.symbol]?.market,pending=o.status==='pending';
  const canCancel=pending&&['HK','US'].includes(market)&&orderCanCancel(market,o.targetDate,new Date(now));
  return {...o,canCancel,canParentCancel:pending&&!!market&&!canCancel};
 });
 return {role,bankDate:today,profile:{kidAvatarData:s.profile?.kidAvatarData||null},settings:{...s.settings,loanLimitCents:loanLimit(s)},summary:d,notifications:role==='kid'?(s.notifications||[]).filter(x=>x.recipient==='kid').slice(0,120):[],watchlist:(s.watchlist||[]).map(symbol=>({...registry[symbol],quote:lastQuote(s,symbol),performance:historicalPerformance(s,symbol)})).filter(x=>x.symbol),symbols:Object.values(registry).map(x=>({...x,quote:lastQuote(s,x.symbol),performance:historicalPerformance(s,x.symbol)})),fixed:s.fixed,loans,depositRequests:s.depositRequests,purchaseRequests:s.purchaseRequests.map(r=>({...r,...purchaseReturnState(r,now)})),orders,positions:s.positions.map(p=>({...p,quote:lastQuote(s,p.symbol),valueCents:lastQuote(s,p.symbol)?quoteValue(p,lastQuote(s,p.symbol)):p.costCents})),wishes:s.wishes,tasks:s.tasks||[],taskProposals:s.taskProposals||[],taskCompletions:s.taskCompletions||[],ledger:s.ledger};
}
function requestPurchase(s,{name,amountCents,note='',link='',wishId}){
  const cleanName=clampText(name,100);
  must(cleanName.length>=1,'请填写商品名称');
  must(validCents(amountCents)&&amountCents>0,'请输入正确金额');
  must(amountCents<=derived(s).availableCents,'可用余额不足，购物申请不能超过可用金额');
  const request={id:id(),name:cleanName,amountCents,reservedCents:amountCents,note:clampText(note,240),link:clampText(link,400),status:'pending',at:new Date().toISOString()};
  if(wishId)request.wishId=wishId;
  s.purchaseRequests.unshift(request);
  return request;
}
function rateFor(s,term){const r=s.settings.fixedRates[term];must(Number.isInteger(r)&&r>=0,'期限错误');return r;}
function loanInterestThrough(l,today){if(!l.principalCents)return l.interestMicroCents;const days=diffDays(l.lastAccruedDay,today);return days?l.interestMicroCents+Math.round(l.principalCents*l.aprBps*days*1e6/3650000):l.interestMicroCents;}
function loanAccrue(s,now=new Date()){const today=bankDate(now);for(const l of s.loans){if(!l.principalCents)continue;const days=diffDays(l.lastAccruedDay,today);if(days){l.interestMicroCents=loanInterestThrough(l,today);l.lastAccruedDay=today;}}}
function settleFixed(s,today=bankDate()){for(const f of s.fixed){if(f.status==='active'&&f.maturity<=today){f.status='matured';const interest=depositInterest(f.principalCents,f.rateBps,f.start,f.maturity);f.interestCents=interest;ledger(s,'fixed.mature',f.principalCents+interest,`${f.term}个月定期到期，本金和利息`);audit(s,'system','fixed.mature',f.id);}}}
const HISTORY_ORDER_REASON='该股票已有较晚成交记录，不能回溯结算；请家长核对历史成本与盈亏后再处理';
const EARLIER_ORDER_REASON='同一股票有更早的订单需要家长处理，处理后按下单顺序成交';
// V2.0.1 wording, shown even when the earlier order was only waiting for its close.
const LEGACY_EARLIER_ORDER_REASON='同一股票有更早订单尚未结算，请先补齐该交易日行情或处理该订单';
const SETTLEMENT_REASONS=new Set([HISTORY_ORDER_REASON,EARLIER_ORDER_REASON,LEGACY_EARLIER_ORDER_REASON]);
function orderSequence(order,index,date=order.targetDate){
 const submittedAt=Date.parse(order.submittedAt);
 return {order,index,date,submittedAt:Number.isFinite(submittedAt)?submittedAt:0};
}
function compareOrderSequence(a,b){
 // Orders are stored newest first. Reverse insertion order breaks timestamp
 // ties, including after a reload, without rearranging the UI's order list.
 return a.date.localeCompare(b.date)||a.submittedAt-b.submittedAt||b.index-a.index;
}
function latestFilledOrders(s){
 const latest=new Map();
 s.orders.forEach((o,index)=>{
  if(o.status!=='filled')return;
  const entry=orderSequence(o,index,validDate(o.priceDate)?o.priceDate:o.targetDate),previous=latest.get(o.symbol);
  if(!previous||compareOrderSequence(previous,entry)<0)latest.set(o.symbol,entry);
 });
 return latest;
}
function requireSafeOrderTarget(s,o,date){
 const latest=latestFilledOrders(s).get(o.symbol);
 must(!latest||compareOrderSequence(orderSequence(o,s.orders.indexOf(o),date),latest)>=0,HISTORY_ORDER_REASON);
}
function clearSettlementReason(o){
 if(SETTLEMENT_REASONS.has(o.reason))delete o.reason;
}
const sessionQuote=(s,symbol,date)=>{const q=s.quotes[symbol+'|'+date];return q?.final===true?q:null;};
// The first final close after `date`: a settlement quote, or a row of the stored
// daily history (Yahoo or parent-entered). Both only ever hold final closes.
function firstCloseAfter(s,security,date,now){
 let best=null;
 for(const q of Object.values(s.quotes)){
  if(q?.symbol===security.symbol&&q.final===true&&validDate(q.date)&&q.date>date&&(!best||q.date<best.date)&&closeIsFinal(security.market,q.date,now))best=q;
 }
 for(const row of (s.priceHistory?.[security.symbol]||[])){
  if(validDate(row?.date)&&row.date>date&&(!best||row.date<best.date)&&Number.isSafeInteger(row.priceMilli)&&row.priceMilli>0&&closeIsFinal(security.market,row.date,now)){
   best={symbol:security.symbol,date:row.date,priceMilli:row.priceMilli,currency:security.currency,final:true,source:'日线历史记录',updatedAt:new Date(now).toISOString()};
  }
 }
 return best;
}
// V2.0.2 rule: every order fills at the first close after it was placed.
// orderTarget names that session in advance. If the session ends without a
// close for the stock (a closure the calendar does not know, or a suspension),
// the order fills at the first later close, which is what a complete calendar
// would have chosen. The price is always published after the order was placed.
export function settleOrders(s,now=new Date()){
 const pending=[];
 for(const [index,o] of s.orders.entries()){
  if(o.status!=='pending')continue;
  const security=getSymbol(s,o.symbol),market=security.market;
  if(market!=='HK'&&market!=='US')continue;
  // A target the calendar knows is closed moves to the next session at once.
  // Normalize every pending target before ordering: two old holiday targets
  // can converge on one session and must then follow their submission order.
  if(!tradingDay(market,o.targetDate)){
    const old=o.targetDate;o.targetDate=nextMarketDay(market,o.targetDate,true);
    if(old!==o.targetDate){o.rolledFrom??=old;audit(s,'system','stock.holiday.roll',`${o.symbol}: ${old} → ${o.targetDate}`);}
  }
  // Roll only on evidence: a later close already exists. A close that has not
  // arrived yet (Yahoo delay or outage) says nothing about a closure, so the
  // order keeps waiting for its own session's close.
  if(closeIsFinal(market,o.targetDate,now)&&!sessionQuote(s,o.symbol,o.targetDate)){
    const later=firstCloseAfter(s,security,o.targetDate,now);
    if(later){
      if(!sessionQuote(s,o.symbol,later.date))s.quotes[o.symbol+'|'+later.date]=later;
      audit(s,'system','stock.close.roll',`${o.symbol}: ${o.targetDate} → ${later.date}`);
      o.rolledFrom??=o.targetDate;o.targetDate=later.date;
    }
  }
  pending.push({...orderSequence(o,index),market});
 }
 const latest=latestFilledOrders(s),blocked=new Map();
 for(const entry of pending.sort(compareOrderSequence)){
  const {order:o,market}=entry;
  clearSettlementReason(o);
  if(blocked.has(o.symbol)){
   // One stock's orders fill in sequence. Behind an order that is only waiting
   // for its close there is nothing to explain; behind one that needs the
   // parent, say so.
   if(blocked.get(o.symbol)==='review')o.reason=EARLIER_ORDER_REASON;
   continue;
  }
  const previous=latest.get(o.symbol);
  if(previous&&compareOrderSequence(entry,previous)<0){
   // A pre-upgrade out-of-order fill needs a history review. Do not silently
   // rewrite that fill or make its cost-basis error worse by filling an old gap.
   o.reason=HISTORY_ORDER_REASON;blocked.set(o.symbol,'review');continue;
  }
  const q=sessionQuote(s,o.symbol,o.targetDate);
  if(!q||!closeIsFinal(market,o.targetDate,now)){blocked.set(o.symbol,'wait');continue;}
  const fx=q.currency==='USD'?8:1;
  if(o.side==='buy'){
    const qty=integerRatio([o.budgetCents,1e7],q.priceMilli*fx,'down');
    if(qty<=0){s.reservedCents-=o.budgetCents;o.status='cancelled';o.reason='金额不足以购买最小碎股单位';continue;}
    const spent=integerRatio([qty,q.priceMilli,fx],1e7,'up');
    const p=s.positions.find(p=>p.symbol===o.symbol)||{symbol:o.symbol,qtyMicro:0,costCents:0};
    must(Number.isSafeInteger(p.qtyMicro+qty)&&validCents(p.costCents+spent),'交易金额或股数超出安全范围');
    if(!s.positions.find(x=>x.symbol===o.symbol))s.positions.push(p);
    p.qtyMicro+=qty;p.costCents+=spent;s.reservedCents-=o.budgetCents;
    ledger(s,'stock.buy',-spent,`买入 ${o.symbol} ${qty/1e6} 股`);o.qtyMicro=qty;o.filledCents=spent;
  }else{
    const p=s.positions.find(p=>p.symbol===o.symbol);
    if(!p||p.qtyMicro<o.qtyMicro){o.status='cancelled';o.reason='持仓不足';continue;}
    const proceeds=integerRatio([o.qtyMicro,q.priceMilli,fx],1e7,'down');
    if(proceeds===0){o.status='cancelled';o.reason='卖出金额不足 O$0.01，已取消并保留持仓';continue;}
    const cost=integerRatio([p.costCents,o.qtyMicro],p.qtyMicro);
    p.qtyMicro-=o.qtyMicro;p.costCents-=cost;if(p.qtyMicro===0)p.costCents=0;
    ledger(s,'stock.sell',proceeds,`卖出 ${o.symbol} ${o.qtyMicro/1e6} 股`);
    o.filledCents=proceeds;o.realizedPnLCents=proceeds-cost;
  }
  o.status='filled';o.filledAt=new Date(now).toISOString();o.priceMilli=q.priceMilli;o.priceDate=q.date;
  latest.set(o.symbol,entry);
  audit(s,'system','stock.fill',`${o.side} ${o.symbol} ${q.date}`);
 }
}
export function maintenance(s){loanAccrue(s);settleFixed(s);settleOrders(s);return {ok:true,now:new Date().toISOString(),pending:s.orders.filter(o=>o.status==='pending').length};}
// Empty or non-numeric values must be rejected, not coerced (+'' === 0 would silently set a 0% rate).
const num=(x,min=0,max=1e8)=>{const n=typeof x==='number'?x:typeof x==='string'&&x.trim()!==''?Number(x):NaN;return Number.isFinite(n)&&n>=min&&n<=max;};
function addQuote(s,payload){const symbol=getSymbol(s,payload.symbol),date=String(payload.date||'');must(validDate(date),'请输入正确交易日期');must(['HK','US'].includes(symbol.market),'不支持此市场的手动成交报价');must(closeIsFinal(symbol.market,date),'只能登记已经结束的交易日收盘价');must(num(payload.price,0,10000000),'收盘价不正确');const priceMilli=Math.round(Number(payload.price)*1000);must(Number.isSafeInteger(priceMilli)&&priceMilli>0&&priceMilli<10000000000,'收盘价不正确');s.quotes[symbol.symbol+'|'+date]={symbol:symbol.symbol,date,priceMilli,currency:symbol.currency,final:true,source:clampText(payload.source||'家长手动登记',80),updatedAt:new Date().toISOString()};s.priceHistory??={};const older=(s.priceHistory[symbol.symbol]||[]).filter(q=>q.date!==date);s.priceHistory[symbol.symbol]=[...older,{date,priceMilli}].sort((a,b)=>a.date.localeCompare(b.date)).slice(-560);}
function canonicalPayload(value){
  if(Array.isArray(value))return value.map(canonicalPayload);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalPayload(value[key])]));
  return value;
}
function requestContent(action,payload){
  // The lookup API adds trusted metadata, which can change between retries.
  // The intended user action is still adding the same normalized symbol.
  const body=['watch.add','security.register'].includes(action)?{symbol:String(payload.symbol||payload.verifiedSecurity?.symbol||'').trim().toUpperCase()}:action==='wish.purchase'?{id:String(payload.id||'')}:payload;
  return JSON.stringify([action,canonicalPayload(body)]);
}
const requestDigest=content=>'sha256$'+createHash('sha256').update(content).digest('hex');
export function runAction(s,role,action,payload={},key){requireReady(s);must(['kid','dad'].includes(role),'未登录');must(typeof key==='string'&&/^[\x21-\x7e]{8,100}$/.test(key),'请求缺少唯一标识');const idem=role+'|'+key,content=requestContent(action,payload);
  if(s.processed.includes(idem)){
    const saved=s.requestDigests?.[idem];
    // Legacy records did not retain payload digests; preserve their replay guard.
    must(!saved||(saved.startsWith('scrypt$')?checkSecret(content,saved):saved===requestDigest(content)),'请求标识已用于其他操作，请刷新后重试');
    return {ok:true,duplicate:true};
  }
  const dadOnly=new Set(['cash.grant','deposit.approve','deposit.reject','purchase.approve','purchase.reject','purchase.deliver','purchase.refund','purchase.return.reject','loan.approve','loan.reject','settings.update','pin.change','password.change','quote.set','quote.batch','order.roll','order.retarget','order.cancel','maintenance.run','task.create','task.update','task.proposal.approve','task.proposal.reject','task.completion.approve','task.completion.reject']);
  must(!dadOnly.has(action)||role==='dad','只有家长可以执行此操作');const pid=String(payload.id||'');const amount=()=>cents(payload.amount);
  switch(action){
  case 'notifications.read':{
    must(role==='kid','只有 Olivia 可以阅读自己的通知');
    const now=new Date().toISOString();for(const n of (s.notifications||[]))if(n.recipient==='kid'&&!n.readAt)n.readAt=now;
    break;
  }
  case 'profile.avatar.set':{must(role==='kid','只有 Olivia 可以修改自己的头像');s.profile??={};s.profile.kidAvatarData=validateKidAvatar(payload.imageData);break;}
  case 'profile.avatar.remove':{must(role==='kid','只有 Olivia 可以修改自己的头像');s.profile??={};s.profile.kidAvatarData=null;break;}
  case 'task.create':{
    const name=clampText(payload.name,80),unit=clampText(payload.unit,24),a=amount();
    must(name.length>=2,'任务名称至少2个字');must(unit.length>=1,'请填写奖励单位，例如「件」');
    must(a%10===0&&a<=1000000,'任务单价须为 O$0.1 的倍数，最高 O$10,000.0');
    s.tasks??=[];s.tasks.unshift({id:id(),name,unit,rewardCents:a,active:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'dad'});break;
  }
  case 'task.update':{
    s.tasks??=[];const t=s.tasks.find(x=>x.id===pid);must(t,'任务不存在');
    const name=clampText(payload.name,80),unit=clampText(payload.unit,24),a=amount();
    must(name.length>=2,'任务名称至少2个字');must(unit.length>=1,'请填写奖励单位');
    must(a%10===0&&a<=1000000,'任务单价须为 O$0.1 的倍数，最高 O$10,000.0');
    must(['true','false',true,false].includes(payload.active),'任务状态不正确');
    t.name=name;t.unit=unit;t.rewardCents=a;t.active=payload.active===true||payload.active==='true';t.updatedAt=new Date().toISOString();break;
  }
  case 'task.propose':{
    must(role==='kid','只有 Olivia 可以提出自己的任务');
    const name=clampText(payload.name,80),unit=clampText(payload.unit,24),a=amount();
    must(name.length>=2,'任务名称至少2个字');must(unit.length>=1,'请填写奖励单位');
    must(a%10===0&&a<=1000000,'任务单价须为 O$0.1 的倍数，最高 O$10,000.0');
    s.taskProposals??=[];must(s.taskProposals.filter(x=>x.status==='pending').length<20,'待审批的任务提议太多，请家长先处理');
    s.taskProposals.unshift({id:id(),name,unit,rewardCents:a,reason:clampText(payload.reason,240),status:'pending',at:new Date().toISOString()});break;
  }
  case 'task.proposal.approve':{
    s.taskProposals??=[];s.tasks??=[];const r=s.taskProposals.find(x=>x.id===pid);must(r&&r.status==='pending','任务提议已处理');
    const t={id:id(),name:r.name,unit:r.unit,rewardCents:r.rewardCents,active:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'kid',proposalId:r.id};
    s.tasks.unshift(t);r.status='approved';r.taskId=t.id;r.reviewAt=new Date().toISOString();notifyKid(s,'任务提议通过啦',`「${r.name}」已经加入任务清单，每${r.unit}可赚 ${notifyMoney(r.rewardCents)}`, 'ok','tasks');break;
  }
  case 'task.proposal.reject':{
    s.taskProposals??=[];const r=s.taskProposals.find(x=>x.id===pid);must(r&&r.status==='pending','任务提议已处理');r.status='rejected';r.reviewAt=new Date().toISOString();notifyKid(s,'任务提议未通过',`「${r.name}」暂时没有加入任务清单`, 'no','tasks');break;
  }
  case 'task.complete':{
    must(role==='kid','只有 Olivia 可以提交任务完成记录');s.tasks??=[];s.taskCompletions??=[];
    const t=s.tasks.find(x=>x.id===pid);must(t&&t.active,'任务不存在或已暂停');
    const qty=Number(payload.quantity);must(Number.isSafeInteger(qty)&&qty>=1&&qty<=500,'完成数量必须是1到500的整数');
    const total=t.rewardCents*qty;must(Number.isSafeInteger(total)&&total<=5000000,'单次任务奖励不得超过 O$50,000.0');
    must(s.taskCompletions.filter(x=>x.status==='pending').length<40,'待验收任务太多，请家长先处理');
    s.taskCompletions.unshift({id:id(),taskId:t.id,taskName:t.name,unit:t.unit,unitRewardCents:t.rewardCents,quantity:qty,amountCents:total,notes:clampText(payload.notes,240),status:'pending',at:new Date().toISOString()});break;
  }
  case 'task.completion.approve':{
    s.taskCompletions??=[];const r=s.taskCompletions.find(x=>x.id===pid);must(r&&r.status==='pending','任务已验收，请勿重复发放奖励');
    must(Number.isSafeInteger(r.amountCents)&&r.amountCents>0,'任务奖励记录不正确');
    ledger(s,'task.earn',r.amountCents,`完成任务：${r.taskName} × ${r.quantity}${r.unit}`);
    r.status='approved';r.reviewAt=new Date().toISOString();r.paidAt=r.reviewAt;notifyKid(s,'任务奖励已到账',`「${r.taskName}」完成 ${r.quantity}${r.unit}，已收入 ${notifyMoney(r.amountCents)}`, 'ok','tasks');break;
  }
  case 'task.completion.reject':{
    s.taskCompletions??=[];const r=s.taskCompletions.find(x=>x.id===pid);must(r&&r.status==='pending','任务已验收');
    r.status='rejected';r.reviewAt=new Date().toISOString();notifyKid(s,'任务验收未通过',`「${r.taskName}」这次没有通过验收，可以问问家长原因`, 'no','tasks');break;
  }
  case 'cash.grant':{const a=amount();ledger(s,'cash.grant',a,clampText(payload.note||'家长存入零花钱'));break;}
  case 'deposit.request':{throw Error('新版不需要存钱申请，请家长直接登记实际注资');}
  case 'deposit.approve':{const r=s.depositRequests.find(x=>x.id===pid);must(r&&r.status==='pending','申请已处理');r.status='approved';r.reviewAt=new Date().toISOString();ledger(s,'deposit.approve',r.amountCents,`家长确认存钱 ${r.note}`);notifyKid(s,'存钱已确认',`${notifyMoney(r.amountCents)} 已存入你的活期账户`, 'ok','account');break;}
  case 'deposit.reject':{const r=s.depositRequests.find(x=>x.id===pid);must(r&&r.status==='pending','申请已处理');r.status='rejected';r.reviewAt=new Date().toISOString();notifyKid(s,'存钱申请未通过','这笔旧版存钱申请没有通过，请和家长确认', 'no','account');break;}
  case 'fixed.open':{const term=Number(payload.term),a=amount();must([3,6,12].includes(term),'只开放3、6、12个月定期');must(a<=derived(s).availableCents,'可用余额不足');const start=bankDate();ledger(s,'fixed.open',-a,`开立${term}个月定期`);s.fixed.unshift({id:id(),principalCents:a,term,rateBps:rateFor(s,term),start,maturity:addMonths(start,term),status:'active',interestCents:0});break;}
  case 'fixed.redeem':{const f=s.fixed.find(x=>x.id===pid);must(f&&f.status==='active','定期不存在或已到期');if(f.maturity<=bankDate()){settleFixed(s);break;}f.status='early';f.interestCents=0;ledger(s,'fixed.early',f.principalCents,`提前赎回${f.term}个月定期（无利息）`);break;}
  case 'purchase.request':{
    requestPurchase(s,{name:clampText(payload.name,90),amountCents:amount(),note:payload.note,link:payload.link});break;
  }
  case 'purchase.approve':{
    // One atomic action: dad confirms the item has been purchased / handed over;
    // the cash deduction and completion state are recorded together.
    const r=s.purchaseRequests.find(x=>x.id===pid);must(r&&r.status==='pending','申请已处理');
    const paid=payload.amount===undefined?r.amountCents:amount();
    must(paid<=r.amountCents,'批准金额不能超过 Olivia 的申请金额；请让她重新提交');
    must(paid<=derived(s).availableCents+purchaseReservation(r),'可用余额不足');
    const now=new Date().toISOString();r.approvedCents=paid;r.status='delivered';r.reservedCents=0;r.reviewAt=now;r.deliveredAt=now;
    ledger(s,'purchase.approve',-paid,`确认购买并交付：${r.name}`);notifyKid(s,'购物申请已完成',`「${r.name}」已确认购买并交付，扣除 ${notifyMoney(paid)}`, 'ok','account','shopping');break;
  }
  case 'purchase.reject':{
    const r=s.purchaseRequests.find(x=>x.id===pid);must(r&&r.status==='pending','申请已处理');r.status='rejected';r.reservedCents=0;r.reviewAt=new Date().toISOString();notifyKid(s,'购物申请未通过',`「${r.name}」暂时不能购买`, 'no','account','shopping');break;
  }
  case 'purchase.deliver':{
    // Compatibility only: old V1.5 already-approved purchases had two steps.
    // V1.6's UI no longer exposes this action.
    const r=s.purchaseRequests.find(x=>x.id===pid);must(r&&r.status==='approved','该购买单无需再次确认交付');r.status='delivered';r.deliveredAt=new Date().toISOString();break;
  }
  case 'purchase.return.request':{
    must(role==='kid','只有 Olivia 可以提交退货申请');
    const r=s.purchaseRequests.find(x=>x.id===pid);
    must(r,'未找到购买记录');
    const eligibility=purchaseReturnState(r);must(eligibility.returnEligible,eligibility.returnBlockedReason);
    r.returnPreviousStatus=r.status;r.status='return_pending';r.returnReason=clampText(payload.reason,200);
    r.returnRequestUsed=true;r.returnRequestedAt=new Date().toISOString();break;
  }
  case 'purchase.return.cancel':{
    must(role==='kid','只有 Olivia 可以撤回退货申请');
    throw Error('退款申请提交后不能撤回，每笔订单只能申请一次');
  }
  case 'purchase.return.reject':{
    const r=s.purchaseRequests.find(x=>x.id===pid);must(r&&r.status==='return_pending','没有待处理的退货申请');
    r.status=r.returnPreviousStatus||'delivered';r.returnRequestUsed=true;r.returnRejectedAt=new Date().toISOString();notifyKid(s,'退货申请未通过',`「${r.name}」的退货申请没有通过，每笔订单只能申请一次`, 'no','account','shopping');break;
  }
  case 'purchase.refund':{
    const r=s.purchaseRequests.find(x=>x.id===pid);
    must(r&&r.status==='return_pending','该订单不能退货：没有待处理的退款申请或已处理');
    must(Number.isSafeInteger(r.approvedCents)&&r.approvedCents>0,'原购买金额不正确');
    r.status='refunded';r.returnRequestUsed=true;r.refundAt=new Date().toISOString();
    ledger(s,'purchase.refund',r.approvedCents,`退货退款：${r.name}`);notifyKid(s,'退款已经到账',`「${r.name}」已退款 ${notifyMoney(r.approvedCents)} 至活期账户`, 'ok','account','shopping');break;
  }
  case 'loan.request':{must(role==='kid','只有 Olivia 可以申请借款');const a=amount(),d=derived(s);must(a%LOAN_UNIT_CENTS===0,'借款金额以 O$ 0.1 为单位');must(d.loanLimitCents>0,'家长已暂停新增借款');must(a<=d.loanAvailableCents,`未还本金与待审批借款合计不能超过 ${notifyMoney(d.loanLimitCents)}，目前还可申请 ${notifyMoneyFloor(d.loanAvailableCents)}`);s.loans.unshift({id:id(),principalCents:0,requestedCents:a,interestMicroCents:0,aprBps:s.settings.loanAprBps,status:'pending',createdAt:new Date().toISOString(),lastAccruedDay:bankDate()});break;}
  case 'loan.approve':{const l=s.loans.find(x=>x.id===pid);must(l&&l.status==='pending','申请已处理');must(validCents(l.requestedCents)&&l.requestedCents>0,'原借款申请金额不正确');const d=derived(s);must(d.loanLimitCents>0,'家长已暂停新增借款');must(d.loanPrincipalCents+d.loanPendingCents<=d.loanLimitCents,`未还本金与待审批借款合计不能超过 ${notifyMoney(d.loanLimitCents)}；请先处理其他申请或调整限额`);l.principalCents=l.requestedCents;l.status='active';l.lastAccruedDay=bankDate();ledger(s,'loan.approve',l.principalCents,'向家长借钱（本金为负债）');notifyKid(s,'借款已批准',`家长批准了 ${notifyMoney(l.principalCents)} 的借款，记得按约定还款`, 'ok','account','loan');break;}
  case 'loan.reject':{const l=s.loans.find(x=>x.id===pid);must(l&&l.status==='pending','申请已处理');l.status='rejected';notifyKid(s,'借款申请未通过',`${notifyMoney(l.requestedCents)} 的借款没有获得批准`, 'no','account','loan');break;}
  case 'loan.repay':{loanAccrue(s);const l=s.loans.find(x=>x.id===pid);must(l&&l.status==='active','未找到待还借款');const dueInterest=Math.round(l.interestMicroCents/1e6),due=dueInterest+l.principalCents;
    // "全部还清": the exact amount (cents, after today's accrual) is computed here, because the UI shows one decimal.
    // Repayments are typed in O$0.1 units and the page shows the due rounded up to O$0.1.
    // Paying that shown amount charges only the exact due, so nothing is waived or overcharged.
    must(due>0,'没有需要偿还的金额');const all=payload.all===true||payload.all==='true';let a=all?due:amount();
    if(!all){must(a%LOAN_UNIT_CENTS===0,'还款金额以 O$ 0.1 为单位');if(a>due){must(a-due<LOAN_UNIT_CENTS,'还款不能超过应还金额');a=due;}}
    // Paying the whole due while all her cash is free (no pending holds) yet short of it by less than
    // O$0.1 uses all of that cash and clears the loan. A waiver needs her cash emptied, is under O$0.1,
    // and closes the loan, so it happens at most once per parent-approved loan.
    const d=derived(s),waived=a===due&&a>d.availableCents&&d.availableCents>0&&d.reservedCents===0&&a-d.availableCents<LOAN_UNIT_CENTS?a-d.availableCents:0;
    if(waived)a=d.availableCents;
    must(a<=d.availableCents,'可用余额不足');const intPaid=Math.min(a,dueInterest);l.interestMicroCents=Math.max(0,l.interestMicroCents-intPaid*1e6);l.principalCents-=a-intPaid;if(waived)l.principalCents=0;
    ledger(s,'loan.repay',-a,`偿还家长借款（利息 ${notifyMoney(intPaid)}）${waived?'，差额不足 O$ 0.1 免还':''}`);
    if(!l.principalCents){l.interestMicroCents=0;l.status='repaid';}
    if(waived){l.waivedCents=waived;audit(s,role,'loan.waive',`借款 ${l.id} 用尽可用余额还款，差额 ${waived} 分免还`);}break;}
  case 'stock.buy':{const symbol=getSymbol(s,payload.symbol),a=amount();must(symbol.tradable,'目前只有港股（HKD）及美股（USD）可以交易');must(a<=derived(s).availableCents,'可用余额不足');const now=new Date(),target=nextTarget(s,symbol.symbol,now);s.reservedCents+=a;s.orders.unshift({id:id(),symbol:symbol.symbol,side:'buy',budgetCents:a,targetDate:target.date,targetSession:target.session,scheduleBasis:'session-close-v1.2',status:'pending',submittedAt:now.toISOString()});break;}
  case 'stock.sell':{const symbol=getSymbol(s,payload.symbol),qty=Number(payload.qty);must(symbol.tradable,'目前只有港股及美股支持交易');must(Number.isFinite(qty)&&qty>0&&qty<=999999,'卖出股数不正确');const qtyMicro=Math.round(qty*1e6);must(qtyMicro>0,'最小精度为百万分之一股');const p=s.positions.find(x=>x.symbol===symbol.symbol);const reserved=s.orders.filter(o=>o.side==='sell'&&o.symbol===symbol.symbol&&o.status==='pending').reduce((n,o)=>n+o.qtyMicro,0);must(p&&p.qtyMicro-reserved>=qtyMicro,'可卖出持仓不足');const now=new Date(),target=nextTarget(s,symbol.symbol,now);s.orders.unshift({id:id(),symbol:symbol.symbol,side:'sell',qtyMicro,targetDate:target.date,targetSession:target.session,scheduleBasis:'session-close-v1.2',status:'pending',submittedAt:now.toISOString()});break;}
  case 'stock.cancel':{const o=s.orders.find(x=>x.id===pid);must(o&&o.status==='pending','订单不能取消');must(orderCanCancel(getSymbol(s,o.symbol).market,o.targetDate),'目标交易日已收盘，不能取消');if(o.side==='buy')s.reservedCents-=o.budgetCents;o.status='cancelled';clearSettlementReason(o);break;}
  case 'order.roll':{
    const o=s.orders.find(x=>x.id===pid);must(o&&o.status==='pending','订单已处理');must(!s.quotes[o.symbol+'|'+o.targetDate],'目标日已有报价，请先结算');
    const m=getSymbol(s,o.symbol).market;must(m==='HK'||m==='US','市场不支持');must(!closeIsFinal(m,o.targetDate)||payload.confirmExceptionalClosure===true,'正常交易日缺报价不可当作休市');
    const target=nextMarketDay(m,o.targetDate);requireSafeOrderTarget(s,o,target);o.rolledFrom??=o.targetDate;o.targetDate=target;settleOrders(s);break;
  }
  case 'order.retarget':{
    const o=s.orders.find(x=>x.id===pid);must(o&&o.status==='pending','订单已处理');const m=getSymbol(s,o.symbol).market;must(m==='HK'||m==='US','市场不支持');must(o.submittedAt,'原始提交时间缺失，无法重算');
    const old=o.targetDate,target=orderTarget(m,new Date(o.submittedAt));requireSafeOrderTarget(s,o,target.date);o.targetDate=target.date;o.targetSession=target.session;o.scheduleBasis='session-close-v1.2';delete o.rolledFrom;
    audit(s,'dad','stock.retarget',`${o.symbol} ${old} → ${target.date}`);settleOrders(s);break;
  }
  case 'order.cancel':{
    // For an order the kid can no longer cancel: e.g. a delisted or long-suspended
    // stock never gets another close, so the order would otherwise wait forever.
    const o=s.orders.find(x=>x.id===pid);must(o&&o.status==='pending','订单已处理');const m=getSymbol(s,o.symbol).market;
    must(!['HK','US'].includes(m)||!orderCanCancel(m,o.targetDate),'成交日收市前请让 Olivia 自己撤单');
    if(o.side==='buy')s.reservedCents-=o.budgetCents;
    o.status='cancelled';o.reason='家长已撤销';o.cancelledAt=new Date().toISOString();
    notifyKid(s,'股票订单已撤销',`家长撤销了${o.side==='buy'?'买入':'卖出'} ${o.symbol} 的订单（成交日 ${o.targetDate}）${o.side==='buy'?`，预留的 ${notifyMoney(o.budgetCents)} 已退回活期`:'，股票已解冻'}`,'info','stocks');
    settleOrders(s);break;
  }
  case 'security.register':{const security=cleanSecurity(payload.verifiedSecurity);must(security.tradable,'该证券不是港股（HKD）或美股（USD），只能加入自选观察，不能买卖');s.securities??=allSecurities(s);s.securities[security.symbol]=security;break;}
  case 'watch.add':{const security=cleanSecurity(payload.verifiedSecurity);s.securities??=allSecurities(s);s.securities[security.symbol]=security;s.watchlist??=[];if(!s.watchlist.includes(security.symbol)){must(s.watchlist.length<10,'自选股最多只能有10只');s.watchlist.push(security.symbol);}break;}
  case 'watch.remove':{s.watchlist??=[];const symbol=String(payload.symbol||'').toUpperCase();must(s.watchlist.includes(symbol),'自选列表没有该股票');s.watchlist=s.watchlist.filter(x=>x!==symbol);break;}
  case 'quote.set':{addQuote(s,payload);settleOrders(s);break;}
  // Store the whole batch before settling: a later close must not stand in for
  // an earlier session whose close is in the same batch.
  case 'quote.batch':{must(Array.isArray(payload.quotes)&&payload.quotes.length<=100&&payload.quotes.every(q=>q&&typeof q==='object'),'行情批次不合法');for(const q of payload.quotes)addQuote(s,{...q,source:q.source||'Yahoo Finance 日线'});settleOrders(s);break;}
  case 'maintenance.run':{maintenance(s);break;}
  case 'settings.update':{if(payload.loanLimit!==undefined){const raw=String(payload.loanLimit).trim();s.settings.loanLimitCents=/^0(?:\.0{1,2})?$/.test(raw)?0:cents(raw);}for(const term of [3,6,12]){const v=payload['rate'+term];if(v!==undefined){must(num(v,0,100),'年化利率必须介于0%至100%');s.settings.fixedRates[term]=Math.round(Number(v)*100);}}if(payload.loanAPR!==undefined){must(num(payload.loanAPR,0,100),'借款年利率必须介于0%至100%');s.settings.loanAprBps=Math.round(Number(payload.loanAPR)*100);}break;}
  case 'pin.change':{must(/^\d{6,10}$/.test(String(payload.pin||'')),'PIN必须为6至10位数字');s.kidHash=hashSecret(String(payload.pin));s.authLocks.kid={count:0,until:0};s.sessions=s.sessions.filter(x=>x.role!=='kid');break;}
  case 'password.change':{must(checkSecret(String(payload.oldPassword||''),s.dadHash),'旧密码不正确');must(typeof payload.newPassword==='string'&&payload.newPassword.length>=12&&payload.newPassword.length<=128,'新密码需要12至128位');s.dadHash=hashSecret(payload.newPassword);s.authLocks.dad={count:0,until:0};s.sessions=s.sessions.filter(x=>x.role!=='dad');break;}
  case 'wish.add':{const name=clampText(payload.name,100);must(name.length>=1,'请输入心愿名称');const a=amount();s.wishes.unshift({id:id(),name,goalCents:a,at:new Date().toISOString()});break;}
  case 'wish.purchase':{
    must(role==='kid','只有 Olivia 可以申请购买心愿');
    const wish=s.wishes.find(x=>x.id===pid);must(wish,'心愿不存在');
    const linked=s.purchaseRequests.find(x=>x.wishId===wish.id&&['pending','approved','delivered','return_pending'].includes(x.status));
    must(!linked,'这个心愿已有购物申请，请到购买记录查看');
    // Use the saved wish snapshot; caller-supplied names, prices and IDs cannot
    // reduce its budget or link an unrelated purchase to this wish.
    requestPurchase(s,{name:wish.name,amountCents:wish.goalCents,note:'来自我的心愿',wishId:wish.id});break;
  }
  case 'wish.remove':{const idx=s.wishes.findIndex(x=>x.id===pid);must(idx>=0,'心愿不存在');s.wishes.splice(idx,1);break;}
  default:throw Error('未知操作：'+action);
  }
  // Financial history and replay protection are durable. The UI paginates its
  // rows; silently deleting old entries here would lose money-movement records
  // and allow an old retried cash grant or partial repayment to execute twice.
  must(s.cashCents>=0&&validCents(s.reservedCents)&&derived(s).availableCents>=0,'账本余额校验失败');
  s.processed.push(idem);s.requestDigests??={};
  // Credential payloads use the same slow salted hash as login secrets, never a
  // cheap PIN fingerprint that would weaken password storage on a copied backup.
  s.requestDigests[idem]=['pin.change','password.change'].includes(action)?hashSecret(content):requestDigest(content);
  audit(s,role,action,pid||payload.symbol||'');return {ok:true};
}
