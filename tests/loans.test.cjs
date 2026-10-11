const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../loans.js');
const base = extra => api.normalize({id:'loan',name:'테스트 대출',bank:'',type:'credit',mode:'bullet',startDate:'2026-01-01',initialBalance:36500,annualRate:10,limit:0,paymentDay:31,maturity:'2026-12-31',dayBasis:'actual',events:[],...extra});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('daily interest includes both boundary days, with repayments and rate changes effective on the recorded day',()=>{
  const loan=base({events:[{id:'rate',type:'rate',date:'2026-01-15',amount:6},{id:'repay',type:'repay',date:'2026-01-10',amount:6500,interest:101},{id:'interest',type:'interest',date:'2026-01-15',amount:55}]});
  near(api.estimate(loan,'2026-01-01','2026-01-20').amount,90+5*30000*.1/365+6*30000*.06/365);
  assert.equal(api.at(loan,'2026-01-09').balance,36500);
  assert.equal(api.at(loan,'2026-01-10').balance,30000);
  assert.equal(api.recordedInterest(loan,'2026-01-01','2026-01-20'),156);
  assert.equal(api.recordedInterest(loan,'2026-01-11','2026-01-20'),55);
});
test('zero-rate loans, leap years and year boundaries do not lose or invent interest days',()=>{
  const loan=base({startDate:'2023-12-31'});
  near(api.estimate(loan,'2023-12-31','2024-01-01').amount,10+3650/366);
  const fixed=base({startDate:'2023-12-31',dayBasis:'365'});
  near(api.estimate(fixed,'2023-12-31','2024-01-01').amount,20);
  assert.equal(api.estimate(base({annualRate:0}),'2026-01-01','2026-02-01').amount,0);
  assert.throws(()=>api.date('2026-02-29'));
});
test('overdraft usage changes the used balance, cash-paid interest does not, and capitalized interest is counted once',()=>{
  const loan=base({type:'overdraft',limit:50000,events:[{id:'draw',type:'draw',date:'2026-01-02',amount:1000},{id:'paid',type:'interest',date:'2026-01-03',amount:100},{id:'capital',type:'interest',date:'2026-01-04',amount:200,capitalized:true}]});
  const s=api.summary(loan,'2026-01-04','2026-01-01','2026-01-04');
  assert.equal(s.balance,37700);assert.equal(s.available,12300);assert.equal(s.recorded,300);
  assert.equal(api.at(loan,'2026-01-03').balance,37500);
  assert.throws(()=>base({type:'overdraft',limit:36000}),/한도/);
  assert.throws(()=>base({type:'overdraft',limit:37000,events:[{id:'draw',type:'draw',date:'2026-01-02',amount:1000}]}),/한도/);
});
test('historical cash interest can be recorded before a current balance anchor, without inventing historical principal',()=>{
  const loan=base({startDate:'2026-02-01',events:[{id:'old',type:'interest',date:'2026-01-15',amount:200}]});
  assert.equal(api.recordedInterest(loan,'2026-01-01','2026-02-01'),200);
  assert.equal(api.at(loan,'2026-01-15').balance,0);
  assert.equal(api.estimate(loan,'2026-01-01','2026-01-31').amount,0);
  assert.equal(api.estimate(loan,'2026-01-01','2026-02-01').partial,true);
  assert.throws(()=>base({startDate:'2026-02-01',events:[{id:'old',type:'repay',date:'2026-01-15',amount:200}]}),/기준일/);
});
test('same-day event order is retained and invalid repayment corrections fail rather than producing negative debt',()=>{
  assert.throws(()=>base({events:[{id:'repay',type:'repay',date:'2026-01-10',amount:40000}]}),/상환 원금/);
  const loan=base({initialBalance:0,events:[{id:'a',type:'draw',date:'2026-01-10',amount:1000},{id:'b',type:'repay',date:'2026-01-10',amount:1000}]});
  assert.equal(api.at(loan,'2026-01-10').balance,0);
  assert.throws(()=>api.normalize({...loan,events:[loan.events[1],loan.events[0]]}),/상환 원금/);
});
test('payment day 31 uses month end, already-recorded due-day interest advances the next due date',()=>{
  const loan=base();
  assert.equal(api.nextDue(loan,'2026-02-01'),'2026-02-28');
  assert.equal(api.nextDue(loan,'2026-02-28'),'2026-02-28');
  const paid=base({events:[{id:'interest',type:'interest',date:'2026-02-28',amount:100}]});
  assert.equal(api.nextDue(paid,'2026-02-28'),'2026-03-31');
});
test('equal-principal and bullet plans cover every due date, including the maturity balloon',()=>{
  const loan=base({initialBalance:1200,annualRate:36.5,mode:'principal',maturity:'2026-03-31'});
  const rows=api.plan(loan,'2026-01-01');
  assert.deepEqual(rows.map(r=>r.date),['2026-01-31','2026-02-28','2026-03-31']);
  assert.deepEqual(rows.map(r=>r.principal),[400,400,400]);
  [36,22.4,12.4].forEach((expected,i)=>near(rows[i].interest,expected));
  assert.equal(rows[2].balance,0);
  const bullet=api.plan({...loan,mode:'bullet'},'2026-01-01');
  assert.deepEqual(bullet.map(r=>r.principal),[0,0,1200]);
  assert.equal(bullet[2].balance,0);
});
test('amortized payments balance the loan using actual day intervals, and zero rate stays finite',()=>{
  const loan=base({initialBalance:1200,annualRate:36.5,mode:'amortized',maturity:'2026-03-31'});
  const rows=api.plan(loan,'2026-01-01');
  const expected=1200*1.03*1.028*1.031/(1.028*1.031+1.031+1);
  rows.forEach(r=>near(r.total,expected));
  near(rows.reduce((s,r)=>s+r.principal,0),1200);assert.equal(rows[2].balance,0);
  const zero=api.plan({...loan,annualRate:0},'2026-01-01');
  zero.forEach(r=>near(r.total,400));
});
test('unknown or passed maturity does not create an invented future payoff plan',()=>{
  assert.deepEqual(api.plan(base({maturity:''}),'2026-01-01'),[]);
  const overdue=api.summary(base({maturity:'2026-01-31'}),'2026-02-01','2026-01-01','2026-02-01');
  assert.equal(overdue.overdue,true);assert.deepEqual(overdue.schedule,[]);
  assert.throws(()=>base({mode:'principal',maturity:''}),/만기일/);
});
test('backup validates ids, balances and schema; financial data cannot inject arbitrary fields',()=>{
  const loan=base();
  assert.equal(api.readBackup({version:1,loans:[{...loan,untrustedInstruction:'ignored'}]})[0].untrustedInstruction,undefined);
  assert.throws(()=>api.readBackup({version:1,loans:[loan,loan]}),/중복/);
  assert.throws(()=>api.readBackup({version:2,loans:[loan]}),/백업/);
});

