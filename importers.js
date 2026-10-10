/* Pure import/calculation code, shared by the browser and node --test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockImports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EPS = 1e-8;
  const text = x => String(x == null ? '' : x).replace(/^\uFEFF/, '').trim();
  function number(x) {
    if (x == null || text(x) === '') return null;
    const value = Number(text(x).replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  }
  function quantity(x) {
    const match = text(x).match(/\(([-\d.,]+)\)\s*$/);
    const n = number(match ? match[1] : x);
    return n == null ? null : Math.abs(n);
  }
  function date(x) {
    if (x instanceof Date) {
      return [x.getFullYear(), String(x.getMonth() + 1).padStart(2, '0'), String(x.getDate()).padStart(2, '0')].join('-');
    }
    const match = text(x).match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
    if (!match) throw new Error('날짜를 읽을 수 없어요: ' + text(x));
    const out = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
    const d = new Date(out + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== out) throw new Error('잘못된 날짜: ' + out);
    return out;
  }
  function csv(input) {
    const rows = []; let row = [], field = '', quoted = false;
    const s = String(input).replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); if (row.some(x => text(x))) rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (quoted) throw new Error('CSV의 따옴표가 닫히지 않았어요. 원본 CSV를 다시 내보내 주세요.');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function findHeader(rows, predicate) {
    for (let i = 0; i < Math.min(rows.length, 20); i++) if (rows[i] && predicate(Array.from(rows[i], text))) return i;
    return -1;
  }
  function stockId(value) { return encodeURIComponent(value); }
  function viewKey(t) { return (t.source || 'manual') + ':' + (t.currency || 'KRW'); }
  function matchExecutions(executions) {
    const positions = new Map(), trades = [], warnings = [], days = new Map();
    // Samsung's settlement export is reverse chronological and groups buys/sells
    // separately. Only date-level execution order is known: pool same-day buys.
    for (const e of [...executions].sort((a, b) => a.date.localeCompare(b.date) || (a.side === 'B' ? 0 : 1) - (b.side === 'B' ? 0 : 1) || a.row - b.row)) {
      const key = e.name, p = positions.get(key) || { qty: 0, cost: 0, netCost: 0, costKnown: true, buyDate: e.date };
      if (e.side === 'B') {
        if (p.qty < EPS) p.buyDate = e.date;
        p.qty += e.qty; p.cost += e.qty * e.price;
        p.netCost += e.qty * e.price + (e.costKnown ? e.fee : 0);
        p.costKnown = p.costKnown && !!e.costKnown;
      } else {
        if (e.qty > p.qty + EPS) throw new Error(e.name + ' ' + e.date + ': 매도 ' + e.qty + '주의 매입원가가 부족해요. 최초 매수부터 전체 내역을 올려 주세요.');
        const cost = p.cost * e.qty / p.qty, netCost = p.netCost * e.qty / p.qty, proceeds = e.qty * e.price;
        const roundKey = key + '|' + e.date;
        const t = days.get(roundKey) || { name: key, qty: 0, invested: 0, netInvested: 0, proceeds: 0, netProceeds: 0, costKnown: true, executions: [], buyDate: p.buyDate, sellDate: e.date };
        t.qty += e.qty; t.invested += cost; t.proceeds += proceeds;
        t.netInvested += netCost; t.netProceeds += proceeds - (e.costKnown ? e.fee : 0);
        t.costKnown = t.costKnown && p.costKnown && !!e.costKnown;
        t.executions.push({ date: e.date, side: 'S', qty: e.qty, price: e.price });
        if (p.buyDate < t.buyDate) t.buyDate = p.buyDate;
        days.set(roundKey, t);
        p.qty -= e.qty; p.cost -= cost; p.netCost -= netCost;
        if (Math.abs(p.qty) < EPS) { p.qty = 0; p.cost = 0; p.netCost = 0; p.costKnown = true; }
      }
      positions.set(key, p);
    }
    for (const t of days.values()) {
      trades.push({ ...t, buyPrice: t.invested / t.qty, sellPrice: t.proceeds / t.qty,
        realizedPnl: t.proceeds - t.invested,
        netPnl: t.costKnown ? t.netProceeds - t.netInvested : null,
        fees: t.costKnown ? (t.netInvested - t.invested) + (t.proceeds - t.netProceeds) : null,
        buyExecutions: executions.filter(e => e.name === t.name && e.side === 'B' && e.date >= t.buyDate && e.date <= t.sellDate).map(e => ({ date: e.date, side: e.side, qty: e.qty, price: e.price })),
        source: 'samsung-ledger', currency: 'KRW',
        basis: t.costKnown ? '입출금액의 수수료·세금 반영 · 이동평균 원가' : '비용 미확인 · 비용 전 추정손익', id: 'samsung-ledger|' + stockId(t.name) + '|' + t.sellDate });
    }
    const openPositions = [...positions].filter(([, p]) => p.qty > EPS).map(([name, p]) => ({ name, ...p }));
    warnings.push('거래일자(결제일) 기준 · 일별 이동평균 매입원가입니다. 일반 현금거래는 일별 입출금액과 체결금액 차이의 비용을 반영합니다. 융자·현금금액 누락·혼합 원가는 비용 전 추정치로 표시합니다. 별도 신용이자·배당은 제외하며, 전체 순수익은 손익표로 확인하세요.');
    if (openPositions.length) warnings.push('보유 중인 ' + openPositions.length + '종목의 미실현손익은 제외했습니다.');
    return { trades, warnings, openPositions };
  }
  function samsungLedger(rows, h) {
    const header = Array.from(rows[h], text);
    const column = key => header.findIndex(x => x.includes(key));
    const c = { date: column('거래일자'), type: column('거래명'), name: column('거래내용'), currency: column('통화'), amount: column('금액'), price: column('거래단가') };
    if ([c.date, c.type, c.name, c.amount, c.price].some(x => x < 0)) throw new Error('삼성증권 거래내역의 필수 열이 없어요.');
    const executions = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i], type = text(r[c.type]), name = text(r[c.name]), currency = text(r[c.currency]);
      if (!/매수|매도/.test(type) || !name || (currency && currency !== 'KRW') || /외화|미국|NASDAQ|NYSE/.test(type)) continue;
      const side = type.includes('매수') ? 'B' : 'S';
      const q = quantity(r[c.amount + (side === 'S' ? 1 : 0)]), price = number(r[c.price]);
      if (!(q > 0) || !(price > 0)) throw new Error((i + 1) + '행의 수량·단가를 읽지 못했어요.');
      executions.push({ date: date(r[c.date]), name, side, qty: q, price, row: i,
        credit: /융자|신용/.test(type), cash: number(r[c.amount + (side === 'B' ? 1 : 0)]), ambiguous: /\(/.test(text(r[c.amount + (side === 'S' ? 1 : 0)])) });
    }
    if (!executions.length) throw new Error('국내주식 매수·매도 내역이 없어요.');
    // Cash is booked once for several fills (including NXT). Reconcile the group,
    // then allocate its costs by execution value. Loan cash includes principal.
    const groups = new Map();
    for (const e of executions) {
      const key = [e.date, e.name, e.side, e.credit].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const group of groups.values()) {
      const gross = group.reduce((s, e) => s + e.qty * e.price, 0);
      const cash = group.reduce((s, e) => s + (e.cash || 0), 0);
      const fee = group[0].side === 'B' ? cash - gross : gross - cash;
      const known = !group.some(e => e.credit || e.ambiguous) && group.some(e => e.cash > 0) && fee >= -EPS;
      for (const e of group) { e.costKnown = known; e.fee = known ? Math.max(0, fee) * e.qty * e.price / gross : 0; }
    }
    return { ...matchExecutions(executions), label: '삼성증권 거래내역', source: 'samsung-ledger' };
  }
  function samsungSummary(rows, h) {
    const header = Array.from(rows[h], text), col = key => header.findIndex(x => x.includes(key));
    const c = { date: col('매매일자'), buy: col('매수금액'), sell: col('매도금액'), pnl: col('순손익'), fee: col('수수료'), tax: col('세금') };
    if ([c.date, c.buy, c.sell, c.pnl].some(x => x < 0)) throw new Error('삼성증권 손익표의 필수 열이 없어요.');
    const trades = [], seen = new Set();
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i]; if (r[c.date] == null || text(r[c.date]) === '' || /합계|총계/.test(text(r[c.date]))) continue;
      const day = date(r[c.date]), invested = number(r[c.buy]), proceeds = number(r[c.sell]), pnl = number(r[c.pnl]);
      if ([invested, proceeds, pnl].some(x => x == null)) throw new Error((i + 1) + '행의 손익 금액이 비어 있어요.');
      if (seen.has(day)) throw new Error(day + ' 손익이 두 번 나와요. 중복 행을 확인해 주세요.');
      seen.add(day);
      trades.push({ id: 'samsung-summary|' + day, name: '삼성증권 일별 순손익', qty: 1, buyDate: day, sellDate: day,
        buyPrice: invested, sellPrice: proceeds, invested, proceeds, realizedPnl: pnl,
        fees: number(r[c.fee]) || 0, taxes: number(r[c.tax]) || 0, currency: 'KRW', source: 'samsung-summary',
        kind: 'summary', basis: '증권사 순손익 · 수수료·세금 차감 후' });
    }
    return { trades, label: '삼성증권 손익표', source: 'samsung-summary', openPositions: [],
      warnings: ['매매일 기준 · 파일의 순손익을 그대로 집계합니다. 거래내역의 종목별 추정손익과 별도로 표시합니다. 신용이자·배당·입출금은 별도입니다.'] };
  }
  function trading212(rows, h) {
    const header = Array.from(rows[h], text), col = key => header.findIndex(x => x.toLowerCase() === key.toLowerCase());
    const c = { action: col('Action'), time: col('Time (UTC)') >= 0 ? col('Time (UTC)') : col('Time'), isin: col('ISIN'), ticker: col('Ticker'), name: col('Name'), id: col('ID'),
      qty: col('No. of shares'), price: col('Price / share'), priceCurrency: col('Currency (Price / share)'),
      result: col('Result'), resultCurrency: col('Currency (Result)'), total: col('Total'), currency: col('Currency (Total)') };
    // Older exports put currency in the column title, e.g. Result (GBP).
    for (const key of ['result', 'total']) if (c[key] < 0) c[key] = header.findIndex(x => new RegExp('^' + key + ' \\([A-Z]{3}\\)$', 'i').test(x));
    if ([c.action, c.time, c.qty, c.price].some(x => x < 0)) throw new Error('Trading 212 Invest/ISA CSV의 필수 열이 없어요.');
    const currencyFor = (r, key, currencyIndex) => text(r[currencyIndex]) || ((header[c[key]] || '').match(/\(([A-Z]{3})\)/) || [])[1] || '';
    const trades = [], positions = new Map(), warnings = [], income = {}, expenses = {}, occurrences = new Map();
    let missingHistory = false, corporateAction = false, ignored = 0, reportedOnly = false;
    const list = rows.slice(h + 1).map((r, i) => ({ r, i })).filter(x => x.r.some(v => text(v))).sort((a, b) => text(a.r[c.time]).localeCompare(text(b.r[c.time])) || a.i - b.i);
    for (const { r, i } of list) {
      const action = text(r[c.action]), side = /\bbuy$/i.test(action) ? 'B' : /\bsell$/i.test(action) ? 'S' : null;
      if (/split|merger|spin.?off|stock distribution/i.test(action)) {
        positions.clear(); missingHistory = true; corporateAction = true;
        warnings.push('기업행동 이벤트가 있어 이후 매입원가는 확인하지 않습니다. 매도 Result가 없는 경우 전체 내역만으로도 계산을 중단합니다.');
        continue;
      }
      if (!side || /cancel|reject|pending/i.test(action)) {
        if (/dividend|interest/i.test(action)) {
          const currency = currencyFor(r, 'total', c.currency), amount = number(r[c.total]);
          if (currency && amount != null) income[currency] = (income[currency] || 0) + amount;
        } else if (!/deposit|withdraw|transfer|currency conversion/i.test(action)) ignored++;
        continue;
      }
      const q = quantity(r[c.qty]), price = number(r[c.price]), day = date(r[c.time]), name = text(r[c.name]) || text(r[c.ticker]);
      if (!(q > 0) || !(price >= 0) || !name) throw new Error((h + i + 2) + '행의 종목·수량·단가를 읽지 못했어요.');
      const result = number(r[c.result]), total = number(r[c.total]);
      const currency = (side === 'S' && result != null ? currencyFor(r, 'result', c.resultCurrency) : '') || currencyFor(r, 'total', c.currency);
      if (!currency) throw new Error('통화가 없는 거래가 있어요. Currency (Total) 또는 Currency (Result) 열을 포함해 내보내 주세요.');
      const totalCurrency = currencyFor(r, 'total', c.currency);
      const key = (text(r[c.isin]) || text(r[c.ticker]) || name) + '|' + currency;
      const p = positions.get(key) || { qty: 0, cost: 0, buyDate: day, name, currency };
      if (side === 'B') {
        if (total == null || (totalCurrency && totalCurrency !== currency)) throw new Error(name + ': 매수 Total과 통화를 확인해 주세요. 환율을 임의로 적용하지 않습니다.');
        if (p.qty < EPS) p.buyDate = day;
        p.qty += q; p.cost += Math.abs(total);
      } else {
        if (corporateAction && result == null) throw new Error(name + ': 기업행동 이후의 매입원가를 확인할 수 없어요. Result가 포함된 CSV를 올려 주세요.');
        const complete = q <= p.qty + EPS && p.qty > EPS;
        if (!complete && result == null) throw new Error(name + ': 매입원가와 Result가 없어요. 최초 매수부터 전체 CSV를 올려 주세요.');
        if (result == null && (total == null || totalCurrency !== currency)) throw new Error(name + ': 손익 계산에 필요한 같은 통화의 Total이 없어요.');
        const cost = complete ? p.cost * q / p.qty : null;
        const proceeds = total != null && totalCurrency === currency ? Math.abs(total) : (cost != null && result != null ? cost + result : null);
        const netFromTotal = complete && !corporateAction && total != null && totalCurrency === currency;
        const pnl = netFromTotal ? proceeds - cost : result;
        if (pnl == null) throw new Error(name + ': 비용 포함 손익과 Result를 확인할 수 없어요.');
        if (!netFromTotal) reportedOnly = true;
        const fingerprint = JSON.stringify([text(r[c.id]), text(r[c.time]), key, q, price, result, total]);
        const ordinal = occurrences.get(fingerprint) || 0; occurrences.set(fingerprint, ordinal + 1);
        trades.push({ id: 'trading212|' + stockId(fingerprint) + '|' + ordinal, source: 'trading212', currency, name,
          ticker: text(r[c.ticker]), qty: q, buyDate: complete ? p.buyDate : day, sellDate: day,
          buyPrice: cost != null ? cost / q : 0, sellPrice: proceeds != null ? proceeds / q : 0,
          invested: cost || 0, proceeds, realizedPnl: pnl, reportedPnl: result, kind: 'reported', reportedOnly: !netFromTotal,
          basis: netFromTotal ? 'Total 기준 비용 포함 손익' : '증권사 보고손익 (Result) · 비용 범위 미확인',
          memo: netFromTotal ? '매수·매도 Total에 반영된 비용 포함 · 이동평균 매입원가' + (result != null ? ' · CSV Result ' + result.toFixed(2) + ' ' + currency : '') : 'CSV Result 원문 그대로 · 전체 매입원가 또는 비용 포함 Total 미확인',
          unknownCost: !complete });
        if (complete) { p.qty -= q; p.cost -= cost; if (Math.abs(p.qty) < EPS) { p.qty = 0; p.cost = 0; } }
        else { missingHistory = true; p.qty = 0; p.cost = 0; }
      }
      positions.set(key, p);
      for (let j = 0; j < header.length; j++) {
        if (!/^(Currency conversion fee|Withholding tax|Stamp duty reserve tax|French transaction tax|Charge amount)( \([A-Z]{3}\))?$/i.test(header[j])) continue;
        const amount = number(r[j]); if (amount == null || !amount) continue;
        const feeCurrency = text(r[col('Currency (' + header[j] + ')')]) || (header[j].match(/\(([A-Z]{3})\)/) || [])[1] || currency;
        expenses[feeCurrency] = (expenses[feeCurrency] || 0) + Math.abs(amount);
      }
    }
    warnings.push('ISA/Invest CSV · 통화별로 집계합니다. 전체 매입 내역이 있으면 매수·매도 Total로 비용 포함 손익을 계산합니다. Total에 반영된 FX 수수료를 다시 빼지 않습니다. CSV Result는 비용 포함 손익과 다를 수 있어 거래별 참고값으로 보존합니다.');
    if (reportedOnly) warnings.push('일부 거래는 비용 포함 손익을 확인할 수 없어 CSV Result로 표시했습니다. 해당 거래는 정확한 비용 차감 후 순손익으로 볼 수 없습니다.');
    if (missingHistory) warnings.push('일부 매수 내역이 없어 CSV Result만 사용했습니다. 해당 거래의 매입원가·보유기간은 확인할 수 없습니다.');
    if (Object.keys(income).length) warnings.push('배당·현금이자는 매매손익과 별도로 집계했습니다: ' + Object.entries(income).map(([c, v]) => c + ' ' + v.toFixed(2)).join(', '));
    if (Object.keys(expenses).length) warnings.push('파일에 기재된 거래 비용(참고): ' + Object.entries(expenses).map(([c, v]) => c + ' ' + v.toFixed(2)).join(', ') + '. 매매손익에서 중복 차감하지 않습니다.');
    if (ignored) warnings.push('매매·입출금·배당·이자 외 이벤트 ' + ignored + '행은 손익에 반영하지 않았습니다.');
    return { source: 'trading212', label: 'Trading 212 ISA/Invest', trades, warnings, income, expenses,
      openPositions: [...positions.values()].filter(p => p.qty > EPS) };
  }
  function trading212CFD(rows, h) {
    const header = Array.from(rows[h], text);
    const norm = value => text(value).toLowerCase().replace(/[ _]/g, '');
    const col = (...names) => header.findIndex(x => names.some(name => norm(x) === norm(name)));
    const c = { type: col('Record Type'), date: col('Date (UTC)', 'Date', 'Time (UTC)', 'Time'), currency: col('Account currency'),
      name: col('Instrument'), ticker: col('Symbol'), priceCurrency: col('Instrument currency'), direction: col('Direction'), qty: col('Units'),
      position: col('Position ID'), order: col('Order ID'), opened: col('Date opened (UTC)'), closed: col('Date closed (UTC)'),
      entry: col('Average price (instrument currency)'), exit: col('Close price (instrument currency)'),
      result: col('Result (account currency)'), fx: col('FX fee (account currency)'), afterFx: col('Result after FX fee (account currency)'),
      overnight: col('Overnight interest (account currency)'), dividend: col('Dividend adjustment (account currency)'),
      total: col('Total result (account currency)'), amount: col('Amount (account currency)'), net: col('Amount net (account currency)') };
    if ([c.type, c.date, c.currency, c.name, c.qty, c.total].some(x => x < 0)) throw new Error('CFD CSV의 필수 열(Record Type, Date (UTC), Account currency, Instrument, Units, Total result (account currency))을 확인해 주세요.');
    const trades = [], occurrences = new Map(), breakdown = {}, events = {};
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i], type = norm(r[c.type]), currency = text(r[c.currency]);
      if (!type) continue;
      if (!currency) throw new Error((i + 1) + '행의 CFD 계좌 통화가 없어요.');
      if (type !== 'closedposition') {
        if (['overnightinterest','dividendadjustment','interestoncash'].includes(type)) {
          const amount = number(r[type === 'dividendadjustment' ? c.net : c.amount]);
          if (amount != null) { const key = currency + ' ' + text(r[c.type]); events[key] = (events[key] || 0) + amount; }
        }
        // Orders describe the same positions; deposits/withdrawals are not P&L.
        continue;
      }
      const pnl = number(r[c.total]), q = quantity(r[c.qty]), name = text(r[c.name]);
      if (pnl == null || !(q > 0) || !name) throw new Error((i + 1) + '행의 CFD 청산 수량·Total result를 읽지 못했어요.');
      const closed = text(r[c.closed]) || text(r[c.date]), opened = text(r[c.opened]);
      const day = date(closed), buyDate = opened ? date(opened) : day;
      if (buyDate > day) throw new Error(name + ': CFD 진입일이 청산일보다 늦어요.');
      const fingerprint = JSON.stringify([text(r[c.position]), text(r[c.order]), closed, name, q, pnl]);
      const ordinal = occurrences.get(fingerprint) || 0; occurrences.set(fingerprint, ordinal + 1);
      const b = breakdown[currency] || { result: 0, fx: 0, overnight: 0, dividend: 0, total: 0 };
      for (const key of ['result','fx','overnight','dividend']) b[key] += number(r[c[key]]) || 0;
      b.total += pnl; breakdown[currency] = b;
      const direction = text(r[c.direction]);
      trades.push({ id: 'trading212-cfd|' + stockId(fingerprint) + '|' + ordinal, source: 'trading212-cfd', currency,
        name, ticker: text(r[c.ticker]), qty: q, buyDate, sellDate: day, buyPrice: number(r[c.entry]), sellPrice: number(r[c.exit]),
        priceCurrency: text(r[c.priceCurrency]), invested: 0, realizedPnl: pnl, reportedPnl: number(r[c.result]),
        resultAfterFx: number(r[c.afterFx]), kind: 'cfd', unknownCost: true, unknownHold: !opened,
        direction: /sell|short/i.test(direction) ? '숏' : /buy|long/i.test(direction) ? '롱' : direction,
        basis: 'CFD 청산 Total result · 비용·조정 포함',
        memo: 'Total result 그대로 · FX fee ' + (number(r[c.fx]) || 0).toFixed(2) + ' · Overnight interest ' + (number(r[c.overnight]) || 0).toFixed(2) + ' · Dividend adjustment ' + (number(r[c.dividend]) || 0).toFixed(2) + ' ' + currency });
    }
    const warnings = ['CFD 청산손익 · Closed position의 Total result만 합산합니다. 주문·입출금은 손익에서 제외하고, 이미 포함된 FX 수수료·오버나이트 이자·배당 조정을 다시 더하거나 빼지 않습니다. 부분 청산과 롱·숏을 모두 포함합니다.',
      '미청산 포지션의 평가손익은 제외합니다. 증거금 자료가 없으므로 투자금 대비 수익률은 계산하지 않습니다. 표시 가격은 종목 통화, 손익은 계좌 통화 기준입니다. 날짜는 CSV의 UTC 기준입니다.'];
    for (const [currency, b] of Object.entries(breakdown)) warnings.push(currency + ' 청산 내역: 가격 손익 ' + b.result.toFixed(2) + ' / FX fee ' + b.fx.toFixed(2) + ' / 이자 ' + b.overnight.toFixed(2) + ' / 배당 조정 ' + b.dividend.toFixed(2) + ' / Total result ' + b.total.toFixed(2));
    if (Object.keys(events).length) warnings.push('별도 이벤트(청산손익에 중복 합산하지 않음): ' + Object.entries(events).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ') + '. 미청산 포지션의 이자·조정은 청산 합계에 포함되지 않을 수 있습니다.');
    trades.sort((a, b) => a.sellDate.localeCompare(b.sellDate));
    return { source: 'trading212-cfd', label: 'Trading 212 CFD', trades, warnings, breakdown, events, openPositions: [] };
  }
  function parseFile(rows) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('파일이 비어 있어요.');
    const cfd = findHeader(rows, h => h.some(x => /^record[ _]?type$/i.test(x)));
    if (cfd >= 0) return trading212CFD(rows, cfd);
    const summary = findHeader(rows, h => h.some(x => x.includes('순손익')) && h.some(x => x.includes('매매일자')));
    if (summary >= 0) return samsungSummary(rows, summary);
    const ledger = findHeader(rows, h => h.includes('거래일자') && h.includes('거래명'));
    if (ledger >= 0) return samsungLedger(rows, ledger);
    const t212 = findHeader(rows, h => h.includes('Action') && (h.includes('Time') || h.includes('Time (UTC)')));
    if (t212 >= 0) return trading212(rows, t212);
    throw new Error('지원 형식을 찾지 못했어요. 삼성증권 거래내역·손익표 또는 Trading 212 ISA/Invest·CFD CSV를 올려 주세요.');
  }
  function replaceImport(existing, result) {
    if (!result.trades.length) throw new Error('계산할 매도 내역이 없어요.');
    return existing.filter(t => t.source !== result.source).concat(result.trades);
  }
  return { number, quantity, date, csv, parseFile, matchExecutions, replaceImport, viewKey };
});
