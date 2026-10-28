// UI smoke test: loads the real app, drives it through the main flows, and reports. Open /smoke.html to run.
// smoke.html points the app at its own storage key, so your real saved data is never touched.
const errors = [];
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

const out = [];
const check = (name, cond, extra = '') => out.push([cond ? 'PASS' : 'FAIL', name + (cond ? '' : ` ${extra}`)]);
const q = s => document.querySelector(s);
const qa = s => [...document.querySelectorAll(s)];
const click = s => { const el = typeof s === 'string' ? q(s) : s; if (!el) throw new Error(`missing ${s}`); el.click(); };
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
const setVal = (el, v, type = 'change') => { el.value = v; fire(el, type); };
const text = () => q('#app').innerText;
const sheet = () => q('#sheet').innerText;
// Check-in at just this one location (the buttons toggle, so turn the others off).
const onlyAt = id => {
  const btn = q(`[data-act=ciLoc][data-v="${id}"]`);
  if (!btn.classList.contains('on')) btn.click();
  for (const b of qa('[data-act=ciLoc].on')) if (b.dataset.v !== id) b.click();
};
const step = (name, fn) => { try { fn(); } catch (e) { out.push(['FAIL', `${name} — ${e.message}`]); } };

const KEY = globalThis.AFP_STORAGE_KEY;
const wipe = () => Object.keys(localStorage).filter(k => k === KEY || k.startsWith(`${KEY}.`)).forEach(k => localStorage.removeItem(k));
wipe();
await (await import('./vault.js')).wipe(); // the second copy too, or a run would recover the last one's data
await import('./app.js');
const store = await import('./store.js');
const { state } = store;
const L = await import('./logic.js');
await new Promise(r => setTimeout(r, 200));

step('a new install starts with setup, which can be skipped', () => {
  check('setup shown first', /Welcome/.test(text()) && !!q('[data-act=obNext]') && q('nav')?.hidden !== false, text().slice(0, 200));
  click('[data-act=obSkip]');
  check('skipping keeps the starter goals', state.settings.onboarded === true && state.slots.length > 5);
  const basement = state.locations.find(l => l.id === 'loc-basement');
  check('the starter Basement has no pull-up bar, rings or dip station', !['pullup-bar', 'rings', 'dip-station', 'kettlebell', 'dip-belt'].some(eq => basement.equipment.includes(eq)));
  // The flows below use every exercise, so this run's Basement gets the bodyweight gear too.
  basement.equipment.push('kettlebell', 'dip-belt', 'pullup-bar', 'rings', 'dip-station');
});

step('check-in renders', () => check('check-in renders', text().includes('Check in') && !!q('[data-act=suggest]')));

step('fresh suggestion', () => {
  onlyAt('loc-basement');
  click('[data-act=suggest]');
  check('session shows blocks', qa('section.block').length > 0);
  check('readiness line shown', /Fresh for power work/.test(text()), text().slice(0, 200));
  check('explosive block first', /Block|Power clean|Broad jump|Box jump|Depth jump|Jump/i.test(qa('section.block')[0].innerText), qa('section.block')[0].innerText.slice(0, 80));
  click('[data-act=finish]');
});

step('tired check-in gives technique', () => {
  onlyAt('loc-basement');
  click('[data-k=energy][data-v="1"]');
  click('[data-act=suggest]');
  check('technique block present', qa('.bhead').some(h => /TECH/.test(h.innerText)), qa('.bhead').map(h => h.innerText.replace(/\n/g, ' ')).join(' | '));
  check('tired readiness shown', /Tired/.test(text()));
});

step('power block while tired offers one-tap technique', () => {
  click('[data-act=addEx]');
  click('[data-act=addExTier][data-t=T2]');
  click('[data-act=addExPick][data-id=ex-broad-jump]');
  const warn = qa('.dose.warn').find(d => /Not fresh/.test(d.innerText));
  check('banner offered', !!warn);
  click('[data-act=toTech]');
  const jump = qa('section.block').find(b => /Broad jump/.test(b.innerText));
  check('block is now technique', !!jump && /TECH/.test(jump.innerText), jump?.innerText.slice(0, 80));
  check('technique scheme chosen', !!jump && /[2-3]/.test(jump.querySelector('[data-act=swapScheme]').innerText));
  click('[data-act=recheck]');
});

step('choose the mix, then regenerate it', () => {
  onlyAt('loc-basement');
  click('[data-k=minutes][data-v="45"]');
  click('[data-k=lean][data-v=lower]');
  click('[data-act=mixStep][data-t=T3][data-d="1"]');
  click('[data-act=mixStep][data-t=T3][data-d="1"]');
  const jumps = q('[data-ci-jumps]');
  check('Add jumps is off by default', jumps && !jumps.checked);
  jumps.checked = true; jumps.dispatchEvent(new Event('change', { bubbles: true }));
  click('[data-act=mixBuild]');
  check('Add jumps gives one JUMP block', qa('section.block').filter(b => /^JUMP/.test(b.querySelector('.tier').innerText.trim())).length === 1);
  const tiers = () => qa('section.block').map(b => b.querySelector('.tier').innerText.trim());
  check('mix: one T2 and several T3s', tiers().filter(t => /^T2/.test(t)).length === 1 && tiers().filter(t => /^T3/.test(t)).length >= 4, tiers().join(','));
  const before = qa('section.block').map(b => b.querySelector('[data-act=swapEx]').innerText).join();
  click('[data-act=regen]');
  const after = qa('section.block').map(b => b.querySelector('[data-act=swapEx]').innerText).join();
  check('regenerate keeps the mix but changes picks', after !== before && tiers().filter(t => /^T2/.test(t)).length === 1, after);
  // A started block stays whole: its sets left to do aren't dropped, and it counts toward the mix.
  const t3 = () => qa('section.block').find(b => /^T3/.test(b.querySelector('.tier').innerText.trim()));
  const started = t3(), name = started.querySelector('[data-act=swapEx]').innerText, sets = started.querySelectorAll('.set:not(.warm)').length;
  click(started.querySelector('.set:not(.warm) [data-act=check]'));
  const t3count = tiers().filter(t => /^T3/.test(t)).length;
  click('[data-act=regen]');
  const still = qa('section.block').find(b => b.querySelector('[data-act=swapEx]').innerText === name);
  check('started block keeps all its sets', !!still && still.querySelectorAll('.set:not(.warm)').length === sets && still.querySelectorAll('.set.done:not(.warm)').length === 1, `${name}: ${still?.querySelectorAll('.set:not(.warm)').length}/${sets}`);
  check('the mix still adds up with a started block', tiers().filter(t => /^T3/.test(t)).length <= t3count, tiers().join(','));
  // Swapping a T3 into a family with a T3 goal counts toward that goal (it used to keep the old exercise's goal).
  const chip = x => x.querySelector('[data-act=swapEx]').innerText.replace(' ▾', '');
  if (!qa('section.block').some(x => chip(x) === 'Dead bug')) {
    // A T3 from a family other than core, so the old exercise's goal can't look right by accident.
    const notCore = new Set(state.exercises.filter(e => e.familyId !== 'fam-core').map(e => e.name));
    const t3b = qa('section.block').filter(x => /^T3/.test(x.querySelector('.tier').innerText.trim()) && !x.querySelector('.set.done')
      && notCore.has(chip(x))).at(-1);
    click(t3b.querySelector('[data-act=swapEx]'));
    click('#sheet [data-act=swapAny]');
    click('#sheet [data-act=addExPick][data-id=ex-dead-bug]');
    const db = qa('section.block').find(x => chip(x) === 'Dead bug');
    check('a swapped-in T3 counts toward its own goal', !!db && /Toward T3 Core/.test(db.innerText), db?.innerText.slice(0, 200));
  }
  click('[data-act=recheck]');
  const j2 = q('[data-ci-jumps]');
  if (j2?.checked) { j2.checked = false; j2.dispatchEvent(new Event('change', { bubbles: true })); }
});

