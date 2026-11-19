import { randomBytes } from 'node:crypto';
import { readStore,mutateStore,storeErrorDetail } from './store.mjs';
import { setup, authenticate, createSession, sessionRole, revokeSession, runAction, view, maintenance, requireReady, trackedSecurities, ingestHistories } from './core.mjs';
import { fetchQuotes, searchYahoo, lookupYahooSymbol, fetchDailyHistory } from './quotes.mjs';

const json=(obj,status=200,headers={})=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store',...headers}});
const parseCookie=(cookie,name)=>cookie.split(';').map(p=>p.trim().split('=')).find(p=>p[0]===name)?.[1]??null;
const sessionOf=(req)=>parseCookie(req.headers.get('cookie')||'','goldengoose_session');
// X-Forwarded-Proto carries a bare scheme ("https", possibly a comma list), never "https:".
const forwardedHttps=req=>/^https$/i.test(String(req.headers.get('x-forwarded-proto')||'').split(',')[0].trim());
const cookie=(value,req,age=7*24*3600)=>{
  const secure=(new URL(req.url).protocol==='https:'||forwardedHttps(req))?'; Secure':'';
  return `goldengoose_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
};
const forbidden=(msg='无权访问')=>json({error:msg},403);
const storeError=e=>['BANK_STORE_UNREADABLE','BANK_STORE_UNAVAILABLE'].includes(e?.code);
const fail=(e)=>json({error:e?.message||'未知服务器错误',...(storeError(e)?{code:e.code}:{})},storeError(e)?503:e?.status||400);
const inputError=(message,status=400)=>Object.assign(new Error(message),{status});
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
async function requestData(req,maxBytes=16384){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')||''))throw inputError('请使用 JSON 格式提交',415);
  if(Number(req.headers.get('content-length')||0)>maxBytes)throw inputError('提交内容过大',413);
  // Limit the stream itself; checking string.length after req.text() still lets
  // an unauthenticated caller allocate an arbitrarily large request in memory.
  const reader=req.body?.getReader(),chunks=[];let length=0;
  if(reader)try{
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
      if(length>maxBytes){await reader.cancel().catch(()=>{});throw inputError('提交内容过大',413);}chunks.push(value);}
  }finally{reader.releaseLock();}
  let body;
  try{body=JSON.parse(Buffer.concat(chunks,length).toString('utf8')||'{}');}catch{throw inputError('不是合法JSON');}
  if(!isObject(body))throw inputError('提交内容必须是 JSON 对象');
  return body;
}
// An opaque ("null") or malformed Origin is a failed check (403), not a URL parser error.
function checkOrigin(req){
  if(req.headers.get('sec-fetch-site')==='cross-site')return false;
  const origin=req.headers.get('origin');if(!origin)return true;
  try{const target=new URL(req.url);if(forwardedHttps(req))target.protocol='https:';return new URL(origin).origin===target.origin;}catch{return false;}
}
const isProd=()=>!!process.env.NETLIFY||process.env.NODE_ENV==='production';
// Keep Yahoo work within a 7 s user-facing budget, leaving time to fall back to
// the offline directory or save and respond. This is an application deadline:
// Netlify's current platform limits are 60 s synchronous / 30 s scheduled.
const PAGE_YAHOO_DEADLINE_MS=7000;
async function doMaintenance({deadline=Date.now()+22000,maxFetchMs=20000}={}){
  const now=new Date(),snapshot=await readStore();requireReady(snapshot);
  // Scheduled run (defaults): of the 30 s limit, at most 20 s fetch quotes after the
  // database cold start, leaving the last eight seconds for the saving transaction.
  // The parent's manual refresh passes a shorter page-request deadline.
  const budgetMs=Math.max(0,Math.min(maxFetchMs,deadline-Date.now()));
  const external=await fetchQuotes(trackedSecurities(snapshot),now,{budgetMs});
  const r=await mutateStore(s=>{requireReady(s);ingestHistories(s,external.histories,now);return maintenance(s);});
  return {...r,quotesFetched:external.quotesFetched,errors:external.errors};
}
export { doMaintenance };
export async function handleApi(req){
  const started=Date.now(),yahooDeadline=started+PAGE_YAHOO_DEADLINE_MS;
  try{
    const url=new URL(req.url),method=req.method.toUpperCase(),p=url.pathname;
    if(!p.startsWith('/api/'))return json({error:'Not found'},404);
    if(method!=='GET'&&!checkOrigin(req))return forbidden('访问来源校验失败');
    if(method==='GET'&&p==='/api/bootstrap'){const s=await readStore();const role=sessionRole(s,sessionOf(req));return json({initialized:!!s.dadHash,role, data:role?view(s,role):null});}
    if(method==='POST'&&p==='/api/setup'){
      const body=await requestData(req);
      const token=process.env.SETUP_TOKEN||(!isProd()?'local-setup':null);
      await mutateStore(s=>setup(s,body.token,token,body.password,body.pin));return json({ok:true});
    }
    if(method==='POST'&&p==='/api/login'){
      const b=await requestData(req),token=randomBytes(32).toString('hex');
      const role=await mutateStore(s=>{const r=authenticate(s,b.role,String(b.password||''));if(r)createSession(s,r,token);return r;});
      if(!role)return json({error:'密码或PIN不正确'},401);
      return json({ok:true,role},200,{'Set-Cookie':cookie(token,req)});
    }
    if(method==='POST'&&p==='/api/logout'){
      const token=sessionOf(req);await mutateStore(s=>{revokeSession(s,token);return {ok:true};});
      return json({ok:true},200,{'Set-Cookie':cookie('',req,0)});
    }
    if(method==='GET'&&p==='/api/stocks/search'){const s=await readStore(),role=sessionRole(s,sessionOf(req));if(!role)return forbidden('请先登录');const q=String(url.searchParams.get('q')||'').slice(0,70);if(!q.trim())return json({results:[]});return json(await searchYahoo(q,{deadline:yahooDeadline}));}
    if(method==='GET'&&p==='/api/state'){
      const s=await readStore(),role=sessionRole(s,sessionOf(req));if(!role)return forbidden('请先登录');return json(view(s,role));
    }
    if(method==='POST'&&p==='/api/action'){
      const body=await requestData(req,285000),token=sessionOf(req),s=await readStore(),role=sessionRole(s,token);if(!role)return forbidden('登录已过期');
      if(body.expectedRole!==undefined&&body.expectedRole!==role)return forbidden('登录账户已切换，请重新登录');
      const action=String(body.action||'');
      if(action==='quote.refresh'){
        if(role!=='dad')return forbidden();const results=await doMaintenance({deadline:yahooDeadline,maxFetchMs:PAGE_YAHOO_DEADLINE_MS});return json({ok:true,...results});
      }
      let payload=body.payload??{},history=null,historyCurrency=null,refreshWarning=null;
      if(!isObject(payload))throw inputError('操作内容必须是 JSON 对象');
      if(action==='watch.add'||action==='security.register'){
        // Never trust the client for exchange/currency/identity. Verify via Yahoo server-side.
        const requested=String(payload.symbol||'').trim().toUpperCase();
        let verified=s.securities?.[requested];
        if(!verified)verified=await lookupYahooSymbol(requested,{deadline:yahooDeadline});
        payload={symbol:requested,verifiedSecurity:verified};
        try{history=await fetchDailyHistory(verified,new Date(),yahooDeadline,meta=>{historyCurrency=meta.currency;});}catch(e){refreshWarning='证券已添加，但行情暂不可用：'+e.message;}
      }
      const result=await mutateStore(current=>{const liveRole=sessionRole(current,token);if(!liveRole)throw inputError('登录已过期',403);if(body.expectedRole!==undefined&&body.expectedRole!==liveRole)throw inputError('登录账户已切换，请重新登录',403);const r=runAction(current,liveRole,action,payload,body.idempotencyKey);if(history?.length)ingestHistories(current,[{symbol:payload.symbol,rows:history,...(historyCurrency?{currency:historyCurrency}:{})}]);return r;});
      return json({...result,...(refreshWarning?{warning:refreshWarning}:{})});
    }
    return json({error:'没有这个 API'},404);
  }catch(e){console.error('[bank-api]',e.message+storeErrorDetail(e));return fail(e);}
}
