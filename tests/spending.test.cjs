const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const api=require('../spending-core.js');
const monzo='Transaction ID,Date,Name,Category,Amount,Notes and #tags,Type\nabc,17/10/2026,테스트 상점,Shopping,-12.50,메모,Card payment\ndef,16/10/2026,테스트 급여,Income,1000,,Transfer';

test('Monzo CSV adds signed transactions, preserves notes, and deduplicates overlapping exports by ID',()=>{
  const one=api.mergeCSV(api.empty(),monzo);assert.equal(one.added,2);assert.equal(one.store.tx[0].amount,-12.5);assert.equal(one.store.tx[0].notes,'메모');
  const again=api.mergeCSV(one.store,monzo);assert.equal(again.added,0);assert.equal(again.store.tx.length,2);
});
test('Money Out and Money In columns use the correct sign, including blank and zero cells',()=>{
  const result=api.mergeCSV(api.empty(),'Date,Description,Money Out,Money In\n2026-10-01,식비,25,\n2026-10-02,입금,,100\n2026-10-03,빈출금,0,20');
  assert.deepEqual(result.store.tx.map(t=>t.amount),[20,100,-25]);
});
test('no-ID exports retain identical legitimate transactions but do not duplicate reordered overlapping files',()=>{
  const text='Date,Name,Category,Amount\n2026-10-01,Cafe,Food,-3\n2026-10-01,Cafe,Food,-3\n2026-10-02,Shop,Shopping,-4';
  const one=api.mergeCSV(api.empty(),text);assert.equal(one.added,3);
  const two=api.mergeCSV(one.store,'Date,Name,Category,Amount\n2026-10-02,Shop,Shopping,-4\n2026-10-01,Cafe,Food,-3\n2026-10-01,Cafe,Food,-3');
  assert.equal(two.added,0);assert.equal(two.store.tx.length,3);
});
test('legacy fallback keys, budgets, goals and currency remain compatible with the original spending tracker',()=>{
  const old={tx:[{key:'2026-10-01|-3|Cafe|1',date:'2026-10-01',amount:-3,name:'Cafe',category:'Food',type:''}],budgets:{Food:50},totalBudget:100,currency:'£',goals:[{name:'테스트 목표',target:200,current:50}]};
  const restored=api.normalize(JSON.parse(JSON.stringify(old)));assert.equal(restored.tx[0].key,old.tx[0].key);assert.equal(restored.budgets.Food,50);assert.equal(restored.goals[0].current,50);
  assert.equal(api.mergeCSV(restored,'Date,Name,Category,Amount\n2026-10-01,Cafe,Food,-3').added,0);
  assert.deepEqual(old.goals,[{name:'테스트 목표',target:200,current:50}]);
});
test('invalid data cannot replace a valid store, and malformed or unrelated files fail clearly',()=>{
  const old=api.mergeCSV(api.empty(),monzo).store,before=JSON.stringify(old);
  assert.throws(()=>api.mergeCSV(old,'Date,Amount\n31/02/2026,-3'),/날짜/);
  assert.throws(()=>api.mergeCSV(old,'Not a bank,Wrong\nhello,2'),/Date/);
  assert.throws(()=>api.normalize({version:1,loans:[]}),/백업/);
  assert.throws(()=>api.normalize({tx:[{key:'x',date:'2026-01-01',amount:Infinity,name:'x',category:'x'}]}),/금액/);
  assert.equal(JSON.stringify(old),before);
});
test('CSV quoting, BOM, dates and previous-month boundaries are deterministic across timezones',()=>{
  const rows=api.parseCSV('\uFEFFDate,Name,Amount\r\n2026-01-01,"A, ""B""",-3');assert.equal(rows[1][1],'A, "B"');
  assert.equal(api.parseDate('29/02/2024'),'2024-02-29');assert.equal(api.parseDate('29/02/2026'),null);
  assert.equal(api.prevMonth('2026-01'),'2025-12');assert.equal(api.prevMonth('2026-10'),'2026-09');
  assert.equal(api.toNum('(£1,234.50)'),-1234.5);
});