step('supersets, real rest, pause and resume, more time', () => {
  check('energy scale: 5 is fresh', /Energy\s*1 wrecked · 5 fresh/i.test(text()), text().slice(0, 300));
  onlyAt('loc-basement');
  click('[data-k=minutes][data-v="60"]'); // long enough for T3 supersets once warm-ups and changeovers count
  click('[data-k=energy][data-v="5"]');
  click('[data-act=suggest]');
  check('suggested T3s are all grouped', qa('section.block').filter(b => /^T3/.test(b.querySelector('.tier').innerText)).every(b => b.classList.contains('paired') || b.classList.contains('haspair')));
  for (const b of qa('[data-act=pairUnlink]')) click(b); // start from no supersets to test the idea row
  const idea = q('[data-act=pairAdd]');
  check('superset idea offered under a main lift', !!idea);
  click(idea);
  const main = () => q('section.block.haspair'), pair = () => q('section.block.paired');
  const nameOf = el => el.querySelector('[data-act=swapEx]').innerText.replace(' ▾', '');
  check('partner shown right under its main lift', !!main() && !!pair() && main().nextElementSibling === pair() && /Superset with/.test(pair().innerText));
  const mainName = nameOf(main()), pairName = nameOf(pair());
  click(main().querySelector('[data-act=check]'));
  const timer = () => q('#timer').innerText;
  check('main lift rest runs, next up is the partner', !q('#timer').hidden && timer().includes(`next: ${pairName} · set 1`), timer());
  const endsAt = state.timer.endsAt;
  click(pair().querySelector('[data-act=check]'));
  check('partner set keeps the main lift countdown', state.timer?.endsAt === endsAt && timer().includes(`next: ${mainName} · set 2`), timer());
  const first = state.sets.find(x => x.blockId === state.timer.blockId && x.done);
  first.loggedAt -= 150000; // as if the set was 2.5 minutes ago
  click(main().querySelectorAll('[data-act=check]')[1]);
  check('real rest shown for the block and the session', /real rest 2:\d\d avg/.test(main().innerText) && /real rest/.test(q('header.top').innerText), main().innerText.slice(0, 200));
  const blocksBefore = qa('section.block').length;
  click('[data-act=finish]');
  check('finishing with sets left offers pause', /not logged yet/.test(sheet()));
  click('#sheet [data-act=pause]');
  check('paused workout waits on the check-in screen', /Paused at/.test(text()) && !!q('[data-act=resume]'));
  click('[data-act=resume]');
  check('resume brings the same workout back', qa('section.block').length === blocksBefore && !!q('section.block.paired'));
  click('[data-act=addEx]');
  click('[data-act=addExTier][data-t=T3]');
  click('[data-act=addExPick][data-id=ex-dead-bug]');
  check('a T3 added by hand joins a superset', qa('section.block.paired').some(b => /Dead bug/.test(b.innerText)));
  // AMRAP last set on a loaded T1/T2 lift: one tap, the last set is marked, and it sticks to the last set.
  const lift = () => qa('section.block').find(x => x.querySelector('[data-act=amrapToggle]'));
  click(lift().querySelector('[data-act=amrapToggle]'));
  const marked = () => [...lift().querySelectorAll('.set:not(.warm)')].map(x => x.classList.contains('amrap'));
  check('AMRAP marks only the last set', marked().at(-1) === true && marked().filter(Boolean).length === 1, JSON.stringify(marked()));
  click(lift().querySelector('[data-act=addSet]'));
  check('AMRAP moves to the new last set', marked().at(-1) === true && marked().filter(Boolean).length === 1, JSON.stringify(marked()));
  click(lift().querySelector('[data-act=removeSet]'));
  click(lift().querySelector('[data-act=amrapToggle]'));
  check('AMRAP off clears it', !marked().some(Boolean));
  // Remove sits in the exercise's header, not next to − set, and can be undone.
  const ringBlocks = () => qa('section.block').length;
  check('remove is in the header, away from the set buttons', !!q('section.block .bhead [data-act=removeBlock]') && !q('section.block .brow [data-act=removeBlock]'));
  const nBefore = ringBlocks();
  const dead = qa('section.block').find(b => /Dead bug/.test(b.innerText));
  click(dead.querySelector('[data-act=removeBlock]'));
  check('remove takes it out', ringBlocks() === nBefore - 1);
  const undoBtn = [...document.querySelectorAll('.toast button')].find(x => x.textContent === 'Undo');
  check('with an Undo', !!undoBtn);
  undoBtn?.click();
  check('undo puts it back', ringBlocks() === nBefore && qa('section.block').some(b => /Dead bug/.test(b.innerText)));
  click(qa('section.block')[0].querySelector('[data-act=exHist]'));
  check('history opens from the exercise', /session/i.test(sheet()) && /Full workouts/.test(sheet()), sheet().slice(0, 200));
  click('#sheet [data-act=sheetClose]');
  click('[data-act=addEx]');
  click('[data-act=addExTier][data-t=T3]');
  click('[data-act=addExPick][data-id=ex-ring-curl]');
  check('two T3s added by hand superset each other', /alternate sets|Giant set/.test(qa('.sslabel').map(x => x.innerText).join(' ')), qa('.sslabel').map(x => x.innerText).join(' | '));
  const lead = qa('section.block.haspair').find(b => /^T3/.test(b.querySelector('.tier').innerText));
check('a T3-led group exists', !!lead);
  if (lead) {
    state.timer = null;
    click(lead.querySelector('[data-act=check]'));
    check('mid-round in a T3 superset: no rest yet', !state.timer);
    // One set of every other exercise in the group finishes the round.
    const size = () => { let n = 1, el = qa('section.block.haspair').find(b => /^T3/.test(b.querySelector('.tier').innerText)); while ((el = el.nextElementSibling)?.classList.contains('paired')) n++; return n; };
    for (let i = 1; i < size(); i++) {
      let el = qa('section.block.haspair').find(b => /^T3/.test(b.querySelector('.tier').innerText));
      for (let j = 0; j < i; j++) el = el.nextElementSibling;
      click(el.querySelector('.set:not(.done) [data-act=check]'));
    }
    check('after the round: rest starts', !!state.timer);
  }
  click('[data-act=moreTime]');
  click('[data-act=addTime][data-v="30"]');
  check('more time adds exercises', qa('section.block').length > blocksBefore, `${blocksBefore} -> ${qa('section.block').length}`);
  click('[data-act=finish]');
  click('#sheet [data-act=finishNow]');
  check('done today shows real rest', /Done today: .*real rest/.test(text()), text().slice(0, 300));
});

step('video links must be web links', () => {
  for (const e of state.exercises) e.youtube = 'javascript:alert(1)';
  click('[data-act=nav][data-tab=today]');
  click('[data-act=suggest]');
  check('no javascript: link rendered', qa('section.block').length > 0 && !qa('a').some(a => /^javascript:/i.test(a.getAttribute('href') || '')));
  for (const e of state.exercises) e.youtube = '';
  click('[data-act=recheck]');
});

step('mobility: routine session, body-part picks, mobility in a workout, library and routines', () => {
  click('[data-act=nav][data-tab=today]');
  check('check-in no longer lists mobility', !q('[data-act=mobStart]') && /under Plans/.test(text()));
  click('[data-act=nav][data-tab=plans]');
  check('Plans lists your mobility routines', /Day 1: Long & Strong/.test(text()) && qa('[data-act=mobStart]').length === 4);
  click('[data-act=mobStart][data-id=mobr-day1]');
  check('routine session opens with its 4 moves', /Mobility/.test(q('#app h1').innerText) && qa('section.block.mob').length === 4 && /Jefferson curl/.test(text()));
  check('history notes and video link shown', /Week 1: 70 lb/.test(q('#app').textContent) && qa('section.block.mob a').some(a => a.href.startsWith('https://www.youtube.com/results')));
  const jc = qa('section.block.mob').find(b => /Jefferson curl/.test(b.innerText));
  const load = jc.querySelector('[data-f=load]');
  setVal(load, '90');
  setVal(jc.querySelector('[data-f=extra]'), '35+25+25');
  setVal(jc.querySelector('[data-mnote]'), 'left side tight');
  click(qa('section.block.mob').find(b => /Jefferson curl/.test(b.innerText)).querySelector('[data-act=mcheck]'));
  check('logging a set starts its rest', !!state.timer && state.timer.total === 60 && /Jefferson curl · set 2/.test(state.timer.next), JSON.stringify(state.timer));
  click('[data-act=mobPick][data-mode=session]');
  click('[data-act=mobPart][data-v="Lats"]');
  check('picking a body part ticks a suggestion', /☑/.test(sheet()));
  click('[data-act=mobAddPicked]');
  check('added to the session', qa('section.block.mob').length === 5);
  click('[data-act=mobFinish]');
  check('finish saves only what was logged', state.mobility.sessions.at(-1).status === 'done' && state.mobility.sessions.at(-1).items.length === 1
    && state.mobility.sessions.at(-1).items[0].note === 'left side tight');
  click('[data-act=nav][data-tab=plans]');
  check('routine shows when it was last done', /Day 1: Long & Strong\s*4 exercises · last today/.test(text()), text().slice(0, 600));
  click('[data-act=nav][data-tab=today]');

  onlyAt('loc-basement');
  click('[data-act=suggest]');
  click('[data-act=mobPick][data-mode=workout]');
  click('[data-act=mobPart][data-v="Hip flexors"]');
  click('[data-act=mobPart][data-v="Adductors"]');
  const picked = (sheet().match(/☑/g) || []).length;
  check('two body parts, two suggestions', picked === 2, String(picked));
  click('[data-act=mobAddPicked]');
  check('mobility shows in the workout', qa('section.block.mob').length === 2 && /Mobility/.test(text()));
  click(qa('section.block.mob')[0].querySelector('[data-act=mcheck]'));
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  const w = state.sessions.filter(x => x.mobility?.length).at(-1);
  check('workout with only mobility logged is kept', !!w && w.status === 'done' && w.mobility.length === 1);

  click('[data-act=nav][data-tab=library]');
  click('[data-act=libMode][data-v=mobility]');
  check('library mobility tab lists all 25', qa('[data-act=mobExEdit]').length === 25);
  click('[data-act=mobExNew]');
  q('#me-name').value = '90/90 hip switch';
  click('[data-act=mobExPart][data-v="Glutes"]');
  check('typed name survives picking a body part', q('#me-name').value === '90/90 hip switch');
  click('[data-act=mobExSave]');
  check('new mobility exercise saved', qa('[data-act=mobExEdit]').length === 26 && /90\/90 hip switch/.test(text()));
  click('[data-act=libMode][data-v=strength]');

  click('[data-act=nav][data-tab=plans]');
  check('plans tab lists the mobility routines', /Mobility routines/.test(text()) && /Day 4: Primal Roots/.test(text()));
  click('[data-act=mobRoutineNew]');
  setVal(q('#mr-name'), 'Hips before volleyball', 'input');
  click('[data-act=mobPick][data-mode=routine]');
  click('[data-act=mobPart][data-v="Glutes"]');
  click('[data-act=mobAddPicked]');
  click('[data-act=mobRoutineSave]');
  check('new routine saved', state.mobility.routines.some(r => r.name === 'Hips before volleyball' && r.items.length >= 1));
  click('[data-act=nav][data-tab=week]');
  check('week tab shows mobility and body parts covered', /Mobility this week/.test(text()) && /2 sessions/.test(text()), text().slice(-400));
});

