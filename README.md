# Adaptive Fitness Planner (Phase 1 prototype)

Single-page web app, no build step, no backend. All data lives in the browser's localStorage; back up from **Settings → Backup and data**.

## Run

```
python -m http.server 8765
```

Open http://localhost:8765. ES modules need to be served over HTTP; opening `index.html` as a file won't work.

To use it on your phone, host the folder on any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages), open it, and "Add to Home Screen" / "Install app". Data is stored per device and per URL, so pick one URL and stick with it.

After the first visit it works offline: `sw.js` fetches from the network first (so updates show up right away) and falls back to the cache when offline or when the network takes more than 2.5 s. When you change the file list, update `SHELL` in `sw.js`.

**Phone checklist once hosted:** install to home screen, check that it opens offline (airplane mode), Settings → Rest timer → *Test sound*, turn on *Notify when rest ends*, then *Test notification*, then start a rest and lock the phone.

## Layout

| File | Role |
|---|---|
| `js/seed.js` | Seed locations, families, exercises, schemes, slots, tier doses |
| `js/store.js` | Load/save/migrate the single JSON state blob |
| `js/logic.js` | Pure rules: estimated max, dose crediting, slot scoring, scheme/exercise choice |
| `js/app.js` | Views, bottom sheets, rest timer, event handling |
| `js/goals.js` | Suggested weekly goals from history (pure functions) |
| `js/fitnotes.js` | FitNotes import: reads a `.fitnotes` backup with sql.js, then plain functions plan and apply the import |
| `sw.js` | Offline cache and background rest-over notifications |
| `tests.html`, `smoke.html` | Rules tests and a UI smoke test. Open them in the browser. Each uses its own storage key, so they never touch real data. `smoke.html?fitnotes=<url of a backup>` also runs a full import through the screens and undoes it |

## Rule decisions not spelled out in the PRD

