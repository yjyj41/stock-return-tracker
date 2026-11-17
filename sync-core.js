(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SuikSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Records that follow the account. Device-only UI state (open tab, view, price cache) stays local.
  const KEYS = [
    'suiknote_v1', 'suiknote_v1_notes', 'suiknote_v1_basis', 'suiknote_v1_fx',
    'suiknote_v1_loans', 'suiknote_v1_loan_period', 'suiknote_v1_loan_assume',
    'spend_tracker_v1', 'spend_tracker_display_v2'
  ];
  const META = 'suiknote_sync_meta';
  const PART = 700000; // characters per Firestore document, under the 1 MiB limit even for multi-byte text
  const isSynced = k => KEYS.includes(k);

  function snapshot(storage) {
    const out = {};
    for (const k of KEYS) { const v = storage.getItem(k); if (v !== null && v !== undefined) out[k] = String(v); }
    return out;
  }
  function hash(text) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const s = String(text);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13); }
    return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36) + '-' + s.length.toString(36);
  }
  function hashes(snap) { const out = {}; for (const k of Object.keys(snap)) out[k] = hash(snap[k]); return out; }
  function split(text, size) {
    const n = size || PART, s = String(text), parts = [];
    for (let i = 0; i < s.length; i += n) parts.push(s.slice(i, i + n));
    return parts.length ? parts : [''];
  }
  function partId(key, i) { return key + '.' + i; }
  // Cloud manifest: {rev, keys:{key:{parts, hash}}}; parts: {id: text}
  function assemble(manifest, parts) {
    const out = {};
    for (const [k, info] of Object.entries((manifest && manifest.keys) || {})) {
      if (!isSynced(k)) continue;
      const n = Number(info && info.parts);
      if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error('클라우드 기록 형식이 올바르지 않습니다: ' + k);
      let text = '';
      for (let i = 0; i < n; i++) {
        const p = parts[partId(k, i)];
        if (typeof p !== 'string') throw new Error('클라우드 기록 일부를 받지 못했습니다: ' + k);
        text += p;
      }
      if (info.hash && hash(text) !== info.hash) throw new Error('클라우드 기록이 저장 중입니다. 잠시 후 다시 시도하세요.');
      out[k] = text;
    }
    return out;
  }
  // Writes needed to move the cloud from `prev` (manifest keys) to `snap`.
  function plan(snap, prevKeys) {
    const prev = prevKeys || {}, writes = [], deletes = [], keys = {};
    for (const [k, text] of Object.entries(snap)) {
      const h = hash(text), parts = split(text);
      keys[k] = { parts: parts.length, hash: h };
      const old = prev[k];
      if (!old || old.hash !== h) parts.forEach((p, i) => writes.push({ id: partId(k, i), key: k, i, text: p }));
      if (old && old.parts > parts.length) for (let i = parts.length; i < old.parts; i++) deletes.push(partId(k, i));
    }
    for (const [k, old] of Object.entries(prev)) {
      if (!(k in snap)) for (let i = 0; i < (Number(old.parts) || 0); i++) deletes.push(partId(k, i));
    }
    return { writes, deletes, keys };
  }
  function same(a, b) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
  }
  function count(snap) {
    const parse = k => { try { return snap[k] ? JSON.parse(snap[k]) : null; } catch (e) { return null; } };
    const trades = parse('suiknote_v1'), loans = parse('suiknote_v1_loans'), spend = parse('spend_tracker_v1');
    return {
      trades: Array.isArray(trades) ? trades.length : 0,
      loans: loans && Array.isArray(loans.loans) ? loans.loans.length : 0,
      loanEvents: loans && Array.isArray(loans.loans) ? loans.loans.reduce((n, l) => n + (Array.isArray(l.events) ? l.events.length : 0), 0) : 0,
      spending: spend && Array.isArray(spend.tx) ? spend.tx.length : 0
    };
  }
  function hasRecords(snap) { const c = count(snap); return c.trades + c.loans + c.spending > 0; }
  // What to do after sign-in or when the cloud changes. meta: this device's last sync for an account.
  function decide({ uid, meta, local, cloudRev, cloud }) {
    const known = meta && meta.uid === uid && Number.isSafeInteger(meta.rev);
    const cloudExists = Number.isSafeInteger(cloudRev) && cloudRev > 0;
    if (!known) {
      if (!cloudExists) return hasRecords(local) ? 'offer-upload' : 'start';
      if (cloud && same(local, cloud)) return 'adopt';
      return hasRecords(local) ? 'ask-replace' : 'pull';
    }
    // Cloud empty: first upload from this device continues; records removed elsewhere are never silently re-uploaded.
    if (!cloudExists) return meta.rev === 0 && meta.dirty ? 'push' : (hasRecords(local) ? 'offer-upload' : 'start');
    if (cloudRev > meta.rev) return meta.dirty ? 'conflict' : 'pull';
    return meta.dirty ? 'push' : 'none';
  }
  function backup(snap, note) {
    return { app: 'suiknote', version: 1, exportedAt: new Date().toISOString(), note: note || '', data: snap };
  }
  function readBackup(raw) {
    if (!raw || raw.app !== 'suiknote' || raw.version !== 1 || !raw.data || typeof raw.data !== 'object') throw new Error('수익노트 전체 백업 JSON 파일을 선택하세요.');
    const out = {};
    for (const [k, v] of Object.entries(raw.data)) { if (isSynced(k) && typeof v === 'string') out[k] = v; }
    if (!Object.keys(out).length) throw new Error('백업에 수익노트 기록이 없습니다.');
    for (const k of ['suiknote_v1', 'suiknote_v1_loans', 'spend_tracker_v1']) if (out[k]) JSON.parse(out[k]);
    return out;
  }
  return { KEYS, META, PART, isSynced, snapshot, hash, hashes, split, partId, assemble, plan, same, count, hasRecords, decide, backup, readBackup };
});
