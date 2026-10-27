// A stand-in for the Supabase project, for tests: it answers the auth and REST calls js/cloud.js makes, in memory, with the
// same rules as supabase/schema.sql (a user sees and changes only their own row; an update only lands if `rev` matches).
// installFake() swaps globalThis.fetch; the returned object lets a test play "the other device" by changing rows directly.
import { SUPABASE_URL } from './cloud-config.js';

const b64 = o => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (id, email) => `${b64({ alg: 'none' })}.${b64({ sub: id, email, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function installFake() {
  const real = globalThis.fetch;
  const fake = {
    rows: new Map(),      // user id -> { rev, saved_at, device, workouts, sets, data }
    users: new Map(),     // email -> id
    codes: new Map(),     // email -> the code "emailed"
    sent: [],             // emails sent: { email, redirect }
    log: [],              // every request: "METHOD path"
    refreshes: 0,
    offline: false,
    failNext: null,       // a status to answer the next REST call with
    beforePatch: null,    // a function to run once, just before the next PATCH is judged
    expireTokens: false,  // make the next REST call answer 401 once (a stale access token)
    restore() { globalThis.fetch = real; },
    // Plays another device: replaces the account's row, bumping rev.
    putRow(email, data, device = 'Other phone') {
      const id = fake.users.get(email) ?? crypto.randomUUID();
      fake.users.set(email, id);
      const cur = fake.rows.get(id);
      const sets = (data.sets ?? []).filter(x => x.done && !x.warmup).length, workouts = (data.sessions ?? []).filter(x => x.firstSetAt).length;
      fake.rows.set(id, { rev: (cur?.rev ?? 0) + 1, saved_at: new Date(data.savedAt ?? Date.now()).toISOString(), device, workouts, sets, data });
    },
    row(email) { return fake.rows.get(fake.users.get(email)); },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (!url.startsWith(SUPABASE_URL)) return real(url, init);
    if (fake.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url), path = u.pathname, method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
    fake.log.push(`${method} ${path}${u.search ? '?' + u.search.slice(1).split('&')[0] : ''}`);
    const headers = init.headers ?? {};
    if (!headers.apikey) return json(401, { message: 'No API key found in request' });
    if (path === '/auth/v1/otp') {
      fake.sent.push({ email: body.email, redirect: u.searchParams.get('redirect_to') });
      if (!fake.users.has(body.email)) fake.users.set(body.email, crypto.randomUUID());
      fake.codes.set(body.email, '123456');
      return json(200, {});
    }
    if (path === '/auth/v1/verify') {
      if (fake.codes.get(body.email) !== body.token) return json(403, { error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      const id = fake.users.get(body.email);
      return json(200, { access_token: jwt(id, body.email), refresh_token: `r-${id}-${++fake.refreshes}`, expires_in: 3600, token_type: 'bearer', user: { id, email: body.email } });
    }
    if (path === '/auth/v1/token') {
      const m = /^r-(.+)-\d+$/.exec(body.refresh_token ?? '');
      if (!m) return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      const email = [...fake.users].find(([, id]) => id === m[1])?.[0];
      return json(200, { access_token: jwt(m[1], email), refresh_token: `r-${m[1]}-${++fake.refreshes}`, expires_in: 3600, token_type: 'bearer', user: { id: m[1], email } });
    }
    if (path === '/auth/v1/logout') return json(204);
    if (path === '/rest/v1/states') {
      const auth = /^Bearer (.+)$/.exec(headers.Authorization ?? '')?.[1];
      let claims = null;
      try { claims = JSON.parse(atob(auth.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* not a token */ }
      if (!claims || fake.expireTokens) { fake.expireTokens = false; return json(401, { message: 'JWT expired' }); }
      if (fake.failNext) { const status = fake.failNext; fake.failNext = null; return json(status, { message: 'Something broke' }); }
      const id = claims.sub, mine = (u.searchParams.get('user_id') ?? `eq.${id}`) === `eq.${id}`;
      const cur = fake.rows.get(id);
      if (method === 'GET') {
        const cols = (u.searchParams.get('select') ?? '').split(',');
        return json(200, mine && cur ? [Object.fromEntries(cols.filter(c => c in cur).map(c => [c, cur[c]]))] : []);
      }
      if (method === 'POST') {
        if (body.user_id !== id) return json(403, { message: 'new row violates row-level security policy' });
        if (cur) return json(409, { message: 'duplicate key value violates unique constraint' });
        const { user_id, ...rest } = body;
        fake.rows.set(id, { rev: 1, ...rest });
        return json(201);
      }
      if (method === 'PATCH') {
        if (fake.beforePatch) { const f = fake.beforePatch; fake.beforePatch = null; f(); } // another device saves just before this lands
        const want = Number(/^eq\.(\d+)$/.exec(u.searchParams.get('rev') ?? '')?.[1]);
        const now = fake.rows.get(id); // after the hook: the row may have moved on
        if (!mine || !now || now.rev !== want) return json(200, []);
        fake.rows.set(id, { ...now, ...body });
        return json(200, [{ rev: body.rev }]);
      }
    }
    return json(404, { message: `unhandled ${method} ${path}` });
  };
  return fake;
}
