// Yahoo Finance endpoints are unofficial and may be rate limited or unavailable.
import { closeIsFinal } from './market.mjs';
import { SYMBOLS, quoteCurrency, quoteCurrencyMatches } from './core.mjs';
import {offlineSearch, offlineSecurity} from './local-search.mjs';
const HEADER={'User-Agent':'Mozilla/5.0 (compatible; GoldenGooseFamilyBank/1.6)','Accept':'application/json','Accept-Language':'zh-HK,zh;q=0.9,en;q=0.8'};
// Provide actionable diagnostics rather than exposing Node's generic `fetch failed`.
export function yahooErrorMessage(error){
 const msg=String(error?.message||''), code=String(error?.cause?.code||error?.code||'');
 const status=msg.match(/Yahoo HTTP (\d+)/)?.[1];
 if(status==='429')return 'Yahoo 搜索暂时限流（HTTP 429），请稍后再试';
 if(status==='401'||status==='403')return 'Yahoo 暂时拒绝访问（HTTP '+status+'）';
 if(code==='EAI_AGAIN'||code==='ENOTFOUND')return '无法连接 Yahoo：DNS/网络故障（'+code+'）';
 if(code==='ECONNRESET'||code==='UND_ERR_SOCKET')return 'Yahoo 网络连接被中断（'+code+'）';
 if(code==='UND_ERR_CONNECT_TIMEOUT'||code==='ETIMEDOUT'||error?.name==='TimeoutError')return '连接 Yahoo 超时，请检查网络或代理设置';
 return msg==='fetch failed'?'暂时无法连接 Yahoo 行情服务':msg.slice(0,160)||'Yahoo 暂时不可用';
}
const NOT_FOUND='Yahoo 找不到该证券';
// deadline: epoch ms after which no new request may start. The app limits page
// Yahoo work to 7 s so the user gets a prompt result and there is time to save.
// Netlify currently allows 60 s for synchronous functions and 30 s for scheduled ones.
async function getYahoo(path,deadline=Infinity){let last;
 for(const host of ['https://query2.finance.yahoo.com','https://query1.finance.yahoo.com']){
  const left=deadline-Date.now();if(left<800){last=last||Object.assign(Error('timeout'),{name:'TimeoutError'});break;}
  try{
   const res=await fetch(host+path,{headers:HEADER,signal:AbortSignal.timeout(Math.min(5500,left))});
   // Yahoo answers an unknown or delisted ticker with HTTP 404. That is a final
   // answer, not a network fault: do not retry the other host or ask the family
   // to reconnect.
   if(res.status===404)throw Object.assign(Error(NOT_FOUND),{notFound:true});
   if(!res.ok)throw Error('Yahoo HTTP '+res.status);
   return await res.json();
  }catch(e){last=e;if(e?.notFound||e?.cause?.code==='EAI_AGAIN'||e?.cause?.code==='ENOTFOUND')break;}
 }
 throw new Error(yahooErrorMessage(last));
}

const displayName=q=>String(q.longname||q.shortname||q.name||q.symbol||'').trim().slice(0,140);
const normalSymbol=s=>String(s||'').trim().toUpperCase();
const identityError=message=>Object.assign(Error(message),{code:'YAHOO_SECURITY_MISMATCH'});
// Yahoo may resolve an obsolete ticker to a new symbol. Do not silently create
// one security while the UI still selects the old one, or apply another symbol's
// prices to an existing holding. Currency/market changes also need parent review.
function assertChartSecurity(meta,security){
 const requested=normalSymbol(security.symbol),received=normalSymbol(meta.symbol);
 if(received&&received!==requested)throw identityError(`Yahoo 返回的证券代码为 ${received}（请求代码 ${requested}），请重新搜索 ${received} 并核对后选择`);
 const currency=quoteCurrency(meta.currency);
 if(!quoteCurrencyMatches(security,currency))throw identityError(`${requested} 的行情币种 ${currency} 与已登记币种 ${security.currency} 不一致，请家长核对后处理`);
 const zone=String(meta.exchangeTimezoneName||''),expectedZone=security.market==='HK'?'Asia/Hong_Kong':security.market==='US'?'America/New_York':security.zone;
 if(zone&&expectedZone&&zone!==expectedZone)throw identityError(`${requested} 的行情交易市场与已登记市场不一致，请家长核对后处理`);
}
const types=new Set(['EQUITY','ETF','MUTUALFUND','FUND']);
const exchangeZone=q=>q.exchangeTimezoneName||'';
export function normalizeSecurity(meta,symbol,searchData=null){
 assertChartSecurity(meta,{symbol});
 const sym=normalSymbol(meta.symbol||symbol),currency=quoteCurrency(meta.currency),zone=exchangeZone(meta);
 const type=String(meta.instrumentType||searchData?.quoteType||'').toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9.\-^=]{0,24}$/.test(sym))throw Error('股票代码不合法');
 if(!types.has(type))throw Error('目前只支持 Yahoo 的股票和 ETF 类型');
 const market=zone==='Asia/Hong_Kong'?'HK':zone==='America/New_York'?'US':'OTHER';
 const name=String(searchData?.longname||searchData?.shortname||meta.longName||meta.shortName||sym).trim().slice(0,140);
 return {symbol:sym,name,market,currency,quoteUnitVerified:true,quoteType:type,exchange:String(meta.fullExchangeName||meta.exchangeName||searchData?.exchange||''),zone:zone||'UTC',tradable:(type==='EQUITY'||type==='ETF')&&((market==='HK'&&currency==='HKD')||(market==='US'&&currency==='USD'))};
}
export async function searchYahoo(q,{deadline=Infinity}={}){
 const query=String(q||'').trim().slice(0,70);
 if(query.length<1)throw Error('请输入股票代码或公司名称');
 const u=new URLSearchParams({q:query,quotesCount:'25',newsCount:'0',enableFuzzyQuery:'true',lang:'zh-HK',region:'HK'});
 try{
  const data=await getYahoo('/v1/finance/search?'+u.toString(),deadline);
  const results=(data.quotes||[]).filter(x=>types.has(String(x.quoteType||'').toUpperCase())&&x.symbol).slice(0,20).map(x=>({
    symbol:normalSymbol(x.symbol),name:displayName(x),exchange:String(x.exchange||''),type:String(x.quoteType||''),
    tradeHint:/\.HK$/i.test(x.symbol)?'HK':(/^(NYQ|NMS|NGM|NCM|ASE|PCX|PNK|BTS|NAS|NYE)$/i.test(x.exchange)?'US':'OTHER')
  }));
  return {results,offline:false,warning:null};
 }catch(e){
  return {results:offlineSearch(query),offline:true,warning:yahooErrorMessage(e)+'。只显示少量离线预置股票，没有实时价格。'};
 }
}

