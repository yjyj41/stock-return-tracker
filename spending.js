/* Adapted from yjyj41/spending-tracker @ 839196e20fcfac1d180e01c4c50287c2824dc0a0 */
(function(){
"use strict";
// ---------- storage ----------
const KEY="spend_tracker_v1";
const analysis=SpendingAnalysis;
const el=id=>document.getElementById(id);
const today=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
const classification=t=>analysis.classify(t,store.management);
const consumed=t=>['expense','fixed'].includes(classification(t).kind);
let undoMeta=null,editingFixedId='',txPage=0,kindFilter='all';
const FXKEY='suiknote_v1_fx',DISPLAYKEY='spend_tracker_display_v2';
let storageProblem='';
let store=load();
function load(){try{const raw=localStorage.getItem(KEY);return raw?SpendingCore.normalize(JSON.parse(raw)):SpendingCore.empty();}catch(e){storageProblem='기존 기록을 읽지 못했습니다. 원본 데이터는 보존되어 있습니다. 지출 백업 파일로 복원하세요. '+e.message;return SpendingCore.empty();}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(SpendingCore.normalize(store)));return true;}catch(e){store=load();render();toast('저장하지 못했습니다. '+e.message);return false;}}
let displayOrder=store.currency==='₩'?'KRW':'GBP';
try{const order=localStorage.getItem(DISPLAYKEY);if(['GBP','KRW'].includes(order))displayOrder=order;}catch(e){}
function loadRates(){try{const raw=JSON.parse(localStorage.getItem(FXKEY)||'{}');return Object.fromEntries(Object.entries(raw||{}).filter(([c,r])=>/^[A-Z]{3}$/.test(c)&&StockPortfolio.validRate(r)));}catch(e){return {};}}
let fxRates=loadRates(),fxBusy=false,fxError='';
const currentRate=()=>StockPortfolio.validRate(fxRates.GBP)?fxRates.GBP:null;
document.getElementById('currency').value=displayOrder;
function ingest(text){const result=SpendingCore.mergeCSV(store,text);localStorage.setItem(KEY,JSON.stringify(result.store));store=result.store;return result.added;}

// ---------- helpers ----------
const fmt=(n,signed=false)=>SpendingCore.formatDual(n,currentRate()?.rate,displayOrder,signed);
const primary=n=>displayOrder==='KRW'?(currentRate()?Math.abs(n*currentRate().rate).toLocaleString('ko-KR',{maximumFractionDigits:0})+'원':'환율 확인 필요'):'£'+Math.abs(n).toLocaleString('ko-KR',{maximumFractionDigits:2});
const ym=d=>d.slice(0,7);
const monthLabel=m=>{const[y,mo]=m.split("-");return `${y}.${mo}`;};
function spendingOf(list){return analysis.summarize(list,store.management).spend;}
function months(){return [...new Set([today().slice(0,7),...store.tx.map(t=>ym(t.date)),...store.management.fixed.map(p=>p.start)])].sort().reverse();}
const prevMonth=SpendingCore.prevMonth;

// ---------- charts ----------
let charts={};
function destroy(){Object.values(charts).forEach(c=>c&&c.destroy());charts={};}
const palette=["#3182F6","#34d399","#fbbf24","#f87171","#a78bfa","#22d3ee","#fb923c","#f472b6","#4ade80","#60a5fa","#facc15","#c084fc"];

