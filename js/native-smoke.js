// The Android app's native side, with stand-in plugins: Bluetooth LE heart rate, notifications (rest timer, interval
// phases, reminders, the toe), keep-awake, the foreground service and the back button. Open /native.html to run.
const out = [];
const check = (name, cond, extra = '') => out.push([cond ? 'PASS' : 'FAIL', name + (cond ? '' : ` ${extra}`)]);
const q = s => document.querySelector(s);
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error(`missing ${s}`); el.click(); };
const text = () => q('#app').innerText;
const tick = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
addEventListener('error', e => errors.push(e.message));
addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
const KEY = globalThis.AFP_STORAGE_KEY;
Object.keys(localStorage).filter(k => k === KEY || k.startsWith(`${KEY}.`)).forEach(k => localStorage.removeItem(k));

// ---------- the stand-in plugins ----------
const calls = [];
const rec = name => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
let notify = null, dropped = null, back = null;
const appListeners = {}, channels = [];
const scheduled = new Map();
globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
globalThis.AFPNative = {
  BleClient: {
    initialize: rec('ble.initialize'),
    requestDevice: async opts => { calls.push(['ble.requestDevice', opts]); return { deviceId: 'AA:BB:CC', name: 'Powr Labs HR' }; },
    connect: async (id, onDisc) => { calls.push(['ble.connect', id]); dropped = onDisc; },
    startNotifications: async (id, svc, chr, cb) => { calls.push(['ble.notify', id, svc, chr]); notify = cb; },
    disconnect: rec('ble.disconnect'),
  },
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'prompt' }),
    requestPermissions: async () => { calls.push(['notif.ask']); return { display: 'granted' }; },
    schedule: async ({ notifications }) => { for (const n of notifications) scheduled.set(n.id, n); },
    cancel: async ({ notifications }) => { for (const n of notifications) scheduled.delete(n.id); },
    createChannel: async ch => { channels.push(ch); },
  },
  KeepAwake: { keepAwake: rec('awake.on'), allowSleep: rec('awake.off') },
  App: { addListener: (ev, fn) => { if (ev === 'backButton') back = fn; (appListeners[ev] ??= []).push(fn); return Promise.resolve({ remove() {} }); }, minimizeApp: rec('app.minimize'),
    getInfo: async () => ({ build: String(installed), version: `1.${installed}` }) },
  ForegroundService: { startForegroundService: rec('fg.start'), stopForegroundService: rec('fg.stop') },
  // Pop-out: the app's own plugin. `pip` is what Android would report; pipChange is fired by hand, as Android would.
  Capacitor: { isPluginAvailable: n => n === 'Pip' },
  Pip: {
    status: async () => ({ supported: true, ...pip }),
    enter: async () => { calls.push(['pip.enter']); return { ok: true }; },
    setAuto: async o => { calls.push(['pip.auto', o.on]); },
    addListener: (ev, fn) => { (appListeners[`pip.${ev}`] ??= []).push(fn); return Promise.resolve({ remove() {} }); },
  },
};
const pip = { pip: false, resumed: true };
// The release on GitHub, as the update check sees it: build 7 published, 5 installed.
let installed = 5;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => (String(url).startsWith('https://api.github.com/')
  ? Promise.resolve(new Response(JSON.stringify({ body: 'The app.\nBuild 7 from abc123.', html_url: 'https://github.com/o/r/releases/tag/android',
    assets: [{ name: 'adaptive-fitness.apk', browser_download_url: 'https://github.com/o/r/releases/download/android/adaptive-fitness.apk' }] })))
  : realFetch(url, opts));
const pipChange = on => { for (const fn of appListeners['pip.pipChange'] ?? []) fn({ on }); };
const lastAuto = () => calls.filter(c => c[0] === 'pip.auto').at(-1)?.[1];
const beat = bpm => { const b = new DataView(new ArrayBuffer(2)); b.setUint8(0, 0); b.setUint8(1, bpm); notify(b); };
let vis = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
// Going to the background as the app sees it: Capacitor's pause and resume. The page stays "visible" (Capacitor keeps
// it running), and its timers keep ticking.
const setVis = v => { for (const fn of appListeners[v === 'hidden' ? 'pause' : 'resume'] ?? []) fn(); };

