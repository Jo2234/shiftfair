# ShiftFair

Fair, feasible volunteer rosters for one-day events such as a student-club
fair. Enter volunteers (skills, availability, workload limits) and shifts
(role, time, headcount); ShiftFair builds a roster that obeys every hard
constraint, balances workload, and explains in plain words why any remaining
slot is unfilled.

It is a static web page: no account, no backend, no AI or API calls at
runtime. Your data stays in your browser (see [PRIVACY.md](PRIVACY.md)).

## Features

- **Hard constraints, always:** required skills, availability covering the
  whole shift, no overlapping shifts per person, per-person shift and minute
  limits, shift headcount.
- **Generate** a roster with a bounded, deterministic search (same input →
  same roster), then a fairness pass that evens out minutes worked.
- **Gap explanations:** for every unfilled shift, how many volunteers qualify,
  how many are already on it, how many could be added now and how many are
  blocked by their other assignments — plus each person's exact blockers
  (missing skill, unavailable, overlap with a named shift, limit reached).
- **Manual control:** add a volunteer by hand (checked immediately; blocked
  choices are disabled with the reason), lock assignments so Generate keeps
  them, remove assignments. Edits that break an assignment remove it with a
  notice naming who and which shift.
- **Coverage and workload** summaries per role and per volunteer.
- **Save/load** a versioned JSON file, and **export CSV** with spreadsheet
  formula prefixes neutralized. Imports are validated transactionally: a bad file changes nothing.
- Keyboard controls, live status messages and a responsive layout.
- A clearly labelled **synthetic sample event** to try it out.

## Run locally

Requires Node.js 24 or newer (developed with Node 26).

```sh
npm ci            # install the pinned development tools
npm run dev       # development server at the printed localhost URL
npm test          # all unit and UI tests (node:test + jsdom)
npm run typecheck # TypeScript, strict
npm run build     # typecheck + production build into dist/
npm run preview   # serve the built dist/ locally
```

`npm run dev` serves the app without the Content-Security-Policy, because the
Vite development server needs inline styles and a live-reload connection. The
production build (`npm run build`) adds a strict CSP to `dist/index.html`
(`default-src 'self'`, `connect-src 'none'`, no inline scripts or styles);
use `npm run preview` to check the app exactly as it ships.

`dist/` is plain static files with relative paths, so it can be hosted on any
static host (for example GitHub Pages) from any sub-path.

## How the solver works

1. Locked assignments are kept if they are valid (invalid ones are dropped and
   reported). Unlocked assignments are recomputed.
2. **Greedy:** repeatedly fill the open shift with the fewest currently
   eligible candidates (ties: earlier start, then id) with the least-loaded
   candidate (fewest minutes, then fewest shifts, then id).
3. **Repair:** for each still-open slot, a depth-limited (3) augmenting search
   may move a qualified volunteer off their unlocked shifts if every freed
   slot can be refilled. Only strict increases in filled slots are kept.
4. **Fairness:** move or swap unlocked work away from the volunteer with the
   most minutes when that strictly narrows the minute spread, without losing
   coverage.

Static eligibility evaluations and dynamic candidate checks count against a
search budget (default 200 000 evaluations). If the budget runs out the result is marked “Search budget
reached”; it still satisfies every hard constraint. The tested synthetic
60-volunteer, 40-shift fixture fills all slots in 4 430 evaluations; very large plans (hundreds
of volunteers and shifts with high headcounts) can reach the budget.

**What it does not claim:** the roster is not guaranteed optimal, and a gap the
solver leaves is not proof that no roster could fill it — unless the gap is
marked “Not enough eligible volunteers”, which means the plan data itself (skills,
availability, limits) does not have enough distinct qualified people.

## Limits

- One event day. Times are `HH:MM` on a 24-hour clock from `00:00` to `24:00`
  (end of day). No overnight shifts, no dates, no time zones.
- Up to 50 roles, 300 volunteers, 300 shifts, 50 people per shift, 20 skills
  and 20 availability windows per item, names up to 80 characters.
- JSON files up to 4 MiB — enough for the largest plan within these limits,
  so any plan you export can be imported again. Very large plans may exceed
  the browser's storage quota; the app then says so and keeps working in
  memory — use Export JSON as your backup.
- Browser storage is per browser and per device; it is not synced or
  encrypted. Clearing site data deletes it.

## Project layout

```
src/core/   pure logic: types, time, skills, constraints, solver, explanations, import/export, sample
src/ui/     DOM UI (no framework) and browser-storage adapter
src/main.ts browser entry point
test/       node:test unit tests (core) and jsdom UI tests
```

## License and credits

MIT — see [LICENSE](LICENSE). AI assistance and development tools are credited
in [ATTRIBUTION.md](ATTRIBUTION.md). The sample data is synthetic.