// ---------- render ----------
function render(){
  requestAnimationFrame(notifyParent);
  renderFX();
  document.getElementById("storageNotice").textContent=storageProblem;
  document.getElementById("totalBudget").value=store.totalBudget||'';
  const ms=months();
  const sel=document.getElementById("month");
  const chosen=sel.value && ms.includes(sel.value)?sel.value:ms[0];
  sel.innerHTML=ms.map(m=>`<option value="${m}" ${m===chosen?"selected":""}>${monthLabel(m)}</option>`).join("");

  const hasData=store.tx.length>0;
  for(const id of ['chartsArea','insightsPanel','transactionsPanel'])document.getElementById(id).style.display=hasData?'':'none';
  document.getElementById("controls").style.display="";
  document.getElementById("clearBtn").disabled=!hasData&&!store.goals.length&&!Object.keys(store.budgets).length&&!store.totalBudget&&!store.management.rules.length&&!store.management.fixed.length&&!store.management.otherIncomeTransfers&&!store.management.salaryNames.length&&!Object.keys(store.management.overrides).length;
  renderManagement();renderSubscriptions();renderFlow(store.tx.filter(t=>ym(t.date)===chosen));
  if(!hasData){
    document.getElementById("cards").innerHTML=`<div class="empty">아직 거래가 없습니다. 아래 ‘CSV 추가 · 환율 · 백업’에서 Monzo CSV를 올려주세요.</div>`;
    document.getElementById("budgetArea").innerHTML="";document.getElementById("catBudgets").innerHTML="";
    document.getElementById("txBody").innerHTML="";document.getElementById("txCount").textContent="";
    document.getElementById("insights").innerHTML="";
    renderGoals();
    el('dataTools').open=true;destroy();return;
  }
  const m=chosen, pm=prevMonth(m);
  const cur_tx=store.tx.filter(t=>ym(t.date)===m);
  const prev_tx=store.tx.filter(t=>ym(t.date)===pm);
  const curSpend=spendingOf(cur_tx), prevSpend=spendingOf(prev_tx);
  const summary=analysis.summarize(cur_tx,store.management),income=summary.income;

  const drill=(kind,text)=>`<button class="ghost" data-drill="${kind}">${text}</button>`;
  el('cards').innerHTML=`
    <div class="panel card"><div class="label">① 쓴 돈 · 월세 포함</div><div class="value">${fmt(curSpend)}</div><div class="hint">실제로 결제·납부한 금액이에요.<br>이체와 미분류 출금은 제외돼요.</div>
    <div class="breakdown"><b>위 금액에 이미 포함</b><br>고정지출 ${fmt(summary.fixed)}<br>생활비·기타 소비 ${fmt(summary.variable)}</div><div class="small-actions">${drill('spending','쓴 돈 내역')}${drill('fixed','고정지출만')}</div></div>
    <div class="panel card"><div class="label">② 번 돈 · 월급 등</div><div class="value">${fmt(income)}</div><div class="hint">급여 등 수입으로 분류된 입금이에요.<br>내 계좌 이체·환급은 제외돼요.</div><div class="small-actions">${drill('income','번 돈 내역')}</div></div>
    <div class="panel card"><div class="label">③ 다른 내 계좌에서 옮겨온 돈</div><div class="value">${fmt(summary.transferInConfirmed)}</div><div class="hint">직접 지정한 이체와 내부이체 표시 기준.<br>번 돈에 더하지 않아요. 이체 출금은 차감하지 않았어요.</div><div class="breakdown">${summary.estimatedCount?`추정 입금 ${fmt(summary.transferInEstimated)}은 위 금액에서 제외했어요.`:'추정 입금은 따로 표시해요.'}</div><div class="small-actions">${drill('transferInConfirmed','누가 보냈는지 보기')}</div></div>`;
  bindDrilldowns(el('cards'));

  destroy();
  const catMap=Object.create(null);
  cur_tx.filter(consumed).forEach(t=>{catMap[t.category]=(catMap[t.category]||0)+(-t.amount);});
  const catEntries=Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
  if(typeof Chart === "function"){
  // comparison chart
  charts.cmp=new Chart(document.getElementById("cmpChart"),{type:"bar",
    data:{labels:[monthLabel(pm),monthLabel(m)],datasets:[{data:[prevSpend,curSpend],
      backgroundColor:["#B0B8C1","#3182F6"],borderRadius:8}]},
    options:baseOpts({money:true})});

  // category chart
  charts.cat=new Chart(document.getElementById("catChart"),{type:"doughnut",
    data:{labels:catEntries.map(e=>e[0]),datasets:[{data:catEntries.map(e=>e[1]),
      backgroundColor:palette,borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",
      labels:{color:"#6B7684",boxWidth:12,font:{size:11}}},
      tooltip:{callbacks:{label:c=>` ${c.label}: ${fmt(c.parsed)}`}}}}});

  // trend chart
  const allM=months().slice().reverse().slice(-12);
  const trend=allM.map(mm=>spendingOf(store.tx.filter(t=>ym(t.date)===mm)));
  charts.trend=new Chart(document.getElementById("trendChart"),{type:"line",
    data:{labels:allM.map(monthLabel),datasets:[{data:trend,borderColor:"#34d399",
      backgroundColor:"rgba(52,211,153,.12)",fill:true,tension:.3,pointRadius:4,pointBackgroundColor:"#34d399"}]},
    options:baseOpts({money:true})});

  }else document.getElementById("chartNotice").textContent="차트 라이브러리를 불러오지 못했습니다. 거래·예산·분석은 계속 사용할 수 있습니다.";
  // budget vs actual
  const ba=document.getElementById("budgetArea");
  const cats=[...new Set([...Object.keys(catMap),...Object.keys(store.budgets)])];
  const withBudget=cats.filter(c=>store.budgets[c]);
  if(!withBudget.length && !store.totalBudget){
    ba.innerHTML=`<div class="empty" style="padding:20px">아래에서 예산 목표를 설정하면<br>여기에 진행률이 표시됩니다.</div>`;
  }else{
    let html="";
    if(store.totalBudget){html+=budgetBar("월 전체",curSpend,store.totalBudget);}
    withBudget.sort((a,b)=>(catMap[b]||0)-(catMap[a]||0)).forEach(c=>{
      html+=budgetBar(c,catMap[c]||0,store.budgets[c]);
    });
    ba.innerHTML=html;
  }

  // category budget inputs
  document.getElementById("totalBudget").value=store.totalBudget||"";
  const inputCats=[...new Set([...catEntries.map(e=>e[0]),...Object.keys(store.budgets)])];
  document.getElementById("catBudgets").innerHTML=inputCats.map(c=>`
    <div class="budget-row">
      <span>${esc(c)} <span class="muted" style="font-size:12px">· 이번 달 ${fmt(catMap[c]||0)}</span></span>
      <input type="number" data-cat="${esc(c)}" aria-label="${esc(c)} 예산 (£ GBP)" class="catBudgetInput" placeholder="목표 (£)" value="${store.budgets[c]||""}" style="width:110px">
    </div>`).join("")||`<span class="muted">거래를 올리면 카테고리가 나타납니다.</span>`;
  document.querySelectorAll(".catBudgetInput").forEach(inp=>{
    inp.addEventListener("change",()=>{
      const c=inp.dataset.cat;const v=parseFloat(inp.value);
      if(v>0)store.budgets[c]=v;else delete store.budgets[c];
      if(!save())return;render();
    });
  });

  renderInsights(m,pm,cur_tx,prev_tx,catMap);
  renderGoals();
  renderTx(cur_tx);
}

