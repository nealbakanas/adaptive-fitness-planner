// Keeping this device's data and the account's copy together (Supabase; see js/cloud.js for the server calls).
// One row per user, with a revision number. A push only lands if it names the revision it was based on; when it
// doesn't, the other device saved first, so this device pulls and merges (js/merge.js) and tries again.
// Nothing on this device is replaced without a snapshot first, and the first time a device meets an account that already
// has data it asks (the result kind 'ask') instead of choosing.
import * as Cloud from './cloud.js';
import * as Vault from './vault.js';
import * as Store from './store.js';
import { mergeStates } from './merge.js';

// What the data looks like for comparing: without the save stamp and this device's running rest timer.
export const fingerprint = s => JSON.stringify({ ...s, savedAt: null, timer: null });
const isEmpty = s => !s.sets.some(x => x.done) && !s.sessions.some(x => x.firstSetAt);
const BASE = 'cloudBase';

// What to do, from what is known (pure; see the tests). `remote`: the row's head or null.
//   upload  the account has nothing yet: send this device's data
//   push    send this device's data over the account's (it has nothing of value, or this device is the newer line)
//   pull    the account has newer data and this device changed nothing: take it
//   merge   both changed: combine them
//   ask     this device meets an account that has data, or looks erased: let the person choose
//   none    already together
export function planSync({ hasBase, baseRev, remote, localChanged, localEmpty, baseHadData, remoteEmpty }) {
  if (!remote) return { action: 'upload' };
  if (!hasBase) return remoteEmpty ? { action: 'push' } : { action: 'ask', choice: localEmpty ? 'account' : 'merge' };
  if (remote.rev < baseRev) return { action: 'push' };
  if (remote.rev === baseRev) {
    if (localEmpty && baseHadData) return { action: 'ask', choice: 'account' }; // erased here: never push that over the account
    return { action: localChanged ? 'push' : 'none' };
  }
  if (localEmpty && !remoteEmpty) return { action: 'ask', choice: 'account' };
  return { action: localChanged ? 'merge' : 'pull' };
}

let busy = false;
export const isBusy = () => busy;
let pending = null; // an 'ask' waiting for the person: { remote, choice }
export const getPending = () => pending;

const summaryOf = s => Vault.summaryOf(s);
// What to send, frozen now: the data may change while the request is in flight, and the base must be what was sent.
function outbox(s) {
  const { workouts, sets } = summaryOf(s), fp = fingerprint(s);
  const data = JSON.parse(fp);
  data.savedAt = s.savedAt; // the other device compares save times to settle a conflict
  return { fp, row: { saved_at: new Date(s.savedAt ?? Date.now()).toISOString(), device: Cloud.deviceName(), workouts, sets, data } };
}

// Remembers what was last synced: the account's rev, and the data as it was then (to tell later what changed where).
async function recordBase(fp, rev) {
  Cloud.update({ baseRev: rev, lastSyncAt: Date.now() });
  await Vault.putKey(BASE, fp);
}

// Takes `next` as this device's data (after a snapshot of what's here).
function applyLocal(next) {
  Store.snapshotNow('before-sync');
  next.timer = Store.state.timer ?? null;
  Store.replaceState(next);
  return Store.state;
}

const stateOf = remote => Store.migrate(structuredClone(remote.data));
function checkVersion(remoteState) {
  if (remoteState.version > Store.CURRENT_VERSION) throw new Cloud.CloudError('Your account has data from a newer version of the app. Update the app on this device first.');
}

// Runs one sync. Resolves { kind, ... }: skipped, none, uploaded, pushed, pulled, merged, ask, or error.
export async function sync() {
  if (!Cloud.signedIn() || busy) return { kind: 'skipped' };
  busy = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await once();
      if (r !== 'again') return r;
    }
    return { kind: 'error', error: new Cloud.CloudError('Your other device kept saving at the same time. Try again in a moment.') };
  } catch (error) {
    return { kind: 'error', error };
  } finally {
    busy = false;
  }
}