export async function lookupYahooSymbol(symbol,{deadline=Infinity}={}){
 const s=normalSymbol(symbol);if(!/^[A-Z0-9][A-Z0-9.\-^=]{0,24}$/.test(s))throw Error('股票代码无效');
 try{
  const json=await getYahoo('/v8/finance/chart/'+encodeURIComponent(s)+'?interval=1d&range=1mo',deadline);
  const meta=json?.chart?.result?.[0]?.meta;if(!meta)throw Error(NOT_FOUND);
  return normalizeSecurity(meta,s);
 }catch(e){
  if(e?.code==='YAHOO_SECURITY_MISMATCH')throw e;
  // Only the deliberately curated, known tickers may be registered offline.
  // Unknown tickers always need authoritative provider metadata before trading.
  if(e.message.includes(NOT_FOUND))throw Error(NOT_FOUND+' '+s+'，请检查代码或重新搜索');
  const known=offlineSecurity(s);
  if(known)return known;
  throw Error('暂时无法在线验证 '+s+'：'+yahooErrorMessage(e)+'。请联网后重试；离线时只开放少量预置股票。');
 }
}

const dayForZone=(epoch,zone)=>{const f=new Intl.DateTimeFormat('en-CA',{timeZone:zone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(epoch*1000));const p=Object.fromEntries(f.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
export function parseDailyChart(json,security,now=new Date(),onMetadata=null){
 const result=json?.chart?.result?.[0];if(!result?.timestamp?.length)throw Error('没有历史日线');
 const meta=result.meta||{};
 assertChartSecurity(meta,security);
 const zone=security.zone||meta.exchangeTimezoneName||(security.market==='HK'?'Asia/Hong_Kong':security.market==='US'?'America/New_York':'UTC');
 const closes=result.indicators?.quote?.[0]?.close||[];
 let lastDay='';const rows=[];
 for(let i=0;i<result.timestamp.length;i++){
  const price=closes[i],date=dayForZone(result.timestamp[i],zone);
  if(!(Number.isFinite(price)&&price>0))continue;
  // HK/US: strictly exclude incomplete current-session bars; other markets: exclude today's bar.
  if(security.market==='HK'||security.market==='US'){
   if(!closeIsFinal(security.market,date,now))continue;
  }else if(date>=dayForZone(Math.floor(new Date(now).getTime()/1000),zone))continue;
  if(date===lastDay)rows.pop();
  const priceMilli=Math.round(price*1000);if(!Number.isSafeInteger(priceMilli)||priceMilli<=0)continue;
  rows.push({date,priceMilli});lastDay=date;
 }
 onMetadata?.({currency:quoteCurrency(meta.currency)});
 return rows.slice(-560);
}
export async function fetchDailyHistory(security,now=new Date(),deadline=Infinity,onMetadata=null){
 const json=await getYahoo('/v8/finance/chart/'+encodeURIComponent(security.symbol)+'?interval=1d&range=2y&includePrePost=false',deadline);
 return parseDailyChart(json,security,now,onMetadata);
}
// Callers pass securities in priority order (pending orders first). Whatever arrives within the
// time budget is still saved and settled; anything skipped is retried on the next scheduled run.
export async function fetchQuotes(securities,now=new Date(),{budgetMs=20000}={}){
 const queue=securities?.length?securities:SYMBOLS;
 const histories=[],errors=[],deadline=Date.now()+budgetMs;let cursor=0;
 async function worker(){for(;;){const i=cursor++;if(i>=queue.length)return;const security=queue[i];
  if(Date.now()>deadline-800){errors.push(security.symbol+': 本次抓取时间已用完，下次自动重试');continue;}
  try{
  let currency;const rows=await fetchDailyHistory(security,now,deadline,meta=>{currency=meta.currency;});
  if(!rows.length)throw Error('当前没有已确认收盘价');
  histories.push({symbol:security.symbol,rows,...(currency?{currency}:{})});
 }catch(e){errors.push(security.symbol+': '+e.message);}}}
 await Promise.all(Array.from({length:Math.min(4,queue.length)},worker));
 return {histories,quotesFetched:histories.reduce((n,x)=>n+x.rows.length,0),errors};
}