// ---------- classification and monthly fixed plans ----------
const normMerchant=analysis.merchant;
function changeManagement(change,message){
  try{const prior=JSON.stringify(store.management),draft=SpendingCore.normalize(store);change(draft.management);
    const next=SpendingCore.normalize(draft);localStorage.setItem(KEY,JSON.stringify(next));store=next;undoMeta=prior;render();toast(message);return true;
  }catch(e){toast('저장하지 못했습니다. '+e.message);return false;}
}
function bindDrilldowns(container){
  container.querySelectorAll?.('[data-drill]').forEach(b=>b.addEventListener('click',()=>showTransactions(b.dataset.drill)));
}
function showTransactions(kind){
  kindFilter=kind;txFilter='';txPage=0;el('kindFilter').value=kind;el('search').value='';
  el('transactionsPanel').open=true;
  renderTx(store.tx.filter(t=>ym(t.date)===el('month').value));
  el('transactionTitle').focus();el('transactionsPanel').scrollIntoView({behavior:'smooth',block:'start'});
  requestAnimationFrame(notifyParent);
}
function renderFlow(rows){
  const s=analysis.summarize(rows,store.management);
  const cards=[['전체 입금',s.grossIn],['전체 출금',s.grossOut],['계좌 증감 · 입금−출금',s.cashNet],['다른 계좌로 옮긴 돈',s.transferOut],['돌려받은 돈 · 환급·비용 정산',s.refund],['쓴 돈−돌려받은 돈',s.netSpend]];
  el('flowSummary').innerHTML=cards.map(([label,value],i)=>`<div><div class="label">${label}</div><div style="font-size:17px;font-weight:600;margin:8px 0">${fmt(value,i===2||i===5)}</div></div>`).join('')+`<div class="small-actions"><button class="ghost" data-drill="refund">환급 내역</button><button class="ghost" data-drill="transferOut">이체 출금 내역</button><button class="ghost" data-drill="all">모든 입출금</button></div>`;
  bindDrilldowns(el('flowSummary'));
  const dates=store.tx.map(t=>t.date).sort();
  el('dataPeriod').textContent=dates.length?`입력된 거래: ${dates[0]} ~ ${dates.at(-1)} · 실제 거래일 기준으로 월을 나눠요. 월 전체 내역인지는 원본 CSV를 확인하세요.`:'CSV 거래내역을 넣으면 월별로 볼 수 있어요.';
  el('reviewBanner').innerHTML=(s.estimatedCount?`<div><b>내 계좌 이체인지 확인할 입금 ${s.estimatedCount}건 · ${fmt(s.transferInEstimated)}</b><br>‘급여·환급 외 입금’ 규칙으로 추정했어요. ② 번 돈과 ③ 옮겨온 돈에는 포함하지 않았어요.<div class="small-actions"><button class="ghost" data-drill="transferInEstimated">보낸 사람 확인</button></div></div>`:'')+(s.reviewCount?`<div style="margin-top:8px"><b>아직 분류하지 않은 거래 ${s.reviewCount}건</b><br>입금 ${fmt(s.reviewIn)} · 출금 ${fmt(s.reviewOut)}<br>위 세 금액에서 제외돼 있어요. 지출인지 이체인지 확인해 주세요.<div class="small-actions"><button class="ghost" data-drill="review">미분류 내역 보기</button></div></div>`:'');
  bindDrilldowns(el('reviewBanner'));
}

