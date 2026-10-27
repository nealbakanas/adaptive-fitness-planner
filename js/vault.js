// A second copy of your data in IndexedDB, plus dated snapshots you can roll back to. No DOM access.
// Every function resolves and never throws: where IndexedDB is missing, blocked or slow they return null or false, and
// the app behaves exactly as it did before this module existed. Test pages name their own database
// (globalThis.AFP_VAULT_NAME), the way AFP_STORAGE_KEY keeps them off your real data.

const NAME = globalThis.AFP_VAULT_NAME ?? 'afp-vault';
const DAY = 864e5;

export const KEEP_DAILY = 14;
export const KEEP_ACTION = 10; // snapshots taken before an import, restore, setup or erase

// ---------- pure rules ----------

export const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// Which snapshots to delete: all but the newest 14 daily and the newest 10 of every other kind together.
// `list`: [{ at, reason }] in any order. Returns the `at` of each one to delete.
export function pruneKeys(list) {
  const newest = [...list].sort((a, b) => b.at - a.at);
  const daily = newest.filter(x => x.reason === 'daily'), action = newest.filter(x => x.reason !== 'daily');
  return [...daily.slice(KEEP_DAILY), ...action.slice(KEEP_ACTION)].map(x => x.at);
}

// Whether today needs its daily snapshot: there are sets logged today and no daily snapshot was taken today.
export function needsDaily(list, state, now = Date.now()) {
  const today = dayOf(now);
  if (list.some(x => x.reason === 'daily' && dayOf(x.at) === today)) return false;
  return state.sets.some(s => s.done && !s.warmup && dayOf(s.loggedAt) === today);
}

// The backup reminder: 3 finished workouts, or 7 days with at least one, since your last backup off this device.
// "Not now" (settings.backupSnoozeUntil) hides it for 3 days.
export function backupNudge(state, now = Date.now()) {
  const st = state.settings;
  if ((st.backupSnoozeUntil ?? 0) > now) return false;
  const since = st.lastExportAt ?? 0;
  const done = (state.sessions || []).filter(s => s.status === 'done' && s.firstSetAt && s.firstSetAt > since);
  if (!done.length) return false;
  if (done.length >= 3) return true;
  const from = st.lastExportAt ?? Math.min(...done.map(s => s.firstSetAt));
  return now - from >= 7 * DAY;
}

// What a snapshot list row says about the data: workouts (sessions with logged sets) and working sets.
export function summaryOf(s) {
  return {
    version: s.version,
    workouts: (s.sessions || []).filter(x => x.firstSetAt).length,
    sets: (s.sets || []).filter(x => x.done && !x.warmup).length,
  };
}

// ---------- IndexedDB ----------

let dbPromise = null;
export const available = () => typeof indexedDB !== 'undefined' && indexedDB !== null;
// Whether the database actually opened (false in some private modes and when storage is blocked).
export const usable = async () => !!(await open());

function open() {
  if (!available()) return Promise.resolve(null);
  dbPromise ??= new Promise(resolve => {
    try {
      const req = indexedDB.open(NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('current');
        db.createObjectStore('snapshots', { keyPath: 'at' }); // the full data
        db.createObjectStore('index', { keyPath: 'at' });     // the same rows without the data, so listing stays small
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

// Runs one transaction. Resolves { value } when it completes (value = what fn passed to its `set`, else null), or null
// when anything failed.
async function run(stores, mode, fn) {
  const db = await open();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(stores, mode);
      let value = null;
      tx.oncomplete = () => resolve({ value });
      tx.onerror = tx.onabort = () => resolve(null);
      fn(tx, v => { value = v; });
    } catch { resolve(null); }
  });
}

// The copy that follows every save. `json` is the state as text. True when it was written.
export async function put(json) {
  return !!(await run(['current'], 'readwrite', tx => tx.objectStore('current').put({ at: Date.now(), json }, 'state')));
}

// { at, json } or null.
export async function get() {
  const r = await run(['current'], 'readonly', (tx, set) => { tx.objectStore('current').get('state').onsuccess = e => set(e.target.result ?? null); });
  return r?.value ?? null;
}

// Small named values beside the copy (the cloud sync's last-synced data lives here). Text in, text out.
export async function putKey(key, text) { return !!(await run(['current'], 'readwrite', tx => tx.objectStore('current').put({ at: Date.now(), json: text }, key))); }
export async function getKey(key) {
  const r = await run(['current'], 'readonly', (tx, set) => { tx.objectStore('current').get(key).onsuccess = e => set(e.target.result?.json ?? null); });
  return r?.value ?? null;
}
export async function delKey(key) { return !!(await run(['current'], 'readwrite', tx => tx.objectStore('current').delete(key))); }

// Adds a snapshot, then prunes. `meta`: { version, workouts, sets }. Returns the snapshot's `at`, or null.
export async function snapshot(json, reason, meta = {}) {
  let at = Date.now();
  const taken = new Set((await list()).map(x => x.at));
  while (taken.has(at)) at++;
  const row = { at, reason, bytes: json.length, ...meta };
  const r = await run(['snapshots', 'index'], 'readwrite', tx => { tx.objectStore('snapshots').put({ ...row, json }); tx.objectStore('index').put(row); });
  if (!r) return null;
  await prune();
  return at;
}

// Snapshot rows without their data, newest first. An unavailable vault lists nothing.
export async function list() {
  const r = await run(['index'], 'readonly', (tx, set) => { tx.objectStore('index').getAll().onsuccess = e => set(e.target.result); });
  return (r?.value ?? []).sort((a, b) => b.at - a.at);
}

// One full snapshot ({ at, reason, ..., json }) or null.
export async function read(at) {
  const r = await run(['snapshots'], 'readonly', (tx, set) => { tx.objectStore('snapshots').get(at).onsuccess = e => set(e.target.result ?? null); });
  return r?.value ?? null;
}

export async function prune() {
  const gone = pruneKeys(await list());
  if (gone.length) await run(['snapshots', 'index'], 'readwrite', tx => { for (const at of gone) { tx.objectStore('snapshots').delete(at); tx.objectStore('index').delete(at); } });
  return gone.length;
}

// Deletes the whole database. Only tests call this: "Erase all data" keeps the vault, with a snapshot first.
export async function wipe() {
  const db = await open();
  if (db) db.close();
  dbPromise = null;
  if (!available()) return;
  await new Promise(resolve => { try { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch { resolve(); } });
}
