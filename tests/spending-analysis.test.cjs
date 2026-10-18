const {test}=require('node:test');
const assert=require('node:assert/strict');
const a=require('../spending-analysis.js'),core=require('../spending-core.js');
const tx=(key,amount,extras={})=>({key,date:'2026-10-01',name:key,category:'General',type:'Faster payment',notes:'',amount,...extras});
const plan={id:'rent',name:'월세',merchant:'Test Landlord',amount:650,day:31,start:'2026-01',end:'',active:true};
test('salary in notes and reimbursements precede the explicit other-incoming transfer policy',()=>{
 const m=a.normalize({otherIncomeTransfers:true});
 assert.equal(a.classify(tx('blank',3000,{notes:'Salary for Sep 2026',type:'chaps'}),m).kind,'income');
 assert.equal(a.classify(tx('refund',35,{notes:'Exp reimbursement for May 26'}),m).kind,'refund');
 assert.equal(a.classify(tx('shop',20,{type:'Card payment'}),m).kind,'refund');
 assert.equal(a.classify(tx('own',500),m).kind,'transfer');
 assert.equal(a.classify(tx('unknown',-30),m).kind,'review');
});
test('classified cash flow reconciles without counting transfers as spending or income',()=>{
 const m=a.normalize({otherIncomeTransfers:true,fixed:[plan]});
 const rows=[tx('pay',3000,{notes:'Salary'}),tx('own',500),tx('rent',-650,{name:'Test Landlord'}),tx('food',-100,{type:'Card payment'}),tx('refund',20,{type:'Card payment'}),tx('pot',-200,{type:'Pot transfer'}),tx('unknown',-30)];
 const s=a.summarize(rows,m);assert.equal(s.spend,750);assert.equal(s.income,3000);assert.equal(s.surplus,2270);assert.equal(s.transferIn,500);assert.equal(s.transferOut,200);assert.equal(s.reviewOut,30);
 assert.equal(s.cashNet,s.surplus+s.transferIn-s.transferOut+s.reviewIn-s.reviewOut);
});
test('individual exceptions outrank exact merchant and direction rules and fixed plans',()=>{
 const m=a.normalize({fixed:[plan],rules:[{merchant:' Test Landlord ',direction:'out',kind:'transfer'}],overrides:{one:'expense'}});
 assert.equal(a.classify(tx('one',-650,{name:'Test Landlord'}),m).kind,'expense');
 assert.equal(a.classify(tx('two',-650,{name:'test landlord'}),m).kind,'transfer');
 assert.equal(a.classify(tx('three',20,{name:'Test Landlord'}),m).kind,'review');
 assert.notEqual(a.merchant('Shop 12'),a.merchant('Shop 13'));
});
test('month-end due dates, partial payments and absent CSV do not manufacture paid or overdue records',()=>{
 assert.equal(a.dueDate('2024-02',31),'2024-02-29');assert.equal(a.dueDate('2026-02',31),'2026-02-28');
 const store=core.empty();store.management=a.normalize({fixed:[plan]});store.tx=[tx('rent',-300,{name:'Test Landlord'})];
 let row=a.planRows(store,'2026-10','2026-10-19')[0];assert.equal(row.actual,300);assert.equal(row.remaining,350);assert.match(row.status,/일부/);
 row=a.planRows(store,'2026-11','2026-10-19')[0];assert.match(row.status,/CSV 기간 밖/);assert.equal(row.actual,0);assert.equal(store.tx.length,1);
});
test('fixed plans reject overlapping periods but permit successor prices and retain historical amounts',()=>{
 assert.throws(()=>a.normalize({fixed:[plan,{...plan,id:'duplicate'}]}),/겹칩니다/);
 const store=core.empty();store.management=a.normalize({fixed:[{...plan,end:'2026-09'},{...plan,id:'new',amount:700,start:'2026-10'}]});
 assert.equal(a.planRows(store,'2026-09','2026-10-19')[0].amount,650);assert.equal(a.planRows(store,'2026-10','2026-10-19')[0].amount,700);
});
test('recurrence suggestions require monthly evidence and never automatically become fixed spending',()=>{
 const store=core.empty();store.tx=[1,2,3].map(i=>tx('sub'+i,-12,{name:'Test Subscription',date:`2026-0${i}-03`,type:'Card payment'}));
 store.tx.push(tx('shop1',-30,{name:'Test Grocer',date:'2026-03-02',type:'Card payment'}),tx('shop2',-31,{name:'Test Grocer',date:'2026-03-09',type:'Card payment'}));
 assert.equal(a.suggestions(store).length,1);assert.equal(a.summarize(store.tx,store.management).fixed,0);
 store.management.dismissed=['test subscription'];assert.equal(a.suggestions(store).length,0);
});
test('classification settings survive legacy migration, reimport and JSON backup',()=>{
 let store=core.mergeCSV(core.empty(),'Transaction ID,Date,Name,Amount\nx,2026-10-01,Test Landlord,-650').store;
 store.management=a.normalize({fixed:[plan],otherIncomeTransfers:true});
 store=core.mergeCSV(store,'Transaction ID,Date,Name,Amount\nx,2026-10-01,Test Landlord,-650').store;
 const restored=core.normalize(JSON.parse(JSON.stringify(store)));assert.equal(restored.tx.length,1);assert.equal(a.summarize(restored.tx,restored.management).fixed,650);assert.equal(restored.management.otherIncomeTransfers,true);
});
test('zero authorisations are visible but never unresolved money; user incoming policy overrides generic Income category',()=>{
 const m=a.normalize({otherIncomeTransfers:true});
 const s=a.summarize([tx('auth',0,{type:'Card payment'}),tx('own',100,{category:'Income'})],m);
 assert.equal(s.reviewCount,0);assert.equal(s.income,0);assert.equal(s.transferIn,100);assert.equal(s.cashNet,100);
});