function renderManagement(){
  const m=store.management;
  if(document.activeElement!==el('salaryNames'))el('salaryNames').value=m.salaryNames.join('\n');
  el('otherIncomeTransfers').checked=m.otherIncomeTransfers;
  el('undoClassification').disabled=!undoMeta;
  el('classificationStatus').textContent='이름·메모의 Salary / Payroll / Wages 표시는 급여로, 카드 반환·Reimbursement는 환급으로 먼저 구분합니다.';
  el('merchantNames').innerHTML=[...new Set(store.tx.filter(t=>t.amount<0).map(t=>t.name))].sort().map(n=>`<option value="${esc(n)}"></option>`).join('');
  el('classificationRules').innerHTML=m.rules.map((r,i)=>`<div class="plan-item">${esc(r.merchant)} · ${r.direction==='in'?'입금':'출금'} → ${analysis.labels[r.kind]}${r.label?" · "+esc(r.label):""} <button class="ghost removeRule" data-i="${i}">규칙 삭제</button></div>`).join('');
  document.querySelectorAll('.removeRule').forEach(b=>b.addEventListener('click',()=>changeManagement(m=>m.rules.splice(+b.dataset.i,1),'규칙 삭제됨')));
  if(!el('fixedStart').value)el('fixedStart').value=el('month').value||today().slice(0,7);
}
function fillFixed(p={}){
  editingFixedId=p.id||'';
  for(const [id,key]of [['fixedName','name'],['fixedMerchant','merchant'],['fixedAmount','amount'],['fixedDay','day'],['fixedStart','start'],['fixedEnd','end']])el(id).value=p[key]||'';
  if(!p.start)el('fixedStart').value=el('month').value||today().slice(0,7);
  el('fixedForm').open=true;el('fixedFormStatus').textContent=editingFixedId?'기존 항목 수정 중':'금액과 납부일을 확인한 후 저장하세요.';
}
function renderSubscriptions(){
  const month=el('month').value||today().slice(0,7),plans=analysis.planRows(store,month,today());
  el('subTotal').textContent=plans.length?`등록한 월 예정액 ${fmt(plans.reduce((s,p)=>s+p.amount,0))} · ${plans.length}개`:'납부 일정 미등록';
  el('subList').innerHTML=plans.map(p=>`<div class="plan-item"><div class="flex-between"><b>${esc(p.name)}</b><span class="tag">${p.due} ${p.days===0?'· 오늘':p.days>0&&p.days<=7?'· '+p.days+'일 후':''}</span></div><div style="line-height:1.9;margin-top:8px">예정 ${fmt(p.amount)}<br>실제 출금 ${fmt(p.actual)} · ${p.status}<br><span class="muted">예정 대비 남은 금액 ${fmt(p.remaining)}${p.dates.length?' · 출금일 '+p.dates.join(', '):''}</span></div><div class="small-actions"><button class="ghost editFixed" data-id="${esc(p.id)}">수정</button><button class="ghost deleteFixed" data-id="${esc(p.id)}">삭제</button></div></div>`).join('')||'<div class="empty">이 달에 등록된 고정지출이 없습니다. 월세·정기결제를 등록하세요.</div>';
  // Plans outside the selected month remain editable, including ended contracts.
  const outside=store.management.fixed.filter(p=>!plans.some(r=>r.id===p.id));
  if(outside.length)el('subList').innerHTML+=`<details><summary>다른 기간의 등록 항목 ${outside.length}개</summary>${outside.map(p=>`<div class="plan-item">${esc(p.name)} · ${p.start} ~ ${p.end||'계속'} <button class="ghost editFixed" data-id="${esc(p.id)}">수정</button><button class="ghost deleteFixed" data-id="${esc(p.id)}">삭제</button></div>`).join('')}</details>`;
  const candidates=analysis.suggestions(store),unplanned=new Map();
  for(const t of store.tx){const c=classification(t),who=normMerchant(t.name);if(c.kind==='fixed'&&!c.planId&&!store.management.dismissed.includes(who)&&(!unplanned.has(who)||unplanned.get(who).date<t.date))unplanned.set(who,t);}
  if(!plans.length&&unplanned.size)el('subList').innerHTML='';
  for(const [who,t]of unplanned){
    const name=store.management.rules.find(r=>r.merchant===who&&r.direction==='out')?.label||t.name;
    const matched=store.tx.filter(x=>ym(x.date)===month&&normMerchant(x.name)===who&&classification(x).kind==='fixed');
    const i=candidates.length;candidates.push({name,merchant:who,amount:-t.amount,day:'',start:t.date.slice(0,7),reason:'고정지출 분류됨 · 납부 일정 등록 필요'});
    el('subList').innerHTML+=`<div class="plan-item"><b>${esc(name)}</b><div style="line-height:1.9">이번 달 실제 출금 ${fmt(-matched.reduce((s,x)=>s+x.amount,0))}<br><span class="muted">${matched.length?'출금일 '+matched.map(x=>x.date).sort().join(', '):'이 달 출금 내역 없음'} · 정기 납부일 미등록</span></div><button class="ghost useCandidate" data-i="${i}">납부 일정 설정</button></div>`;
  }
  el('fixedSuggestions').innerHTML=candidates.map((p,i)=>`<div class="plan-item"><b>${esc(p.name)}</b> · 최근 금액 ${fmt(p.amount)}<div class="muted">${p.reason}</div><div class="small-actions"><button class="ghost useCandidate" data-i="${i}">납부 일정 설정</button><button class="ghost dismissCandidate" data-i="${i}">후보 제외</button></div></div>`).join('')||'<p class="muted">확인할 후보가 없습니다. 월세는 위에서 직접 등록할 수 있습니다.</p>';
  document.querySelectorAll('.editFixed').forEach(b=>b.addEventListener('click',()=>fillFixed(store.management.fixed.find(p=>p.id===b.dataset.id))));
  document.querySelectorAll('.deleteFixed').forEach(b=>b.addEventListener('click',()=>changeManagement(m=>{m.fixed=m.fixed.filter(p=>p.id!==b.dataset.id);},'고정지출 삭제됨 · 마지막 변경 되돌리기 가능')));
  document.querySelectorAll('.useCandidate').forEach(b=>b.addEventListener('click',()=>fillFixed(candidates[+b.dataset.i])));
  document.querySelectorAll('.dismissCandidate').forEach(b=>b.addEventListener('click',()=>changeManagement(m=>m.dismissed.push(candidates[+b.dataset.i].merchant),'후보 제외됨')));
}

