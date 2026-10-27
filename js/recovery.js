// Recovery test: the second copy in IndexedDB brings your data back when the browser clears localStorage. Open /recovery.html.
// It reloads itself between phases (a cleared browser is a fresh page load), keeping its place in sessionStorage.
// Like smoke.html it points the app at its own storage key and database, never your real data.
const out = [];
const check = (name, cond, extra = '') => out.push([cond ? 'PASS' : 'FAIL', name + (cond ? '' : ` ${extra}`)]);
const q = s => document.querySelector(s);
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error(`missing ${s}`); el.click(); };
const text = () => q('#app').innerText;
const tick = ms => new Promise(r => setTimeout(r, ms));
const KEY = globalThis.AFP_STORAGE_KEY, PHASE = 'afp-recovery-phase', RESULTS = 'afp-recovery-results';
const phase = Number(sessionStorage.getItem(PHASE) || 0);
const keep = () => sessionStorage.setItem(RESULTS, JSON.stringify([...JSON.parse(sessionStorage.getItem(RESULTS) || '[]'), ...out]));
const next = n => { keep(); sessionStorage.setItem(PHASE, String(n)); location.reload(); return new Promise(() => {}); };
const errors = [];
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
const wipeAll = async () => { Object.keys(localStorage).filter(k => k === KEY || k.startsWith(`${KEY}.`)).forEach(k => localStorage.removeItem(k)); await (await import('./vault.js')).wipe(); };
const logSets = (state, n) => { for (let i = 0; i < n; i++) state.sets.push({ id: `r${i}`, sessionId: 'rs', blockId: 'rb', exerciseId: 'ex-back-squat', tier: 'T1', load: 200, reps: 3, done: true, loggedAt: Date.now() - i * 1000 }); state.sessions.push({ id: 'rs', status: 'done', day: '2026-01-01', checkinAt: Date.now() - 1e5, firstSetAt: Date.now() - 9e4, blocks: [] }); };

try {
  if (phase === 0) {
    // Without IndexedDB (private mode, blocked): the app works exactly as before.
    await wipeAll();
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    await import('./app.js');
    const store = await import('./store.js');
    check('no IndexedDB: the app still starts', /Welcome/.test(text()));
    click('[data-act=obSkip]');
    store.state.settings.bodyweight = 150;
    check('no IndexedDB: saving still works', store.save() && JSON.parse(localStorage.getItem(KEY)).settings.bodyweight === 150);
    check('no IndexedDB: nothing to recover and no error', (await store.recover()).kind === 'none' && (await store.flushVault()) === false);
    await next(1);
  } else if (phase === 1) {
    // Real data, saved in both places, then the browser "clears" localStorage.
    await wipeAll();
    await import('./app.js');
    const store = await import('./store.js'), V = await import('./vault.js');
    click('[data-act=obSkip]');
    store.state.settings.bodyweight = 199;
    logSets(store.state, 12);
    store.save();
    await store.flushVault();
    const copy = await V.get();
    check('the second copy holds the data', !!copy && JSON.parse(copy.json).settings.bodyweight === 199 && JSON.parse(copy.json).sets.length === 12);
    check('a day with logged sets has one daily snapshot', (await V.list()).filter(r => r.reason === 'daily').length === 1);
    await store.flushVault();
    check('and still one after another save', (await V.list()).filter(r => r.reason === 'daily').length === 1);
    check('saves are stamped', typeof store.state.savedAt === 'number');
    localStorage.removeItem(KEY);
    await next(2);
  } else if (phase === 2) {
    // The page loads with nothing in localStorage: the second copy brings it back.
    await import('./app.js');
    const store = await import('./store.js');
    check('the data came back instead of the setup', !/Welcome/.test(text()) && store.state.settings.bodyweight === 199 && store.state.sets.length === 12, text().slice(0, 200));
    check('with a banner saying so', /Recovered your data from this device's backup copy/.test(text()) && /12 sets/.test(text()), text().slice(0, 300));
    check('and it is saved here again', JSON.parse(localStorage.getItem(KEY)).sets.length === 12);
    click('[data-act=recoveredOk]');
    check('OK dismisses the banner', !/Recovered your data/.test(text()));

    // A localStorage write failed: the second copy is newer. Offered, never applied on its own.
    const V = await import('./vault.js');
    const newer = { ...JSON.parse(JSON.stringify(store.state)), savedAt: store.state.savedAt + 60000 };
    newer.settings.bodyweight = 177;
    await V.put(JSON.stringify(newer));
    const r = await store.recover();
    check('a newer second copy is found', r.kind === 'newer', JSON.stringify(r));
    check('and not applied yet', store.state.settings.bodyweight === 199);
    click('[data-act=nav][data-tab=week]');
    check('the banner offers it', /A newer copy of your data was found/.test(text()) && /Use it/.test(text()) && /Ignore/.test(text()), text().slice(0, 300));
    check('and a snapshot keeps it whatever you choose', (await V.list()).some(x => x.reason === 'recovered'));
    click('[data-act=recoveryUse]');
    check('Use it takes it', store.state.settings.bodyweight === 177);
    await tick(300);
    check('after a snapshot of what was here', (await V.list()).some(x => x.reason === 'before-restore'));

    const again = { ...JSON.parse(JSON.stringify(store.state)), savedAt: store.state.savedAt + 60000 };
    again.settings.bodyweight = 155;
    await V.put(JSON.stringify(again));
    check('another newer copy', (await store.recover()).kind === 'newer');
    click('[data-act=nav][data-tab=more]');
    click('[data-act=recoveryIgnore]');
    check('Ignore keeps what is here', store.state.settings.bodyweight === 177 && !/A newer copy/.test(text()));

    // Next load: what's saved here can't be opened, but the second copy can.
    await V.put(JSON.stringify(store.state));
    localStorage.setItem(KEY, '{this is not json');
    await next(3);
  } else if (phase === 3) {
    await import('./app.js');
    const store = await import('./store.js');
    check('unreadable data shows the problem and keeps saving paused', /couldn.t be opened/.test(text()) && !!q('[data-act=startFresh]'), text().slice(0, 300));
    check('and offers the backup copy', /Use the backup copy from/.test(text()) && !!q('[data-act=recoveryUse]'), text().slice(0, 300));
    check('the unreadable data was left alone', localStorage.getItem(KEY) === '{this is not json');
    click('[data-act=recoveryUse]');
    check('using it brings the data back and clears the problem', store.state.settings.bodyweight === 177 && store.state.sets.length === 12 && !/couldn.t be opened/.test(text()));
    check('and saving works again', JSON.parse(localStorage.getItem(KEY)).settings.bodyweight === 177);
    await wipeAll();
    sessionStorage.removeItem(PHASE);
  }
} catch (e) {
  out.push(['FAIL', `phase ${phase} — ${e.message}`]);
}

if (phase === 3 || out.some(r => r[0] === 'FAIL')) {
  keep();
  const all = JSON.parse(sessionStorage.getItem(RESULTS) || '[]');
  sessionStorage.removeItem(RESULTS); sessionStorage.removeItem(PHASE);
  if (errors.length) all.push(['FAIL', `page errors: ${errors.join(' | ')}`]);
  const fails = all.filter(r => r[0] === 'FAIL').length;
  document.getElementById('summary').textContent = `${all.filter(r => r[0] === 'PASS').length} passed, ${fails} failed`;
  document.title = fails ? 'FAIL' : 'PASS';
  document.getElementById('out').innerHTML = all.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
}
