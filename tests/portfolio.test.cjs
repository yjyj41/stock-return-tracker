const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../portfolio.js');
const trade = (source, realizedPnl, extra={}) => ({ source, realizedPnl, currency:String(source).startsWith('samsung') ? 'KRW' : 'GBP', sellDate:'2026-10-01', ...extra });
const rates={GBP:{rate:1800,date:'2026-10-09',source:'test'}};
test('combined total prefers official Samsung summary and excludes old/manual duplicates',()=>{
  const r=api.combined([trade('samsung-summary',1000),trade('samsung-ledger',1500),trade('trading212',10),trade('trading212-cfd',-20),trade(undefined,999)],'net',rates);
  assert.equal(r.total,-17000);assert.equal(r.rows.length,3);assert.equal(r.excludedLedger,true);assert.equal(r.excludedManual,true);
});
test('reporting mode compares ISA Result and CFD result after FX, without changing stored net',()=>{
  const ts=[trade('trading212',10,{reportedPnl:12}),trade('trading212-cfd',-20,{resultAfterFx:-15})];
  assert.equal(api.combined(ts,'net',rates).total,-18000);
  assert.equal(api.combined(ts,'reported',rates).total,-5400);
  assert.equal(ts[0].realizedPnl,10);
  assert.equal(api.pnlFor(trade('trading212',2,{reportedPnl:0}),'reported'),0);
});
test('missing or invalid FX never produces a misleading partial combined total',()=>{
  const ts=[trade('samsung-summary',1000),trade('trading212',10)];
  assert.equal(api.combined(ts,'net',{}).total,null);
  assert.deepEqual(api.combined(ts,'net',{GBP:{rate:0,date:'2026-10-09'}}).missing,['GBP']);
  assert.equal(api.combined(ts,'net',rates).total,19000);
});
test('Samsung ledger is flagged as an estimate when summary is unavailable',()=>{
  assert.equal(api.combined([trade('samsung-ledger',100)],'net',{}).estimated,true);
  assert.equal(api.combined([trade('trading212',3,{reportedOnly:true})],'net',rates).estimated,true);
  assert.equal(api.combined([trade('trading212',3)],'reported',rates).comparisonMissing,true);
});
test('currency pair, positive rate and valid rate date are required',()=>{
  assert.equal(api.parseRate({base:'GBP',quote:'KRW',rate:1800,date:'2026-10-09'},'GBP').rate,1800);
  for(const p of [{base:'KRW',quote:'GBP',rate:1/1800,date:'2026-10-09'},{base:'GBP',quote:'KRW',rate:-1,date:'2026-10-09'},{base:'GBP',quote:'KRW',rate:1800,date:'2026-02-30'}]) assert.throws(()=>api.parseRate(p,'GBP'));
});
test('FX fetch deduplicates currencies, sends no account data and reports partial failure',async()=>{
  const calls=[];
  const r=await api.fetchRates(['GBP','GBP','KRW','USD'],async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/usd/')) return {ok:false,status:503};
    return {ok:true,json:async()=>({base:'GBP',quote:'KRW',rate:1800,date:'2026-10-09'})};
  });
  assert.equal(calls.length,2);assert.equal(r.rates.GBP.rate,1800);assert.deepEqual(r.errors,['USD']);
  assert.equal(calls[0].options.credentials,'omit');assert.ok(!calls[0].url.includes('amount'));
});
