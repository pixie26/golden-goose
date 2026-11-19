import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join,extname,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
// Load the project's .env on any Node.js 22 release (`--env-file-if-exists` needs
// 22.9+, so older 22.x failed to start with "bad option"). Variables already set in
// the real environment win, as with --env-file. This must run before lib/ is
// imported: the store resolves BANK_DATA_FILE when its module loads.
try{process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)),'.env'));}catch(e){if(e?.code!=='ENOENT')throw e;}
const { handleApi,doMaintenance }=await import('./lib/api.mjs');
const port=Number(process.env.PORT||3000);
// `npm run lan` lets an iPad / phone on the same Wi-Fi open the local test bank.
const lan=process.argv.includes('--lan');
const host=process.env.HOST||(lan?'0.0.0.0':'127.0.0.1');
const projectRoot=dirname(fileURLToPath(import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
// Explicit static paths keep local account files and project source private.
const STATIC=new Set(['index.html','app.js','style.css','site.webmanifest',
  ...['goose.svg','logo.svg','coin.svg','hero-fairytale.png','hero-mobile.png','action-icons.png','brand-goose.png'].map(name=>'assets/images/'+name),
  ...['favicon.svg','apple-touch-icon.png','favicon.ico','favicon-32.png','app-icon-192.png','app-icon-512.png'].map(name=>'assets/icons/'+name)]);
const app=createServer(async(req,res)=>{
  try{
    const requestUrl=new URL(req.url,'http://'+(req.headers.host||'localhost:'+port));const pathname=requestUrl.pathname;
    if(pathname.startsWith('/api/')){
      const init={method:req.method,headers:req.headers};
      if(!['GET','HEAD'].includes(req.method)){init.body=Readable.toWeb(req);init.duplex='half';}
      const r=await handleApi(new Request(requestUrl.href,init));
      res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));return;
    }
    const file=pathname==='/'?'index.html':pathname.replace(/^\//,'');
    if(!STATIC.has(file)){res.writeHead(404);res.end('Not found');return;}
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end('Method not allowed');return;}
    const data=await readFile(join(projectRoot,'public',file));
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});res.end(req.method==='HEAD'?undefined:data);
  }catch(e){console.error('[bank-server]',e.code||e.name||'server-error');res.writeHead(e.code==='ENOENT'?404:500);res.end(e.code==='ENOENT'?'Not found':'服务器暂时不可用，请稍后重试');}
});
app.listen(port,host,()=>{
  console.log(`\n皇家金鹅银行已启动：http://localhost:${port}`);
  if(lan){
    const ips=Object.values(networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address);
    for(const ip of ips)console.log(`同一 Wi-Fi 的 iPad / 手机打开：http://${ip}:${port}`);
    console.log('（局域网模式：仅在家庭可信网络使用；完成首次设置后再分享地址。）');
  }
  console.log(process.env.SETUP_TOKEN?'首次设置使用环境变量 SETUP_TOKEN 中的密钥（不在日志显示）。':'本地首次设置密钥：local-setup');
  console.log(process.env.DATABASE_URL?'账本使用已配置的 PostgreSQL 数据库。\n':`本地账本：${process.env.BANK_DATA_FILE||join(projectRoot,'data','bank.local.json')}\n`);
});
// Local mode: hourly accrual and maturity, plus quote refresh and settlement when Yahoo is reachable.
if(!process.env.DISABLE_LOCAL_TIMER)setInterval(()=>doMaintenance().catch(()=>{}),60*60*1000).unref();