test('confirmed balances replace principal from their date, without inventing repayments or paid interest',()=>{
  const loan=base({events:[{id:'snapshot',type:'balance',date:'2026-01-10',amount:30000,annualRate:6}]});
  assert.equal(api.at(loan,'2026-01-09').balance,36500);
  assert.equal(api.at(loan,'2026-01-10').balance,30000);
  assert.equal(api.at(loan,'2026-01-10').rate,6);
  near(api.estimate(loan,'2026-01-01','2026-01-20').amount,90+11*30000*.06/365);
  assert.equal(api.recordedInterest(loan,'2026-01-01','2026-01-20'),0);
  assert.equal(api.summary(loan,'2026-01-20','2026-01-01','2026-01-20').confirmed,'2026-01-10');
  assert.equal(api.summary(loan,'2026-01-09','2026-01-01','2026-01-09').confirmed,'2026-01-01');
});

test('confirmed zero balances stop plans; omitted rates preserve history while zero is a valid new rate',()=>{
  const loan=base({events:[{id:'a',type:'balance',date:'2026-01-10',amount:30000},{id:'b',type:'balance',date:'2026-01-11',amount:30000,annualRate:0},{id:'c',type:'balance',date:'2026-01-12',amount:0}]});
  assert.equal(api.at(loan,'2026-01-10').rate,10);
  assert.equal(api.at(loan,'2026-01-11').rate,0);
  const restored=api.readBackup({version:1,loans:[JSON.parse(JSON.stringify(loan))]})[0];
  assert.equal(restored.events[0].annualRate,null);assert.equal(restored.events[1].annualRate,0);
  const summary=api.summary(restored,'2026-01-12','2026-01-01','2026-01-12');
  assert.equal(summary.balance,0);assert.equal(summary.next,'');assert.deepEqual(summary.schedule,[]);
});

test('balance confirmations respect overdraft limits and the original balance anchor',()=>{
  assert.throws(()=>base({type:'overdraft',limit:40000,events:[{id:'a',type:'balance',date:'2026-01-10',amount:40001}]}),/한도/);
  assert.throws(()=>base({events:[{id:'a',type:'balance',date:'2025-12-31',amount:1000}]}),/기준일/);
  assert.throws(()=>base({events:[{id:'a',type:'balance',date:'2026-01-10',amount:1000,annualRate:101}]}),/금리/);
});