- **Urgency** = priority × remaining quota ÷ days left in the week (the PRD's "× days left" would make slots less urgent as the week ends).
- **Time budget** comes from scheme minutes plus warmup (T1 +3 min), not fixed 12/20/40 thresholds. With the seeded schemes, 12 min fits a T1, 20 fits T1+T2, and 40 adds T3.
- **Estimated max**: Epley, sets of 10 reps or fewer only, best of the last 3 sessions with T1/T2 work for that exercise (technique and pump sessions don't count, so they can't drag loads down). Falls back to an optional per-exercise *starting max*. Bodyweight moves add the bodyweight recorded with each set.
- **Target load** = e1RM × intensity for the scheme's reps-per-set (about 2 reps in reserve), clamped to the tier's range and rounded to the load increment. Swapping scheme or exercise recalculates it.
- **Slot credit**: sets auto-count when the exercise's family and the block's tier match a slot and, for T1/T2, the load is at least the tier's intensity floor × the pre-session e1RM. A slot earns one exposure per *day* whose counted sets meet the dose, so chunks across the day add up. Override any set in Week.
- **T1/T2 slots need a load × reps exercise at the location**, otherwise they're left out of the suggestion. Once any lift in a family has an estimated max, **T1 only uses lifts with one**, so a heavy squat goal waits for the barbell instead of becoming goblet squats at the Office (T2 can still use them).
- **Energy** = derived from fatigue and optional sleep. **"May split"** is a check-in toggle that favors many-set schemes.
- **Max reps per set** (optional, per exercise) is a hard filter on schemes. Seeded at 5 for clean variations.
- **Rest timer**: rest = today's per-block setting (tap ⏱ on a block) > per-exercise override > scheme default. Starts on set check-off (toggle in Settings), stored as an end timestamp so it survives reloads and backgrounding. Beeps at 10s left and at zero, vibrates on Android, and holds a screen wake lock during sessions.
- **Tiers follow GZCL for loaded lifts:** T1 85-100% in sets of 1-3 (10-15 reps), T2 65-85% (20-30 reps), T3 10+ reps a set (30+ total). All editable under Settings > Tier doses. T1 schemes are all sets of 1-3.
- **Explosive work and technique (athletic focus):** exercises can be flagged *explosive* (jumps, throws, Olympic lifts) and given a body *region* (lower, upper, whole body). Explosive work is **power** work when you're fresh: energy above 2.5 (fatigue 1-3; fatigue 3 with sleep 1 counts as tired) and no heavy T1 work in the same region since the start of yesterday. Explosive T1 work (cleans, jumps) doesn't count as heavy. Otherwise it becomes **technique** (the TECH tier): its own weekly goal, lower volume and load, never counted toward the power goal and never lowering an estimated max. Fresh days put explosive power blocks first; on tired or heavy days power goals wait (they aren't suggested) and technique goals get a boost. A power block that starts while not fresh offers a one-tap "Do it as technique".
- **Jumps** count by reps (contacts). A goal can set its own reps per session (the seeded jumps goal is 12-20). Explosive work prefers sets of 1-3 and never gets the high-energy volume bonus.
- **Anytime exercises** get a boost on short check-ins (20 min or less) and split days.
- **Energy** at check-in is 1 wrecked … 5 fresh, so it points the same way as Sleep (1 poor … 5 great). It's stored as fatigue = 6 − energy.
- **T3s always come grouped**: T3s superset with each other in twos (alternate sets, rest after each round); an odd one out joins an existing T3 pair as a giant set, else a free T1/T2/technique block it doesn't compete with. Supersets on T1/T2 are optional (the idea row and ↔ Superset). ↔ Superset can also add a block to an existing pair to make a giant set. Unlink to do one on its own.
- **Supersets**: each T1/T2/technique block offers one T3 idea to do in its rest (Add, Other, No thanks), or tap ↔ Superset to pair it with any block or exercise. Pairs follow movement patterns read from exercise and family names: upper body pairs with its antagonist (pull-ups with triceps or push-ups, dips and presses with curls, rows or face pulls); lower body with its complement (squats and lunges with hamstrings/hips, hinges with quads, calves with either); core fits anything. Explosive main lifts (jumps, cleans) only get core or upper-body partners so the legs stay fresh. Ideas need no barbell, skip families with their own T1/T2 goal, and prefer an open T3 goal, then exercises you've done in the last 12 weeks. T3 pairs and giant sets use the same matching. A partner set doesn't restart the main lift's rest timer; "next" alternates between the two. A partner counts half its minutes toward the time budget.
- **Pause and more time**: Finish with sets left offers *Pause for later*; the paused workout waits on the check-in screen with Resume (paused workouts close at the end of the day like open ones). *+ Time* in the session header adds goal work that fits the extra minutes, from families not already in the workout.
- **Real rest** = time since the same block's previous set minus roughly the set's work (3 s a rep, or the set's time); gaps over 15 minutes count as breaks. Shown per block, for the session, in the finish message and in "Done today", next to the planned rest.
- **Timed and distance sets** (holds, sprints) count as one rep each toward a goal.
- **Freak Athlete Hyper Pro** (with its GHD pad and the Leg Developer attachment) movements are in the library as accessory work, needing the `hyper-pro` / `leg-developer` gear, which starts at the Basement: Nordic curl, glute-ham raise, seated and lying leg curl, back extension (45° and 90°), reverse hyper, hip thrust, Sorensen hold, belt squat, leg extension, reverse Nordic, calf raise, GHD sit-up and Trap 3 raise. Upgrading existing data reuses families and exercises you already have by the same name.
- **Archived exercises** stay in history but are left out of suggestions, swaps and pickers (Library → Show archived).
- Week starts Monday by default. Sleep is 1–5, stored as a number.

## Data safety

- If saved data can't be opened (for example an upgrade step fails), the app keeps it untouched, pauses saving, and shows a message with **Copy the saved data** and **Start fresh**. It never saves the starter data over it.
- If a save fails (storage full or blocked), a message stays at the top of every tab until a save succeeds.
- The FitNotes import takes a snapshot first; **Backup and data → Undo last import** puts it back.

## Mobility

Mobility lives outside the strength framework: its own exercises, routines and sessions (`js/mobility.js`), with no tiers, weekly goals or estimated maxes, and it never counts toward strength goals.

- **Exercises** have body parts (Hamstrings, Hip flexors, Adductors, Glutes, Quads & knees, Calves & ankles, Spine, Thoracic, Shoulders, Lats), a dose (sets × reps or hold, ranges, each side, tempo), rest, what to log per set (reps, hold time, load, and one custom field such as "Deficit (cm)" or "Knee-to-floor (cm)"), cues, a YouTube search phrase and history notes. Add and edit them in Library → Mobility.
- **Routines** (Plans tab) are ordered lists of mobility exercises. The four you've been running (Long & Strong, All the Width, Bend Don't Break, Primal Roots) are included, with your week 1–2 notes as each exercise's history.
- **Mobility sessions** start from the check-in screen: a routine, or *Pick body parts*. **+ Mobility** adds moves to a strength workout the same way.
- **Picking by body part**: choose up to 3; for each part the move you've done least recently is ticked (moves covering more of the picked parts rank first). Each set shows last time's numbers and note; loads and the custom field prefill from last time.
- Logging a set starts that exercise's rest. Finishing keeps only what you logged. The Week tab shows mobility sessions and which body parts you've covered.

## Suggested weekly goals

Week → **Suggest from history** (also offered after a FitNotes import). It looks at the last 12 weeks (26 if that's thin) and proposes goals for review: untick or change any of them, then **Replace my goals** or **Add to my goals**, with Undo.

- **Which movements and how often** come from your history: families trained at least every few weeks; times per week = workouts with that family ÷ weeks (1-3).
- **Tiers and rep ranges follow GZCL**, not your recent numbers: explosive loaded lifts (cleans) → T1 power, high priority; jumps/sprints → T2 power at about 12 reps a session, high priority; other loaded lifts → T1 if you do them heavy (3+ workouts and a third of them), else T2; everything else → T3.
- **The main explosive lift also gets a technique goal** (once a week) for tired days.
- **About one heavy (T1) lift per workout**: explosive lifts first, then lower body. Extra heavy lifts become T2 support work.
- **Chest and shoulders** are always included, once a week at low priority.
- **The week has to fit**: about 3 goal sessions per 45-minute workout; accessories are unticked first, explosive lifts last.

## FitNotes import

Settings → Backup and data → **Import from FitNotes**. Pick the `.fitnotes` backup; it's read on the phone with sql.js (kept in `vendor/sql.js`, version 1.14.2, about 0.7 MB, loaded the first time you import) and never uploaded.

- **Window**: the last 1, 2 (default) or 4 years. Two years of your history is about 5,700 sets and 1.3 MB of saved data.
- **Review**: exercises with 3+ workouts in the last year are listed with best guesses (existing exercise or new; family; how it was logged; body region; explosive; equipment) and can be changed. Older ones come in archived.
- **Matching** uses names and how the sets were logged, so FitNotes "Pull Up" with added weight goes to *Weighted pull-up*, not the reps-only *Pull-up*. An unused starter exercise can switch how it's logged to match the history.
- **Conversion**: kg to lb (rounded to 0.5). On bodyweight exercises 0 lb and 1 lb mean bodyweight; on loaded lifts they mean no weight was entered (left out of the estimated max). 0-rep sets are kept as misses. Sprint distances typed in the weight column become distance.
- **Tiers** are guessed per set from GZCL (1-3 reps at 85%+ of the lift's best in the previous 12 weeks → T1, up to 8 reps at 65%+ → T2, else T3; jumps and sprints → T2).
- **Usual choice per family** becomes the exercise you did most in the last year, unless you've been logging the current one in this app.
- **Repeat imports** skip sets already imported (stable ids) and reuse earlier choices. If you log the same workout in both apps, it counts twice.

## Not in Phase 1

Session formats (EMOM/AMRAP/circuits), mobility, regression notices, a progress view, IndexedDB storage (needed before importing much more than 2 years), configurable recovery rules (only "penalize T1 after T1" exists), override analytics beyond the acceptance counts, drag-to-rank (up/down arrows instead), sync. Background rest alerts are best effort: the service worker waits for the timer (up to the browser's ~5 minute limit) and notifies only if the app isn't visible. That works on Android; iOS pauses web apps when locked, and fixing that would need a push server (a P2 backend).