step('library shows region + explosive, edit sheet has the controls', () => {
  click('[data-act=nav][data-tab=library]');
  check('library lists explosive tag', /explosive/.test(text()));
  click('[data-act=libEdit][data-id=ex-broad-jump]');
  check('region select is lower', q('#ee-region').value === 'lower');
  check('explosive ticked', q('#ee-expl').checked);
  q('#ee-region').value = 'full'; q('#ee-expl').checked = false;
  click('[data-act=exSave]');
  click('[data-act=libEdit][data-id=ex-broad-jump]');
  check('edits saved', q('#ee-region').value === 'full' && !q('#ee-expl').checked);
  click('[data-act=sheetClose]');
});

step('quick-add guesses region and explosive from the name', () => {
  click('[data-act=quickAdd]');
  const n = q('#qa-name'); setVal(n, 'Hang snatch', 'input');
  check('region guessed whole body', q('input[name=qa-region]:checked')?.value === 'full');
  check('explosive guessed', q('#qa-expl').checked);
  setVal(n, 'Seated broad jump 2', 'input');
  check('region re-guessed lower', q('input[name=qa-region]:checked')?.value === 'lower');
  click('input[name=qa-region][value=upper]');
  setVal(n, 'Seated broad jump 3', 'input');
  check('touched region is kept', q('input[name=qa-region]:checked')?.value === 'upper');
  click('[data-act=qaSave]');
  check('exercise saved', /Seated broad jump 3/.test(text()) || qa('.toast').length > 0);
});

step('technique goal and per-goal reps', () => {
  click('[data-act=nav][data-tab=week]');
  click('[data-act=goalNew]');
  click('[data-act=goalSet][data-k=tier][data-v=TECH]');
  check('technique tier offered', /Technique/.test(sheet()));
  setVal(q('#g-reps'), '10', 'input');
  click('[data-act=goalSet][data-k=priority][data-v="2"]');
  check('typed reps survive a sheet refresh', q('#g-reps').value === '10');
  click('[data-act=goalSave]');
  check('technique goal listed', qa('.slotrow').some(r => /TECH/.test(r.innerText)));
  const jumpsGoal = qa('.slotrow').find(r => /Jumps/.test(r.innerText));
  check('seeded jumps goal present', !!jumpsGoal);
  click(jumpsGoal);
  check('jumps goal shows its own reps', q('#g-reps').value === '12', q('#g-reps')?.value);
  click('[data-act=sheetClose]');
});

step('settings pages render, tier doses include technique', () => {
  click('[data-act=nav][data-tab=more]');
  for (const p of ['you', 'timer', 'locations', 'tiers', 'schemes', 'data']) {
    click(`[data-act=setPage][data-p=${p}]`);
    if (!q('.pagetitle')) check(`settings page ${p}`, false, 'no title');
    if (p === 'tiers') check('tier page lists technique', /technique/i.test(text()) && /Target load from/i.test(text()));
    if (p === 'schemes') check('scheme page lists technique schemes', qa('.menurow').length > 10);
    click('[data-act=setPage][data-p=""]');
  }
  check('all settings pages opened', true);
});

step('archiving hides an exercise until you ask for it', () => {
  click('[data-act=nav][data-tab=library]');
  click('[data-act=libEdit][data-id=ex-air-squat]');
  q('#ee-arch').checked = true;
  click('[data-act=exSave]');
  check('archived exercise hidden', !/Air squat/.test(text()));
  click('[data-act=libArchived]');
  check('shown on request, marked archived', /Air squat/.test(text()) && /archived/.test(text()));
  click('[data-act=libArchived]');
});

step('warm-ups are optional, only for T1/T2, and never fill the working sets', () => {
  click('[data-act=nav][data-tab=today]');
  if (!q('[data-act=addEx]')) { onlyAt('loc-basement'); click('[data-act=suggest]'); }
  click('[data-act=addEx]');
  click('[data-act=addExTier][data-t=T2]');
  click('[data-act=addExPick][data-id=ex-deficit-rdl]');
  const blk = () => qa('section.block').find(b => /Deficit Romanian deadlift/.test(b.innerText));
  check('no warm-ups until asked', !blk().querySelector('.set.warm'));
  const work = () => state.sets.filter(x => x.blockId === blk().querySelector('[data-act=addWarm]').dataset.b && !x.warmup);
  setVal(blk().querySelector('.set:not(.warm) input[data-f=load]'), '200');
  click(blk().querySelector('[data-act=addWarm]'));
  click(blk().querySelector('[data-act=addWarm]'));
  const rows = blk().querySelectorAll('.set.warm');
  check('two warm-up rows, before the working sets', rows.length === 2 && blk().querySelector('.sets').firstElementChild.classList.contains('warm'));
  check('warm-up fields start empty, suggestions as placeholders', rows[0].querySelector('[data-f=load]').value === '' && rows[0].querySelector('[data-f=load]').placeholder === '80' && rows[1].querySelector('[data-f=reps]').placeholder === '3',
    `${rows[0].querySelector('[data-f=load]').placeholder} ${rows[1].querySelector('[data-f=reps]').placeholder}`);
  const loads = work().map(x => x.load).join();
  state.timer = null;
  setVal(rows[0].querySelector('[data-f=load]'), '95');
  setVal(rows[0].querySelector('[data-f=reps]'), '5');
  click(blk().querySelector('.set.warm [data-act=check]'));
  check('logging a warm-up leaves the working sets alone', work().map(x => x.load).join() === loads && work().every(x => !x.done), `${loads} -> ${work().map(x => x.load).join()}`);
  check('no rest after a warm-up', !state.timer);
  const credit = L.creditWeek(state);
  check('warm-ups count toward nothing', !state.sets.some(x => x.warmup && credit.assign.get(x.id)));
  check('and never set a max', L.estimatedMax(state, 'ex-deficit-rdl') == null);
  click(blk().querySelector('[data-act=tierEdit]'));
  click('[data-act=tierPick][data-t=T3]');
  check('T3 has no warm-up button, unlogged warm-ups go', !blk().querySelector('[data-act=addWarm]') && blk().querySelectorAll('.set.warm').length === 1);
  click(blk().querySelector('[data-act=removeBlock]'));
});

step('focused workouts from check-in and when a suggestion is thin', () => {
  click('[data-act=nav][data-tab=today]');
  if (q('[data-act=finish]')) { click('[data-act=finish]'); if (q('[data-act=finishNow]')) click('[data-act=finishNow]'); }
  check('focus buttons on check-in', qa('[data-act=focus]').length === 4);
  onlyAt('loc-basement');
  click('[data-k=minutes][data-v="60"]');
  click('[data-act=focus][data-r=lower][data-x="1"]');
  check('focused lower + explosive workout', /Lower body \+ explosive/i.test(q('.badge')?.innerText) && qa('section.block').length >= 4, text().slice(0, 300));
  check('explains how it was built', /How this was built/.test(text()));
  click('[data-act=recheck]');
  // Short on goals: an incline-only goal list leaves most of the hour empty.
  const saved = state.slots;
  state.slots = state.slots.filter(x => x.familyId === 'fam-incline');
  click('[data-k=minutes][data-v="60"]');
  click('[data-k=lean][data-v=lower]');
  check('lean picked', q('[data-k=lean][data-v=lower]').classList.contains('on'));
  check('focused workouts for the lean come first', q('[data-act=focus]').dataset.r === 'lower' && qa('[data-act=focus].lean').every(b => b.dataset.r === 'lower') && qa('[data-act=focus].lean').length === 2);
  click('[data-act=suggest]');
  check('thin suggestion offers a focused workout', !!q('.focusoffer [data-act=focus]'), text().slice(0, 300));
  check('the offer leads with the lean too', q('.focusoffer [data-act=focus]').dataset.r === 'lower' && q('.focusoffer [data-act=focus]').classList.contains('lean'));
  check('and fills the hour from the library anyway', qa('section.block').length >= 5 && Number(/est (\d+) min/.exec(text())?.[1]) >= 50 && /leaning lower/.test(text()), text().slice(0, 300));
  check('says how the rest was filled', qa('details.why').some(d => /rest is from your library, leaning lower-body/.test(d.textContent)));
  click('.focusoffer [data-act=focus][data-r=upper]');
  check('replaced with an upper workout', /Upper body/i.test(q('.badge')?.innerText) && qa('section.block').length >= 4 && !q('.focusoffer'));
  click('[data-act=moreTime]');
  click('[data-act=addTime][data-v="15"]');
  check('+ Time adds accessories to a focused workout', qa('section.block').length >= 5);
  state.slots = saved;
  click('[data-act=recheck]');
  click('[data-k=lean][data-v=either]');
});

