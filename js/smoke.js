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
const step = (name, fn) => { try { fn(); } catch (e) { out.push(['FAIL', `${name} — ${e.message}`]); } };

const KEY = globalThis.AFP_STORAGE_KEY;
const wipe = () => Object.keys(localStorage).filter(k => k === KEY || k.startsWith(`${KEY}.`)).forEach(k => localStorage.removeItem(k));
wipe();
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
  click('[data-k=locationId][data-v=loc-basement]');
  click('[data-act=suggest]');
  check('session shows blocks', qa('section.block').length > 0);
  check('readiness line shown', /Fresh for power work/.test(text()), text().slice(0, 200));
  check('explosive block first', /Block|Power clean|Broad jump|Box jump|Depth jump|Jump/i.test(qa('section.block')[0].innerText), qa('section.block')[0].innerText.slice(0, 80));
  click('[data-act=finish]');
});

step('tired check-in gives technique', () => {
  click('[data-k=locationId][data-v=loc-basement]');
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
  click('[data-k=locationId][data-v=loc-basement]');
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
  click('[data-k=locationId][data-v=loc-basement]');
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
  check('check-in lists your mobility routines', /Day 1: Long & Strong/.test(text()) && qa('[data-act=mobStart]').length === 4);
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
  check('routine shows when it was last done', /Day 1: Long & Strong\s*4 exercises · last today/.test(text()), text().slice(0, 600));

  click('[data-k=locationId][data-v=loc-basement]');
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
  if (!q('[data-act=addEx]')) { click('[data-k=locationId][data-v=loc-basement]'); click('[data-act=suggest]'); }
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
  click('[data-k=locationId][data-v=loc-basement]');
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
  check('offered on check-in, not started', !!q('[data-act=progOpen][data-id=aa2]') && !q('[data-act=progSession]'));
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
  check('check-in card shows the next day and done today', /week 1 of 12, day 2 of 5/.test(text()) && /Done today/.test(text()), text().slice(0, 500));
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
  if (!q('[data-act=addEx]')) { click('[data-k=locationId][data-v=loc-basement]'); click('[data-act=suggest]'); }
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

const fails = out.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${out.filter(r => r[0] === 'PASS').length} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = out.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