async function once() {
  const head = await Cloud.getRemote();
  const rec = Cloud.record(), local = Store.state;
  const baseJson = rec.baseRev != null ? await Vault.getKey(BASE) : null;
  const hasBase = rec.baseRev != null;
  const baseHadData = baseJson ? (() => { try { const b = JSON.parse(baseJson); return b.sets.some(x => x.done) || b.sessions.some(x => x.firstSetAt); } catch { return false; } })() : hasBase;
  const plan = planSync({
    hasBase, baseRev: rec.baseRev, remote: head,
    localChanged: baseJson == null ? true : fingerprint(local) !== baseJson,
    localEmpty: isEmpty(local), baseHadData,
    remoteEmpty: !head || ((head.sets ?? 0) === 0 && (head.workouts ?? 0) === 0),
  });
  switch (plan.action) {
    case 'none': Cloud.update({ lastSyncAt: Date.now() }); pending = null; return { kind: 'none' };
    case 'upload': {
      const out = outbox(local);
      const ok = await Cloud.insertRemote(out.row);
      if (ok === 'conflict') return 'again';
      await recordBase(out.fp, 1);
      pending = null;
      return { kind: 'uploaded' };
    }
    case 'push': return push(local, head.rev);
    case 'pull': {
      const remote = await Cloud.getRemote({ withData: true });
      const theirs = stateOf(remote); checkVersion(theirs);
      const now = applyLocal(theirs);
      await recordBase(fingerprint(now), remote.rev);
      pending = null;
      return { kind: 'pulled', device: remote.device, savedAt: remote.saved_at };
    }
    case 'merge': return merge(JSON.parse(baseJson ?? 'null'), head.rev);
    case 'ask': {
      pending = { remote: head, choice: plan.choice };
      return { kind: 'ask', remote: head, choice: plan.choice, local: summaryOf(local) };
    }
  }
}

async function push(local, rev) {
  const out = outbox(local);
  const ok = await Cloud.updateRemote(rev, out.row);
  if (ok === 'conflict') return 'again';
  await recordBase(out.fp, rev + 1);
  pending = null;
  return { kind: 'pushed' };
}

// Combines this device with the account's copy; both copies are kept as snapshots first.
async function merge(base, rev) {
  const remote = await Cloud.getRemote({ withData: true });
  if (remote.rev !== rev) return 'again';
  const theirs = stateOf(remote); checkVersion(theirs);
  await Vault.snapshot(JSON.stringify(theirs), 'cloud-copy', summaryOf(theirs));
  const merged = mergeStates(base ? Store.migrate(base) : null, Store.state, theirs);
  const now = applyLocal(merged);
  const out = outbox(now);
  const ok = await Cloud.updateRemote(remote.rev, out.row);
  if (ok === 'conflict') return 'again'; // the next pass merges again with whatever landed meanwhile
  await recordBase(out.fp, remote.rev + 1);
  pending = null;
  return { kind: 'merged', device: remote.device, savedAt: remote.saved_at };
}

// The person's answer to an 'ask': 'account' (use the account's copy), 'keep' (this device's, uploaded over it) or 'merge'.
export async function resolve(choice) {
  if (!pending || busy) return { kind: 'skipped' };
  busy = true;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await Cloud.getRemote({ withData: true });
      if (!remote) { busy = false; pending = null; return await sync(); }
      const theirs = stateOf(remote); checkVersion(theirs);
      if (choice === 'account') {
        await Vault.snapshot(JSON.stringify(theirs), 'cloud-copy', summaryOf(theirs));
        const now = applyLocal(theirs);
        await recordBase(fingerprint(now), remote.rev);
        pending = null;
        return { kind: 'pulled', device: remote.device, savedAt: remote.saved_at };
      }
      await Vault.snapshot(JSON.stringify(theirs), 'cloud-copy', summaryOf(theirs)); // the account's copy is kept whatever happens to it
      if (choice === 'keep') {
        const out = outbox(Store.state);
        const ok = await Cloud.updateRemote(remote.rev, out.row);
        if (ok === 'conflict') continue;
        await recordBase(out.fp, remote.rev + 1);
        pending = null;
        return { kind: 'pushed' };
      }
      const now = applyLocal(mergeStates(null, Store.state, theirs));
      const out = outbox(now);
      const ok = await Cloud.updateRemote(remote.rev, out.row);
      if (ok === 'conflict') continue;
      await recordBase(out.fp, remote.rev + 1);
      pending = null;
      return { kind: 'merged', device: remote.device, savedAt: remote.saved_at };
    }
    return { kind: 'error', error: new Cloud.CloudError('Your other device kept saving at the same time. Try again in a moment.') };
  } catch (error) {
    return { kind: 'error', error };
  } finally {
    busy = false;
  }
}

export async function signOut() {
  await Cloud.signOut();
  await Vault.delKey(BASE);
  pending = null;
}

// Automatic syncing: shortly after you stop saving, when the network comes back, and when you return to the app.
let timer = null, onResult = () => {}, lastRun = 0;
export function schedule(ms = 10000) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}
export async function run() {
  clearTimeout(timer);
  if (!Cloud.signedIn() || busy || (globalThis.navigator && navigator.onLine === false)) return;
  lastRun = Date.now();
  onResult(await sync());
}
export function start(handler) {
  onResult = handler;
  Store.onSave(() => { if (!busy && Cloud.signedIn()) schedule(10000); });
  globalThis.addEventListener?.('online', () => schedule(500));
  globalThis.document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastRun > 60e3) schedule(500); });
  if (Cloud.signedIn()) schedule(1500);
}
