/* Adapted from yjyj41/spending-tracker @ 839196e20fcfac1d180e01c4c50287c2824dc0a0 */
(function(){
"use strict";
// ---------- storage ----------
const KEY="spend_tracker_v1";
let storageProblem='';
let store=load();
function load(){try{const raw=localStorage.getItem(KEY);return raw?SpendingCore.normalize(JSON.parse(raw)):SpendingCore.empty();}catch(e){storageProblem='기존 기록을 읽지 못했습니다. 원본 데이터는 보존되어 있습니다. 지출 백업 파일로 복원하세요. '+e.message;return SpendingCore.empty();}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(SpendingCore.normalize(store)));return true;}catch(e){store=load();cur=store.currency;document.getElementById('currency').value=cur;render();toast('저장하지 못했습니다. '+e.message);return false;}}
let cur=store.currency;
document.getElementById('currency').value=cur;
function ingest(text){const result=SpendingCore.mergeCSV(store,text);localStorage.setItem(KEY,JSON.stringify(result.store));store=result.store;return result.added;}

// ---------- helpers ----------
const fmt=n=>cur+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:n%1?2:0});
const ym=d=>d.slice(0,7);
const monthLabel=m=>{const[y,mo]=m.split("-");return `${y}.${mo}`;};
function spendingOf(list){return list.filter(t=>t.amount<0).reduce((s,t)=>s+(-t.amount),0);}
function months(){return [...new Set(store.tx.map(t=>ym(t.date)))].sort().reverse();}
const prevMonth=SpendingCore.prevMonth;

// ---------- charts ----------
let charts={};
function destroy(){Object.values(charts).forEach(c=>c&&c.destroy());charts={};}
const palette=["#3182F6","#34d399","#fbbf24","#f87171","#a78bfa","#22d3ee","#fb923c","#f472b6","#4ade80","#60a5fa","#facc15","#c084fc"];

