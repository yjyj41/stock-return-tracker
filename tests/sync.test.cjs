const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sync-core.js');

const store = obj => ({ getItem: k => (k in obj ? obj[k] : null) });
const trades = JSON.stringify([{ id: 'a' }, { id: 'b' }]);

test('only account records are synced, never price cache or device UI state', () => {
  const snap = S.snapshot(store({ suiknote_v1: trades, suiknote_v1_view: 'x', suiknote_v1_account: 'loans', pcx_1: '[]', code_삼성: '005930', spend_tracker_v1: '{"tx":[]}' }));
  assert.deepEqual(Object.keys(snap).sort(), ['spend_tracker_v1', 'suiknote_v1']);
  assert.equal(S.isSynced('suiknote_sync_meta'), false);
});

test('large values are split into parts and reassembled exactly, with hash checks', () => {
  const big = 'ㄱ'.repeat(S.PART * 2 + 5);
  const p = S.plan({ spend_tracker_v1: big, suiknote_v1: trades }, {});
  assert.equal(p.keys.spend_tracker_v1.parts, 3);
  const parts = Object.fromEntries(p.writes.map(w => [w.id, w.text]));
  assert.deepEqual(S.assemble({ keys: p.keys }, parts), { spend_tracker_v1: big, suiknote_v1: trades });
  parts['spend_tracker_v1.1'] = 'changed';
  assert.throws(() => S.assemble({ keys: p.keys }, parts), /저장 중/);
  delete parts['spend_tracker_v1.2'];
  assert.throws(() => S.assemble({ keys: p.keys }, parts), /일부/);
});

test('plan rewrites only changed keys and deletes parts that are no longer used', () => {
  const first = S.plan({ suiknote_v1: 'x'.repeat(S.PART + 1), suiknote_v1_fx: '{}' }, {});
  const next = S.plan({ suiknote_v1: 'short' }, first.keys);
  assert.deepEqual(next.writes.map(w => w.id), ['suiknote_v1.0']);
  assert.deepEqual(next.deletes.sort(), ['suiknote_v1.1', 'suiknote_v1_fx.0']);
  assert.equal(S.plan({ suiknote_v1: 'short' }, next.keys).writes.length, 0);
});

test('first sign-in asks before moving or replacing anything that holds records', () => {
  const withData = { suiknote_v1: trades }, prefsOnly = { suiknote_v1_fx: '{}' };
  assert.equal(S.decide({ uid: 'u', meta: null, local: withData, cloudRev: 0 }), 'offer-upload');
  assert.equal(S.decide({ uid: 'u', meta: null, local: prefsOnly, cloudRev: 0 }), 'start');
  assert.equal(S.decide({ uid: 'u', meta: null, local: prefsOnly, cloudRev: 3, cloud: withData }), 'pull');
  assert.equal(S.decide({ uid: 'u', meta: null, local: withData, cloudRev: 3, cloud: withData }), 'adopt');
  assert.equal(S.decide({ uid: 'u', meta: null, local: withData, cloudRev: 3, cloud: { suiknote_v1: '[]' } }), 'ask-replace');
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'other', rev: 5 }, local: withData, cloudRev: 0 }), 'offer-upload');
});

test('known device pulls, pushes or reports a conflict from revisions', () => {
  const local = { suiknote_v1: trades };
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 2, dirty: false }, local, cloudRev: 3 }), 'pull');
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 2, dirty: true }, local, cloudRev: 3 }), 'conflict');
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 3, dirty: true }, local, cloudRev: 3 }), 'push');
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 3, dirty: false }, local, cloudRev: 3 }), 'none');
  // Account records deleted elsewhere are not silently re-uploaded.
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 4, dirty: false }, local, cloudRev: 0 }), 'offer-upload');
  assert.equal(S.decide({ uid: 'u', meta: { uid: 'u', rev: 0, dirty: true }, local, cloudRev: 0 }), 'push');
});

test('counts summarise each area and full backups round-trip only synced keys', () => {
  const snap = { suiknote_v1: trades, suiknote_v1_loans: JSON.stringify({ version: 1, loans: [{ events: [1, 2] }] }), spend_tracker_v1: JSON.stringify({ tx: [1, 2, 3] }) };
  assert.deepEqual(S.count(snap), { trades: 2, loans: 1, loanEvents: 2, spending: 3 });
  const raw = JSON.parse(JSON.stringify(S.backup({ ...snap, pcx_1: 'x' })));
  assert.deepEqual(S.readBackup(raw), snap);
  assert.throws(() => S.readBackup({ tx: [] }), /전체 백업/);
  assert.throws(() => S.readBackup({ app: 'suiknote', version: 1, data: { suiknote_v1: '{bad' } }));
});