await (await import('./vault.js')).wipe();
await import('./app.js');
const store = await import('./store.js');
const S = () => store.state;
await tick(200);

try {
  check('the plugins are the app\'s: no second copy loaded', globalThis.AFPNative.BleClient.requestDevice && calls.some(c => c[0] === 'notif.ask'), JSON.stringify(calls));
  check('first run: bring your data from the browser version', /Used it in Chrome\?/.test(text()) && !!q('[data-act=obMove]'));
  click('[data-act=obMove]');
  check('…goes to Backup and data, setup skipped', S().settings.onboarded && /Backup and data/.test(text()), text().slice(0, 200));

  // Heart rate over the native Bluetooth plugin.
  S().settings.hrMax = 190;
  click('[data-act=nav][data-tab=heart]');
  click('.hrpill'); await tick(50);
  const req = calls.find(c => c[0] === 'ble.requestDevice');
  check('the strap is picked from Android\'s list, heart-rate straps only', req && req[1].services[0] === '0000180d-0000-1000-8000-00805f9b34fb' && calls.some(c => c[0] === 'ble.initialize'), JSON.stringify(req));
  beat(131);
  check('readings arrive and show', /♥ 131/.test(q('.hrpill')?.textContent ?? '') && /Z2/.test(q('.hrpill')?.textContent ?? ''), q('.hrpill')?.textContent);
  check('the strap is remembered by its id, to reconnect without the list', S().settings.hrStrap === 'Powr Labs HR' && S().settings.hrStrapId === 'AA:BB:CC');
  dropped(); await tick(20);
  check('a drop says so, then reconnects by id', /Reconnecting/.test(q('.hrpill')?.textContent ?? ''));
  await tick(1200);
  check('…and does', calls.filter(c => c[0] === 'ble.connect').length >= 2);
  beat(128);

  // Tracking an activity: the screen stays on, and a foreground service keeps the strap going with it off.
  click('[data-act=hrTrackStart]'); await tick(20);
  check('tracking keeps the screen on (keep-awake)', calls.some(c => c[0] === 'awake.on'));
  check('and starts the foreground service, as a connected device', calls.some(c => c[0] === 'fg.start' && c[1].serviceType === 16 && /Recording heart rate/.test(c[1].title)), JSON.stringify(calls.filter(c => c[0] === 'fg.start')));
  click('[data-act=hrTrackDiscard]'); await tick(20);
  check('stopping stops the service and lets the screen sleep', calls.some(c => c[0] === 'fg.stop') && calls.some(c => c[0] === 'awake.off'));

  // The rest timer and the interval timer as notifications while the phone is locked.
  click('[data-act=nav][data-tab=timer]');
  click('[data-act=ivPreset][data-id=iv-tabata]');
  click('[data-act=ivStart]');
  setVis('hidden'); await tick(50);
  const phases = [...scheduled.values()].filter(n => n.id >= 7010 && n.id < 7060).sort((a, b) => a.id - b.id);
  check('locked mid-Tabata: each phase as a notification at its time', phases.length >= 15 && /^Work · round 1 of 8/.test(phases[0].title) && phases[0].schedule.at > Date.now() && phases.at(-1).title === 'Done' && phases.every(n => n.smallIcon === 'ic_stat_afp'), JSON.stringify(phases.slice(0, 3).map(n => n.title)));
  setVis('visible'); await tick(50);
  check('back in the app: they\'re cancelled', ![...scheduled.keys()].some(id => id >= 7001 && id < 7060));

  // Pop-out: going home mid-timer pops the app out over other apps; in the window the timer carries on itself.
  check('a running timer turns pop-out-on-leaving on', lastAuto() === true, JSON.stringify(calls.filter(c => c[0] === 'pip.auto')));
  check('and the timer has a pop-out button', !!q('[data-act=pipGo]'));
  click('[data-act=pipGo]'); await tick(20);
  check('…which pops out', calls.some(c => c[0] === 'pip.enter'));
  Object.assign(pip, { pip: true, resumed: false });
  pipChange(true); setVis('hidden'); await tick(300);
  const pv = q('#pip');
  check('the window shows just the phase, the clock and the heart rate', document.body.classList.contains('pip') && !pv.hidden && /Get ready|Work/.test(pv.textContent) && /\d:\d\d/.test(pv.textContent) && /♥ 128/.test(pv.textContent), pv.textContent);
  check('in the window the app isn\'t away: no notifications, beeps carry on', ![...scheduled.keys()].some(id => id >= 7010 && id < 7060));
  Object.assign(pip, { pip: false, resumed: false });
  pipChange(false); await tick(50);
  check('closing the window leaves it in the background: notifications again', [...scheduled.keys()].some(id => id >= 7010 && id < 7060) && !document.body.classList.contains('pip'));
  Object.assign(pip, { pip: false, resumed: true });
  setVis('visible'); await tick(50);
  check('back in the app: cancelled, the full app back', ![...scheduled.keys()].some(id => id >= 7010 && id < 7060) && q('#pip').hidden);
  click('[data-act=ivStop]'); click('[data-act=ivDiscard]'); await tick(300);
  check('nothing running: going home just goes home', lastAuto() === false);
  check('Timer has the pop-out setting', !!q('input[data-bind="settings.timer.pip"]'));

  // The max heart-rate test, with the strap: its steps, the peak at the end, and the max set from it.
  click('[data-act=ivPreset][data-id=iv-maxhr]');
  check('the test: its steps and a warning', /Max heart rate test/.test(text()) && /All out/.test(text()) && /chest pain/.test(text()) && !q('[data-act=ivSave]'));
  click('[data-act=ivStart]'); await tick(300);
  const skipTo = async label => { for (let i = 0; i < 8 && !new RegExp(label).test(q('#iv-run .ivphase')?.textContent ?? ''); i++) { click('[data-act=ivSkip]'); await tick(300); } };
  await skipTo('Warm up');
  beat(122); await tick(1100); beat(124);
  check('each step with its cue', /Warm up/.test(q('#iv-run').textContent) && /steady pace/.test(q('#iv-run').textContent) && /Next: Hard · 3:00/.test(q('#iv-run').textContent), q('#iv-run').textContent);
  // (Heart rate is kept as 5-second averages: a reading 5 s into a step lands in that step.)
  await skipTo('Hard'); await tick(5100); beat(171);
  await skipTo('All out'); await tick(5100); beat(193); await tick(5100); beat(196); await tick(300);
  click('[data-act=ivStop]');
  check('the result: the peak, higher than your max', /Peak heart rate/.test(text()) && /♥ 196/.test(text()) && /Higher than your max of 190/.test(text()) && /may be low/.test(text()), text().slice(0, 300));
  check('…each step\'s average and peak', /Warm up\s*12\d/.test(text()) && /All out\s*19\d\s*196/.test(text()), text().slice(0, 500));
  click('[data-act=hrUseTop][data-v="196"]');
  check('one tap makes it your max', S().settings.hrMax === 196);
  check('and it logs as one stretch', /Log \d+:\d\d/.test(q('[data-act=ivLog]')?.textContent ?? ''));
  click('[data-act=ivDiscard]');
  S().settings.hrMax = 190;
  S().timer = { endsAt: Date.now() + 90e3, total: 90, blockId: 'b', setId: 's', next: 'Back squat · set 2' };
  setVis('hidden'); await tick(50);
  check('the rest timer: "Rest over" when it ends', scheduled.get(7001)?.title === 'Rest over' && /Back squat · set 2/.test(scheduled.get(7001).body) && Math.abs(scheduled.get(7001).schedule.at - S().timer.endsAt) < 5);
  await tick(1200);
  check('…and it stays scheduled while the timer keeps ticking in the background', scheduled.has(7001) && vis === 'visible', [...scheduled.keys()].join());
  check('on the timers channel: pops up, with sound and vibration', scheduled.get(7001)?.channelId === 'timers' && channels.some(c => c.id === 'timers' && c.importance === 5 && c.vibration));
  setVis('visible'); S().timer = null; await tick(50);

  // A new APK: a banner on Today with the download, Later hides it; Settings keeps the link.
  click('[data-act=nav][data-tab=today]'); await tick(50);
  const dl = [...document.querySelectorAll('#app a')].find(a => /Download/.test(a.textContent));
  check('a newer build on the release: a banner with the download', /app update is ready/.test(text()) && dl?.href.endsWith('/adaptive-fitness.apk'), text().slice(0, 200));
  click('[data-act=updateLater]');
  check('Later hides it', !/app update is ready/.test(text()));
  click('[data-act=nav][data-tab=more]');
  check('Settings still has it', /Update the app/.test(text()) && /build 7 is ready · you have 5/.test(text()));

  // Reminders.
  click('[data-act=nav][data-tab=more]');
  check('Settings lists Reminders in the app', !!q('[data-act=setPage][data-p=reminders]'));
  click('[data-act=setPage][data-p=reminders]');
  const t = new Date(Date.now() + 3600e3), hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const inp = q('input[data-bind="settings.reminders.foot"]'); inp.value = hhmm; inp.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(1800);
  const foot = [...scheduled.values()].filter(n => n.id >= 7111 && n.id < 7118);
  // Each of the next 7 days at that time, from today if it's still to come (near midnight "an hour from now" is tomorrow).
  const due = Array.from({ length: 7 }, (_, d) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(t.getHours(), t.getMinutes(), 0, 0); return x.getTime(); }).filter(x => x > Date.now()).length;
  check('a foot strength reminder for each of the next 7 days, at your time', foot.length === due && due >= 6 && foot.every(n => n.title === 'Foot strength' && new Date(n.schedule.at).getMinutes() === t.getMinutes()), `${foot.length}/${due} ${hhmm}`);
  const m = new Date(Date.now() + 7200e3);
  const mi = q('input[data-bind="settings.reminders.morning"]'); mi.value = `${String(m.getHours()).padStart(2, '0')}:${String(m.getMinutes()).padStart(2, '0')}`; mi.dispatchEvent(new Event('change', { bubbles: true }));
  S().morning.log.unshift({ id: 'x', day: (await import('./logic.js')).dayKey(), at: Date.now(), energy: 4, pain: {} }); store.save();
  await tick(1800);
  const morn = [...scheduled.values()].filter(n => n.id >= 7101 && n.id < 7108);
  check('morning check done today: today\'s reminder is skipped, the next 6 days are there', morn.length === 6 && !morn.some(n => n.id === 7101), morn.map(n => n.id).join());
  inp.value = ''; inp.dispatchEvent(new Event('change', { bubbles: true })); await tick(1800);
  check('clearing a time turns it off', ![...scheduled.keys()].some(id => id >= 7111 && id < 7118));

  // The back button.
  back();
  check('back: out of a Settings page', !q('[data-act=setPage][data-p=""]') && /Reminders/.test(text()) === true && !!q('[data-act=setPage][data-p=you]'));
  click('[data-act=setPage][data-p=you]'); click('[data-act=nav][data-tab=today]');
  click('[data-act=footProgress]');
  back();
  check('back: a sheet closes first', q('#sheet').hidden);
  click('[data-act=nav][data-tab=heart]');
  back();
  check('back: other tabs go to Today', q('#nav button.on')?.dataset.tab === 'today');
  back();
  check('back on Today: the app goes to the background', calls.some(c => c[0] === 'app.minimize'));
  const entered = calls.filter(c => c[0] === 'pip.enter').length;
  S().timer = { endsAt: Date.now() + 90e3, total: 90, blockId: 'b', setId: 's', next: 'Back squat · set 2' };
  back(); await tick(20);
  check('…but with a timer running it pops out instead', calls.filter(c => c[0] === 'pip.enter').length === entered + 1);
  S().timer = null;
} catch (e) {
  out.push(['FAIL', `native — ${e.message} ${e.stack?.split('\n')[1] ?? ''}`]);
}
if (errors.length) out.push(['FAIL', `page errors: ${errors.join(' | ')}`]);
Object.keys(localStorage).filter(k => k === KEY || k.startsWith(`${KEY}.`)).forEach(k => localStorage.removeItem(k));
const fails = out.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${out.filter(r => r[0] === 'PASS').length} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = out.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
