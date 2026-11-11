# Pressure route hint and mouth keys — worklog

Plan: `archive/pressure-hint-plan.md`.

## Review of the previous task (air-scale calibration)

The fix is correct: the lanes name real materials, the neutral r 2.7 grain is
`REFERENCE_GRAIN_MASS`, and the suite is green. Nothing had to be changed.

- Checked the suspected stats mislabel in `experiments/air-scale.html` (rows are
  indexed by lane number, and `compact` shifts grains down when one drains).
  Not a defect, by reading `compact` and `removeGrains`, not by running the
  page: only the bottom drains, and the lanes drain heaviest first, which is
  the last index, so the remaining rows keep their lanes.
- Found next to it and fixed in step 2: `bestQuarterForValve` allocated an
  array on every call inside the route search, although
  `pressure-routing-worklog.md` states the search does not allocate.
- Left as they are, noted for whoever touches the fixture next: the lane table
  exists twice (fixture and page), the 1× tolerance is 20 px against 1.2 px
  measured, and the OK line omits the 2× standard lift.

Baseline before this task, re-run: `render-smoke`, `game-fixtures`,
`vent-fixtures`, `air-scale-fixtures`, `geometry-check` all exit 0.

- `render-smoke`: `drawCalls 639614 stroke 20344 fill 29862 fillRect 28116 drawImage 23865 overlay 301`
- `game-fixtures`: quest gen `easy 63 med 109 hard 68`, `pressure 55`, `bots completed 4 (55 pts)`

## Review of the next-step plan

