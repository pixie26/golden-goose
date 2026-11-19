import test from 'node:test';
import assert from 'node:assert/strict';
import { validMarketDate,tradingDay,nextMarketDay,closeIsFinal,orderTarget } from '../lib/market.mjs';

test('malformed or non-existent calendar days cannot become closing-price dates',()=>{
  for(const date of ['2026-02-30','2026-02-29','2026-04-31','2026-13-01','2026-00-01','garbage','2026-1-01','']){
    assert.equal(validMarketDate(date),false,date);
    assert.equal(tradingDay('US',date),false,date);
    assert.equal(closeIsFinal('HK',date,new Date('2026-12-01T12:00:00Z')),false,date);
    assert.throws(()=>nextMarketDay('US',date),/日期/);
  }
  assert.equal(validMarketDate('2028-02-29'),true);
});

test('official holiday and half-day boundaries keep HK and US order targets intact',()=>{
  assert.equal(orderTarget('HK',new Date('2026-12-24T03:59:00Z')).date,'2026-12-24');
  assert.equal(orderTarget('HK',new Date('2026-12-24T04:00:00Z')).date,'2026-12-28');
  assert.equal(orderTarget('US',new Date('2026-11-27T17:59:00Z')).date,'2026-11-27');
  assert.equal(orderTarget('US',new Date('2026-11-27T18:00:00Z')).date,'2026-11-30');
});
