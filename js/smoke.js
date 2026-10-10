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
const { state } = await import('./store.js');
const L = await import('./logic.js');
await new Promise(r => setTimeout(r, 200));

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

step('supersets, real rest, pause and resume, more time', () => {
  check('energy scale: 5 is fresh', /Energy\s*1 wrecked · 5 fresh/i.test(text()), text().slice(0, 300));
  click('[data-k=locationId][data-v=loc-basement]');
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
  check('library mobility tab lists all 16', qa('[data-act=mobExEdit]').length === 16);
  click('[data-act=mobExNew]');
  q('#me-name').value = '90/90 hip switch';
  click('[data-act=mobExPart][data-v="Glutes"]');
  check('typed name survives picking a body part', q('#me-name').value === '90/90 hip switch');
  click('[data-act=mobExSave]');
  check('new mobility exercise saved', qa('[data-act=mobExEdit]').length === 17 && /90\/90 hip switch/.test(text()));
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
  click('[data-act=suggest]');
  check('thin suggestion offers a focused workout', !!q('.focusoffer [data-act=focus]'), text().slice(0, 300));
  click('.focusoffer [data-act=focus][data-r=upper]');
  check('replaced with an upper workout', /Upper body/i.test(q('.badge')?.innerText) && qa('section.block').length >= 4 && !q('.focusoffer'));
  click('[data-act=moreTime]');
  click('[data-act=addTime][data-v="15"]');
  check('+ Time adds accessories to a focused workout', qa('section.block').length >= 5);
  state.slots = saved;
  click('[data-act=recheck]');
});

step('hold timer logs a timed set and starts the rest', () => {
  click('[data-act=nav][data-tab=today]');
  if (!q('[data-act=addEx]')) { click('[data-k=locationId][data-v=loc-basement]'); click('[data-act=suggest]'); }
  click('[data-act=addEx]');
  click('[data-act=addExPick][data-id=ex-sorensen]');
  const block = qa('section.block').find(b => /Sorensen hold/.test(b.innerText));
  check('timed set has a start button', !!block?.querySelector('[data-act=workStart]'));
  const setId = block.querySelector('[data-act=workStart]').dataset.id;
  click(block.querySelector('[data-act=workStart]'));
  check('timer counts you in', /Get ready · Sorensen hold/.test(q('#timer').innerText), q('#timer').innerText);
  check('set row shows it is running', !!qa('section.block').find(b => /Sorensen hold/.test(b.innerText))?.querySelector('.go.on'));
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
  click(qa('section.block').find(b => /Sorensen hold/.test(b.innerText)).querySelector('[data-act=workStart]'));
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

const fails = out.filter(r => r[0] === 'FAIL').length;
document.getElementById('summary').textContent = `${out.filter(r => r[0] === 'PASS').length} passed, ${fails} failed`;
document.title = fails ? 'FAIL' : 'PASS';
document.getElementById('out').innerHTML = out.map(([k, n]) => `<div class="${k}">${k}  ${n.replace(/</g, '&lt;')}</div>`).join('');
