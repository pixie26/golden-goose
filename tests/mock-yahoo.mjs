// Only used in the server HTTP integration test. Never imported by production.
const networkFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
 const s=String(url);
 if(s.startsWith('https://query1.finance.yahoo.com/v1/finance/search?')||s.startsWith('https://query2.finance.yahoo.com/v1/finance/search?')){
  const q=new URL(s).searchParams.get('q');
  return new Response(JSON.stringify({quotes:q==='AAPL'?[{symbol:'AAPL',shortname:'Apple Inc.',quoteType:'EQUITY',exchange:'NMS'}]:[]}),{status:200,headers:{'Content-Type':'application/json'}});
 }
 return networkFetch(url,options);
};