The item has been carried since `0.2-worklog.md` ("a visible pocket hint while
it is signed (the shaft column and the own mouths that matter), and let `Tab`
cycle the player's own mouths") and was repeated by the lubricant and
air-scale worklogs. The shaft column no longer exists:
`pressure-routing-worklog.md` removed it, signing installs only the bottle, and
the player builds the route by quarter turns. The plan was therefore rewritten
around the route search the bots already use:

- the hint is the search result, not a column, and it never turns anything;
- one trace function feeds both the bots and the hint;
- `Tab` walks only owner-dealt mouths, so Lab keeps a single tab stop and focus
  can always leave the field;
- the refresh is keyed on a new `sim.targetVersion`, so nothing runs per frame.

## Steps

Status is updated as each step lands; an unticked step is not done.

- [x] 1. Mouth keys in `app.js` (+ `render-smoke` assertions)
  - `focusInlet` is the keyboard cursor on a mouth. `Tab` / `Shift+Tab` walk
    the owner-dealt mouths a person's seat may press; `Space` / `Enter` press
    the focused one; an arrow or a pointer press returns the keys to the
    valves.
  - The click branch and the key share one `pressMouth(inlet, flip)`, so the
    refusal texts and the paused redraw exist once.
  - The focused mouth reuses the hover ring and label, and `announceMouth`
    writes its name, state and what `Space` does to the live status line.
  - `focusedMouth()` drops a focus whose mouth stopped being pressable, because
    `G` changes the mode while the canvas keeps the focus.
  - Validation: `node experiments/render-smoke.cjs` PASS — Lab `Tab` is not
    consumed; Game: `Shift+Tab` on the valve cursor is not consumed, four stops
    (two out, then two in), label drawn, `Space` seals, `Enter` reopens,
    `Shift+Space` is refused as a polarity swap, `Shift+Tab` steps back, the
    fifth `Tab` is not consumed, arrow and pointer press hand `Space` back to
    the valve; Vent: a seat's mouth is named on focus.
- [x] 2. `sim.targetVersion`, `traceAirRoute`, `game.routes`, bots on the shared trace (+ `game-fixtures`)
  - `simulation.js`: `sim.targetVersion` rises at all six writers of
    `sim.target` (`initSchedule`, auto-rotation, stall back-off, `turn`,
    `setTarget`, `installValve`).
  - `game.js`: `findAirRoute` now reports the reservoir mouth and the side
    facing it instead of a per-state quarter table. `traceAirRoute` unrolls the
    search into a route buffer; `botStepPressureQuest` turns the first cell the
    buffer lists, so the chain walk exists once. `bestQuarterForValve` reads a
    constant step table; it used to build `[1, -1, 2]` on every call inside the
    search, against the worklog's own no-allocation claim.
  - `refreshRoute` runs from `evaluateQuest` for a person's pressure goal and
    returns on the three cache keys. `evaluateQuest` on seed 7, ad hoc loop of
    20 000 calls: 0.34 µs with the cached route, 3.4 µs when it searches.
  - Signing and seat renumbering forget the key: quest ids restart with a
    match, and `renumberSeats` moves a goal to another seat's buffer.
  - Validation: `node experiments/game-fixtures.cjs` PASS with the new
    `testRouteHint` (both polarities): contiguous cells from a band cell to
    the bottle, mouth polarity and column, `pending` equals the turns listed,
    following them leaves 0 pending on the same cells and every valve joins
    its two sides, nothing is installed, the cache does not search a still
    field, an own sealed mouth is offered with `open it`, a bot seat gets no
    route until handed to a person, the route never crosses another goal, a
    goal that moves down a seat reads its route again, a walled-in bottle
    reports no route. Bots unchanged: `bots completed 4 (55 pts)`, quest
    generator counts identical to the baseline.
- [x] 3. `R.renderRoutes`, goal-card readout (+ `render-smoke`)
  - Thread in the seat's accent, dashed where a valve must turn, amber turn
    arrows, cup on the reservoir mouth; five strokes per route, no allocation.
  - Looked at real pixels (seeds 7, 11, 16, 21, 99 through an ad hoc
    `@napi-rs/canvas` render, not kept). Three things changed because of it:
    the thread rounds corners on the elbow radius instead of a hard corner at
    the hub; the arrows moved from the axes to the diagonals at radius 15,
    where their heads no longer sit on the thread; cream arrows vanished on
    the white pipe interiors, so they use the selection amber.
  - The readout's open form was reworded after reading it against the model:
    it is cached on turns and presses, so it cannot claim the bottle is
    charging or bleeding. It says what to do if the pressure stalls.
  - Validation: `node experiments/render-smoke.cjs` PASS — the card carries
    the route line, the frame draws `count + 2 × pending` segments under the
    route pen and one dash/solid pair, following the arrows drops them and
    the card reads `Route open`, dropping the goal removes thread and line.
- [x] 4. Help, hints, aria-label, README
  - Shared `index.html`: canvas `aria-label`, `#mouth-hint`, `#vent-hint`,
    Help paragraph, two shortcut rows. README: controls and Game paragraphs,
    plan link.
- [x] 5. Full regression, plan to `archive/`
  - Two defects found while re-reading the diff:
    - the mouth cursor was released in `onclick`, which a drag suppresses. It
      is released at `pointerdown` now, and the smoke drives the real press
      sequence;
    - after the keys returned to the valves the live status line still said
      `Space seals it`. One `releaseMouth()` now serves every exit and writes
      where the keys went; the smoke asserts it for all four exits.

## Validation

All exit 0, run after the last source change:

| Suite | Result |
|---|---|
| `render-smoke` | PASS, `drawImage 24895 overlay 315` (baseline `23865` / `301`; the rise is the added Game-mode frames). Its `drawCalls`, `stroke`, `fill` and `fillRect` totals differ on every run, at the baseline too, so only these two compare |
| `game-fixtures` | PASS, quest gen `63/109/68`, `pressure 55`, `route hint (3 turns followed)`, `bots completed 4 (55 pts)` — identical to baseline |
| `vent-fixtures`, `vent-balance` | PASS; all eight bands and reach figures equal the baseline for seeds 7, 21, 99, 2024 |
| `gas`, `air`, `air-scale`, `pressure-propagation`, `calibration` fixtures | PASS |
| `simulation`, `geometry` fixtures, `geometry-check` | PASS |
| `water`, `water-state`, `water-color`, `water-sources`, `water-buoyancy` fixtures | PASS |
| `heat`, `melt` fixtures | PASS |

`node --check` on every touched file and `git diff --check` are clean.
`geometry-check` prints a different elbow count on every run (249–299 seen,
260 and 299 at the baseline commit), so that count is not a regression signal
either. Both were checked in a detached worktree of `f9c66cd`.

Not validated: a real browser. Focus order, the live-region announcement and
the look at other zoom levels were checked only through the DOM stub and a
node canvas.

## Next step

1. **Vent band reachability** (an unconfirmed lead, cheapest to settle): an
   earlier reading of `fitVentBand` / `ventTurnPick` suggested that seed 7
   with seat 0 played by a bot can get a band (`0.59–0.75`) above what its
   pocket settles at (`~0.54`). `experiments/vent-balance.cjs` does not cover
   that roster: its one-seat seed 7 row reads `1.00 reach / 0.15–0.31`.
   Reproduce it there first; if it does not reproduce, drop the item.
2. **Route hint for Vent seats**: the same buffer could show which locked route
   feeds a collector. It needs a design first, because Vent routes are built
   at setup and the valves on them do not turn.
3. **Bleed hint**: the readout can only say `if the pressure stalls`. Naming
   the branch that bleeds an open route needs the pocket graph (`net.comp`),
   not the route search.
4. Carried over, unchanged: heat picture at ±10000 E/s, grain bots with two
   lateral jogs, water quest hook, per-vent channel readout.