// ---------- smart insights ----------
function renderInsights(m,pm,cur_tx,prev_tx,catMap){
  const el=document.getElementById("insights");
  const out=[];
  const curSpend=spendingOf(cur_tx), prevSpend=spendingOf(prev_tx);
  // category growth
  const prevCat=Object.create(null);prev_tx.filter(consumed).forEach(t=>{prevCat[t.category]=(prevCat[t.category]||0)+(-t.amount);});
  let topGrow=null;
  for(const c in catMap){const d=catMap[c]-(prevCat[c]||0);if(!topGrow||d>topGrow.d)topGrow={c,d,now:catMap[c]};}
  if(topGrow&&topGrow.d>0)out.push(["📈","가장 많이 늘어난 지출",`<b>${esc(topGrow.c)}</b> · 지난달보다 +${fmt(topGrow.d)} 늘어 ${fmt(topGrow.now)}`]);
  // biggest single
  const spend=cur_tx.filter(consumed);
  if(spend.length){const big=spend.reduce((a,b)=>(-b.amount>-a.amount?b:a));
    out.push(["💳","이번 달 최대 지출",`<b>${fmt(big.amount)}</b> · ${esc(big.name)} (${big.date})`]);}
  // most frequent merchant
  const cnt=Object.create(null);spend.forEach(t=>{const k=normMerchant(t.name)||t.name;cnt[k]=(cnt[k]||0)+1;});
  const freq=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0];
  if(freq&&freq[1]>1){const sample=spend.find(t=>(normMerchant(t.name)||t.name)===freq[0]);
    out.push(["🏪","가장 자주 간 곳",`<b>${esc(sample?sample.name:freq[0])}</b> · ${freq[1]}회 방문`]);}
  const remaining=analysis.planRows(store,m,today()).reduce((sum,p)=>sum+p.remaining,0);
  if(remaining>0)out.push(['📅','등록한 고정지출 중 출금 미확인',`${fmt(remaining)} · 실제 미납액이 아니라 예정액과 입력된 거래의 차이입니다.`]);
  // vs last month summary
  if(prevSpend>0){const diff=curSpend-prevSpend,pct=diff/prevSpend*100;
    out.push([diff>0?"🔺":"🔻","지난달 대비",`총지출이 ${diff>0?"증가":"감소"} <b>${pct>0?"+":""}${pct.toFixed(0)}%</b> (${fmt(Math.abs(diff))})`]);}
  el.innerHTML=out.length?out.map(([ic,t,b])=>`
    <div class="panel" style="background:var(--panel2);padding:14px">
      <div class="muted" style="font-size:12px">${ic} ${t}</div>
      <div style="margin-top:6px;font-size:14px;line-height:1.5">${b}</div>
    </div>`).join(""):`<div class="empty">인사이트를 만들 거래가 부족해요.</div>`;
}

// ---------- savings goals ----------
function renderGoals(){
  const el=document.getElementById("goalList");
  // overall net flow hint
  const net=analysis.summarize(store.tx,store.management).surplus;
  document.getElementById("netHint").textContent=store.tx.length?`전체 수입−소비+환급 ${fmt(net,true)} (확인 필요 제외)`:"";
  if(!store.goals.length){el.innerHTML=`<div class="empty" style="padding:14px">아직 목표가 없어요. 아래에서 추가해보세요.</div>`;return;}
  el.innerHTML=store.goals.map((g,i)=>{
    const pct=Math.max(0,Math.min(g.current/g.target*100,100));const done=g.current>=g.target;
    return `<div style="margin-bottom:16px">
      <div class="flex-between" style="font-size:14px">
        <span><b>${esc(g.name)}</b> ${done?'<span class="tag" style="background:rgba(52,211,153,.15);color:var(--accent2)">달성!</span>':''}</span>
        <span class="muted">${fmt(g.current)} / ${fmt(g.target)} (${(g.current/g.target*100).toFixed(0)}%)</span>
      </div>
      <div class="bar" style="height:12px"><i style="width:${pct}%"></i></div>
      <div class="row" style="margin-top:8px">
        <input type="number" placeholder="저축액 추가 (£)" aria-label="${esc(g.name)} 저축액 추가 (£ GBP)" data-add="${i}" style="width:150px">
        <button class="ghost addToGoal" data-i="${i}">+ 추가</button>
        <button class="ghost delGoal" data-i="${i}">삭제</button>
      </div>
    </div>`;}).join("");
  document.querySelectorAll(".addToGoal").forEach(b=>b.addEventListener("click",()=>{
    const i=+b.dataset.i;const inp=document.querySelector(`[data-add="${i}"]`);const v=parseFloat(inp.value);
    if(v){store.goals[i].current=(store.goals[i].current||0)+v;if(!save())return;render();toast("저축액 반영됨");}}));
  document.querySelectorAll(".delGoal").forEach(b=>b.addEventListener("click",()=>{
    if(confirm("이 목표를 삭제할까요?")){store.goals.splice(+b.dataset.i,1);if(!save())return;render();}}));
}
function budgetBar(label,actual,budget){
  const pct=Math.min(actual/budget*100,100);const over=actual>budget;
  return `<div style="margin-bottom:14px">
    <div class="flex-between" style="font-size:13px"><span>${esc(label)}</span>
    <span class="${over?'up':'muted'}">${fmt(actual)} / ${fmt(budget)} (${(actual/budget*100).toFixed(0)}%)</span></div>
    <div class="bar"><i class="${over?'over':''}" style="width:${pct}%"></i></div></div>`;
}
function baseOpts(o={}){return{responsive:true,maintainAspectRatio:false,
  plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>` ${o.money?fmt(c.parsed.y??c.parsed):c.parsed}`}}},
  scales:{x:{ticks:{color:"#6B7684"},grid:{display:false}},
    y:{title:{display:!!o.money,text:displayOrder==='KRW'?'KRW (원화 환산)':'GBP (파운드)'},ticks:{color:"#6B7684",callback:v=>o.money?primary(v):v},grid:{color:"#E5E8EB"}}}};}