step('Air Alert 2: optional, started from Plans, one day per finished session', () => {
  click('[data-act=nav][data-tab=today]');
  if (q('[data-act=finish]')) { click('[data-act=finish]'); if (q('[data-act=finishNow]')) click('[data-act=finishNow]'); }
  check('not on check-in', !q('[data-act=progOpen][data-id=aa2]'));
  click('[data-act=nav][data-tab=plans]');
  check('offered under Plans, not started', !!q('[data-act=progOpen][data-id=aa2]') && !q('[data-act=progSession]'));
  click('[data-act=progOpen][data-id=aa2]');
  check('program page with the 12-week chart', /Air Alert 2/.test(text()) && qa('.progchart tbody tr').length === 12 && /1×1200/.test(text()));
  setVal(q('[data-vert="aa2|1"]'), '24');
  check('a vertical can be logged before starting', state.programs.aa2?.verticals?.[0]?.value === 24);
  click('[data-act=progStart][data-id=aa2]');
  check('week 1 is highlighted', q('.progchart tr.cur th')?.textContent === '1');
  click('[data-act=progSession][data-id=aa2]');
  check('session with the week 1 dose', /Jump program/.test(text()) && /week 1, day 1/.test(text()) && qa('section.block.mob').length === 5 && /2 × 25/.test(text()), text().slice(0, 300));
  check('rows prefilled with the reps', q('section.block.mob input[data-f=reps]')?.value === '25');
  click(q('section.block.mob [data-act=mcheck]'));
  click('[data-act=mobFinish]');
  check('finishing moves to day 2', state.programs.aa2.week === 1 && state.programs.aa2.day === 2, JSON.stringify(state.programs.aa2));
  check('check-in shows done today', /Done today/.test(text()), text().slice(0, 500));
  click('[data-act=nav][data-tab=plans]');
  check('the Plans card shows the next day', /week 1 of 12, day 2 of 5/.test(text()) && /Done today ✓/.test(text()), text().slice(0, 500));
  click('[data-act=nav][data-tab=week]');
  check('week tab shows program days, not as mobility', /Air Alert 2/.test(text()) && /1 of 5 days this week/.test(text()));
  click('[data-act=histOpen]');
  check('history lists it', /Air Alert 2 · week 1, day 1/.test(text()) && /Leap ups/.test(text()));
  click('[data-act=nav][data-tab=plans]');
  click('[data-act=progOpen][data-id=aa2]');
  setVal(q('[data-progweek=aa2]'), '6');
  check('jump to a week', state.programs.aa2.week === 6 && state.programs.aa2.day === 1);
  click('[data-act=progStop][data-id=aa2]');
  click('[data-act=confirmYes]');
  check('stop keeps verticals', !!state.programs.aa2.stopped && state.programs.aa2.verticals.length === 1);
  click('[data-act=nav][data-tab=today]');
});

step('hold timer logs a timed set and starts the rest', () => {
  click('[data-act=nav][data-tab=today]');
  if (!q('[data-act=addEx]')) { onlyAt('loc-basement'); click('[data-act=suggest]'); }
  click('[data-act=addEx]');
  click('[data-act=addExPick][data-id=ex-sorensen]');
  // Do it on its own: an added T3 can join a superset, and then the rest waits for the end of the round.
  const ses = state.sessions.at(-1), sor = ses.blocks.find(b => b.exerciseId === 'ex-sorensen');
  for (const b of ses.blocks.filter(x => x === sor ? x.pairOf : x.pairOf === sor.id)) click(`[data-act=pairUnlink][data-b="${b.id}"]`);
  check('the hold is on its own', !sor.pairOf && !ses.blocks.some(x => x.pairOf === sor.id));
  const block = qa('section.block').find(b => /Sorensen hold/.test(b.querySelector('.bhead')?.innerText ?? ''));
  check('timed set has a start button', !!block?.querySelector('[data-act=workStart]'));
  const setId = block.querySelector('[data-act=workStart]').dataset.id;
  click(block.querySelector('[data-act=workStart]'));
  check('timer counts you in', /Get ready · Sorensen hold/.test(q('#timer').innerText), q('#timer').innerText);
  check('set row shows it is running', !!qa('section.block').find(b => /Sorensen hold/.test(b.querySelector('.bhead')?.innerText ?? ''))?.querySelector('.go.on'));
  const st = state.sets.find(x => x.id === setId);
  check('starts from 30s with no history', st.time === 30, String(st.time));
  state.timer.startedAt -= 7000; // 5s get-ready + 2s into the hold
  document.dispatchEvent(new Event('visibilitychange')); // runs a timer tick
  check('then the hold', /Go · Sorensen hold/.test(q('#timer').innerText), q('#timer').innerText);
  click('[data-act=workLog]');
  check('log now records the time held', st.done && st.time === 2, `${st.done} ${st.time}`);
  check('rest starts after the hold', state.timer && state.timer.kind !== 'work' && /Rest/.test(q('#timer').innerText));
  const next = state.sets.find(x => x.blockId === st.blockId && !x.done);
  check('the next set starts from that time', next?.time === 2, String(next?.time));
  click(qa('section.block').find(b => /Sorensen hold/.test(b.querySelector('.bhead')?.innerText ?? '')).querySelector('[data-act=workStart]'));
  state.timer.startedAt -= 60000;
  state.timer.endsAt -= 60000;
  document.dispatchEvent(new Event('visibilitychange'));
  check('running out logs the full hold', next.done && next.time === 2, `${next.done} ${next.time}`);
});

step('per-side mobility hold runs each side', () => {
  click('[data-act=mobPick][data-mode=workout]');
  click('[data-act=mobPart][data-v="Hip flexors"]');
  for (const b of qa('#sheet [data-act=mobTick]')) if (b.classList.contains('on')) click(b);
  click('#sheet [data-act=mobTick][data-id=mob-couch-stretch]');
  click('[data-act=mobAddPicked]');
  const go = q('[data-act=mworkStart]');
  check('mobility hold has a start button', !!go);
  click(go);
  check('per-side hold counts you in', /Get ready · Active couch stretch/.test(q('#timer').innerText), q('#timer').innerText);
  state.timer.startedAt -= 5000 + 45000 + 1000;
  document.dispatchEvent(new Event('visibilitychange'));
  check('switches sides', /Switch sides/.test(q('#timer').innerText), q('#timer').innerText);
  state.timer.startedAt -= 5000;
  document.dispatchEvent(new Event('visibilitychange'));
  check('then the right side', /Right side/.test(q('#timer').innerText), q('#timer').innerText);
  click('[data-act=workCancel]');
  check('cancel logs nothing', !q('#timer').innerText.trim() || !/Right side/.test(q('#timer').innerText));
  const couch = state.sessions.find(s => s.status === 'open')?.mobility?.find(it => it.exerciseId === 'mob-couch-stretch');
  check('mobility set not logged', couch && !couch.sets.some(x => x.done));
  click('[data-act=finish]');
  if (q('[data-act=finishNow]')) click('[data-act=finishNow]');
});

step('history lists logged workouts and searches by exercise', () => {
  click('[data-act=nav][data-tab=week]');
  click('[data-act=histOpen]');
  check('history page', /History/.test(text()) && qa('.card.hist').length > 0, text().slice(0, 300));
  check('timed sets shown with their times', /Sorensen hold/.test(text()) && /2s \(×2\)/.test(text()), text().slice(0, 600));
  const search = q('#histq');
  setVal(search, 'sorensen', 'input');
  check('search keeps matching sessions and exercises', /session with “sorensen”/.test(text()) && qa('.histex').every(r => /Sorensen/.test(r.innerText)), text().slice(0, 400));
  check('search box keeps focus', document.activeElement?.id === 'histq');
  setVal(q('#histq'), 'zzz', 'input');
  check('no matches message', /No sessions match/.test(text()));
  click('[data-act=histClose]');
  check('back to the week', /This week/.test(text()));
  click('[data-act=nav][data-tab=library]');
  click('[data-act=libEdit][data-id=ex-sorensen]');
  click('#sheet [data-act=exHist]');
  check('an exercise\'s history lists its sessions', /Sorensen hold/.test(sheet()) && /session/i.test(sheet()), sheet().slice(0, 200));
  click('#sheet [data-act=histOpen]');
  check('history from an exercise opens filtered', q('#histq')?.value === 'Sorensen hold' && !q('#sheet:not([hidden])'));
  click('[data-act=nav][data-tab=week]');
  check('leaving and coming back shows the week', /This week/.test(text()) && !q('#histq'));
});

step('deficit RDL goal on the week', () => {
  check('T2 deficit RDL goal listed', qa('.slotrow').some(r => /T2/.test(r.innerText) && /Deficit Romanian deadlift/.test(r.innerText)));
});

step('suggested goals need history first', () => {
  click('[data-act=nav][data-tab=week]');
  click('[data-act=gsOpen]');
  check('explains there is not enough history', /Not enough history yet/.test(text()));
  click('[data-act=gsCancel]');
});

step('FitNotes import screen is reachable', () => {
  click('[data-act=nav][data-tab=more]');
  click('[data-act=setPage][data-p=data]');
  check('import row on the data page', /Import from FitNotes/.test(text()));
  click('[data-act=setPage][data-p=fitnotes]');
  check('pick screen has bodyweight and file picker', !!q('[data-fnfile]') && !!q('#fn-bw'));
});

