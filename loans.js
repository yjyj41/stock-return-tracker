/* Browser-local loan ledger. Estimates are separate from recorded bank charges. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockLoans = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('날짜를 확인해 주세요.');
    const d = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== value) throw new Error('유효한 날짜를 입력해 주세요.');
    return value;
  }
  const stamp = value => new Date(date(value) + 'T00:00:00Z').getTime();
  const shift = (value, days) => new Date(stamp(value) + days * DAY).toISOString().slice(0,10);
  const days = (from, to) => (stamp(to) - stamp(from)) / DAY;
  function numeric(value, label, integer) {
    if (value == null || String(value).trim() === '') throw new Error(label + '을 입력해 주세요.');
    const n = Number(String(value).replace(/,/g,'').trim());
    if (!Number.isFinite(n) || n < 0 || n > 1e14 || (integer && !Number.isSafeInteger(n))) throw new Error(label + '은 0 이상의 올바른 ' + (integer ? '원 단위 금액' : '숫자') + '을 입력해 주세요.');
    return n;
  }
  function annual(value) { const n = numeric(value, '연 금리'); if (n > 100) throw new Error('연 금리는 0~100%로 입력해 주세요.'); return n; }
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('대출 기록 형식이 올바르지 않습니다.');
    const name = String(raw.name || '').trim();
    if (!name || name.length > 100) throw new Error('대출 이름을 100자 이내로 입력해 주세요.');
    if (!['credit','overdraft'].includes(raw.type)) throw new Error('대출 종류를 선택해 주세요.');
    if (!['unknown','bullet','principal','amortized'].includes(raw.mode)) throw new Error('상환 방식을 선택해 주세요.');
    const loan = { id:String(raw.id || ''), name, bank:String(raw.bank || '').trim().slice(0,100), type:raw.type,
      mode:raw.type === 'overdraft' ? 'bullet' : raw.mode, startDate:date(raw.startDate), initialBalance:numeric(raw.initialBalance,'기준일 대출 잔액',true),
      annualRate:annual(raw.annualRate), limit:raw.type === 'overdraft' ? numeric(raw.limit,'마이너스통장 한도',true) : 0,
      paymentDay:raw.paymentDay == null || String(raw.paymentDay).trim() === '' ? null : numeric(raw.paymentDay,'매월 이자 납부일',true), maturity:raw.maturity ? date(raw.maturity) : '', dayBasis:raw.dayBasis === '365' ? '365' : 'actual', note:String(raw.note || '').slice(0,500), events:[] };
    if (!loan.id || loan.id.length > 100) throw new Error('대출 식별자가 올바르지 않습니다.');
    if (loan.paymentDay != null && (loan.paymentDay < 1 || loan.paymentDay > 31)) throw new Error('이자 납부일은 1~31일입니다.');
    if (loan.type === 'overdraft' && loan.limit < loan.initialBalance) throw new Error('사용 잔액이 마이너스통장 한도보다 큽니다.');
    if (loan.maturity && loan.maturity < loan.startDate) throw new Error('만기일은 잔액 기준일 이후로 입력해 주세요.');
    if (loan.maturity && days(loan.startDate,loan.maturity) > 50 * 366) throw new Error('50년 이내의 만기일을 입력해 주세요.');
    if (!Array.isArray(raw.events || [])) throw new Error('대출 거래 기록 형식이 올바르지 않습니다.');
    const ids = new Set();
    loan.events = (raw.events || []).map(e => {
      if (!e || !['draw','repay','interest','rate','balance'].includes(e.type)) throw new Error('대출 거래 종류가 올바르지 않습니다.');
      const id = String(e.id || '');
      if (!id || id.length > 100 || ids.has(id)) throw new Error('대출 거래 식별자가 중복되거나 올바르지 않습니다.');
      ids.add(id);
      const out = {id,type:e.type,date:date(e.date),amount:e.type === 'rate' ? annual(e.amount) : numeric(e.amount,'거래 금액',true),
        interest:e.type === 'repay' ? numeric(e.interest == null || e.interest === '' ? 0 : e.interest,'함께 납부한 이자',true) : 0,
        capitalized:e.type === 'interest' && e.capitalized === true, memo:String(e.memo || '').slice(0,300)};
      if (e.type === 'balance') out.annualRate = e.annualRate == null || String(e.annualRate).trim() === '' ? null : annual(e.annualRate);
      if (out.date < loan.startDate && !(out.type === 'interest' && !out.capitalized)) throw new Error('원금·금리·잔액 편입 거래는 잔액 기준일 이후여야 합니다. 기준일 이전 현금 이자는 별도로 기록할 수 있습니다.');
      if (!['rate','balance'].includes(out.type) && out.amount <= 0) throw new Error('거래 금액은 0원보다 커야 합니다.');
      return out;
    });
    timeline(loan); // Validate all historical balances, including edited records.
    return loan;
  }
  function timeline(loan) {
    let balance = loan.initialBalance, rate = loan.annualRate;
    const rows = [{date:loan.startDate,balance,rate,order:-1}];
    const ordered = loan.events.map((e,i)=>({...e,order:i})).sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order);
    for (const e of ordered) {
      if (e.date < loan.startDate) { rows.push({...e,balance:null,rate}); continue; }
      if (e.type === 'draw' || (e.type === 'interest' && e.capitalized)) balance += e.amount;
      if (e.type === 'repay') balance -= e.amount;
      if (e.type === 'rate') rate = e.amount;
      if (e.type === 'balance') { balance = e.amount; if (e.annualRate != null) rate = e.annualRate; }
      if (balance < 0) throw new Error(e.date + ': 상환 원금이 대출 잔액보다 큽니다.');
      if (loan.type === 'overdraft' && balance > loan.limit) throw new Error(e.date + ': 사용 잔액이 마이너스통장 한도를 초과합니다. 한도를 확인해 주세요.');
      rows.push({...e,balance,rate});
    }
    return rows.sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order);
  }
  function at(loan, asOf) {
    date(asOf);
    const rows = timeline(loan).filter(r=>r.date <= asOf && r.balance !== null);
    return rows.length ? rows[rows.length-1] : {balance:0,rate:loan.annualRate};
  }
  function denominator(value, basis) {
    const y = Number(value.slice(0,4));
    return basis === '365' ? 365 : y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365;
  }
  function factor(rate, basis, from, endExclusive) {
    let result = 0, cursor = from;
    while (cursor < endExclusive) {
      const nextYear = (Number(cursor.slice(0,4))+1) + '-01-01';
      const end = endExclusive < nextYear ? endExclusive : nextYear;
      result += days(cursor,end) * rate / 100 / denominator(cursor,basis);
      cursor = end;
    }
    return result;
  }
  function estimate(loan, from, to) {
    date(from); date(to);
    if (to < from) return {amount:0,coveredDays:0,partial:false};
    const start = from < loan.startDate ? loan.startDate : from;
    if (to < start) return {amount:0,coveredDays:0,partial:true};
    const end = shift(to,1), rows = timeline(loan).filter(r=>r.balance!==null);
    const cuts = [...new Set([start,end,...rows.map(r=>r.date).filter(d=>d>start&&d<end)])].sort();
    let amount = 0, position=0;
    for (let i=0;i<cuts.length-1;i++) {
      while(position+1<rows.length && rows[position+1].date<=cuts[i])position++;
      const current = rows[position];
      amount += current.balance * factor(current.rate,loan.dayBasis,cuts[i],cuts[i+1]);
    }
    return {amount,coveredDays:days(start,end),partial:from<loan.startDate};
  }
  function recordedInterest(loan, from, to) {
    return loan.events.filter(e=>e.date>=from&&e.date<=to).reduce((s,e)=>s+(e.type==='interest'?e.amount:e.type==='repay'?e.interest:0),0);
  }
  function dueInMonth(year, month, day) {
    const last = new Date(Date.UTC(year,month,0)).getUTCDate();
    return [year,String(month).padStart(2,'0'),String(Math.min(day,last)).padStart(2,'0')].join('-');
  }
  function monthShift(value, offset, day) {
    const d = new Date(Date.UTC(Number(value.slice(0,4)),Number(value.slice(5,7))-1+offset,1));
    return dueInMonth(d.getUTCFullYear(),d.getUTCMonth()+1,day);
  }
  function nextDue(loan, asOf) {
    if (!loan.paymentDay) return '';
    let due = monthShift(asOf,0,loan.paymentDay);
    if (due < asOf || (due === asOf && recordedInterest(loan,due,due)>0)) due = monthShift(asOf,1,loan.paymentDay);
    if (due < loan.startDate) due = monthShift(loan.startDate,0,loan.paymentDay) < loan.startDate ? monthShift(loan.startDate,1,loan.paymentDay) : monthShift(loan.startDate,0,loan.paymentDay);
    if (loan.maturity && due > loan.maturity) return loan.maturity >= asOf ? loan.maturity : '';
    return due;
  }
  function plan(loan, asOf, options) {
    date(asOf);
    const current = at(loan,asOf);
    if (!current.balance || !loan.maturity || !loan.paymentDay || loan.mode==='unknown' || loan.maturity < asOf) return [];
    const dates = [], first = nextDue(loan,asOf);
    for (let due=first;due && due<=loan.maturity && dates.length<602;due=monthShift(due,1,loan.paymentDay)) dates.push(due);
    if (dates[dates.length-1] !== loan.maturity) dates.push(loan.maturity);
    const previousDue=monthShift(first,-1,loan.paymentDay);
    let periodStart = previousDue;
    const latestPayment = loan.events.filter(e=>e.date<=asOf && (e.type==='interest'||(e.type==='repay'&&e.interest>0))).map(e=>e.date).sort().pop();
    if (latestPayment && latestPayment > periodStart) periodStart = latestPayment;
    if (periodStart < loan.startDate) periodStart = loan.startDate;
    let pastInterest = periodStart < asOf ? estimate(loan,periodStart,shift(asOf,-1)).amount : 0;
    if(options&&options.fullCycle&&periodStart===loan.startDate&&previousDue<loan.startDate)pastInterest+=loan.initialBalance*factor(loan.annualRate,loan.dayBasis,previousDue,loan.startDate);
    let cursor = asOf;
    const factors = dates.map(d=>{ const f=factor(current.rate,loan.dayBasis,cursor,d);cursor=d;return f; });
    let fixed = 0;
    if (loan.mode === 'amortized') {
      let low=0,high=current.balance*(1+factors[0])+pastInterest+1;
      for(let i=0;i<70;i++) {
        const pay=(low+high)/2;
        let remaining=current.balance;
        factors.forEach((f,j)=>{remaining=remaining*(1+f)+(j===0?pastInterest:0)-pay;});
        if(remaining>0)low=pay;else high=pay;
      }
      fixed=high;
    }
    let balance = current.balance;
    return dates.map((d,i)=>{
      const interest = balance*factors[i]+(i===0?pastInterest:0);
      const principal = i===dates.length-1 ? balance : loan.mode==='bullet' ? 0 : loan.mode==='principal' ? Math.min(balance,current.balance/dates.length) : Math.min(balance,Math.max(0,fixed-interest));
      balance=Math.max(0,balance-principal);
      return {date:d,principal,interest,total:principal+interest,balance};
    });
  }
  function summary(loan, asOf, from, to) {
    const current=at(loan,asOf), next=nextDue(loan,asOf), schedule=plan(loan,asOf);
    const daily=current.balance*current.rate/100/denominator(asOf,loan.dayBasis);
    const confirmed=loan.events.filter(e=>e.type==='balance'&&e.date<=asOf).map(e=>e.date).sort().pop() || loan.startDate;
    return {...current,confirmed,available:loan.type==='overdraft'?Math.max(0,loan.limit-current.balance):null,
      daily,monthly:current.balance*factor(current.rate,loan.dayBasis,asOf,shift(asOf,30)),
      recorded:recordedInterest(loan,from,to),estimate:estimate(loan,from,to),next:current.balance?next:'',schedule,
      overdue:!!(current.balance&&loan.maturity&&loan.maturity<asOf)};
  }
  // Replay assumed payments only in a disposable model. Never persist them as bank transactions.
  function projection(loan, asOf) {
    date(asOf);
    const observed=at(loan,asOf);
    const anchors=timeline(loan).filter(r=>r.date<=asOf && (!r.id||r.type==='balance'));
    const anchor=anchors[anchors.length-1];
    const fallback={balance:observed.balance,rate:observed.rate,anchor:anchor?anchor.date:loan.startDate,paid:[],schedule:[],available:false};
    if(!anchor||!loan.paymentDay||!loan.maturity||loan.mode==='unknown')return fallback;
    if(!anchor.balance)return {...fallback,balance:0,available:true};
    if(anchor.date>=loan.maturity)return {...fallback,warning:'확인 잔액 기준일이 만기일 이후입니다. 실제 상환 여부를 확인하세요.'};
    const changes=loan.events.map((e,i)=>({...e,order:i})).filter(e=>e.date>anchor.date&&e.date<=asOf).sort((a,b)=>a.date.localeCompare(b.date)||a.order-b.order);
    const replaced=new Set();
    for(const e of changes.filter(e=>e.type==='repay')) {
      let due=monthShift(e.date,0,loan.paymentDay);
      if(due>e.date)due=monthShift(e.date,-1,loan.paymentDay);
      if(due>anchor.date)replaced.add(due);
      if(e.date>=loan.maturity)replaced.add(loan.maturity);
    }
    const model={...loan,startDate:anchor.date,initialBalance:anchor.balance,annualRate:anchor.rate,events:[]};
    const paid=[];
    let cursor=shift(anchor.date,1), serial=0;
    function advance(before) {
      const rows=plan(model,cursor,{fullCycle:true});
      for(const row of rows.filter(r=>r.date<before)) {
        if(!replaced.has(row.date)) {
          model.events.push({id:'assumed-'+serial++,type:'repay',date:row.date,amount:Math.min(at(model,row.date).balance,row.principal),interest:row.interest});
          paid.push(row);
        }
        // Establish a paid cycle even for zero-interest loans, without changing the actual ledger.
        model.events.push({id:'cycle-'+serial++,type:'interest',date:row.date,amount:0});
      }
      // Preserve the unmodified future schedule between real changes: do not rescale installments on every visit.
      return rows.filter(r=>r.date>=before);
    }
    try {
      for(const e of changes) {
        advance(e.date);
        model.events.push(e.type==='interest'&&!e.capitalized?{...e,amount:0}:e);
        timeline(model);
        const nextCursor=e.type==='repay'?shift(e.date,1):e.date;
        if(nextCursor>cursor)cursor=nextCursor;
      }
      const schedule=advance(asOf);
      const current=at(model,asOf);
      return {balance:current.balance,rate:current.rate,anchor:anchor.date,paid,schedule,available:true};
    } catch(e) {
      return {...fallback,warning:'실제 기록과 납부 가정이 맞지 않습니다. 잔액을 확인해 갱신하세요.'};
    }
  }
  function dueWindow(loans, asOf, horizon, assume) {
    const end=shift(asOf,horizon), rows=[],unknown=[];
    for(const loan of loans) {
      const current=at(loan,asOf), projected=projection(loan,asOf);
      const schedule=assume&&projected.available?projected.schedule:plan(loan,asOf);
      if(!(assume?projected.balance:current.balance))continue;
      const dates=[];
      if(loan.paymentDay) {
        let due=monthShift(asOf,0,loan.paymentDay);
        if(due<asOf)due=monthShift(asOf,1,loan.paymentDay);
        for(;due<=end;due=monthShift(due,1,loan.paymentDay))if(due>=loan.startDate&&(!loan.maturity||due<=loan.maturity))dates.push(due);
      } else unknown.push(loan.id);
      if(loan.maturity&&loan.maturity>=asOf&&loan.maturity<=end&&!dates.includes(loan.maturity))dates.push(loan.maturity);
      for(const due of dates) {
        const amount=schedule.find(r=>r.date===due);
        const bankRecorded=recordedInterest(loan,due,due)>0||loan.events.some(e=>e.type==='repay'&&e.date===due);
        const sameAnchor=due<=projected.anchor;
        rows.push({loanId:loan.id,name:loan.name,bank:loan.bank,date:due,days:days(asOf,due),principal:amount&&!sameAnchor?amount.principal:null,interest:amount&&!sameAnchor?amount.interest:null,total:amount&&!sameAnchor?amount.total:null,recorded:bankRecorded,maturity:due===loan.maturity,anchorDay:sameAnchor});
      }
    }
    rows.sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name));
    return {rows,unknown};
  }
  function readBackup(raw) {
    if (!raw || raw.version!==1 || !Array.isArray(raw.loans) || raw.loans.length>500) throw new Error('수익노트 대출 백업 JSON 파일을 선택해 주세요.');
    const loans=raw.loans.map(normalize),ids=new Set(loans.map(l=>l.id));
    if(ids.size!==loans.length)throw new Error('중복된 대출 기록이 있습니다.');
    return loans;
  }
  return {date,shift,days,normalize,timeline,at,estimate,recordedInterest,nextDue,plan,summary,projection,dueWindow,readBackup};
});
