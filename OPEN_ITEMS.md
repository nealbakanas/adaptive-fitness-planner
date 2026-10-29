# Open items

What's left, what's been asked for, and ideas worth building. Newest thinking first within each section.
Done items move to the changelog in the PRs, not here.

## Bugs and loose ends

- **A workout went missing during an update (Oct 27).** Not reproduced. Two ways it can happen: a workout with no
  set ticked is dropped when the app closes it the next day, or another device chose "Keep this device's" and
  overwrote the account. Waiting on: was anything else signed in, and is there a "before-sync" saved copy from that
  morning (Settings → Backup and data)?
- **Second-device sync** hasn't been tried on a real second phone (only in tests).
- **No password reset** for the cloud account.
- **Mobility entries can't be edited in History** (strength sets can).
- **"Add jumps" label wraps** on a narrow phone.
- **Several locations:** blocks aren't grouped by location, so a workout can go Basement → Office → Basement.
- **Tests pin the data version number** in a dozen places; every version bump edits them all.

## Things to check with real use

- **Pace learning** needs cleanly logged workouts (each set ticked as you finish it). Revisit the estimates after a
  few weeks; if most workouts are still logged in bursts, consider a harder nudge.
- **Conditioning thresholds** are guesses: a day counts at 90 calories or 8 rounds; bike supersets are 8 cal in a
  T1 rest and 6 in a T2. Tune from experience (Settings → Tiers → COND, Settings → Schemes).
- **Recovery weights** (lower T1 ×0.35 the day after heavy lower work, the other half ×1.2) are first guesses.

## Asked for, not built yet

- **Weekly review: new goals from what you did but didn't plan** (e.g. 3 sessions of an exercise with no goal),
  reusing Suggest from history.
- **PRs:** trophies start from now (no backfill of past records); the exercise History sheet doesn't show them yet.

## Ideas from openGym (github.com/DuarteSantos8/openGym)

Reimplement, don't copy: openGym is AGPL-3.0. Rough order of value for this app.

1. **Effort per set (RIR or RPE), optional.** Smarter progression (all reps at RIR 3 → bigger jump) and better
   recovery steering.
2. **Double progression and auto-deload.** Double progression through a rep range for T2/T3; a lift stalled 3
   sessions running (the weekly review already flags it) gets a one-tap deload.
3. **Plate math.** From the load and the plates you own: what goes on each side.
4. **A planned backup per goal.** Equipment busy → one tap swaps in your backup, same sets and reps.
5. **Muscle-level recovery** (fatigue per muscle, weighted by how hard the sets were) instead of upper/lower.
6. **Records and an estimated-max chart** per lift in exercise History.
7. **Imports from Strong and Hevy** next to FitNotes.
8. **Bodyweight trend chart** against a goal.
9. **Rest-timer screen flash** for loud gyms.
10. **A bridge for Claude** (MCP or an export) to read your training directly, beyond Copy review.

Not worth it here: native and Watch apps, 20 languages, a 5,600-exercise animation library, multi-user admin.

## Bigger ideas

The moonshot doc (Claude Docs, "Moonshot") has the specs; 1 (never lose data), 2 (taste), 3 (pace) and 6 (weekly
review) are built. The rest are still open there.