// ---------- render ----------
function render(){
  requestAnimationFrame(notifyParent);
  document.getElementById("storageNotice").textContent=storageProblem;
  document.getElementById("totalBudget").value=store.totalBudget||'';
  const ms=months();
  const sel=document.getElementById("month");
  const chosen=sel.value && ms.includes(sel.value)?sel.value:ms[0];
  sel.innerHTML=ms.map(m=>`<option value="${m}" ${m===chosen?"selected":""}>${monthLabel(m)}</option>`).join("");

  const hasData=store.tx.length>0;
  for(const id of ['chartsArea','insightsPanel','subscriptionsPanel','transactionsPanel'])document.getElementById(id).style.display=hasData?'':'none';
  document.getElementById("controls").style.display="";
  document.getElementById("clearBtn").disabled=!hasData&&!store.goals.length&&!Object.keys(store.budgets).length&&!store.totalBudget;
  if(!hasData){
    document.getElementById("cards").innerHTML=`<div class="empty">아직 데이터가 없습니다. 위에 Monzo CSV를 올려보세요.</div>`;
    document.getElementById("budgetArea").innerHTML="";document.getElementById("catBudgets").innerHTML="";
    document.getElementById("txBody").innerHTML="";document.getElementById("txCount").textContent="";
    document.getElementById("insights").innerHTML="";document.getElementById("subList").innerHTML="";
    document.getElementById("subTotal").textContent="";renderGoals();
    destroy();return;
  }
  const m=chosen, pm=prevMonth(m);
  const cur_tx=store.tx.filter(t=>ym(t.date)===m);
  const prev_tx=store.tx.filter(t=>ym(t.date)===pm);
  const curSpend=spendingOf(cur_tx), prevSpend=spendingOf(prev_tx);
  const income=cur_tx.filter(t=>t.amount>0).reduce((s,t)=>s+t.amount,0);

  // cards
  let deltaHtml="";
  if(prevSpend>0){
    const diff=curSpend-prevSpend, pct=(diff/prevSpend*100);
    const cls=diff>0?"up":(diff<0?"down":"flat");
    deltaHtml=`<div class="delta ${cls}">${diff>0?"▲":diff<0?"▼":"="} ${fmt(Math.abs(diff))} (${pct>0?"+":""}${pct.toFixed(1)}%) vs 지난 달</div>`;
  }else deltaHtml=`<div class="delta flat">지난 달 데이터 없음</div>`;
  let budgetCard="";
  if(store.totalBudget){
    const left=store.totalBudget-curSpend; const cls=left<0?"up":"down";
    budgetCard=`<div class="panel card"><div class="label">월 목표 대비</div>
      <div class="value">${fmt(curSpend)} <span class="muted" style="font-size:15px">/ ${fmt(store.totalBudget)}</span></div>
      <div class="delta ${cls}">${left>=0?"남음 "+fmt(left):"초과 "+fmt(left)}</div></div>`;
  }
  document.getElementById("cards").innerHTML=`
    <div class="panel card"><div class="label">이번 달 총지출 (${monthLabel(m)})</div><div class="value">${fmt(curSpend)}</div>${deltaHtml}</div>
    <div class="panel card"><div class="label">이번 달 수입</div><div class="value">${fmt(income)}</div><div class="delta flat">순흐름 ${income-curSpend>=0?"+":""}${fmt(income-curSpend)}</div></div>
    <div class="panel card"><div class="label">거래 건수</div><div class="value">${cur_tx.length}</div><div class="delta flat">지출 ${cur_tx.filter(t=>t.amount<0).length}건</div></div>
    ${budgetCard}`;

  destroy();
  const catMap=Object.create(null);
  cur_tx.filter(t=>t.amount<0).forEach(t=>{catMap[t.category]=(catMap[t.category]||0)+(-t.amount);});
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
      <input type="number" data-cat="${esc(c)}" class="catBudgetInput" placeholder="목표" value="${store.budgets[c]||""}" style="width:110px">
    </div>`).join("")||`<span class="muted">거래를 올리면 카테고리가 나타납니다.</span>`;
  document.querySelectorAll(".catBudgetInput").forEach(inp=>{
    inp.addEventListener("change",()=>{
      const c=inp.dataset.cat;const v=parseFloat(inp.value);
      if(v>0)store.budgets[c]=v;else delete store.budgets[c];
      if(!save())return;render();
    });
  });

  renderInsights(m,pm,cur_tx,prev_tx,catMap);
  renderSubscriptions();
  renderGoals();
  renderTx(cur_tx);
}

// ---------- subscription / recurring detection ----------
function normMerchant(name){
  return String(name).toLowerCase()
    .replace(/,.*$/,"")                 // drop after comma
    .replace(/[0-9#*]+/g,"")            // drop digits/refs
    .replace(/\b(ltd|limited|inc|uk|gbp|london|payment|card)\b/g,"")
    .replace(/[^a-z가-힣\s]/g," ")
    .replace(/\s+/g," ").trim();
}
function median(a){const s=[...a].sort((x,y)=>x-y);const n=s.length;return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2;}
function detectRecurring(){
  const groups=Object.create(null);
  store.tx.filter(t=>t.amount<0).forEach(t=>{
    const k=normMerchant(t.name);if(!k||k.length<2)return;
    (groups[k]=groups[k]||[]).push({date:t.date,amt:-t.amount,name:t.name});
  });
  const subs=[];
  for(const k in groups){
    const g=groups[k].sort((a,b)=>a.date<b.date?-1:1);
    if(g.length<2)continue;
    const amts=g.map(x=>x.amt), med=median(amts);
    // amount consistency: most charges within 25% of median (filters out groceries etc.)
    const consistent=amts.filter(a=>Math.abs(a-med)<=med*0.25).length;
    if(consistent < Math.max(2,g.length*0.6))continue;
    // intervals in days
    const ms=g.map(x=>new Date(x.date).getTime());
    const ivs=[];for(let i=1;i<ms.length;i++)ivs.push((ms[i]-ms[i-1])/86400000);
    const iv=median(ivs);
    let freq=null,perMonth=0;
    if(iv>=6&&iv<=8){freq="매주";perMonth=4.33;}
    else if(iv>=12&&iv<=16){freq="격주";perMonth=2.17;}
    else if(iv>=26&&iv<=35){freq="매월";perMonth=1;}
    else if(iv>=80&&iv<=100){freq="분기";perMonth=1/3;}
    else if(iv>=350&&iv<=380){freq="연간";perMonth=1/12;}
    else continue;
    const last=g[g.length-1], lastAmt=last.amt;
    const next=new Date(new Date(last.date).getTime()+iv*86400000).toISOString().slice(0,10);
    // price rise: latest vs median of earlier charges
    const earlier=amts.slice(0,-1);
    const baseAmt=earlier.length?median(earlier):med;
    const rise=lastAmt>baseAmt*1.05 && (lastAmt-baseAmt)>0.5 ? {from:baseAmt,to:lastAmt} : null;
    subs.push({name:last.name,typical:med,lastAmt,freq,perMonth,monthly:med*perMonth,
      last:last.date,next,count:g.length,rise});
  }
  return subs.sort((a,b)=>b.monthly-a.monthly);
}
function renderSubscriptions(){
  const subs=detectRecurring();
  const el=document.getElementById("subList");
  if(!subs.length){el.innerHTML=`<div class="empty" style="padding:20px">정기결제로 보이는 거래가 아직 없어요.<br>여러 달치 CSV를 올리면 더 정확히 감지됩니다.</div>`;
    document.getElementById("subTotal").textContent="";return;}
  const total=subs.reduce((s,x)=>s+x.monthly,0);
  document.getElementById("subTotal").textContent=`월 약 ${fmt(total)} · ${subs.length}건`;
  el.innerHTML=subs.map(s=>`
    <div style="display:grid;grid-template-columns:1fr auto;gap:8px;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-weight:600">${esc(s.name)} ${s.rise?`<span class="tag" style="background:rgba(248,113,113,.15);color:var(--danger)">▲ 인상</span>`:""}</div>
        <div class="muted" style="font-size:12px">${s.freq} · 최근 ${s.last} · 다음 예상 ${s.next}${s.rise?` · ${fmt(s.rise.from)}→${fmt(s.rise.to)}`:""}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:600">${fmt(s.lastAmt)}</div>
        <div class="muted" style="font-size:12px">월 ${fmt(s.monthly)}</div>
      </div>
    </div>`).join("");
}

// ---------- smart insights ----------
function renderInsights(m,pm,cur_tx,prev_tx,catMap){
  const el=document.getElementById("insights");
  const out=[];
  const curSpend=spendingOf(cur_tx), prevSpend=spendingOf(prev_tx);
  // category growth
  const prevCat=Object.create(null);prev_tx.filter(t=>t.amount<0).forEach(t=>{prevCat[t.category]=(prevCat[t.category]||0)+(-t.amount);});
  let topGrow=null;
  for(const c in catMap){const d=catMap[c]-(prevCat[c]||0);if(!topGrow||d>topGrow.d)topGrow={c,d,now:catMap[c]};}
  if(topGrow&&topGrow.d>0)out.push(["📈","가장 많이 늘어난 지출",`<b>${esc(topGrow.c)}</b> · 지난달보다 +${fmt(topGrow.d)} 늘어 ${fmt(topGrow.now)}`]);
  // biggest single
  const spend=cur_tx.filter(t=>t.amount<0);
  if(spend.length){const big=spend.reduce((a,b)=>(-b.amount>-a.amount?b:a));
    out.push(["💳","이번 달 최대 지출",`<b>${fmt(big.amount)}</b> · ${esc(big.name)} (${big.date})`]);}
  // most frequent merchant
  const cnt=Object.create(null);spend.forEach(t=>{const k=normMerchant(t.name)||t.name;cnt[k]=(cnt[k]||0)+1;});
  const freq=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0];
  if(freq&&freq[1]>1){const sample=spend.find(t=>(normMerchant(t.name)||t.name)===freq[0]);
    out.push(["🏪","가장 자주 간 곳",`<b>${esc(sample?sample.name:freq[0])}</b> · ${freq[1]}회 방문`]);}
  // projection (only if selected month is current calendar month)
  const now=new Date(), today=now.toLocaleDateString("sv-SE",{timeZone:"Asia/Seoul"}), curM=today.slice(0,7);
  if(m===curM){const [year,month,dayN]=today.split("-").map(Number),days=new Date(Date.UTC(year,month,0)).getUTCDate();
    const proj=curSpend/dayN*days;
    out.push(["🔮","이대로면 월말 예상",`<b>${fmt(proj)}</b> · 현재 ${dayN}일째 ${fmt(curSpend)} 지출`]);}
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
  const net=store.tx.reduce((s,t)=>s+t.amount,0);
  document.getElementById("netHint").textContent=store.tx.length?`전체 순흐름 ${net>=0?"+":""}${fmt(net)}`:"";
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
        <input type="number" placeholder="저축액 추가" data-add="${i}" style="width:130px">
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
    y:{ticks:{color:"#6B7684",callback:v=>o.money?fmt(v):v},grid:{color:"#E5E8EB"}}}};}

let txFilter="";
function renderTx(list){
  const f=txFilter.toLowerCase();
  const rows=list.filter(t=>!f||(t.name+t.category+(t.notes||" ")).toLowerCase().includes(f));
  document.getElementById("txCount").textContent=`(${rows.length}건)`;
  document.getElementById("txBody").innerHTML=rows.map(t=>`
    <tr><td>${t.date}</td><td>${esc(t.name)}</td><td><span class="tag">${esc(t.category)}</span></td>
    <td class="amt ${t.amount<0?'':'down'}">${t.amount<0?"-":"+"}${fmt(t.amount)}</td></tr>`).join("")
    ||`<tr><td colspan="4" class="empty">거래 없음</td></tr>`;
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
document.getElementById("month").addEventListener("change",render);
document.getElementById("search").addEventListener("input",e=>{txFilter=e.target.value;
  const m=document.getElementById("month").value;renderTx(store.tx.filter(t=>ym(t.date)===m));});
document.getElementById("currency").addEventListener("change",e=>{cur=e.target.value;store.currency=cur;if(!save())return;render();});
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
    store={tx:[],budgets:{},totalBudget:null,currency:cur,goals:[]};if(!save())return;render();toast("삭제 완료");}});
document.getElementById("exportBtn").addEventListener("click",()=>{
  const blob=new Blob([JSON.stringify(store,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download=`지출트래커_백업_${new Date().toISOString().slice(0,10)}.json`;a.click();});
document.getElementById("importBtn").addEventListener("click",()=>document.getElementById("importFile").click());
document.getElementById("importFile").addEventListener("change",async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  try{if(f.size>20*1024*1024)throw new Error('20MB 이하 백업 파일을 선택하세요.');const restored=SpendingCore.normalize(JSON.parse(await f.text()));localStorage.setItem(KEY,JSON.stringify(restored));store=restored;storageProblem='';cur=store.currency;document.getElementById('currency').value=cur;render();toast('복원 완료');}
  catch(err){toast('복원하지 못했습니다. 기존 기록은 유지됩니다. '+err.message);}
});
function notifyParent(){
  if(window.parent!==window)window.parent.postMessage({type:'suiknote-spending-size',height:Math.ceil(document.body.getBoundingClientRect().height)+8,count:store.tx.length},location.origin);
}
if(typeof ResizeObserver==='function')new ResizeObserver(()=>requestAnimationFrame(notifyParent)).observe(document.body);
window.addEventListener('storage',e=>{if(e.key===KEY){store=load();cur=store.currency;document.getElementById('currency').value=cur;render();}});


render();

})();
