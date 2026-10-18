/* Compatible with yjyj41/spending-tracker's spend_tracker_v1 backup and storage. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./spending-analysis.js'):root.SpendingAnalysis);if(typeof module==='object'&&module.exports)module.exports=api;else root.SpendingCore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(analysis){
  'use strict';
  const symbols=['£','₩','$','€'];
  function empty(){return {tx:[],budgets:Object.create(null),totalBudget:null,currency:'£',goals:[],management:analysis.normalize()};}
  function validDate(s){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s||''))return false;
    const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s;
  }
  function parseDate(value){
    const s=String(value||'').trim();let m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s|$)/),out;
    if(m)out=`${m[3]}-${m[2]}-${m[1]}`;
    else if((m=s.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/)))out=m[1];
    else if((m=s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/)))out=`20${m[3]}-${m[2]}-${m[1]}`;
    return validDate(out)?out:null;
  }
  function toNum(value){
    if(value==null||String(value).trim()==='')return NaN;
    let s=String(value).trim().replace(/[£₩$€,\s]/g,'');
    if(/^\(.*\)$/.test(s))s='-'+s.slice(1,-1);
    return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)?Number(s):NaN;
  }
  function parseCSV(text){
    const rows=[];let cell='',row=[],quoted=false;
    text=String(text).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;}
      else if(c==='"')quoted=true;
      else if(c===','){row.push(cell);cell='';}
      else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';}
      else cell+=c;
    }
    if(quoted)throw new Error('CSV 따옴표가 닫히지 않았습니다. 원본 CSV를 확인하세요.');
    if(cell.length||row.length){row.push(cell);rows.push(row);}
    return rows.filter(r=>r.some(c=>c.trim()!==''));
  }
  function idx(headers,...names){
    const h=headers.map(x=>String(x).trim().toLowerCase());
    for(const n of names){const i=h.indexOf(n.toLowerCase());if(i>=0)return i;}
    for(const n of names.filter(x=>x.length>2)){const i=h.findIndex(x=>x.includes(n.toLowerCase()));if(i>=0)return i;}
    return -1;
  }
  function text(value,label,max){if(typeof value!=='string'||value.length>max)throw new Error(label+' 형식을 확인하세요.');return value;}
  function positive(value,label,zero){
    if(typeof value!=='number'||!Number.isFinite(value)||value>1e14||value<(zero?0:Number.MIN_VALUE))throw new Error(label+' 금액을 확인하세요.');return value;
  }
  function normalize(raw){
    if(!raw||!Array.isArray(raw.tx)||raw.tx.length>300000)throw new Error('지출 트래커 백업 JSON 파일을 선택하세요.');
    const out=empty(),keys=new Set();out.currency=symbols.includes(raw.currency)?raw.currency:'£';
    out.tx=raw.tx.map(t=>{
      if(!t||!validDate(t.date)||typeof t.amount!=='number'||!Number.isFinite(t.amount)||Math.abs(t.amount)>1e14)throw new Error('거래 날짜·금액 형식을 확인하세요.');
      const key=text(t.key,'거래 식별자',5000);if(!key||keys.has(key))throw new Error('거래 식별자가 중복되거나 비어 있습니다.');keys.add(key);
      return {key,date:t.date,amount:t.amount,name:text(t.name,'상점',1000),category:text(t.category,'카테고리',300),type:text(t.type||'','거래 종류',300),notes:text(t.notes||'','메모',3000)};
    });
    if(raw.budgets!=null&&(typeof raw.budgets!=='object'||Array.isArray(raw.budgets)))throw new Error('예산 형식을 확인하세요.');
    for(const [k,v]of Object.entries(raw.budgets||{})){text(k,'예산 카테고리',300);out.budgets[k]=positive(v,'카테고리 예산',true);}
    out.totalBudget=raw.totalBudget==null||raw.totalBudget===0?null:positive(raw.totalBudget,'월 예산',false);
    if(raw.goals!=null&&!Array.isArray(raw.goals))throw new Error('저축 목표 형식을 확인하세요.');
    out.goals=(raw.goals||[]).map(g=>({name:text(g.name,'목표 이름',300),target:positive(g.target,'목표',false),current:positive(g.current==null?0:g.current,'저축액',true)}));
    out.management=analysis.normalize(raw.management);
    return out;
  }
  const signature=t=>JSON.stringify([t.date,t.amount,t.name,t.category,t.type]);
  function mergeCSV(raw,csv){
    const store=normalize(raw),rows=parseCSV(csv);if(!rows.length)throw new Error('CSV 파일이 비어 있습니다.');
    const head=rows[0],iDate=idx(head,'date','transaction date','started date'),iAmt=idx(head,'amount','value'),iOut=idx(head,'money out'),iIn=idx(head,'money in');
    if(iDate<0||(iAmt<0&&iOut<0&&iIn<0))throw new Error('Date와 Amount 또는 Money Out / Money In 열이 필요합니다.');
    const iCurrency=head.findIndex(h=>['currency','account currency'].includes(String(h).trim().toLowerCase()));
    const iId=idx(head,'transaction id','id'),iCat=idx(head,'category'),iName=idx(head,'name','description','merchant','reference','counterparty'),iNotes=idx(head,'notes and #tags','notes','note'),iType=idx(head,'type');
    const seen=new Set(store.tx.map(t=>t.key)),existing=new Map(),occurrences=new Map();let added=0,skipped=0;
    for(const t of store.tx){const sig=signature(t);existing.set(sig,(existing.get(sig)||0)+1);}
    for(const row of rows.slice(1)){
      if(iCurrency>=0&&String(row[iCurrency]||'').trim()&&String(row[iCurrency]).trim().toUpperCase()!=='GBP')throw new Error('이 지출 탭은 GBP 계좌 기준입니다. 다른 통화의 CSV는 합칠 수 없습니다.');
      const date=parseDate(row[iDate]);let amount=toNum(row[iAmt]);
      if(!Number.isFinite(amount)){
        const out=toNum(row[iOut]),input=toNum(row[iIn]);
        if(Number.isFinite(out)||Number.isFinite(input))amount=(Number.isFinite(input)?Math.abs(input):0)-(Number.isFinite(out)?Math.abs(out):0);
      }
      if(!date||!Number.isFinite(amount))throw new Error('CSV 거래 날짜 또는 금액을 읽지 못했습니다. 원본 파일을 확인하세요.');
      const name=String(row[iName]||row[iNotes]||'기타').trim(),category=String(row[iCat]||'미분류').trim()||'미분류',type=String(row[iType]||'').trim(),notes=String(row[iNotes]||'').trim(),id=String(row[iId]||'').trim();
      const t={date,amount,name,category,type,notes},sig=signature(t),occ=(occurrences.get(sig)||0)+1;occurrences.set(sig,occ);
      const key=id||'fallback|'+sig+'|'+occ;
      if(seen.has(key)||(!id&&occ<=(existing.get(sig)||0))){skipped++;continue;}
      seen.add(key);store.tx.push({key,...t});added++;
    }
    store.tx.sort((a,b)=>b.date.localeCompare(a.date));return {store:normalize(store),added,skipped};
  }
  function prevMonth(m){const[y,month]=m.split('-').map(Number);return `${month===1?y-1:y}-${String(month===1?12:month-1).padStart(2,'0')}`;}
  function formatDual(value,rate,order='GBP',signed=false){
    const sign=signed?(value<0?'-':'+'):'';
    const gbp=sign+'£'+Math.abs(value).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2});
    const krw=typeof rate==='number'&&Number.isFinite(rate)&&rate>0?sign+Math.abs(value*rate).toLocaleString('ko-KR',{maximumFractionDigits:0})+'원':'환율 확인 필요';
    return order==='KRW'?krw+' · '+gbp:gbp+' · '+(krw==='환율 확인 필요'?krw:'약 '+krw);
  }
  return {empty,normalize,parseCSV,parseDate,toNum,idx,mergeCSV,prevMonth,formatDual};
});
