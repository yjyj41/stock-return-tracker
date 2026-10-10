(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockPortfolio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const labels = { 'samsung-summary': '삼성증권 손익표', 'samsung-ledger': '삼성증권 거래내역 추정', trading212: 'Trading 212 ISA/Invest', 'trading212-cfd': 'Trading 212 CFD' };
  function accountFor(source) {
    return String(source).startsWith('samsung-') ? 'domestic' : String(source).startsWith('trading212') ? 'overseas' : 'legacy';
  }
  function netViews(trades, account) {
    return [...new Set(trades.filter(t => accountFor(t.source) === account).map(t => t.source + ':' + (t.currency || 'KRW')))];
  }
  function preferredView(trades, account, requested) {
    const views = netViews(trades, account);
    return views.includes(requested) ? requested : views.find(v => v.startsWith('samsung-ledger:')) || views[0] || (account === 'overseas' ? 'trading212:GBP' : 'samsung-summary:KRW');
  }
  function pnlFor(trade, basis) {
    if (trade.source === 'samsung-ledger' && trade.costKnown && finite(trade.netPnl)) return trade.netPnl;
    if (basis === 'reported') {
      if (trade.source === 'trading212-cfd' && finite(trade.resultAfterFx)) return trade.resultAfterFx;
      if (trade.source === 'trading212' && finite(trade.reportedPnl)) return trade.reportedPnl;
    }
    return finite(trade.realizedPnl) ? trade.realizedPnl : (trade.sellPrice - trade.buyPrice) * trade.qty;
  }
  function heldComparison(trade, price) {
    const cost = trade.costKnown && finite(trade.netInvested) ? trade.netInvested : trade.invested;
    if (!finite(price) || price <= 0 || !finite(cost) || cost <= 0 || !(trade.qty > 0)) return null;
    const pnl = price * trade.qty - cost;
    return { pnl, returnPct: pnl / cost * 100, valueGap: (price - trade.sellPrice) * trade.qty };
  }
  function validRate(rate) {
    if (!rate || !finite(rate.rate) || rate.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(rate.date || '')) return false;
    const day = new Date(rate.date + 'T00:00:00Z');
    return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === rate.date;
  }
  function parseRate(payload, currency) {
    if (!payload || payload.base !== currency || payload.quote !== 'KRW' || !validRate(payload)) throw new Error(currency + ' 환율 응답이 올바르지 않습니다.');
    return { rate: payload.rate, date: payload.date, source: 'Frankfurter', fetchedAt: new Date().toISOString() };
  }
  async function fetchRates(currencies, fetcher) {
    const rates = {}, errors = [];
    await Promise.all([...new Set(currencies)].filter(c => c !== 'KRW').map(async currency => {
      if (!/^[A-Z]{3}$/.test(currency)) { errors.push(currency); return; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        // Only the currency pair leaves the browser, never trade amounts or files.
        const response = await fetcher('https://api.frankfurter.dev/v2/rate/' + currency.toLowerCase() + '/krw', { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        rates[currency] = parseRate(await response.json(), currency);
      } catch (e) { errors.push(currency); }
      finally { clearTimeout(timer); }
    }));
    return { rates, errors: errors.sort() };
  }
  function combined(trades, basis, rates) {
    const useSummary = trades.some(t => t.source === 'samsung-summary');
    const hasLedger = trades.some(t => t.source === 'samsung-ledger');
    const missingNet = hasLedger && !useSummary;
    // A ledger's gross estimate must never be substituted for Samsung net profit.
    const chosen = trades.filter(t => labels[t.source] && t.source !== 'samsung-ledger');
    const groups = new Map();
    let estimated = false, comparisonMissing = false;
    for (const t of chosen) {
      const currency = t.currency || 'KRW', key = t.source + ':' + currency;
      const g = groups.get(key) || { source: t.source, currency, label: labels[t.source], pnl: 0, count: 0, from: t.sellDate, to: t.sellDate };
      g.pnl += pnlFor(t, basis); g.count++;
      if (t.sellDate < g.from) g.from = t.sellDate;
      if (t.sellDate > g.to) g.to = t.sellDate;
      groups.set(key, g);
      if (t.source === 'samsung-ledger' || (basis !== 'reported' && t.reportedOnly)) estimated = true;
      if (basis === 'reported' && ((t.source === 'trading212' && !finite(t.reportedPnl)) || (t.source === 'trading212-cfd' && !finite(t.resultAfterFx)))) comparisonMissing = true;
    }
    const missing = [], rows = [...groups.values()].map(g => {
      const rate = g.currency === 'KRW' ? { rate: 1, date: '', source: '' } : rates[g.currency];
      const available = g.currency === 'KRW' || validRate(rate);
      if (!available) missing.push(g.currency);
      return { ...g, rate: available ? rate.rate : null, rateDate: available ? rate.date : '', rateSource: available ? rate.source : '', krw: available ? g.pnl * rate.rate : null };
    });
    const total = missingNet || missing.length || rows.some(r => !finite(r.pnl)) ? null : rows.reduce((s, r) => s + r.krw, 0);
    return { rows, total, missing: [...new Set(missing)], missingNet, estimated, comparisonMissing,
      excludedLedger: hasLedger,
      excludedManual: trades.some(t => !labels[t.source]) };
  }
  return { accountFor, netViews, preferredView, pnlFor, heldComparison, validRate, parseRate, fetchRates, combined };
});
