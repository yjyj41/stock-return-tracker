(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SpendingAnalysis=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const labels={expense:'생활비 · 변동지출',fixed:'고정지출',income:'수입',transfer:'계좌이체',refund:'환급',review:'확인 필요',neutral:'금액 없는 거래'};
  const merchant=s=>String(s||'').trim().replace(/\s+/g,' ').toLowerCase();
  const direction=t=>t.amount<0?'out':'in';
  const allowed=(kind,dir)=>Object.hasOwn(labels,kind)&&kind!=='neutral'&&(dir==='out'?!['income','refund'].includes(kind):!['expense','fixed'].includes(kind));
  const month=s=>/^\d{4}-(0[1-9]|1[0-2])$/.test(s||'');
  function str(v,max){if(typeof v!=='string'||v.length>max)throw new Error('지출 분류 설정 형식을 확인하세요.');return v;}
  function normalize(raw){
    const out={overrides:Object.create(null),rules:[],fixed:[],dismissed:[],salaryNames:[],otherIncomeTransfers:false};if(raw==null)return out;
    if(typeof raw!=='object'||Array.isArray(raw))throw new Error('지출 분류 설정 형식을 확인하세요.');
    for(const [k,v]of Object.entries(raw.overrides||{})){str(k,5000);if(!Object.hasOwn(labels,v))throw new Error('거래 분류를 확인하세요.');out.overrides[k]=v;}
    for(const r of raw.rules||[]){if(!r||!['in','out'].includes(r.direction)||!allowed(r.kind,r.direction))throw new Error('자동 분류 규칙을 확인하세요.');const name=merchant(str(r.merchant,1000));if(!name)throw new Error('상대방 이름이 필요합니다.');out.rules.push({merchant:name,direction:r.direction,kind:r.kind,label:r.label?str(r.label,300):''});}
    const ids=new Set();
    for(const p of raw.fixed||[]){
      if(!p||typeof p.amount!=='number'||!Number.isFinite(p.amount)||p.amount<=0||p.amount>1e14||!Number.isInteger(p.day)||p.day<1||p.day>31||!month(p.start)||p.end&&(!month(p.end)||p.end<p.start))throw new Error('고정지출 금액·납부일·적용 기간을 확인하세요.');
      const id=str(p.id,200),name=str(p.name,300),who=merchant(str(p.merchant,1000));if(!id||!name.trim()||!who||ids.has(id))throw new Error('고정지출 이름·식별자를 확인하세요.');ids.add(id);
      out.fixed.push({id,name:name.trim(),merchant:who,amount:p.amount,day:p.day,start:p.start,end:p.end||'',active:p.active!==false});
    }
    for(let i=0;i<out.fixed.length;i++)for(let j=0;j<i;j++){
      const a=out.fixed[i],b=out.fixed[j];if(a.active&&b.active&&a.merchant===b.merchant&&a.start<=(b.end||'9999-12')&&b.start<=(a.end||'9999-12'))throw new Error('같은 상대방의 고정지출 적용 기간이 겹칩니다. 기존 항목을 수정하세요.');
    }
    out.dismissed=[...new Set((raw.dismissed||[]).map(s=>merchant(str(s,1000))))];
    out.salaryNames=[...new Set((raw.salaryNames||[]).map(s=>merchant(str(s,1000))).filter(Boolean))];out.otherIncomeTransfers=raw.otherIncomeTransfers===true;
    return out;
  }
  const active=(p,m)=>p.active&&m>=p.start&&(!p.end||m<=p.end);
  function classify(t,meta){
    const m=meta||normalize(),who=merchant(t.name),dir=direction(t),plan=m.fixed.find(p=>p.merchant===who&&active(p,t.date.slice(0,7)));
    const result=(kind,reason,manual=false,estimated=false)=>({kind,label:labels[kind],reason,manual,estimated,planId:kind==='fixed'&&plan?plan.id:null});
    if(t.amount===0)return result('neutral','금액 0 · 합계에서 제외');
    const override=m.overrides[t.key];if(allowed(override,dir))return result(override,'이 거래에 직접 지정',true);
    const rule=m.rules.find(r=>r.merchant===who&&r.direction===dir);if(rule)return result(rule.kind,(rule.label?rule.label+' · ':'')+'같은 상대방 분류 규칙',true);
    if(plan&&t.amount<0)return result('fixed',plan.name+' · 등록한 고정지출',true);
    const type=merchant(t.type).replace(/[_-]/g,' '),category=merchant(t.category),words=merchant(t.name+' '+(t.notes||''));
    if(/pot transfer|pot withdrawal|pot deposit|internal transfer|own account/.test(type+' '+category))return result('transfer','Pots·내부이체 표시');
    if(t.amount>0&&(/refund|reversal|chargeback/.test(type+' '+category)||/card payment/.test(type)||/\breimbursement\b|비용 환급/.test(words)))return result('refund','환급·비용 정산 또는 카드 결제 반환 표시');
    if(t.amount>0&&m.salaryNames.includes(who))return result('income','등록한 급여 입금 이름',true);
    if(t.amount>0&&(/^(salary|wages)$/.test(category)||/\b(salary|payroll|wages)\b|급여|월급/.test(words)))return result('income','급여 표시');
    if(t.amount>0&&m.otherIncomeTransfers)return result('transfer','급여·환급 외 입금 규칙으로 추정 · 보낸 사람 확인 필요',false,true);
    if(t.amount>0&&category==='income')return result('income','수입 카테고리');
    if(t.amount<0&&(/\b(rent|landlord|council tax|mortgage)\b|월세|집세/.test(words)||/^(bills|housing|rent)$/.test(category)))return result('expense','주거비·청구서 지출 · 고정 여부 확인 가능');
    if(/transfer|faster payment|bank payment|p2p/.test(type+' '+category))return result('review',t.amount<0?'송금: 본인 계좌 이동인지 실제 지출인지 확인':'입금: 본인 계좌 이동인지 실제 수입인지 확인');
    if(t.amount<0)return result('expense','출금 거래 · 분류 수정 가능');
    return result('review','입금 성격 확인 필요');
  }
  function summarize(tx,meta){
    const s={spend:0,fixed:0,variable:0,income:0,refund:0,transferIn:0,transferInConfirmed:0,transferInEstimated:0,estimatedCount:0,transferOut:0,reviewIn:0,reviewOut:0,reviewCount:0,grossIn:0,grossOut:0};
    for(const t of tx){const c=classify(t,meta),k=c.kind,n=Math.abs(t.amount);if(t.amount>0)s.grossIn+=n;else if(t.amount<0)s.grossOut+=n;
      if(k==='expense'){s.variable+=n;s.spend+=n;}else if(k==='fixed'){s.fixed+=n;s.spend+=n;}else if(k==='income')s.income+=n;else if(k==='refund')s.refund+=n;else if(k==='transfer'){s[t.amount<0?'transferOut':'transferIn']+=n;if(t.amount>0){s[c.estimated?'transferInEstimated':'transferInConfirmed']+=n;if(c.estimated)s.estimatedCount++;}}else if(k==='review'){s.reviewCount++;s[t.amount<0?'reviewOut':'reviewIn']+=n;}}
    s.cashNet=s.grossIn-s.grossOut;s.netSpend=s.spend-s.refund;s.surplus=s.income-s.netSpend;return s;
  }
  function dueDate(m,day){const[y,mo]=m.split('-').map(Number);return m+'-'+String(Math.min(day,new Date(Date.UTC(y,mo,0)).getUTCDate())).padStart(2,'0');}
  function planRows(store,m,today){
    const meta=store.management||normalize(),latest=store.tx.reduce((a,t)=>t.date>a?t.date:a,'');
    return meta.fixed.filter(p=>active(p,m)).map(p=>{
      const payments=store.tx.filter(t=>t.date.slice(0,7)===m&&t.amount<0&&classify(t,meta).planId===p.id),actual=payments.reduce((n,t)=>n-t.amount,0),due=dueDate(m,p.day);
      const remaining=Math.max(0,p.amount-actual),days=Math.round((new Date(due+'T00:00:00Z')-new Date(today+'T00:00:00Z'))/86400000);
      const status=actual>=p.amount-0.005?'납부 내역 있음':actual>0?'일부 내역 · 금액 확인':due>latest?'CSV 기간 밖 · 예정':due>today?'예정':'내역 없음 · 확인 필요';
      return {...p,due,actual,remaining,days,status,dates:payments.map(t=>t.date).sort(),latest};
    }).sort((a,b)=>a.due.localeCompare(b.due)||a.name.localeCompare(b.name));
  }
  function suggestions(store){
    const meta=store.management||normalize(),groups=new Map(),latest=store.tx.reduce((a,t)=>t.date>a?t.date:a,'');
    for(const t of store.tx){const k=classify(t,meta).kind,who=merchant(t.name);if(t.amount>=0||k!=='expense'||!who||meta.dismissed.includes(who)||meta.fixed.some(p=>p.active&&p.merchant===who)||meta.rules.some(r=>r.merchant===who&&r.direction==='out')||meta.overrides[t.key])continue;
      if(!groups.has(who))groups.set(who,[]);groups.get(who).push(t);}
    const result=[];
    for(const [who,rows]of groups){rows.sort((a,b)=>a.date.localeCompare(b.date));const last=rows.at(-1),[yy,mm]=latest.split('-').map(Number),cutoff=new Date(Date.UTC(yy,mm-6,1)).toISOString().slice(0,10),recent=rows.filter(t=>t.date>=cutoff);
      const rent=/\b(rent|landlord|mortgage|council tax)\b|월세|집세/.test(merchant(last.name+' '+last.notes));
      const direct=/direct[ _-]?debit|standing[ _-]?order/.test(merchant(last.type));
      const byMonth=new Set(recent.map(t=>t.date.slice(0,7))),amounts=recent.map(t=>-t.amount).sort((a,b)=>a-b),median=amounts[Math.floor(amounts.length/2)]||-last.amount;
      const near=recent.filter(t=>Math.abs(-t.amount-median)<=Math.max(1,median*.1)).length;
      const day=Number(last.date.slice(8)),regularDays=recent.every(t=>Math.abs(Number(t.date.slice(8))-day)<=4);
      const monthNumbers=[...byMonth].sort().map(m=>Number(m.slice(0,4))*12+Number(m.slice(5))),consecutive=monthNumbers.every((n,i)=>!i||n-monthNumbers[i-1]===1);
      const monthly=byMonth.size===recent.length&&byMonth.size>=(direct?2:3)&&near>=recent.length*.8&&regularDays&&consecutive;
      if(!rent&&!monthly)continue;
      result.push({merchant:who,name:last.name,amount:-last.amount,day,start:rows[0].date.slice(0,7),count:rows.length,last:last.date,reason:rent?'주거비 이름·메모 단서 · 확인 필요':direct?'자동이체의 월별 반복 · 확인 필요':'3개월 이상 비슷한 날짜·금액 · 확인 필요'});
    }
    return result.sort((a,b)=>b.amount-a.amount);
  }
  return {labels,merchant,direction,allowed,normalize,classify,summarize,dueDate,planRows,suggestions};
});