let txFilter="";
function renderTx(list){
  const f=txFilter.toLowerCase();
  const rows=list.filter(t=>{const result=classification(t),c=result.kind;return (!f||(t.name+t.category+(t.notes||'')).toLowerCase().includes(f))&&(kindFilter==='all'||kindFilter==='spending'&&consumed(t)||kindFilter==='transferIn'&&c==='transfer'&&t.amount>0||kindFilter==='transferInConfirmed'&&c==='transfer'&&t.amount>0&&!result.estimated||kindFilter==='transferInEstimated'&&c==='transfer'&&t.amount>0&&result.estimated||kindFilter==='transferOut'&&c==='transfer'&&t.amount<0||kindFilter===c);});
  const incoming=['transferIn','transferInConfirmed','transferInEstimated','income','refund'].includes(kindFilter);
  el('counterpartyHeading').textContent=incoming?'보낸 사람 / 메모':'상대방 / 내용';
  el('transactionHelp').textContent=incoming?'CSV에 기록된 이름과 메모입니다. 이름 미기재 거래는 메모를 참고하세요. 이름만으로 실제 계좌 소유자를 확인할 수는 없어요. 은행명은 메모에 있는 경우에만 볼 수 있어요.':'금액은 원본 거래일 기준입니다. 아래에서 거래별 분류를 수정할 수 있어요.';
  const pages=Math.max(1,Math.ceil(rows.length/100));txPage=Math.min(txPage,pages-1);
  el('txCount').textContent=`(${rows.length}건)`;el('txPage').textContent=`${txPage+1} / ${pages}`;el('prevTx').disabled=txPage===0;el('nextTx').disabled=txPage===pages-1;
  const totals=analysis.summarize(rows,store.management);el('filteredSum').textContent=`필터 결과 · 입금 ${fmt(totals.grossIn)} · 출금 ${fmt(totals.grossOut)}`;
  el('txBody').innerHTML=rows.slice(txPage*100,(txPage+1)*100).map(t=>{const c=classification(t),override=store.management.overrides[t.key];return `<tr><td>${t.date}</td><td class="tx-name">${esc(t.counterparty===undefined?t.name:(t.counterparty||'이름 미기재'))}<div class="muted">메모: ${esc(t.notes||'없음')}</div>${t.amount>0&&t.counterparty===undefined?'<small class="muted">CSV 표시명 · 원본 이름 확인은 CSV 재업로드</small>':t.counterparty===''?'<small class="muted">보낸 사람 확인 필요</small>':''}</td><td><span class="tag">${esc(t.category)}</span></td><td class="amt ${t.amount<0?'':'down'}">${fmt(t.amount,true)}</td><td class="tx-kind"><b>${c.estimated?'추정 · ':''}${c.label}${c.kind==='transfer'?(t.amount<0?' 출금':' 입금'):''}</b><div class="muted">${esc(c.reason)}</div><select class="changeKind" data-key="${esc(t.key)}" aria-label="${esc(t.name)} ${t.date} 거래 분류"><option value="auto" ${!override?'selected':''}>자동 분류</option>${Object.entries(analysis.labels).filter(([k])=>analysis.allowed(k,analysis.direction(t))).map(([k,v])=>`<option value="${k}" ${override===k?'selected':''}>${v}</option>`).join('')}</select><button class="ghost applyRule" data-key="${esc(t.key)}" style="font-size:12px">같은 이름에 적용</button></td></tr>`;}).join('')||'<tr><td colspan="5" class="empty">거래 없음</td></tr>';
  document.querySelectorAll('.changeKind').forEach(b=>b.addEventListener('change',()=>changeManagement(m=>{if(b.value==='auto')delete m.overrides[b.dataset.key];else m.overrides[b.dataset.key]=b.value;},'거래 분류 저장됨')));
  document.querySelectorAll('.applyRule').forEach(b=>b.addEventListener('click',()=>{const t=store.tx.find(t=>t.key===b.dataset.key),kind=classification(t).kind,who=normMerchant(t.name),dir=analysis.direction(t);
    changeManagement(m=>{m.rules=m.rules.filter(r=>r.merchant!==who||r.direction!==dir);m.rules.push({merchant:who,direction:dir,kind});for(const x of store.tx)if(normMerchant(x.name)===who&&analysis.direction(x)===dir)delete m.overrides[x.key];},'같은 이름·입출금 방향의 모든 기간에 적용됨');}));
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

// ---------- toast ----------
let tT;function toast(msg){document.getElementById("importStatus").textContent=msg;const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");
  clearTimeout(tT);tT=setTimeout(()=>t.classList.remove("show"),2200);}

// ---------- events ----------
const drop=document.getElementById("drop"),fileInput=document.getElementById("file");
drop.addEventListener("click",()=>fileInput.click());
drop.addEventListener("keydown",e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileInput.click();}});
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over");});
drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");handleFiles(e.dataTransfer.files);});
fileInput.addEventListener("change",e=>handleFiles(e.target.files));
async function handleFiles(files){
  if(!files.length)return;
  let added=0;
  try{for(const file of files){if(!/\.csv$/i.test(file.name))throw new Error('CSV 파일을 선택하세요.');if(file.size>20*1024*1024)throw new Error('20MB 이하 파일을 선택하세요.');added+=ingest(await file.text());}storageProblem='';render();toast(added+'건 추가됨 (중복 제외)');}
  catch(e){render();toast('파일 불러오기: '+e.message+(added?' · 앞선 파일 '+added+'건은 저장됨':''));}
  fileInput.value='';
}
document.getElementById("month").addEventListener("change",()=>{txPage=0;render();});
document.getElementById("search").addEventListener("input",e=>{txFilter=e.target.value;txPage=0;
  const m=document.getElementById("month").value;renderTx(store.tx.filter(t=>ym(t.date)===m));});
