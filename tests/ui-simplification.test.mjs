import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('V1.3 hides redundant wallet card and legacy deposit request records',()=>{
  assert.doesNotMatch(ui,/我的活期钱包/);
  assert.doesNotMatch(ui,/旧版存钱记录/);
  assert.doesNotMatch(ui,/旧版待处理存钱申请/);
  assert.doesNotMatch(ui,/listRequests\(data\.depositRequests/);
  assert.doesNotMatch(ui,/approvals\(data\.depositRequests/);
});
test('V1.3 retains current balances and all functional pages',()=>{
  assert.match(ui,/活期现金/);
  assert.match(ui,/现在可用/);
  assert.match(ui,/id="fixed"/);
  assert.match(ui,/id="shopping"/);
  assert.match(ui,/借款审批/);
  assert.match(ui,/stock-search-field/);
  assert.match(ui,/data-tab="history"/);
});