// With ?fitnotes=<url of a backup>, run the whole import through the screens, then undo it.
const fixture = new URLSearchParams(location.search).get('fitnotes');
const waitFor = async (cond, ms = 60000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 200));
  }
};
if (fixture) {
  try {
    q('#fn-bw').value = '235';
    const buf = await (await fetch(fixture)).arrayBuffer();
    const input = q('[data-fnfile]');
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'FitNotes_Backup.fitnotes'));
    input.files = dt.files;
    fire(input, 'change');
    await waitFor(() => !!q('[data-act=fnImport]') || !!q('.banner.bad'));
    check('review screen', !!q('[data-act=fnImport]'), text().slice(0, 300));
    check('review lists the active exercises', qa('.fnrow').length >= 30, String(qa('.fnrow').length));
    click(qa('[data-act=fnToggle]')[0]);
    check('a row opens with its controls', !!q('.fnedit select[data-k=target]'));
    out.push(['INFO', `review: ${qa('.fnrow').slice(0, 12).map(r => r.querySelector('.menurow').innerText.replace(/\n+/g, ' / ')).join(' || ')}`]);
    click('[data-act=fnImport]');
    await waitFor(() => /Estimated maxes/.test(text()), 20000);
    check('summary screen', /Imported/.test(text()));
    out.push(['INFO', `summary: ${q('#app').innerText.replace(/\n+/g, ' | ').slice(0, 1400)}`]);
    click('[data-act=gsOpen]');
    check('goal suggestions from the imported history', /Suggested goals/.test(text()) && qa('.gsline').length >= 5, String(qa('.gsline').length));
    out.push(['INFO', `goals: ${qa('.gsline').map(r => r.innerText.replace(/\n+/g, ' / ')).join(' || ')}`]);
    click(qa('[data-act=gsToggle]')[0]);
    const quota = () => q('.fnedit .stepper span')?.textContent;
    const q0 = quota();
    click('.fnedit [data-act=gsStep][data-d="1"]');
    check('a goal can be changed before applying', Number(quota()) === Number(q0) + 1, `${q0} -> ${quota()}`);
    click('[data-act=gsApply][data-mode=replace]');
    check('goals replaced', /Goals updated/.test(text()) && /Clean variations/.test(text()) && !/Incline press/.test(text()));
    click('[data-act=gsUndo]');
    check('undo brings the old goals back', /Incline press/.test(text()) && !/Goals updated/.test(text()));
    click('[data-act=nav][data-tab=library]');
    check('imported exercises in the Library', /Block Power Clean/.test(text()));
    click('[data-act=nav][data-tab=more]');
    click('[data-act=setPage][data-p=data]');
    click('[data-act=fnUndo]');
    click('[data-act=confirmYes]');
    click('[data-act=nav][data-tab=library]');
    check('undo takes the import back out', !/Block Power Clean/.test(text()));
  } catch (e) {
    check('FitNotes import flow', false, e.message);
  }
}

check('no uncaught errors', errors.length === 0, errors.join(' | '));
wipe();


step('set up again: locations, week, lifts, maxes, review, save and undo', () => {
  click('[data-act=nav][data-tab=more]');
  click('[data-act=setupAgain]');
  check('starts at about you', /About you/.test(text()));
  click('[data-act=obSet][data-k=unit][data-v=lb]');
  setVal(q('[data-ob=bodyweight]'), '210');
  click('[data-act=obNext]');
  check('locations', /Where you train/.test(text()) && qa('[data-act=obEq]').length > 5);
  click('[data-act=obLocAdd]');
  setVal(q('[data-ob="loc.2.name"]'), 'Hotel');
  click('[data-act=obEq][data-i="2"][data-eq=dumbbells]');
  click('[data-act=obNext]');
  setVal(q('[data-ob="week.workouts"]'), '5'); setVal(q('[data-ob="week.minutes"]'), '60');
  click('[data-act=obNext]');
  check('heavy lifts prefilled from current goals', /Heavy lifts/.test(text()) && qa('[data-act=obToggle][data-k=t1].on').length === 2);
  click('[data-act=obToggle][data-k=t1][data-id=gs-bench-press]');
  check('a third heavy lift', qa('[data-act=obToggle][data-k=t1].on').length === 3);
  // Adding your own lift right from the step picks it.
  click('[data-act=quickAdd][data-from=ob]');
  q('#qa-name').value = 'Pin press';
  for (const eq of ['barbell', 'rack']) q(`input[name="qa-eq"][value="${eq}"]`).checked = true;
  click('[data-act=qaSave]');
  const pin = state.exercises.find(e => e.name === 'Pin press');
  check('an exercise added in setup is picked on that step', !!pin && pin.role === 'main' && !!q(`[data-act=obToggle][data-k=t1][data-id="${pin.id}"].on`), text().slice(0, 300));
  click(`[data-act=obToggle][data-k=t1][data-id="${pin.id}"]`); // and can be turned off like any other
  click('[data-act=obNext]');
  check('support step offers power work', /Support work/.test(text()) && !!q('[data-act=obToggle][data-k=power]'));
  click('[data-act=obNext]');
  click('[data-act=obToggle][data-k=pump][data-id=fam-calves]');
  click('[data-act=obNext]');
  check('maxes for the picked lifts', !!q('[data-ob="max.ex-back-squat"]'));
  setVal(q('[data-ob="max.ex-back-squat"]'), '350');
  click('[data-act=obNext]');
  check('review shows goals and the budget', /Your weekly goals/.test(text()) && /minutes a week|more than the/.test(text()) && qa('.slotrow').length > 5, text().slice(0, 400));
  const before = JSON.stringify(state.slots);
  click('[data-act=obFinish]');
  check('saved: goals, week, location, max', state.slots.some(sl => sl.exerciseId === 'gs-bench-press' && sl.tier === 'T1') && state.settings.week.workouts === 5
    && state.locations.some(l => l.name === 'Hotel' && l.equipment.includes('dumbbells')) && state.exercises.find(e => e.id === 'ex-back-squat').testedMax?.load === 350 && state.settings.bodyweight === 210);
  check('history untouched and back on Today', state.sets.length > 0 && /Undo/.test(text()));
  click('[data-act=setupUndo]');
  const now = store.state; // undo swaps in the saved copy as a new object
  check('undo restores the old goals', JSON.stringify(now.slots) === before && !now.locations.some(l => l.name === 'Hotel') && !/Undo/.test(text()));
});

step('editing a past workout from History', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=week]');
  click('[data-act=histOpen]');
  const edits = qa('[data-act=histEdit]');
  check('finished workouts offer Edit', edits.length > 0);
  const id = edits[0].dataset.id;
  const sess = () => st().sessions.find(x => x.id === id);
  const mine = () => st().sets.filter(x => x.sessionId === id && x.done);
  click(edits[0]);
  check('the editor opens with date, place and the exercises', /Edit workout/.test(text()) && !!q('#hist-date') && qa('.histedit').length > 0, text().slice(0, 200));
  // How long: typed in for a workout logged after the fact, shown in History; empty goes back to first set to last.
  setVal(q('#hist-dur'), '52');
  check('How long is saved on the workout', sess().durationMin === 52);
  click('[data-act=histEditDone]');
  check('and History shows it', new RegExp(`took 52 min|· 52 min`).test(text()), text().slice(0, 300));
  click(qa('[data-act=histEdit]').find(b => b.dataset.id === id));
  setVal(q('#hist-dur'), '');
  check('clearing it goes back to the logged times', sess().durationMin === undefined);
  // A value: type it and it is saved.
  const reps = q('.histedit [data-f=reps]') ?? q('.histedit [data-f=time]');
  const sid = reps.dataset.set;
  setVal(reps, '11');
  check('editing a number saves it', Number(st().sets.find(x => x.id === sid)[reps.dataset.f]) === 11);
  // A set: add, then delete and undo.
  const n0 = mine().length;
  click(q('.histedit [data-act=histAddSet]'));
  check('+ set adds one, copied from the last', mine().length === n0 + 1);
  click(qa('.histedit [data-act=histDelSet]').at(-1));
  check('deleting a set removes it', mine().length === n0);
  const undo = [...document.querySelectorAll('.toast button')].filter(x => x.textContent === 'Undo').at(-1);
  undo.click();
  check('Undo puts it back', mine().length === n0 + 1);
  click(qa('.histedit [data-act=histDelSet]').at(-1));
  // A tier change moves the whole exercise.
  const sel = q('.histedit select[data-hgtier]');
  const before = sel.value, other = before === 'T3' ? 'T2' : 'T3';
  setVal(sel, other);
  check('changing the tier changes its sets', mine().some(x => x.tier === other) && qa('.histedit select[data-hgtier]').some(x => x.value === other));
  // Another exercise, from the whole library.
  click('[data-act=histAddEx]');
  check('adding offers the whole library', /Add an exercise/.test(sheet()) && !!q('#sheet [data-act=addExPick][data-id=ex-dead-bug]'));
  const groups0 = qa('.histedit').length;
  click('#sheet [data-act=addExPick][data-id=ex-dead-bug]');
  check('the new exercise has a set to fill in', qa('.histedit').length === groups0 + 1 && mine().some(x => x.exerciseId === 'ex-dead-bug'));
  // Another day (keeping the time of day).
  const t0 = sess().firstSetAt ?? sess().checkinAt;
  const d = new Date(t0 - 3 * 864e5);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  setVal(q('#hist-date'), iso);
  check('moving the date shifts the workout by whole days', Math.abs((t0 - (sess().firstSetAt ?? sess().checkinAt)) - 3 * 864e5) < 3700e3 && sess().day === iso, `${sess().day} ${iso}`);
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const keep = sess().firstSetAt ?? sess().checkinAt;
  setVal(q('#hist-date'), future);
  check('a day that hasn\'t happened is refused', (sess().firstSetAt ?? sess().checkinAt) === keep);
  // Remove an exercise, then the whole workout; both undo.
  const g0 = qa('.histedit').length;
  click(q('.histedit [data-act=histDelGroup]'));
  check('removing an exercise takes its sets', qa('.histedit').length === g0 - 1);
  [...document.querySelectorAll('.toast button')].filter(x => x.textContent === 'Undo').at(-1).click();
  check('and Undo brings it back', qa('.histedit').length === g0);
  const total = mine().length;
  click('[data-act=histDeleteWorkout]');
  click('#sheet [data-act=confirmYes]');
  check('deleting the workout removes it and returns to History', !sess() && /History/.test(text()) && !q('#hist-date'));
  [...document.querySelectorAll('.toast button')].filter(x => x.textContent === 'Undo').at(-1).click();
  check('Undo restores the workout and its sets', !!sess() && mine().length === total);
  click('[data-act=nav][data-tab=today]');
});

