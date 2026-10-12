const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const imports = require('../importers.js');
const portfolio = require('../portfolio.js');
const loans = require('../loans.js');
function app() {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const script = html.split('<script type="text/x-dc" data-dc-script>')[1].split('</script>')[0];
  const context = { DCLogic:class {}, StockImports:imports, StockPortfolio:portfolio, StockLoans:loans, window:{}, localStorage:{}, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(script + '\nthis.App = Component;', context);
  const component = new context.App(); component.scheduleDraw = () => {};
  return component;
}
test('trade details and stock filters stay visible while domestic headline stays official net', () => {
  const c = app();
  c.state.trades = [
    {id:'cash',source:'samsung-ledger',name:'테스트',qty:2,buyPrice:100,sellPrice:120,invested:200,realizedPnl:40,netPnl:35,costKnown:true,fees:5,buyDate:'2026-01-02',sellDate:'2026-01-03'},
    {id:'unknown',source:'samsung-ledger',name:'다른종목',qty:1,buyPrice:100,sellPrice:90,invested:100,realizedPnl:-10,buyDate:'2026-01-02',sellDate:'2026-01-04'},
    {id:'official',source:'samsung-summary',kind:'summary',name:'일별 합계',qty:1,buyPrice:300,sellPrice:330,invested:300,realizedPnl:22,buyDate:'2026-01-03',sellDate:'2026-01-03'},
    {id:'foreign',source:'trading212',name:'Overseas',currency:'GBP',qty:1,buyPrice:100,sellPrice:150,realizedPnl:50,buyDate:'2026-01-02',sellDate:'2026-01-03'}
  ];
  c.state.selectedView = 'samsung-ledger:KRW';
  let v = c.renderVals();
  assert.equal(v.stats.totalPnlLabel, '+22원');
  assert.equal(v.visibleTrades.length, 2); assert.equal(v.stockTotals.length, 2);
  assert.equal(v.sourceViews.length, 2); assert.equal(v.chips.length, 3);
  assert.equal(v.visibleTrades.find(t=>t.id==='cash').pnlBasisLabel, '비용 반영 손익');
  assert.equal(v.visibleTrades.find(t=>t.id==='unknown').pnlBasisLabel, '비용 전 추정');
  c.state.filter = '테스트'; v = c.renderVals();
  assert.equal(v.visibleTrades.length, 1); assert.equal(v.stats.totalPnlLabel, '+22원');
  c.state.trades = c.state.trades.filter(t=>t.source!=='samsung-summary'); v = c.renderVals();
  assert.equal(v.stats.totalPnlLabel,'순손익표 필요'); assert.equal(v.visibleTrades.length,1);
  assert.equal(v.combinedTotal,'삼성 순손익표 필요');
});
test('loan tab is separate, while only recorded interest in the common date range reduces stock net',()=>{
  const c=app();
  c.state.trades=[{id:'t',source:'samsung-summary',kind:'summary',name:'일별 합계',qty:1,buyPrice:1000,sellPrice:2000,invested:1000,realizedPnl:1000,buyDate:'2026-01-15',sellDate:'2026-01-15'},{id:'old',source:'samsung-summary',kind:'summary',name:'일별 합계',qty:1,buyPrice:1000,sellPrice:1500,invested:1000,realizedPnl:500,buyDate:'2025-12-15',sellDate:'2025-12-15'}];
  c.state.loans=[loans.normalize({id:'loan',name:'테스트',type:'credit',mode:'bullet',startDate:'2026-01-01',initialBalance:1000,annualRate:0,paymentDay:15,maturity:'2027-01-15',events:[{id:'paid',type:'interest',date:'2026-01-10',amount:100},{id:'repay',type:'repay',date:'2026-01-20',amount:250,interest:30},{id:'other',type:'interest',date:'2026-02-10',amount:50}]})];
  c.state.loanFrom='2026-01-01';c.state.loanTo='2026-01-31';c.state.selectedLoanId='loan';
  c.state.accountScope='combined';let v=c.renderVals();
  assert.equal(v.combinedTotal,'+1,500원');assert.equal(v.loanAdjusted.total,'+870원');
  c.state.accountScope='loans';v=c.renderVals();
  assert.equal(v.isLoans,true);assert.equal(v.isAccount,false);assert.equal(v.isList,false);assert.equal(v.showStockTabs,false);
  assert.equal(v.stats.countLabel,'1개 대출');assert.equal(v.loanDashboard.recorded,'130원');assert.equal(v.loanDashboard.accrued,'0원');
  assert.equal(v.loanCards.length,1);
});

test('adjusted profit requires stock data and never labels a partial foreign sum as complete Korean net',()=>{
  const c=app();
  let v=c.renderVals();assert.equal(v.loanAdjusted.total,'주식 순손익 파일 필요');assert.match(v.loanAdjusted.detail,/순손익 미확인/);
  c.state.trades=[{id:'ledger',source:'samsung-ledger',name:'국내',qty:1,buyPrice:100,sellPrice:150,buyDate:'2026-01-01',sellDate:'2026-01-02'}, {id:'foreign',source:'trading212',name:'해외',currency:'KRW',qty:1,buyPrice:100,sellPrice:150,realizedPnl:50,buyDate:'2026-01-01',sellDate:'2026-01-02'}];
  v=c.renderVals();assert.equal(v.loanAdjusted.total,'삼성 순손익표 필요');assert.match(v.loanAdjusted.detail,/순손익 미확인/);
});

test('upcoming due cards expose dates and missing bill amounts while auto projections keep actual costs separate',()=>{
  const c=app();
  const today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
  const maturity=loans.shift(today,365);
  c.state.loans=[loans.normalize({id:'loan',name:'오늘 대출',bank:'테스트 은행',type:'credit',mode:'amortized',startDate:today,initialBalance:1000000,annualRate:6,paymentDay:Number(today.slice(8,10)),maturity,events:[]})];
  c.state.loanAutoAssume=true;
  let v=c.renderVals();assert.equal(v.loanUpcoming[0].dayLabel,'오늘');assert.equal(v.loanUpcoming[0].amount,'은행 청구액 확인');
  assert.equal(v.loanWindowCards[0].total,'금액 확인 필요');assert.match(v.loanBalanceTitle,/정상 납부 가정/);
  assert.equal(v.loanDashboard.recorded,'0원');assert.equal(c.state.loans[0].events.length,0);
  c.state.loanAutoAssume=false;v=c.renderVals();assert.match(v.loanAssumptionNote,/꺼져/);assert.match(v.loanBalanceTitle,/입력 기록/);
});
