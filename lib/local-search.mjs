// Small, explicitly labelled offline directory for testing when Yahoo is unreachable.
// It is NOT the full Yahoo universe and never supplies synthetic prices.
import { SYMBOLS } from './core.mjs';
const rows = [
 ...SYMBOLS.map(x=>({...x,aliases:''})),
 {symbol:'TSLA',name:'Tesla 特斯拉',market:'US',currency:'USD',aliases:'tesla tesla inc 特斯拉 电动车'},
 {symbol:'NVDA',name:'NVIDIA 英伟达',market:'US',currency:'USD',aliases:'nvidia 英伟达 辉达'},
 {symbol:'AMZN',name:'Amazon 亚马逊',market:'US',currency:'USD',aliases:'amazon 亚马逊'},
 {symbol:'GOOGL',name:'Alphabet 谷歌 A',market:'US',currency:'USD',aliases:'google alphabet 谷歌'},
 {symbol:'GOOG',name:'Alphabet 谷歌 C',market:'US',currency:'USD',aliases:'google alphabet 谷歌'},
 {symbol:'META',name:'Meta Platforms',market:'US',currency:'USD',aliases:'facebook instagram 元宇宙'},
 {symbol:'NFLX',name:'Netflix 奈飞',market:'US',currency:'USD',aliases:'netflix 奈飞'},
 {symbol:'AMD',name:'AMD 超威',market:'US',currency:'USD',aliases:'amd advanced micro devices 超威'},
 {symbol:'BABA',name:'Alibaba ADR 阿里巴巴',market:'US',currency:'USD',aliases:'alibaba 阿里'},
 {symbol:'TSM',name:'TSMC 台积电 ADR',market:'US',currency:'USD',aliases:'taiwan semiconductor 台积电'},
 {symbol:'JPM',name:'JPMorgan Chase 摩根大通',market:'US',currency:'USD',aliases:'jpmorgan 摩根大通'},
 {symbol:'BRK-B',name:'Berkshire Hathaway B',market:'US',currency:'USD',aliases:'berkshire 巴菲特 伯克希尔'},
 {symbol:'DIS',name:'Disney 迪士尼',market:'US',currency:'USD',aliases:'disney 迪士尼'},
 {symbol:'NKE',name:'Nike 耐克',market:'US',currency:'USD',aliases:'nike 耐克'},
 {symbol:'SPY',name:'SPDR S&P 500 ETF',market:'US',currency:'USD',quoteType:'ETF',aliases:'sp500 s&p 500 标普500'},
 {symbol:'QQQ',name:'Invesco Nasdaq 100 ETF',market:'US',currency:'USD',quoteType:'ETF',aliases:'nasdaq100 纳斯达克100'},
 {symbol:'VTI',name:'Vanguard Total Stock ETF',market:'US',currency:'USD',quoteType:'ETF',aliases:'vanguard 全市场'},
 {symbol:'0005.HK',name:'汇丰控股 HSBC',market:'HK',currency:'HKD',aliases:'hsbc 汇丰'},
 {symbol:'0388.HK',name:'香港交易所 HKEX',market:'HK',currency:'HKD',aliases:'hkex 港交所'},
 {symbol:'3690.HK',name:'美团',market:'HK',currency:'HKD',aliases:'meituan 美团'},
 {symbol:'1810.HK',name:'小米集团',market:'HK',currency:'HKD',aliases:'xiaomi 小米'},
 {symbol:'9618.HK',name:'京东集团',market:'HK',currency:'HKD',aliases:'jd 京东'},
 {symbol:'9999.HK',name:'网易',market:'HK',currency:'HKD',aliases:'netease 网易'},
 {symbol:'1211.HK',name:'比亚迪股份',market:'HK',currency:'HKD',aliases:'byd 比亚迪'},
 {symbol:'2318.HK',name:'中国平安',market:'HK',currency:'HKD',aliases:'pingan 平安'},
 {symbol:'1299.HK',name:'友邦保险',market:'HK',currency:'HKD',aliases:'aia 友邦'},
 {symbol:'3067.HK',name:'iShares 恒生科技 ETF',market:'HK',currency:'HKD',quoteType:'ETF',aliases:'恒生科技 etf'},
 ];
const unique = [...new Map(rows.map(x=>[x.symbol,x])).values()];
export const offlineSecurity = symbol => {
 const x = unique.find(x=>x.symbol === String(symbol||'').trim().toUpperCase());
 if (!x) return null;
 const quoteType=x.quoteType||(x.symbol==='VOO'||x.symbol==='2800.HK'?'ETF':'EQUITY');
 return {symbol:x.symbol,name:x.name,market:x.market,currency:x.currency,quoteType,exchange:x.market==='HK'?'HKEX':'US',zone:x.market==='HK'?'Asia/Hong_Kong':'America/New_York',tradable:true,offlineDirectory:true};
};
export const offlineSearch = query => {
 const q = String(query||'').toLowerCase().trim();
 if (!q) return [];
 return unique.map(x=>{
  const symbol=x.symbol.toLowerCase(); const haystack=[x.name,x.aliases,symbol].join(' ').toLowerCase();
  let score = symbol===q?0 : symbol.startsWith(q)?1 : x.name.toLowerCase().startsWith(q)?2 : haystack.includes(q)?3 : 99;
  return {x,score};
 }).filter(x=>x.score<99).sort((a,b)=>a.score-b.score||a.x.symbol.localeCompare(b.x.symbol)).slice(0,15).map(({x})=>({
   symbol:x.symbol,name:x.name,exchange:x.market==='HK'?'HKEX（离线目录）':'美股（离线目录）',
   type:x.quoteType||(x.symbol==='VOO'||x.symbol==='2800.HK'?'ETF':'EQUITY'),
   tradeHint:x.market,offline:true
 }));
};