step('taste: Learn from my swaps, Forget, favorites, Never suggest, and your usual swap', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=more]'); click('[data-act=setPage][data-p=you]');
  check('Settings has Learn from my swaps and a way to forget', /Learn from my swaps/.test(text()) && !!q('[data-act=tasteForget]'), text().slice(0, 300));
  const sw = q('input[data-bind="settings.learnTaste"]');
  check('learning is on by default', sw.checked && st().settings.learnTaste !== false);
  sw.checked = false; fire(sw, 'change');
  check('the switch turns it off', st().settings.learnTaste === false);
  sw.checked = true; fire(sw, 'change');
  click('[data-act=tasteForget]');
  check('Forget asks first', /Forget what it learned/.test(sheet()));
  click('#sheet [data-act=confirmYes]');
  check('and starts fresh from now', st().settings.tasteSince > Date.now() - 5000);
  st().settings.tasteSince = null;
  // The exercise editor.
  click('[data-act=nav][data-tab=library]');
  click('[data-act=libEdit][data-id=ex-leg-ext]');
  check('the editor has In suggestions', !!q('#ee-pref') && /Never suggest/.test(sheet()));
  setVal(q('#ee-pref'), 'never');
  click('#sheet [data-act=exSave]');
  check('Never suggest is saved on the exercise', st().exercises.find(e => e.id === 'ex-leg-ext').pref === 'never');
  click('[data-act=libEdit][data-id=ex-leg-ext]'); setVal(q('#ee-pref'), ''); click('#sheet [data-act=exSave]');
  check('and Normal clears it', !st().exercises.find(e => e.id === 'ex-leg-ext').pref);
  // The swap sheet: your usual first, and Never suggest the one you're swapping away from.
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  click('[data-act=suggest]');
  const sess = st().sessions.filter(x => x.status === 'open').at(-1);
  const block = sess.blocks.find(b => b.tier === 'T3') ?? sess.blocks.at(-1);
  const cur = st().exercises.find(e => e.id === block.exerciseId);
  const alts = L.alternatives(st(), cur, st().locations.find(l => l.id === sess.locationId));
  check('the block has other family members to swap to', alts.length >= 2, cur.name);
  const usual = alts.at(-1); // not the closest one, so "your usual first" is visible
  for (let i = 0; i < 2; i++) block.swaps.push({ type: 'exercise', from: cur.id, to: usual.id, reason: null, at: Date.now() - 1000 });
  store.save();
  click(`[data-act=swapEx][data-b="${block.id}"]`);
  const first = q('#sheet [data-act=pickEx]');
  check('your usual replacement is listed first, marked', first?.dataset.id === usual.id && /your usual \(2×\)/.test(first.innerText), first?.innerText);
  click(`#sheet [data-act=tastePref][data-id="${cur.id}"]`);
  check('Never suggest the exercise you are swapping away from', st().exercises.find(e => e.id === cur.id).pref === 'never');
  check('and the sheet offers to undo it', new RegExp(`Suggest ${cur.name.replace(/[()+.]/g, '.')} again`).test(sheet()));
  click(`#sheet [data-act=tastePref][data-id="${cur.id}"]`);
  check('tapping again clears it', !st().exercises.find(e => e.id === cur.id).pref);
  click('#sheet [data-act=sheetClose]');
  // Removing an unlogged suggested exercise leaves a vote against it.
  const victim = sess.blocks.find(b => !(b.swaps || []).length && !st().sets.some(x => x.blockId === b.id && x.done));
  click(`[data-act=removeBlock][data-b="${victim.id}"]`);
  const rec = (sess.removed ?? []).at(-1);
  check('a removal is recorded as a suggested one', rec?.exerciseId === victim.exerciseId && rec.wasSuggested === true, JSON.stringify(sess.removed));
  [...document.querySelectorAll('.toast button')].filter(x => x.textContent === 'Undo').at(-1).click();
  check('and Undo takes the vote back too', !(sess.removed ?? []).some(r => r.exerciseId === victim.exerciseId));
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
});

step('pace: History shows planned and actual minutes; Settings shows the learned changeover; estimates say your pace', () => {
  const st = () => store.state;
  const M = 6e4, added = [];
  for (const d of [3, 4, 5]) {
    const sid = `pace-${d}`, start = Date.now() - d * 864e5;
    const blocks = [['ex-front-squat', 'T1', 's-t1-5x3', 5], ['ex-db-curl', 'T3', 's-t3-3x15', 3], ['ex-db-oh-tri', 'T3', 's-t3-3x15', 3]]
      .map(([exerciseId, tier, schemeId, n], i) => ({ id: `${sid}-b${i}`, tier, exerciseId, schemeId, swaps: [], n }));
    let t = start;
    for (const b of blocks) {
      for (let k = 0; k < b.n; k++) { st().sets.push({ id: `${b.id}-${k}`, sessionId: sid, blockId: b.id, exerciseId: b.exerciseId, tier: b.tier, reps: 5, load: 100, done: true, loggedAt: t }); t += 3 * M; }
      t += 4 * M; // the last set's 3 minutes, then 4 to the next exercise (T3s: no warm-up)
      delete b.n;
    }
    st().sessions.push({ id: sid, day: L.dayKey(start), status: 'done', source: 'suggested', locationId: 'loc-basement', minutes: 45, checkinAt: start - 600e3, firstSetAt: start, blocks, fatigue: 2, intent: 'auto' });
    added.push(sid);
  }
  store.save();
  click('[data-act=nav][data-tab=week]');
  click('[data-act=histOpen]');
  check('a finished workout shows planned and actual minutes', /planned 45 · took 38 min/.test(text()), text().slice(0, 500));
  click('[data-act=nav][data-tab=more]'); click('[data-act=setPage][data-p=you]');
  check('Settings shows the learned changeover', /Basement[\s\S]*4\.0 min changeover, from 3 workouts/.test(text()), text().slice(text().indexOf('Pace'), text().indexOf('Pace') + 300));
  const sw = q('input[data-bind="settings.learnPace"]');
  check('Use my pace is on by default', sw?.checked && st().settings.learnPace !== false);
  sw.checked = false; fire(sw, 'change');
  check('the switch turns it off', st().settings.learnPace === false && L.changeoverAt(st(), 'loc-basement') === 2);
  sw.checked = true; fire(sw, 'change');
  check('and back on', L.changeoverAt(st(), 'loc-basement') === 4);
  click('[data-act=paceReset]');
  check('Reset asks first', /Reset your pace/.test(sheet()));
  click('#sheet [data-act=sheetClose]');
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  click('[data-act=suggest]');
  check('the session estimate says it used your pace', /est \d+ min \(your pace\)/.test(text()), text().slice(0, 300));
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  st().sessions = st().sessions.filter(x => !added.includes(x.id));
  st().sets = st().sets.filter(x => !added.includes(x.sessionId));
  store.save();
});

step('weekly review: the Last week card, Review, Accept, Undo, Copy', () => {
  const st = () => store.state;
  const lastWeek = L.weekBounds(st(), L.weekBounds(st()).start - 864e5).start;
  const sid = 'review-last-week', at = lastWeek + 864e5 + 12 * 3600e3;
  const arms = L.familyMembers(st(), 'fam-arms')[0].id;
  st().sessions.push({ id: sid, day: L.dayKey(at), status: 'done', source: 'suggested', locationId: 'loc-basement', minutes: 45, checkinAt: at - 6e5, firstSetAt: at, blocks: [] });
  for (let i = 0; i < 3; i++) st().sets.push({ id: `${sid}-${i}`, sessionId: sid, blockId: null, exerciseId: arms, tier: 'T3', reps: 15, done: true, loggedAt: at + i * 6e4 });
  const dip = st().slots.find(sl => sl.familyId === 'fam-dip' && sl.tier === 'T2') ?? (st().slots.push({ id: 'sl-review-dip', familyId: 'fam-dip', tier: 'T2', quota: 1, priority: 2 }), st().slots.at(-1));
  // A goal naming an exercise whose gear is nowhere: the weighted-dip case.
  st().exercises.push({ ...st().exercises.find(e => e.id === 'ex-wdip'), id: 'ex-review-nogear', name: 'Moon dip', equipment: ['moon-rig'] });
  dip.exerciseId = 'ex-review-nogear';
  st().reviews = [];
  store.save();
  click('[data-act=nav][data-tab=week]');
  check('a new week shows the Last week card', !!q('.review-due') && /Last week/.test(q('.review-due').innerText) && /goal sessions/.test(q('.review-due').innerText), text().slice(0, 300));
  check('and Review this week is always there', !!q('[data-act=reviewOpen][data-w="' + L.weekBounds(st()).start + '"]'));
  click('.review-due [data-act=reviewOpen]');
  check('the review lists goals with done and why', /Week of/.test(text()) && /Goals/.test(text()) && /No location has the gear for it/.test(text()), text().slice(0, 600));
  const before = JSON.stringify(st().slots);
  const accept = q('[data-act=reviewAccept][data-id^="gear:"]');
  check('the weighted-dip goal has a Can’t be done fix to accept', !!accept && /no location has the gear/.test(accept.closest('.proposal').innerText), text().slice(-800));
  click(accept);
  check('Accept changes the goal', JSON.stringify(st().slots) !== before && st().slots.find(sl => sl.id === dip.id)?.exerciseId !== 'ex-review-nogear');
  check('and marks it accepted', /accepted/.test(text()));
  click('[data-act=reviewUndo]');
  check('Undo restores the goals exactly', JSON.stringify(st().slots) === before);
  check('and the proposal is open again', !!q('[data-act=reviewAccept][data-id^="gear:"]'));
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); // no clipboard: the sheet to copy from
  click('[data-act=reviewCopy]');
  delete navigator.clipboard;
  check('Copy review gives the text to copy', /Goals:/.test(q('#review-text')?.value ?? '') && /Goal sessions: \d+ of \d+/.test(q('#review-text').value), q('#review-text')?.value);
  if (q('#sheet:not([hidden])')) click('#sheet [data-act=sheetClose]');
  click('[data-act=reviewClose]');
  check('once reviewed, the Last week card is gone', !q('.review-due'));
  // A skipped proposal stays skipped; Dismiss hides an unreviewed week's card.
  st().reviews = []; store.save();
  click('[data-act=nav][data-tab=week]');
  click('.review-due [data-act=reviewDismiss]');
  check('Dismiss hides the card', !q('.review-due'));
  st().sessions = st().sessions.filter(x => x.id !== sid);
  st().sets = st().sets.filter(x => x.sessionId !== sid);
  delete dip.exerciseId;
  st().exercises = st().exercises.filter(e => e.id !== 'ex-review-nogear');
  st().reviews = [];
  store.save();
  click('[data-act=nav][data-tab=today]');
});

