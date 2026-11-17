// Google sign-in and Firestore sync for 수익노트.
// The app keeps reading and writing localStorage; this module mirrors the synced keys to
// suiknote/{uid} (manifest) and suiknote/{uid}/parts/{key.i} in the existing journal Firebase project.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, collection, getDocFromServer, getDocsFromServer, runTransaction, onSnapshot, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const S = window.SuikSync;
const config = {
  apiKey: 'AIzaSyD58SEKBUCyg4Q6w2_tbw8MfsJivKr4jVU',
  authDomain: 'bullet-journal-b359c.firebaseapp.com',
  projectId: 'bullet-journal-b359c',
  storageBucket: 'bullet-journal-b359c.firebasestorage.app',
  messagingSenderId: '79627536417',
  appId: '1:79627536417:web:5812b77638d0be1baafb60'
};
const app = getApps().find(a => a.name === 'suiknote') || initializeApp(config, 'suiknote');
const auth = getAuth(app);
const db = getFirestore(app);
const SKIP = 'suiknote_signin_skip', DEVICE = 'suiknote_device';
const rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;

let state = { ready: false, user: null, status: 'signed-out', syncedAt: '', prompt: null, error: '', counts: null, welcome: false };
let applying = false, pushTimer = null, pushing = false, pushAgain = false, unlisten = null, cloudCache = null;

const device = (() => { try { let d = localStorage.getItem(DEVICE); if (!d) { d = Math.random().toString(36).slice(2, 10); rawSet.call(localStorage, DEVICE, d); } return d; } catch (e) { return 'tmp'; } })();
const readMeta = () => { try { return JSON.parse(localStorage.getItem(S.META) || 'null'); } catch (e) { return null; } };
const writeMeta = m => { try { rawSet.call(localStorage, S.META, JSON.stringify(m)); } catch (e) {} };
const local = () => S.snapshot(localStorage);
const manifestRef = uid => doc(db, 'suiknote', uid);
const partsRef = uid => collection(db, 'suiknote', uid, 'parts');
const partRef = (uid, id) => doc(db, 'suiknote', uid, 'parts', id);
const time = () => new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