document.getElementById("currency").addEventListener("change",e=>{const order=e.target.value;if(!['GBP','KRW'].includes(order))return;try{localStorage.setItem(DISPLAYKEY,order);displayOrder=order;render();}catch(err){document.getElementById('currency').value=displayOrder;toast('표시 설정을 저장하지 못했습니다.');}});
document.getElementById("saveBudget").addEventListener("click",()=>{
  const v=parseFloat(document.getElementById("totalBudget").value);
  store.totalBudget=v>0?v:null;if(!save())return;render();toast("목표 저장됨");});
document.getElementById("addGoal").addEventListener("click",()=>{
  const name=document.getElementById("goalName").value.trim();
  const target=parseFloat(document.getElementById("goalTarget").value);
  if(!name||!(target>0)){toast("목표 이름과 금액을 입력하세요");return;}
  store.goals.push({name,target,current:0});if(!save())return;
  document.getElementById("goalName").value="";document.getElementById("goalTarget").value="";
  render();toast("목표 추가됨");});
document.getElementById("clearBtn").addEventListener("click",()=>{
  if(confirm("모든 거래와 예산 설정을 삭제할까요? 되돌릴 수 없습니다.")){
    store=SpendingCore.empty();undoMeta=null;if(!save())return;render();toast("삭제 완료");}});
document.getElementById("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(store,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download=`지출트래커_백업_${new Date().toISOString().slice(0,10)}.json`;a.click();});
document.getElementById("importBtn").addEventListener("click",()=>document.getElementById("importFile").click());
document.getElementById("importFile").addEventListener("change",async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  try{if(f.size>20*1024*1024)throw new Error('20MB 이하 백업 파일을 선택하세요.');const restored=SpendingCore.normalize(JSON.parse(await f.text()));localStorage.setItem(KEY,JSON.stringify(restored));store=restored;undoMeta=null;storageProblem='';render();toast('복원 완료');}
  catch(err){toast('복원하지 못했습니다. 기존 기록은 유지됩니다. '+err.message);}
});
el('kindFilter').addEventListener('change',e=>{kindFilter=e.target.value;txPage=0;render();});
el('prevTx').addEventListener('click',()=>{txPage=Math.max(0,txPage-1);render();});
el('nextTx').addEventListener('click',()=>{txPage++;render();});
el('saveClassification').addEventListener('click',()=>{const names=el('salaryNames').value.split('\n').map(n=>n.trim()).filter(Boolean),policy=el('otherIncomeTransfers').checked;changeManagement(m=>{m.salaryNames=names;m.otherIncomeTransfers=policy;},'입금 분류 설정 저장됨');});
el('undoClassification').addEventListener('click',()=>{if(!undoMeta)return;const prior=JSON.parse(undoMeta);if(changeManagement(m=>{for(const k of Object.keys(m))delete m[k];Object.assign(m,prior);},'분류·고정지출 변경을 되돌렸습니다.')){undoMeta=null;el('undoClassification').disabled=true;}});
el('resetFixed').addEventListener('click',()=>fillFixed());
el('saveFixed').addEventListener('click',()=>{const plan={id:editingFixedId||'fixed-'+Date.now()+'-'+Math.random().toString(36).slice(2),name:el('fixedName').value,merchant:el('fixedMerchant').value,amount:Number(el('fixedAmount').value),day:Number(el('fixedDay').value),start:el('fixedStart').value,end:el('fixedEnd').value,active:true};
  if(changeManagement(m=>{m.fixed=m.fixed.filter(p=>p.id!==plan.id);m.fixed.push(plan);},'고정지출 일정 저장됨')){editingFixedId=plan.id;el('fixedFormStatus').textContent='저장되었습니다.';}});
