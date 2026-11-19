// HKEX / NYSE regular-session calendars. Times are exchange local.
// Official lists: HKEX 2026–2027 and NYSE 2026–2028 published schedules.
// Later years follow fixed rules: every NYSE full holiday and 13:00 early close,
// and the HKEX half-days (no afternoon session on the eves of Christmas, New Year
// and Lunar New Year). Later HKEX full-day holidays and any special closure are
// not guessed: a day without a close never fills an order, and settlement uses
// the first later close instead (lib/core.mjs), which is the fill a complete
// calendar would give.
const HOLIDAYS={
 HK:new Set(`2026-01-01 2026-02-17 2026-02-18 2026-02-19 2026-04-03 2026-04-06 2026-04-07 2026-05-01 2026-05-25 2026-06-19 2026-07-01 2026-10-01 2026-10-19 2026-12-25 2027-01-01 2027-02-08 2027-02-09 2027-03-26 2027-03-29 2027-04-05 2027-05-13 2027-06-09 2027-07-01 2027-09-16 2027-10-01 2027-10-08 2027-12-27`.split(' ')),
 US:new Set(`2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25`.split(' '))
};
const HALF_DAYS={
 HK:new Set(`2026-02-16 2026-12-24 2026-12-31 2027-02-05 2027-12-24 2027-12-31`.split(' ')),
 US:new Set(`2026-11-27 2026-12-24 2027-11-26 2028-07-03 2028-11-24`.split(' '))
};
// Last year each official list covers; later years use the rules below.
const OFFICIAL_THROUGH={HK:2027,US:2028};
// Lunar New Year's Day, 2026–2099. Two independent lunisolar tables (Python
// `lunardate` 0.3 and `holidays` 0.109) agree on every year.
const LUNAR_NEW_YEAR=new Map(`2026-02-17 2027-02-06 2028-01-26 2029-02-13 2030-02-03 2031-01-23 2032-02-11 2033-01-31 2034-02-19 2035-02-08 2036-01-28 2037-02-15 2038-02-04 2039-01-24 2040-02-12 2041-02-01 2042-01-22 2043-02-10 2044-01-30 2045-02-17 2046-02-06 2047-01-26 2048-02-14 2049-02-02 2050-01-23 2051-02-11 2052-02-01 2053-02-19 2054-02-08 2055-01-28 2056-02-15 2057-02-04 2058-01-24 2059-02-12 2060-02-02 2061-01-21 2062-02-09 2063-01-29 2064-02-17 2065-02-05 2066-01-26 2067-02-14 2068-02-03 2069-01-23 2070-02-11 2071-01-31 2072-02-19 2073-02-07 2074-01-27 2075-02-15 2076-02-05 2077-01-24 2078-02-12 2079-02-02 2080-01-22 2081-02-09 2082-01-29 2083-02-17 2084-02-06 2085-01-26 2086-02-14 2087-02-03 2088-01-24 2089-02-10 2090-01-30 2091-02-18 2092-02-07 2093-01-27 2094-02-15 2095-02-05 2096-01-25 2097-02-12 2098-02-01 2099-01-21`.split(' ').map(d=>[Number(d.slice(0,4)),d]));
const TZ={HK:'Asia/Hong_Kong',US:'America/New_York'};
// One formatter per exchange: building an Intl formatter per call dominated
// parsing two years of daily bars for every tracked stock.
const PARTS_FORMAT={};
export function exchangeParts(market,at=new Date()){
  if(!TZ[market])throw Error('暂不支持这个交易市场');
  PARTS_FORMAT[market]??=new Intl.DateTimeFormat('en-US',{timeZone:TZ[market],year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const part=PARTS_FORMAT[market].formatToParts(new Date(at));
  const p=Object.fromEntries(part.map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
}
export function addDate(date,days=1){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function validMarketDate(date){
 if(typeof date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(date))return false;
 const parsed=new Date(date+'T12:00:00Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date;
}
const ymd=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const weekday=date=>new Date(date+'T12:00:00Z').getUTCDay();
const isWeekday=date=>weekday(date)>=1&&weekday(date)<=5;
function nthWeekday(y,m,dow,n){return ymd(y,m,1+(dow-weekday(ymd(y,m,1))+7)%7+7*(n-1));}
function lastWeekday(y,m,dow){const last=new Date(Date.UTC(y,m,0,12)).toISOString().slice(0,10);return addDate(last,-((weekday(last)-dow+7)%7));}
function easterSunday(y){
 const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
 const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),n=h+l-7*m+114;
 return ymd(y,Math.floor(n/31),n%31+1);
}
// NYSE Rule 7.2: a Saturday holiday closes the Friday before, except New Year's
// Day (that Friday ends the previous year); a Sunday holiday closes the Monday after.
function nyseObserved(date,saturdayToFriday=true){const w=weekday(date);return w===6?(saturdayToFriday?addDate(date,-1):null):w===0?addDate(date,1):date;}
function nyseRules(y){
 const thanksgiving=nthWeekday(y,11,4,4),july4=weekday(ymd(y,7,4)),dec24=weekday(ymd(y,12,24));
 return {
  holidays:new Set([nyseObserved(ymd(y,1,1),false),nthWeekday(y,1,1,3),nthWeekday(y,2,1,3),addDate(easterSunday(y),-2),lastWeekday(y,5,1),
   nyseObserved(ymd(y,6,19)),nyseObserved(ymd(y,7,4)),nthWeekday(y,9,1,1),thanksgiving,nyseObserved(ymd(y,12,25))].filter(Boolean)),
  // 13:00 closes: 3 July when Independence Day is Tuesday–Friday, the day after
  // Thanksgiving, and Christmas Eve Monday–Thursday.
  half:new Set([july4>=2&&july4<=5?ymd(y,7,3):null,addDate(thanksgiving,1),dec24>=1&&dec24<=4?ymd(y,12,24):null].filter(Boolean)),
 };
}
// HKEX: no afternoon session on the eves of Christmas, New Year and Lunar New
// Year when the eve is a weekday.
function hkexRules(y){
 const lny=LUNAR_NEW_YEAR.get(y);
 return {holidays:new Set(),half:new Set([lny?addDate(lny,-1):null,ymd(y,12,24),ymd(y,12,31)].filter(d=>d&&isWeekday(d)))};
}
const ruleCache=new Map();
// Rule-based closures for one year (exported for the calendar tests).
export function calendarRules(market,year){
 const key=market+year;let rules=ruleCache.get(key);
 if(!rules){rules=market==='US'?nyseRules(year):hkexRules(year);ruleCache.set(key,rules);}
 return rules;
}
function listedDay(lists,market,date){
 if(!lists[market]||!validMarketDate(date))return false;
 const year=Number(date.slice(0,4));
 return year>OFFICIAL_THROUGH[market]?calendarRules(market,year)[lists===HOLIDAYS?'holidays':'half'].has(date):lists[market].has(date);
}
export function tradingDay(market,date){return !!HOLIDAYS[market]&&validMarketDate(date)&&isWeekday(date)&&!listedDay(HOLIDAYS,market,date);}
export function closeMinute(market,date){return listedDay(HALF_DAYS,market,date)?(market==='HK'?12*60:13*60):16*60;}
export function nextMarketDay(market,date,includeToday=false){if(!HOLIDAYS[market]||!validMarketDate(date))throw Error('交易市场或日期不正确');let d=includeToday?date:addDate(date);for(let i=0;i<20;i++,d=addDate(d)){if(tradingDay(market,d))return d;}throw Error('无法确定下一交易日');}
export function orderTarget(market,submittedAt=new Date()){
 const p=exchangeParts(market,submittedAt);
 if(tradingDay(market,p.date)&&p.minute<closeMinute(market,p.date)){
   return {date:p.date,session:p.minute<570?'preopen':'intraday',market};
 }
 return {date:nextMarketDay(market,p.date),session:tradingDay(market,p.date)?'afterclose':'closed',market};
}
// Avoid treating Yahoo's intraday "daily close" (last price so far) as a final close.
// HKEX closing auction (CAS) ends randomly 16:08–16:10 (12:08–12:10 on half days) and
// Yahoo's HKEX feed is delayed 15 minutes; US closing-auction prints can also arrive a few
// minutes after 16:00 ET. A 5-minute buffer could therefore book a pre-auction price.
export const FINAL_CLOSE_BUFFER_MINUTES=60;
export function closeIsFinal(market,date,now=new Date()){
 if(!tradingDay(market,date))return false;
 const p=exchangeParts(market,now);
 return date<p.date || (date===p.date&&p.minute>=closeMinute(market,date)+FINAL_CLOSE_BUFFER_MINUTES);
}
export function orderCanCancel(market,targetDate,now=new Date()){
 const p=exchangeParts(market,now);
 return targetDate>p.date || (targetDate===p.date&&p.minute<closeMinute(market,targetDate));
}