step('check-in at several locations', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  click('[data-act=ciLoc][data-v=loc-office]');
  check('both locations are on', qa('[data-act=ciLoc].on').length === 2);
  click('[data-act=ciLoc][data-v=loc-basement]'); click('[data-act=ciLoc][data-v=loc-office]');
  check('the last one stays on', qa('[data-act=ciLoc].on').length === 1 && q('[data-act=ciLoc].on').dataset.v === 'loc-office');
  click('[data-act=ciLoc][data-v=loc-basement]');
  click('[data-act=suggest]');
  const sess = st().sessions.filter(x => x.status === 'open').at(-1);
  check('the workout keeps both, the first picked as the main one', JSON.stringify(sess.locationIds) === '["loc-office","loc-basement"]' && sess.locationId === 'loc-office');
  check('the header names both', /Office \+ Basement/.test(text()), text().slice(0, 200));
  const away = sess.blocks.map(b => st().exercises.find(e => e.id === b.exerciseId)).find(e => L.elsewhere(e, L.placeOf(st(), sess)));
  check('an exercise only one place has says where', !away || /at Basement/.test(text()));
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  onlyAt('loc-basement');
});

step('skip a category today: nothing from it is suggested', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  const fam = st().slots.find(sl => sl.quota > 0 && sl.tier === 'T3')?.familyId;
  check('check-in offers Skip today with your goal categories', !!q('[data-skip]') && !!q(`[data-act=ciSkip][data-v="${fam}"]`));
  click(`[data-act=ciSkip][data-v="${fam}"]`);
  check('tapping one skips it', q(`[data-act=ciSkip][data-v="${fam}"]`).classList.contains('on') && /Skip today: /.test(q('[data-skip] summary').innerText));
  click('[data-act=suggest]');
  const sess = st().sessions.filter(x => x.status === 'open').at(-1);
  check('no block from it', !sess.blocks.some(b => st().exercises.find(e => e.id === b.exerciseId)?.familyId === fam));
  check('the header says what is skipped', /Skipping today:/.test(text()));
  click('[data-act=moreTime]');
  if (q('#sheet [data-act=moreTimeGo]')) click('#sheet [data-act=moreTimeGo]');
  check('+ Time keeps skipping it', !sess.blocks.some(b => st().exercises.find(e => e.id === b.exerciseId)?.familyId === fam));
  if (q('#sheet:not([hidden])')) click('#sheet [data-act=sheetClose]');
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  click(`[data-act=ciSkip][data-v="${fam}"]`);
  check('tap again to un-skip', !(store.state && q(`[data-act=ciSkip][data-v="${fam}"]`).classList.contains('on')));
});

step('conditioning: Add conditioning, an EMOM on the bike, the EMOM clock', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  const box = q('input[data-ci-cond]');
  check('check-in has Add conditioning, off by default', !!box && !box.checked);
  box.checked = true; fire(box, 'change');
  click('[data-act=suggest]');
  const sess = st().sessions.filter(x => x.status === 'open').at(-1);
  const b = sess.blocks.find(x => x.tier === 'COND');
  check('the workout has one conditioning block, last', !!b && sess.blocks.filter(x => x.tier === 'COND').length === 1 && [...document.querySelectorAll('section.block .tier')].at(-1)?.textContent.startsWith('COND'));
  const card = [...document.querySelectorAll('section.block')].find(x => x.querySelector(`[data-b="${b.id}"]`));
  check('in calories, every minute', /cal/.test(card.innerText) && /every \d:\d\d/.test(card.innerText) && /EMOM/.test(card.innerText), card.innerText.slice(0, 300));
  const sc = st().schemes.find(x => x.id === b.schemeId);
  click(card.querySelector('[data-act=emomStart]'));
  check('Start EMOM runs the clock to round 2', Math.abs(st().timer.endsAt - Date.now() - sc.emom * 1000) < 2000 && /round 2/.test(st().timer.next));
  const card2 = [...document.querySelectorAll('section.block')].find(x => x.querySelector(`[data-b="${b.id}"]`));
  click(card2.querySelector('[data-act=check]'));
  check('logging round 1 keeps the clock: the rest ends when round 2 starts', Math.abs(st().timer.endsAt - (b.emomStart + sc.emom * 1000)) < 1500, `${st().timer.endsAt - b.emomStart}`);
  if (sc.ramp) check('a ladder adds a calorie each round', st().sets.filter(x => x.blockId === b.id).map(x => x.reps).join() === Array.from({ length: sc.sets }, (_, i) => sc.reps + i * sc.ramp).join());
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  const box2 = q('input[data-ci-cond]'); box2.checked = false; fire(box2, 'change');
  st().timer = null;
});

step('conditioning supersets: the bike is the superset idea for the first T1 and T2', () => {
  const st = () => store.state;
  click('[data-act=nav][data-tab=today]');
  onlyAt('loc-basement');
  click('[data-k=minutes][data-v="90"]');
  const box = q('input[data-ci-condpair]');
  check('check-in has Conditioning supersets, off by default', !!box && !box.checked);
  box.checked = true; fire(box, 'change');
  click('[data-act=suggest]');
  const sess = st().sessions.filter(x => x.status === 'open').at(-1);
  const ideaFor = b => [...document.querySelectorAll('.pairidea')].find(x => x.querySelector(`[data-act=pairAdd][data-b="${b.id}"]`));
  const t1 = sess.blocks.find(b => b.tier === 'T1'), t2s = sess.blocks.filter(b => b.tier === 'T2' && !sess.blocks.some(x => x.pairOf === b.id));
  check('the workout has a T1 and a T2', !!t1 && t2s.length > 0, sess.blocks.map(b => b.tier).join());
  check('the first T1 gets the bike', /Assault bike/.test(ideaFor(t1)?.innerText ?? '') && /COND/.test(ideaFor(t1).innerText), ideaFor(t1)?.innerText);
  const order = [...document.querySelectorAll('[data-act=pairAdd]')].map(x => x.dataset.b);
  const firstT2 = sess.blocks.filter(b => b.tier === 'T2').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).find(b => ideaFor(b));
  check('the first T2 gets the bike', firstT2 && /Assault bike/.test(ideaFor(firstT2).innerText));
  const later = sess.blocks.filter(b => b.tier === 'T2' && b !== firstT2 && ideaFor(b));
  check('later T2s get the usual ideas', later.every(b => !/Assault bike/.test(ideaFor(b).innerText)));
  click(ideaFor(t1).querySelector('[data-act=pairAdd]'));
  const nb = sess.blocks.find(b => b.pairOf === t1.id);
  const sets = st().sets.filter(x => x.blockId === nb?.id);
  check('+ Add pairs a bike round with each T1 set', nb?.tier === 'COND' && nb.exerciseId === 'ex-assault-bike'
    && sets.length === st().schemes.find(x => x.id === t1.schemeId).sets && sets.every(x => x.reps === 8), JSON.stringify(nb));
  check('shown as a superset in the rest', /Superset with/.test(text()));
  click('[data-act=finish]');
  if (q('#sheet [data-act=finishNow]')) click('#sheet [data-act=finishNow]');
  const box2 = q('input[data-ci-condpair]'); box2.checked = false; fire(box2, 'change');
  click('[data-k=minutes][data-v="45"]');
});