el('resetSuggestions').addEventListener('click',()=>changeManagement(m=>{m.dismissed=[];},'제외했던 후보를 다시 표시합니다.'));
el('importSettings').addEventListener('click',()=>el('settingsFile').click());
el('settingsFile').addEventListener('change',async e=>{const f=e.target.files[0];e.target.value='';if(!f)return;try{
  if(f.size>1024*1024)throw new Error('1MB 이하 설정 파일을 선택하세요.');const raw=JSON.parse(await f.text());if(raw.type!=='suiknote-spending-settings')throw new Error('지출 분류 설정 파일이 아닙니다.');const incoming=analysis.normalize(raw.management);
  changeManagement(m=>{m.salaryNames=[...new Set([...m.salaryNames,...incoming.salaryNames])];m.otherIncomeTransfers=incoming.otherIncomeTransfers;
    for(const r of incoming.rules){m.rules=m.rules.filter(x=>x.merchant!==r.merchant||x.direction!==r.direction);m.rules.push(r);}
    for(const p of incoming.fixed){m.fixed=m.fixed.filter(x=>x.id!==p.id);m.fixed.push(p);}Object.assign(m.overrides,incoming.overrides);
  },'개인 분류 설정 적용됨 · 거래 원본은 유지됩니다.');
}catch(err){toast('설정 불러오기: '+err.message);}});
function notifyParent(){
  if(window.parent!==window)window.parent.postMessage({type:'suiknote-spending-size',height:Math.ceil(document.body.getBoundingClientRect().height)+8,count:store.tx.length},location.origin);
}
if(typeof ResizeObserver==='function')new ResizeObserver(()=>requestAnimationFrame(notifyParent)).observe(document.body);
window.addEventListener('storage',e=>{if(e.key===KEY||e.key===null){store=load();undoMeta=null;render();}if(e.key===FXKEY||e.key===null){fxRates=loadRates();fxError='';render();}});

function renderFX(){
  const rate=currentRate();
  document.getElementById('fxSummary').textContent=(rate?'1 GBP = '+rate.rate.toLocaleString('ko-KR',{maximumFractionDigits:4})+'원 · '+rate.date+' · '+rate.source:'환율 미확인 · 원화 환산액을 표시하려면 환율을 조회하거나 직접 입력하세요.')+(fxBusy?' · 조회 중…':'');
  const input=document.getElementById('fxRate');if(document.activeElement!==input)input.value=rate?rate.rate:'';
  document.getElementById('fxError').textContent=fxError;
  document.getElementById('refreshFX').disabled=fxBusy;document.getElementById('applyFX').disabled=fxBusy;
}
function saveRate(rate){
  const next={...loadRates(),GBP:rate};localStorage.setItem(FXKEY,JSON.stringify(next));fxRates=next;
  if(window.parent!==window)window.parent.postMessage({type:'suiknote-spending-fx'},location.origin);
}
document.getElementById('applyFX').addEventListener('click',()=>{
  const value=document.getElementById('fxRate').value.trim(),rate=Number(value);
  if(!value||!Number.isFinite(rate)||rate<=0){fxError='1 GBP당 원화 환율을 양수로 입력하세요.';renderFX();return;}
  try{saveRate({rate,date:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}),source:'수동입력',fetchedAt:new Date().toISOString()});fxError='';render();}
  catch(e){fxError='환율을 저장하지 못했습니다. 기존 환율을 유지합니다.';renderFX();}
});
async function refreshFX(){
  if(fxBusy)return;fxBusy=true;fxError='';renderFX();
  const requestedRate=JSON.stringify(loadRates().GBP);
  try{const result=await StockPortfolio.fetchRates(['GBP'],(url,options)=>fetch(url,options));
    if(!result.rates.GBP)throw new Error('조회 실패');
    if(JSON.stringify(loadRates().GBP)===requestedRate)saveRate(result.rates.GBP);else fxRates=loadRates();
  }catch(e){fxError='최신 환율을 불러오지 못했습니다. 저장된 환율이 있으면 유지합니다. 직접 입력도 가능합니다.';}
  finally{fxBusy=false;render();}
}
document.getElementById('refreshFX').addEventListener('click',refreshFX);


render();
if(typeof fetch==='function'&&currentRate()?.source!=='수동입력')refreshFX();

})();
