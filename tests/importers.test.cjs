const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../importers.js');
const ledgerHeader = ['거래일자','거래명','거래내용','통화코드','금액(수량)','','현금잔액','잔고수량','평가금액','거래단가'];
const execution = (day, side, qty, price, name = '테스트') => [day,side,name,'',side === '매수' ? -qty : '',side === '매도' ? -qty : '',null,null,null,price];
test('reverse chronology, partial sales and remaining stock do not drop realized P&L', () => {
  const result = api.parseFile([ledgerHeader,execution('2026-01-05','매도',4,150),execution('2026-01-02','매수',10,100)]);
  assert.equal(result.trades[0].realizedPnl,200);
  assert.equal(result.openPositions[0].qty,6);
  assert.equal(result.openPositions[0].cost,600);
});
test('fee(quantity) is parsed as quantity, preserving partial sale', () => {
  const sell = execution('2026-01-05','매도',100,120); sell[5]='640(100)';
  const result = api.parseFile([ledgerHeader,sell,execution('2026-01-02','매수',150,100)]);
  assert.equal(result.trades[0].qty,100); assert.equal(result.trades[0].realizedPnl,2000);
});
test('SheetJS sparse header cells are normalized', () => {
  const sparse=[...ledgerHeader];delete sparse[5];
  const result=api.parseFile([sparse,execution('2026-01-05','매도',1,120),execution('2026-01-02','매수',1,100)]);
  assert.equal(result.trades[0].realizedPnl,20);
});
test('same-day settlement grouping and precise weighted average prices', () => {
  const result=api.parseFile([ledgerHeader,execution('2026-01-02','매도',3,11),execution('2026-01-02','매수',1,10),execution('2026-01-02','매수',2,10.1)]);
  assert.ok(Math.abs(result.trades[0].realizedPnl-2.8)<1e-8);
  assert.equal(result.openPositions.length,0);
});
test('missing initial purchase is visible, not a zero or false gain', () => {
  assert.throws(()=>api.parseFile([ledgerHeader,execution('2026-01-02','매도',3,11)]),/매입원가가 부족/);
});
test('official Samsung net profit is used exactly and not rebuilt from prices', () => {
  const rows=[['매매일자','매수금액','매도금액','손익(A)','수수료(B)','세금(C)','순손익(A-B-C)','수익률'],['2026-01-02',1000,1200,200,2,3,195,19.5],['2026-01-03',1000,1000,0,0,0,0,0]];
  const result=api.parseFile(rows);
  assert.equal(result.trades.reduce((s,t)=>s+t.realizedPnl,0),195);
  assert.equal(result.trades[1].realizedPnl,0);
});
const tHeader=['Action','Time','ISIN','Ticker','Name','No. of shares','Price / share','Currency (Price / share)','Result','Currency (Result)','Total','Currency (Total)','ID','Currency conversion fee','Currency (Currency conversion fee)'];
const tRow=(action,time,qty,price,result,total,currency='GBP',id='')=>[action,time,'test','TEST','Test Corp',qty,price,'USD',result,currency,total,currency,id,'',''];
test('Trading 212 preserves Result zero while using cost-inclusive Total; fractions and currencies survive', () => {
  const rows=[tHeader,tRow('Market buy','2026-01-02 10:00:00',0.25,100,'',20),tRow('Market sell','2026-01-03 10:00:00',0.25,101,0,20.2)];
  rows[2][13]=0.03; rows[2][14]='GBP';
  const r=api.parseFile(rows); assert.equal(r.trades[0].qty,0.25);assert.equal(r.trades[0].reportedPnl,0);assert.ok(Math.abs(r.trades[0].realizedPnl-0.2)<1e-8);assert.equal(r.trades[0].currency,'GBP');assert.equal(r.expenses.GBP,0.03);
});
test('Total fallback includes costs once and uses account currency, not instrument USD', () => {
  const r=api.parseFile([tHeader,tRow('Market sell','2026-01-03 10:00:00',0.5,60,'',23.8),tRow('Market buy','2026-01-02 10:00:00',0.5,50,'',20.2)]);
  assert.ok(Math.abs(r.trades[0].realizedPnl-3.6)<1e-8);assert.equal(r.trades[0].currency,'GBP');
});
test('Result allows a partial history, but lack of both cost and Result fails clearly', () => {
  assert.equal(api.parseFile([tHeader,tRow('Market sell','2026-01-03',1,100,5,100)]).trades[0].unknownCost,true);
  assert.throws(()=>api.parseFile([tHeader,tRow('Market sell','2026-01-03',1,100,'',100)]),/매입원가와 Result/);
});
test('Result currencies remain separate and two identical legitimate sales survive', () => {
  const r=api.parseFile([tHeader,tRow('Market sell','2026-01-03',1,100,5,100,'USD'),tRow('Market sell','2026-01-03',1,100,5,100,'USD'),tRow('Market sell','2026-01-03',1,100,2,100,'EUR')]);
  assert.equal(r.trades.length,3);assert.equal(new Set(r.trades.map(t=>t.id)).size,3);
  assert.deepEqual([...new Set(r.trades.map(api.viewKey))],['trading212:USD','trading212:EUR']);
});
test('deposits do not become gains and dividends/interest stay separate', () => {
  const r=api.parseFile([tHeader,tRow('Deposit','2026-01-01',0,0,'',1000),tRow('Dividend (Ordinary)','2026-01-02',0,0,'',2),tRow('Interest on cash','2026-01-02',0,0,'',1),tRow('Market sell','2026-01-03',1,100,5,100)]);
  assert.equal(r.trades.length,1);assert.equal(r.income.GBP,3);assert.equal(r.trades[0].realizedPnl,5);
});
test('reimport replaces one format and preserves other brokers/manual records', () => {
  const record={source:'samsung-ledger',currency:'KRW',id:'new'},r={source:'samsung-ledger',trades:[record]};
  const old=[{id:'manual'},{source:'samsung-ledger',id:'old'},{source:'trading212',id:'foreign'},{source:'samsung-summary',id:'summary'}];
  const once=api.replaceImport(old,r),twice=api.replaceImport(once,r);
  assert.deepEqual(once,twice);assert.equal(once.length,4);assert.ok(once.some(t=>t.id==='foreign'));
});
test('CSV handles BOM, quoted commas, newlines and escaped quotes',()=>{
  assert.deepEqual(api.csv('\uFEFFAction,Name\r\n"Market sell","Company, Inc.\n""Class A"""\r\n'),[['Action','Name'],['Market sell','Company, Inc.\n"Class A"']]);
  assert.throws(()=>api.csv('a,"unclosed'),/따옴표/);
});
test('incomplete CFD headers do not get silently misparsed as equities',()=>{
  assert.throws(()=>api.parseFile([['RecordType','Result'],['CLOSED_POSITION',2]]),/CFD/);
});
test('ISA Time (UTC) and FX-inclusive totals are recognized without double deduction',()=>{
  const header=[...tHeader];header[1]='Time (UTC)';
  const buy=tRow('Market buy','2026-01-01 10:00:00+00:00',0.5,100,'',50);buy[13]=0.075;
  const sell=tRow('Market sell','2026-01-02 10:00:00+00:00',0.5,120,10.15,60);sell[13]=0.075;
  const r=api.parseFile([header,buy,sell]);assert.equal(r.trades[0].realizedPnl,10);assert.equal(r.trades[0].reportedPnl,10.15);assert.equal(r.trades[0].reportedOnly,false);
});
const cHeader=['Record Type','Date (UTC)','Account currency','Instrument','Symbol','Instrument currency','Direction','Units','Position ID','Order ID','Date opened (UTC)','Date closed (UTC)','Average price (instrument currency)','Close price (instrument currency)','Result (account currency)','FX fee (account currency)','Result after FX fee (account currency)','Overnight interest (account currency)','Dividend adjustment (account currency)','Total result (account currency)','Amount (account currency)','Amount net (account currency)'];
const cRow=(type,pnl=0,order='one')=>[type,'2026-01-02 10:00:00+00:00','GBP','Test CFD','TEST','USD','Sell',0.125,'position',order,'2026-01-01 10:00:00+00:00','2026-01-02 10:00:00+00:00',100,90,10,-0.05,9.95,-0.95,1,pnl,'',''];
test('CFD closed Total includes costs once, preserving shorts and partial close events',()=>{
  const interest=cRow('Overnight interest');interest[20]=-0.95;
  const order=cRow('Order',999);const deposit=cRow('Transaction',999);deposit[20]=1000;
  const r=api.parseFile([cHeader,cRow('Closed position',10,'one'),order,interest,deposit,cRow('Closed position',0,'two')]);
  assert.equal(r.trades.length,2);assert.equal(r.trades.reduce((s,t)=>s+t.realizedPnl,0),10);
  assert.equal(r.trades[0].direction,'숏');assert.equal(r.trades[0].qty,0.125);assert.equal(r.trades[0].priceCurrency,'USD');
  assert.equal(r.trades[0].unknownCost,true);assert.equal(r.trades[0].unknownHold,false);
  assert.equal(r.events['GBP Overnight interest'],-0.95);assert.equal(r.breakdown.GBP.fx,-0.1);
});
test('CFD reported zero survives and missing Total result fails instead of inventing profit',()=>{
  const r=api.parseFile([cHeader,cRow('Closed position',0)]);assert.equal(r.trades[0].realizedPnl,0);
  const bad=cRow('Closed position','');assert.throws(()=>api.parseFile([cHeader,bad]),/Total result/);
});
test('ISA and CFD of the same currency stay separate and reimport preserves the other account',()=>{
  const isa=api.parseFile([tHeader,tRow('Market sell','2026-01-03',1,100,5,100)]);
  const cfd=api.parseFile([cHeader,cRow('Closed position',-2)]);
  const all=api.replaceImport(isa.trades,cfd);assert.equal(all.length,2);
  assert.deepEqual(all.map(api.viewKey),['trading212:GBP','trading212-cfd:GBP']);
  assert.deepEqual(api.replaceImport(all,cfd),all);
});
test('older currency-in-title Trading 212 export is recognized',()=>{
  const rows=[['Action','Time','Name','No. of shares','Price / share','Result (EUR)','Total (EUR)'],['Market sell','2026-01-03','Test',0.1,10,0,1]];
  const r=api.parseFile(rows);assert.equal(r.trades[0].currency,'EUR');assert.equal(r.trades[0].realizedPnl,0);
});
test('corporate actions prevent an unsupported cost reconstruction',()=>{
  assert.throws(()=>api.parseFile([tHeader,tRow('Stock split','2026-01-01',2,50,'',''),tRow('Market buy','2026-01-02',1,50,'',50),tRow('Market sell','2026-01-03',1,60,'',60)]),/기업행동/);
});