// ---------- backup and data (async: the second copy lives in IndexedDB) ----------
const tick = ms => new Promise(r => setTimeout(r, ms));
const V = await import('./vault.js');
try {
  const st = () => store.state;
  click('[data-act=nav][data-tab=today]');
  // The reminder: three finished workouts and no backup off the device.
  st().settings.lastExportAt = null; st().settings.backupSnoozeUntil = null;
  while (st().sessions.filter(x => x.status === 'done' && x.firstSetAt).length < 3) st().sessions.push({ id: L.uid(), status: 'done', firstSetAt: Date.now() - 1000, checkinAt: Date.now() - 2000, blocks: [], source: 'suggested' });
  click('[data-act=nav][data-tab=more]'); click('[data-act=nav][data-tab=today]');
  check('the backup reminder shows after 3 workouts', /Save backup/.test(text()) && /Not now/.test(text()), text().slice(0, 300));
  click('[data-act=backupSnooze]');
  check('Not now hides it for 3 days', !/Not now/.test(text()) && st().settings.backupSnoozeUntil > Date.now() + 2.9 * 864e5);

  click('[data-act=nav][data-tab=more]');
  click('[data-act=setPage][data-p=data]');
  await tick(400);
  check('Backup and data shows the three status lines', /Protected from automatic clearing/.test(text()) && /Copy on this device/.test(text()) && /Last backup off this device\s*Never/.test(text()), text().slice(0, 500));
  check('the copy on this device is reported', /Saved (just now|\d+ min ago)/.test(text()) || /Not saved yet/.test(text()), text().slice(0, 400));

  // Snapshots: take one by hand, change something, go back to it, and undo.
  st().settings.bodyweight = 201; store.save();
  await store.snapshotNow('before-import');
  await tick(300);
  st().settings.bodyweight = 250; store.save();
  click('[data-act=nav][data-tab=more]'); click('[data-act=setPage][data-p=data]');
  await tick(500);
  const rows = qa('[data-act=vaultRestore]');
  check('saved copies are listed', rows.length >= 1 && rows.some(r => /before an import/.test(r.innerText)), qa('.menu').map(m => m.innerText).join(' | ').slice(0, 400));
  click(rows.find(r => /before an import/.test(r.innerText)));
  await tick(300);
  check('restoring asks first', /Go back to/.test(sheet()) && /Restore/.test(sheet()), sheet().slice(0, 200));
  click('#sheet [data-act=confirmYes]');
  check('restoring puts that copy back', st().settings.bodyweight === 201);
  const undo = [...document.querySelectorAll('.toast button')].filter(x => x.textContent === 'Undo').at(-1); // the newest toast's
  check('and offers Undo', !!undo);
  undo?.click();
  check('Undo brings back what was there', st().settings.bodyweight === 250);
  await tick(300);
  check('a snapshot was taken before the restore', (await V.list()).some(r => r.reason === 'before-restore'));

  // Save backup: the share sheet when the browser offers one, else a download. Only a finished one counts.
  const canShare = Object.getOwnPropertyDescriptor(navigator, 'canShare'), share = Object.getOwnPropertyDescriptor(navigator, 'share');
  const stub = (k, v) => Object.defineProperty(navigator, k, { value: v, configurable: true, writable: true });
  st().settings.lastExportAt = null;
  stub('canShare', () => true); stub('share', async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); });
  click('[data-act=nav][data-tab=more]'); click('[data-act=setPage][data-p=data]');
  click('[data-act=saveBackup]'); await tick(200);
  check('a cancelled share is not a backup', st().settings.lastExportAt == null);
  let shared = null;
  stub('share', async data => { shared = data; });
  click('[data-act=saveBackup]'); await tick(200);
  check('a finished share is a backup, named by date', st().settings.lastExportAt > Date.now() - 5000 && /^fitness-backup-\d{4}-\d\d-\d\d\.json$/.test(shared?.files?.[0]?.name ?? ''), shared?.files?.[0]?.name);
  st().settings.lastExportAt = null;
  stub('canShare', undefined);
  click('[data-act=saveBackup]'); await tick(200);
  check('without a share sheet it downloads, and that counts', st().settings.lastExportAt > Date.now() - 5000);
  for (const [k, d] of [['canShare', canShare], ['share', share]]) { if (d) Object.defineProperty(navigator, k, d); else delete navigator[k]; }
  await store.flushVault();
} catch (e) {
  out.push(['FAIL', `backup and data — ${e.message}`]);
}

// ---------- getting updates ----------
try {
  click('[data-act=nav][data-tab=today]'); click('[data-act=nav][data-tab=more]');
  check('Settings has a way to get the latest version', !!q('[data-act=refreshApp]') && /Get the latest version/.test(text()));
  check('no update banner at first', !q('[data-act=reloadApp]'));
  if (navigator.serviceWorker) {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'update-ready' } }));
    check('a newer version arriving shows a Reload banner', !!q('[data-act=reloadApp]') && /newer version of the app is ready/.test(text()), text().slice(0, 200));
  }
} catch (e) {
  out.push(['FAIL', `updates — ${e.message}`]);
}

// ---------- the account (the fake Supabase stands in for the server) ----------
const { installFake } = await import('./fake-supabase.js');
const fake = installFake();
try {
  const st = () => store.state;
  const Cloud = await import('./cloud.js');
  const page = async () => { click('[data-act=nav][data-tab=today]'); click('[data-act=nav][data-tab=more]'); click('[data-act=setPage][data-p=data]'); await tick(300); };
  Cloud.reset();
  await page();
  check('the account section offers a password sign-in', /back up to your account/i.test(text()) && !!q('#cloud-email') && !!q('#cloud-password') && !!q('[data-act=cloudPassword][data-m=in]') && !!q('[data-act=cloudPassword][data-m=up]'), text().slice(0, 300));
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'secret12', 'input');
  click('[data-act=cloudPassword][data-m=in]'); await tick(300);
  check('signing in before there is an account says so', /don.t match/.test(text()) && !Cloud.signedIn(), text().slice(0, 300));
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'abc', 'input');
  click('[data-act=cloudPassword][data-m=up]'); await tick(100);
  check('a short password is refused before anything is sent', !Cloud.signedIn() && fake.passwords.size === 0);
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'secret12', 'input');
  click('[data-act=cloudPassword][data-m=up]'); await tick(900);
  check('Create account signs in and the first sync uploads', Cloud.signedIn() && /Signed in as\s*me@example\.com/.test(text()) && fake.row('me@example.com')?.rev === 1, text().slice(0, 300));
  check('the account holds the data', fake.row('me@example.com').data.sets.length === st().sets.length && /Synced\s*(just now|\d+ min ago)/.test(text()), text().slice(0, 400));
  // The emailed link and code still work for anyone who prefers them.
  click('[data-act=cloudSignOut]'); await tick(200);
  click('#sheet [data-act=confirmYes]'); await tick(400);
  click('[data-act=cloudMode][data-m=link]');
  setVal(q('#cloud-email'), 'other@example.com', 'input');
  click('[data-act=cloudSend]'); await tick(300);
  check('the link path shows a code field naming the address', !!q('#cloud-code') && /other@example\.com/.test(text()), text().slice(0, 300));
  setVal(q('#cloud-code'), '000000', 'input');
  click('[data-act=cloudVerify]'); await tick(300);
  check('a wrong code says so', /code didn.t work/.test(text()) && !Cloud.signedIn(), text().slice(0, 300));
  click('[data-act=cloudChange]'); await tick(100); // back to the password form
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'wrong-one', 'input');
  click('[data-act=cloudPassword][data-m=in]'); await tick(300);
  check('a wrong password says so', /don.t match/.test(text()) && !Cloud.signedIn(), text().slice(0, 300));
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'secret12', 'input');
  const sessionsBefore = st().sessions.length;
  click('[data-act=cloudPassword][data-m=in]'); await tick(1200);
  check('signing back in asks what to do with the account\'s backup', /Your account has a backup/.test(sheet()), sheet().slice(0, 200) + text().slice(0, 200));
  click('#sheet [data-act=cloudChoose][data-c=merge]'); await tick(1200);
  check('Merge both finishes and signs in', Cloud.signedIn() && st().sessions.length >= sessionsBefore && !q('#sheet:not([hidden])'));

  // The other device saves: Sync now brings it in.
  const theirs = structuredClone(fake.row('me@example.com').data);
  theirs.sessions.push({ id: 'phone-session', status: 'done', firstSetAt: Date.now(), checkinAt: Date.now(), blocks: [] }); theirs.savedAt = Date.now() + 10;
  fake.putRow('me@example.com', theirs);
  click('[data-act=cloudSync]'); await tick(900);
  check('Sync now brings the other device\'s workout in', st().sessions.some(x => x.id === 'phone-session') && fake.row('me@example.com').rev >= 2, `rev ${fake.row('me@example.com').rev}`);
  check('and says so', [...document.querySelectorAll('.toast')].some(t => /other device/.test(t.textContent)));

  // Signing out keeps the data; signing back in asks before touching anything.
  click('[data-act=cloudSignOut]'); await tick(200);
  click('#sheet [data-act=confirmYes]'); await tick(500);
  check('signing out brings the sign-in form back and keeps the data', !!q('#cloud-email') && !Cloud.signedIn() && st().sessions.some(x => x.id === 'phone-session'));
  setVal(q('#cloud-email'), 'me@example.com', 'input'); setVal(q('#cloud-password'), 'secret12', 'input');
  const sessionsHere = st().sessions.length;
  click('[data-act=cloudPassword][data-m=in]'); await tick(1200);
  check('signing back in asks what to do with the account\'s backup', /Your account has a backup/.test(sheet()) && !!q('#sheet [data-act=cloudChoose][data-c=merge]') && !!q('#sheet [data-act=cloudChoose][data-c=account]') && !!q('#sheet [data-act=cloudChoose][data-c=keep]'), sheet().slice(0, 300));
  check('and changes nothing yet', st().sessions.length === sessionsHere);
  click('#sheet [data-act=cloudChoose][data-c=merge]'); await tick(1200);
  check('Merge both finishes and syncs', !q('#sheet:not([hidden])') && Cloud.record().baseRev >= 3 && !/Choose what to do/.test(text()), `${Cloud.record().baseRev} ${text().slice(0, 200)}`);
  check('a saved copy of the account\'s backup was kept', (await V.list()).some(r => r.reason === 'cloud-copy'));
  click('[data-act=cloudSignOut]'); await tick(200);
  click('#sheet [data-act=confirmYes]'); await tick(400);
} catch (e) {
  out.push(['FAIL', `the account — ${e.message}`]);
} finally {
  fake.restore();
}

const fails = out.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${out.filter(r => r[0] === 'PASS').length} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = out.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
