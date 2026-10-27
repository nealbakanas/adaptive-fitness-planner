// The cloud account: sign in by email (a link or a code), and read and write this user's one row of data in Supabase.
// Plain fetch against Supabase's auth and REST endpoints (no library to load, and every call is easy to fake in tests).
// No DOM. Sync decisions live in js/sync.js; this file only talks to the server and keeps the session.
import { SUPABASE_URL, SUPABASE_KEY } from './cloud-config.js';

const KEY = `${globalThis.AFP_STORAGE_KEY ?? 'afp.v1'}.cloud`;
const nowSec = () => Math.floor(Date.now() / 1000);

// What failed: `offline` (no network), `auth` (signed out or the session ran out), `conflict`, or anything else.
export class CloudError extends Error {
  constructor(message, { status = 0, offline = false, auth = false } = {}) { super(message); Object.assign(this, { status, offline, auth }); }
}

// This device's cloud record, kept in its own localStorage key (never inside the data, so it never syncs):
// { session, baseRev, lastSyncAt, device }. `baseRev` is the account row's rev as of the last sync here.
let rec = readRec();
function readRec() { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } }
function writeRec() { try { localStorage.setItem(KEY, JSON.stringify(rec)); } catch { /* the next sync starts over */ } }
export const record = () => rec;
export function update(patch) { Object.assign(rec, patch); writeRec(); }
export function reset() { rec = {}; try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ } }

export const configured = () => !!(SUPABASE_URL && SUPABASE_KEY);
export const signedIn = () => !!rec.session?.refresh_token;
export const email = () => rec.session?.user?.email ?? null;
export function deviceName() {
  if (!rec.device) {
    const ua = globalThis.navigator?.userAgent ?? '';
    const kind = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Browser';
    update({ device: `${kind} ${Math.random().toString(36).slice(2, 6)}` });
  }
  return rec.device;
}

// ---------- requests ----------

async function messageOf(res) {
  try {
    const b = await res.json();
    return b.msg || b.message || b.error_description || b.error || `HTTP ${res.status}`;
  } catch { return `HTTP ${res.status}`; }
}

async function raw(path, { method = 'GET', body, headers = {}, token = null } = {}) {
  const h = { apikey: SUPABASE_KEY, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  try {
    return await fetch(SUPABASE_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new CloudError('You appear to be offline.', { offline: true });
  }
}

let refreshing = null;
async function refresh() {
  refreshing ??= (async () => {
    const res = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rec.session?.refresh_token } });
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) { update({ session: null }); throw new CloudError('Your sign-in expired. Sign in again.', { status: res.status, auth: true }); }
      throw new CloudError(await messageOf(res), { status: res.status });
    }
    setSession(await res.json());
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function accessToken() {
  if (!rec.session) throw new CloudError('Sign in first.', { auth: true });
  if ((rec.session.expires_at ?? 0) - 60 < nowSec()) await refresh();
  return rec.session.access_token;
}

// An authenticated request; one retry after a refresh when the server says the token is no good.
async function call(path, opts = {}) {
  let res = await raw(path, { ...opts, token: await accessToken() });
  if (res.status === 401) { await refresh(); res = await raw(path, { ...opts, token: rec.session.access_token }); }
  if (res.status === 401) throw new CloudError('Your sign-in expired. Sign in again.', { status: 401, auth: true });
  return res;
}

// ---------- signing in ----------

function jwtUser(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { id: p.sub, email: p.email ?? null };
  } catch { return null; }
}

function setSession(s) {
  const user = s.user?.id ? { id: s.user.id, email: s.user.email ?? null } : jwtUser(s.access_token);
  update({ session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? nowSec() + (Number(s.expires_in) || 3600), user } });
}

// Emails a sign-in link and a code. The link brings you back to this page signed in; the code works where the link
// can't (a home-screen app on an iPhone opens links in Safari instead).
export async function sendCode(address) {
  const back = globalThis.location ? location.origin + location.pathname : undefined;
  const res = await raw(`/auth/v1/otp${back ? `?redirect_to=${encodeURIComponent(back)}` : ''}`, { method: 'POST', body: { email: address, create_user: true } });
  if (res.status === 429) throw new CloudError('Too many sign-in emails just now. Wait a minute and try again.', { status: 429 });
  if (!res.ok) throw new CloudError(await messageOf(res), { status: res.status });
  return true;
}

export async function verifyCode(address, code) {
  const res = await raw('/auth/v1/verify', { method: 'POST', body: { type: 'email', email: address, token: String(code).trim() } });
  if (!res.ok) throw new CloudError(res.status === 403 || res.status === 400 ? 'That code didn’t work. It may have expired; send a new one.' : await messageOf(res), { status: res.status });
  setSession(await res.json());
  return true;
}

// Coming back from the emailed link: the session is in the address after the #. Takes it and clears the address.
// Returns 'signedIn', an error message string, or null when the address has nothing for us.
export function takeSessionFromUrl() {
  const hash = globalThis.location?.hash ?? '';
  if (!/access_token=|error=/.test(hash)) return null;
  const p = new URLSearchParams(hash.slice(1));
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* leave it */ }
  if (p.get('error')) return decodeURIComponent((p.get('error_description') || p.get('error')).replace(/\+/g, ' '));
  setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: p.get('expires_in'), expires_at: Number(p.get('expires_at')) || undefined });
  return 'signedIn';
}

export async function signOut() {
  if (rec.session) { try { await raw('/auth/v1/logout', { method: 'POST', token: rec.session.access_token }); } catch { /* signing out here is what counts */ } }
  update({ session: null, baseRev: null, lastSyncAt: null });
}

// ---------- the account's row ----------

const row = () => `user_id=eq.${rec.session.user.id}`;

// The row without its data (rev, saved_at, device, workouts, sets), or with it. Null when the account has none yet.
export async function getRemote({ withData = false } = {}) {
  const cols = `rev,saved_at,device,workouts,sets${withData ? ',data' : ''}`;
  const res = await call(`/rest/v1/states?select=${cols}&${row()}&limit=1`);
  if (!res.ok) throw new CloudError(await messageOf(res), { status: res.status });
  return (await res.json())[0] ?? null;
}

// First upload. 'conflict' when a row already exists (another device got there first).
export async function insertRemote(fields) {
  const res = await call('/rest/v1/states', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: { user_id: rec.session.user.id, rev: 1, ...fields } });
  if (res.status === 409) return 'conflict';
  if (!res.ok) throw new CloudError(await messageOf(res), { status: res.status });
  return true;
}

// Replaces the row only if it is still at `rev` (nobody else pushed since); writes rev + 1. 'conflict' when it moved on.
export async function updateRemote(rev, fields) {
  const res = await call(`/rest/v1/states?${row()}&rev=eq.${rev}&select=rev`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: { ...fields, rev: rev + 1 } });
  if (!res.ok) throw new CloudError(await messageOf(res), { status: res.status });
  return (await res.json()).length ? true : 'conflict';
}