function embeddedApp(raw,rate){
  const elements=new Map(),saved=new Map([['spend_tracker_v1',JSON.stringify(raw)],['suiknote_v1_loans','keep-loans'],['suiknote_v1','keep-stocks']]);
  if(rate)saved.set('suiknote_v1_fx',JSON.stringify({GBP:rate}));
  function el(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',style:{},listeners:{},classList:{add(){},remove(){}},addEventListener(name,cb){this.listeners[name]=cb;},getBoundingClientRect(){return {height:1000};}});return elements.get(id);}
  const window={addEventListener(){}};window.parent=window;
  const context={SpendingAnalysis:require('../spending-analysis.js'),SpendingCore:api,StockPortfolio:require('../portfolio.js'),window,document:{getElementById:el,querySelectorAll:()=>[],body:{getBoundingClientRect:()=>({height:1000})}},localStorage:{getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v)},requestAnimationFrame:fn=>fn(),setTimeout:()=>0,clearTimeout(){},console};
  vm.createContext(context);vm.runInContext(fs.readFileSync(require.resolve('../spending.js'),'utf8'),context);
  return {elements,saved};
}
test('existing spending data renders budgets, goals, transactions and backup controls even when charts fail to load',()=>{
  const raw=api.mergeCSV(api.empty(),monzo).store;raw.totalBudget=100;raw.budgets.Shopping=20;raw.goals=[{name:'테스트 여행',target:100,current:10}];
  const {elements,saved}=embeddedApp(raw);
  assert.match(elements.get('cards').innerHTML,/12.5/);assert.match(elements.get('goalList').innerHTML,/테스트 여행/);
  assert.match(elements.get('budgetArea').innerHTML,/월 전체/);assert.match(elements.get('txBody').innerHTML,/테스트 상점/);
  assert.match(elements.get('chartNotice').textContent,/라이브러리/);assert.equal(elements.get('controls').style.display,'');
  assert.equal(saved.get('suiknote_v1_loans'),'keep-loans');assert.equal(saved.get('suiknote_v1'),'keep-stocks');
});
test('CSV and backup text is escaped before use in category budget HTML',()=>{
  const raw=api.mergeCSV(api.empty(),monzo).store;raw.tx[0].category='<img src=x onerror=alert(1)>';raw.budgets[raw.tx[0].category]=100;
  const {elements}=embeddedApp(raw);
  assert.ok(!elements.get('catBudgets').innerHTML.includes('<img'));assert.ok(!elements.get('budgetArea').innerHTML.includes('<img'));
  assert.match(elements.get('catBudgets').innerHTML,/&lt;img/);
});
test('empty spending stores still expose restore and backup controls',()=>{
  const {elements}=embeddedApp(api.empty());assert.equal(elements.get('controls').style.display,'');assert.equal(elements.get('clearBtn').disabled,true);
});

test('dual amounts multiply pounds by the applied rate, preserve signs, and reverse only display order',()=>{
  assert.equal(api.formatDual(12.5,1800),'£12.50 · 약 22,500원');
  assert.equal(api.formatDual(-12.5,1800,'GBP',true),'-£12.50 · 약 -22,500원');
  assert.equal(api.formatDual(12.5,2000,'KRW'),'25,000원 · £12.50');
  for(const rate of [null,0,-1,NaN,Infinity])assert.equal(api.formatDual(12.5,rate),'£12.50 · 환율 확인 필요');
});

test('changing the shared GBP rate updates spending, budgets, goals and rows without changing original amounts',()=>{
  const raw=api.mergeCSV(api.empty(),monzo).store;raw.totalBudget=100;raw.goals=[{name:'여행',target:200,current:10}];
  const before=JSON.stringify(raw),{elements,saved}=embeddedApp(raw,{rate:1800,date:'2026-10-17',source:'수동입력'});
  assert.match(elements.get('txBody').innerHTML,/-22,500원/);
  assert.match(elements.get('goalList').innerHTML,/360,000원/);
  elements.get('fxRate').value='2000';elements.get('applyFX').listeners.click();
  assert.equal(JSON.parse(saved.get('suiknote_v1_fx')).GBP.rate,2000);
  assert.match(elements.get('cards').innerHTML,/25,000원/);
  assert.match(elements.get('budgetArea').innerHTML,/200,000원/);
  assert.match(elements.get('goalList').innerHTML,/400,000원/);
  elements.get('currency').listeners.change({target:{value:'KRW'}});
  assert.match(elements.get('txBody').innerHTML,/-25,000원 · -£12.50/);
  assert.equal(saved.get('spend_tracker_v1'),before);
  assert.equal(saved.get('suiknote_v1_loans'),'keep-loans');
  elements.get('fxRate').value='0';elements.get('applyFX').listeners.click();
  assert.equal(JSON.parse(saved.get('suiknote_v1_fx')).GBP.rate,2000);
  assert.match(elements.get('fxError').textContent,/양수/);
});

test('missing or malformed stored exchange rate shows GBP and requests a rate instead of relabelling it as won',()=>{
  const raw=api.mergeCSV(api.empty(),monzo).store;
  for(const rate of [undefined,{rate:1800,date:'2026-02-30',source:'수동입력'}]){
    const {elements}=embeddedApp(raw,rate);
    assert.match(elements.get('cards').innerHTML,/£12.50 · 환율 확인 필요/);
    assert.match(elements.get('fxSummary').textContent,/환율 미확인/);
    assert.ok(!elements.get('cards').innerHTML.includes('12.50원'));
  }
});

test('non-GBP account exports cannot be silently mixed, while merchant local currency does not change GBP account amounts',()=>{
  assert.throws(()=>api.mergeCSV(api.empty(),'Date,Amount,Currency\n2026-10-01,-10,USD'),/GBP/);
  assert.equal(api.mergeCSV(api.empty(),'Date,Amount,Currency,Local currency\n2026-10-01,-10,GBP,USD').store.tx[0].amount,-10);
});