function emit(patch) {
  state = { ...state, ...patch };
  api.state = state;
  window.dispatchEvent(new CustomEvent('suiknote-account', { detail: state }));
}
function message(e) {
  const code = (e && e.code) || '';
  if (code === 'permission-denied') return '계정 저장소 권한이 없습니다. Firebase 보안 규칙에 suiknote 경로가 추가됐는지 확인하세요.';
  if (code === 'auth/popup-blocked') return '팝업이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 다시 로그인하세요.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '로그인 창이 닫혔습니다.';
  if (code === 'auth/unauthorized-domain') return '이 주소(' + location.hostname + ')는 Firebase 로그인 허용 도메인이 아닙니다. localhost 또는 yjyj41.github.io에서 여세요.';
  if (code === 'auth/network-request-failed' || code === 'unavailable') return '네트워크에 연결할 수 없습니다. 연결되면 다시 동기화합니다.';
  return (e && e.message) || String(e);
}
function download(snap, note) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const blob = new Blob([JSON.stringify(S.backup(snap, note), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'suiknote-backup-' + stamp + (note ? '-' + note : '') + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function writeLocal(snap) {
  applying = true;
  try { for (const k of S.KEYS) { if (k in snap) rawSet.call(localStorage, k, snap[k]); else rawRemove.call(localStorage, k); } }
  finally { applying = false; }
}

// --- change tracking: this window through Storage.prototype, the spending frame through storage events ---
function changed() {
  if (applying) return;
  const user = auth.currentUser, meta = readMeta();
  if (!user || !meta || meta.uid !== user.uid) return;
  if (state.prompt && state.prompt !== 'remote-update') return;
  const now = S.hashes(local()), prev = meta.hashes || {};
  const dirty = Object.keys(now).length !== Object.keys(prev).length || Object.keys(now).some(k => now[k] !== prev[k]);
  if (!dirty) return;
  if (!meta.dirty) writeMeta({ ...meta, dirty: true });
  // Edited here while another device's change waits: both sides changed, so ask instead of overwriting either.
  if (state.prompt === 'remote-update') { conflict(user.uid); return; }
  emit({ status: navigator.onLine ? 'pending' : 'offline' });
  clearTimeout(pushTimer); pushTimer = setTimeout(push, 1500);
}
Storage.prototype.setItem = function (k, v) { const r = rawSet.call(this, k, v); if (this === window.localStorage && S.isSynced(k)) changed(); return r; };
Storage.prototype.removeItem = function (k) { const r = rawRemove.call(this, k); if (this === window.localStorage && S.isSynced(k)) changed(); return r; };
window.addEventListener('storage', e => { if (e.storageArea === localStorage && (e.key === null || S.isSynced(e.key))) changed(); });
window.addEventListener('online', () => { const m = readMeta(); if (auth.currentUser && m && m.dirty) push(); });

async function readCloud(uid) {
  const m = await getDocFromServer(manifestRef(uid));
  if (!m.exists()) return { rev: 0, keys: {}, snap: {} };
  const data = m.data(), parts = {};
  (await getDocsFromServer(partsRef(uid))).forEach(d => { parts[d.id] = d.data().text; });
  return { rev: data.rev, keys: data.keys || {}, snap: S.assemble(data, parts) };
}

async function push(expectedRev) {
  const user = auth.currentUser;
  if (!user || state.prompt) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true; clearTimeout(pushTimer);
  const snap = local(), meta = readMeta() || {};
  const base = Number.isSafeInteger(expectedRev) ? expectedRev : (meta.uid === user.uid ? meta.rev || 0 : 0);
  emit({ status: 'syncing', error: '' });
  try {
    const rev = await runTransaction(db, async t => {
      const m = await t.get(manifestRef(user.uid));
      const cur = m.exists() ? m.data().rev : 0;
      if (cur !== base) { const err = new Error('다른 기기에서 먼저 저장했습니다.'); err.code = 'suik/conflict'; throw err; }
      const p = S.plan(snap, m.exists() ? m.data().keys : {});
      if (p.writes.length + p.deletes.length > 450) throw new Error('한 번에 저장할 기록이 너무 많습니다. 전체 백업을 받은 뒤 다시 시도하세요.');
      p.writes.forEach(w => t.set(partRef(user.uid, w.id), { key: w.key, i: w.i, text: w.text }));
      p.deletes.forEach(id => t.delete(partRef(user.uid, id)));
      t.set(manifestRef(user.uid), { rev: cur + 1, keys: p.keys, updatedAt: new Date().toISOString(), device });
      return cur + 1;
    });
    const nowHashes = S.hashes(local()), sent = S.hashes(snap);
    const still = Object.keys(nowHashes).length !== Object.keys(sent).length || Object.keys(nowHashes).some(k => nowHashes[k] !== sent[k]);
    writeMeta({ uid: user.uid, rev, dirty: still, hashes: sent, syncedAt: new Date().toISOString() });
    emit({ status: still ? 'pending' : 'synced', syncedAt: time() });
    if (still) pushAgain = true;
  } catch (e) {
    if (e.code === 'suik/conflict') await conflict(user.uid);
    else emit({ status: e.code === 'unavailable' || !navigator.onLine ? 'offline' : 'error', error: message(e) });
  } finally {
    pushing = false;
    if (pushAgain && !state.prompt) { pushAgain = false; pushTimer = setTimeout(push, 800); }
  }
}

async function conflict(uid) {
  try { cloudCache = await readCloud(uid); } catch (e) { emit({ status: 'error', error: message(e) }); return; }
  emit({ status: 'paused', prompt: 'conflict', counts: { local: S.count(local()), cloud: S.count(cloudCache.snap) } });
}

function applyCloud(uid, cloud) {
  writeLocal(cloud.snap);
  writeMeta({ uid, rev: cloud.rev, dirty: false, hashes: S.hashes(cloud.snap), syncedAt: new Date().toISOString() });
  location.reload();
}

function listen(uid) {
  if (unlisten) unlisten();
  unlisten = onSnapshot(manifestRef(uid), s => {
    if (!s.exists() || s.metadata.hasPendingWrites) return;
    const d = s.data(), meta = readMeta();
    if (!meta || meta.uid !== uid || d.rev <= meta.rev || state.prompt) return;
    if (meta.dirty) conflict(uid);
    else emit({ prompt: 'remote-update' });
  }, e => emit({ status: 'error', error: message(e) }));
}

async function start(user) {
  emit({ user: { name: user.displayName || '', email: user.email || '', photo: user.photoURL || '' }, status: 'checking', error: '', welcome: false });
  let cloud;
  try { cloud = await readCloud(user.uid); }
  catch (e) { emit({ status: e.code === 'unavailable' ? 'offline' : 'error', error: message(e) }); return; }
  cloudCache = cloud;
  const meta = readMeta(), snap = local();
  const action = S.decide({ uid: user.uid, meta, local: snap, cloudRev: cloud.rev, cloud: cloud.snap });
  const counts = { local: S.count(snap), cloud: S.count(cloud.snap) };
  if (action === 'pull') { applyCloud(user.uid, cloud); return; }
  if (action === 'adopt' || action === 'none') {
    if (action === 'adopt') writeMeta({ uid: user.uid, rev: cloud.rev, dirty: false, hashes: S.hashes(snap), syncedAt: new Date().toISOString() });
    emit({ status: 'synced', syncedAt: time() });
  } else if (action === 'start') {
    writeMeta({ uid: user.uid, rev: cloud.rev, dirty: false, hashes: {}, syncedAt: '' });
    emit({ status: 'synced', syncedAt: time() });
    changed();
  } else if (action === 'push') {
    push();
  } else {
    emit({ status: 'paused', prompt: action, counts });
  }
  listen(user.uid);
}

onAuthStateChanged(auth, user => {
  if (unlisten) { unlisten(); unlisten = null; }
  if (user) { start(user); emit({ ready: true }); return; }
  let skipped = false; try { skipped = localStorage.getItem(SKIP) === '1'; } catch (e) {}
  emit({ ready: true, user: null, status: 'signed-out', prompt: null, counts: null, welcome: !skipped });
});

const api = {
  state,
  async signIn() {
    emit({ error: '' });
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { emit({ error: message(e) }); }
  },
  async signOut() { await signOut(auth); },
  skip() { try { rawSet.call(localStorage, SKIP, '1'); } catch (e) {} emit({ welcome: false }); },
  showWelcome() { emit({ welcome: true }); },
  syncNow() { const m = readMeta(); if (m && m.dirty) push(); else if (auth.currentUser) start(auth.currentUser); },
  backup() { download(local(), 'device'); },
  async restore(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) throw new Error('50MB 이하 백업 파일을 선택하세요.');
    const snap = S.readBackup(JSON.parse(await file.text()));
    download(local(), 'before-restore');
    for (const [k, v] of Object.entries(snap)) localStorage.setItem(k, v);
    setTimeout(() => location.reload(), 1600);
  },
  // Choices for the prompt dialogs. Every choice that replaces records downloads the replaced side first.
  async resolve(choice) {
    const user = auth.currentUser;
    if (!user) return;
    const prompt = state.prompt, snap = local();
    if (choice === 'later') { emit({ prompt: null, status: 'paused' }); return; }
    if (prompt === 'remote-update' || choice === 'cloud') {
      if (choice === 'cloud' && S.hasRecords(snap)) download(snap, 'device');
      try { applyCloud(user.uid, prompt === 'remote-update' ? await readCloud(user.uid) : (cloudCache || await readCloud(user.uid))); }
      catch (e) { emit({ status: 'error', error: message(e) }); }
      return;
    }
    if (choice === 'upload' || choice === 'local') {
      if (choice === 'upload') download(snap, 'before-upload');
      else if (cloudCache && S.hasRecords(cloudCache.snap)) download(cloudCache.snap, 'account');
      emit({ prompt: null });
      await push(cloudCache ? cloudCache.rev : 0);
      listen(user.uid);
      return;
    }
    if (choice === 'fresh') {
      download(snap, 'device');
      writeLocal({});
      writeMeta({ uid: user.uid, rev: cloudCache ? cloudCache.rev : 0, dirty: false, hashes: {}, syncedAt: '' });
      location.reload();
    }
  },
  async deleteCloud() {
    const user = auth.currentUser;
    if (!user) return;
    const cloud = await readCloud(user.uid);
    if (S.hasRecords(cloud.snap)) download(cloud.snap, 'account-before-delete');
    const batch = writeBatch(db);
    (await getDocsFromServer(partsRef(user.uid))).forEach(d => batch.delete(d.ref));
    batch.delete(manifestRef(user.uid));
    await batch.commit();
    // Records stay on this device; signing out keeps the next edit from re-uploading them.
    writeMeta({ uid: user.uid, rev: 0, dirty: false, hashes: {}, syncedAt: '' });
    await signOut(auth);
  }
};
window.SuikAccount = api;
emit({});
