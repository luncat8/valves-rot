# Seat roster and Vent mode (0.2.4)

## Review

- The previous job (lubrication, `0.2.3`) left two next steps: let the grain bots
  route through two lateral jogs, and give a person a keyboard path to their own
  mouths plus a highlight for a signed quest's pocket. Neither blocks this one.
  The jog change is untouched; the mouth/pocket item is carried into
  `vent-plan.md`'s deferred list, where the pocket now also means a vent rig's
  column and bottle.
- Reviewing the tree rather than the prose paid again: `archive/0.2-worklog.md`
  §0.2.2 describes `GAS.probeMouths`, `pressurePocketColumns`, `fitPressureQuest`,
  `saveColumn`/`restoreColumn` and `MIN_SPAN`/`WEAK_SPAN`/`SOFT_MARGIN`, and none
  of them exist. A design that was replaced leaves its worklog behind; read
  `game.js`.
- Two things in the existing code turned out to be load-bearing for this job and
  worth knowing before touching them: `INL.press` already refuses a mouth owned by
  somebody else (so ownership is the whole of vent seat control), and
  `S.installValve` re-bases a rotor's `ports` onto its canonical type while moving
  the rotation into `angle` (so a borrowed column cannot be restored by comparing
  port lists).

## What was asked

1. Add and remove players at any time, with a per-player **bot or person**
   checkbox instead of one global bot switch over a fixed four-player roster.
2. A second game mode, playable with **one or two** players only: gas routes to
   the players' bottles built at setup, `5%` of the valves randomly rotated, a
   player controlling **only their own vents** and no valves, and the task of
   keeping a target pressure range inside their own bottle cell.

## Seat roster

- `game.players` is now dense and `player.id === index`, so a seat list can shrink
  without leaving holes in the tint, ownership and quest arrays. `MAX_SEATS = 5`
  (`min(R.PLAYERS.length, I.MAX_PLAYERS)`), `VENT_MAX = 2` in Vent mode.
- `addPlayer`, `removePlayer`, `setPlayerBot`, `setBotControl`, `setMode` and
  `resetMatch` are the whole API; each ends in `reseats`, which gives the new list
  what it owns — Game mode re-deals the mouth bands, Vent mode gives its borrowed
  columns back and builds rigs for the seats that remain. `Bot control` became a
  pause over the seats whose own `bot` flag is on.
- Removing a seat renumbers the ones behind it (`renumberSeats` shifts
  `caseTint`, `goalOwner` and every signed quest's `owner`), so a dropped seat
  never leaves a color nobody holds. Seat `0` cannot be removed; scores stay with
  the player, not the seat.
- The panel row carries a bot checkbox and a remove button, `#add-seat` caps
  itself per mode, and a refusal says whose seat it was: `pressActor` returns `-1`
  for a mouth a person may not touch, and `app.js` names the reason.

## Vent mode

- A rig borrows one **column**: `solid-straight` quarter `1` in all ten rows, with
  a `hollow-straight` bottle at `GOAL_CHAMBER` in a mid-column row, every cell
  `autoLocked`, cased and owned by the seat. Its two mouths are the column's own —
  the bottom one a `HIGH` source, the top one a `LOW` vent — and they are the only
  mouths in the bands. Grains are drained (they would pack the pipe being
  regulated), the grid gas backend is forced on, and `5%` of the *rest* of the
  field keeps turning by itself.
- Two rigs go as far apart as the columns allow (`VENT_COL_GAP`, farthest-column
  rule) and the bottle sits in rows `4..6`: near a mouth band the column's pulses
  arrive faster than a seat can answer them (`7.7..14.9` mouth moves per second),
  and a bottle with sideways ports lets a rival's pulse own the whole band — a
  `hollow-cross` bottle moved `0.2..0.3` on a neighbour's drain, the same rig with
  a straight bottle moved less than a band.
- Bands: `measureVentSpan` solves each mouth pair to convergence
  (`GAS.steady(gas, gas.pTarget)`; the live 12-iteration path undershoots by up to
  `0.2`) and the band is fitted inside that span with a half width of
  `0.06..0.11`, `VENT_EDGE_MARGIN = 0.15` from either end. Holding it for
  `VENT_HOLD = 4 s` scores `50`/`25`/`10` by tightness and fits the next band a
  `VENT_BAND_STEP = 0.22` step away; leaving it by more than `VENT_ALARM = 0.18`
  counts once as a lost regulation.
- On the field the bottle carries the band as a tag, the live pocket pressure as a
  gauge needle and the hold as an arc (`R.renderVents`); the panel row carries the
  same numbers and clicking it selects the bottle.

## What the measurements decided

The seat loop is a bang-bang controller over a plant that keeps moving after the
control stops. Every rule below was chosen by a balance run, not by argument;
`experiments/logs/vent-mode-0.2.4.txt` keeps the numbers.

| rule | held inside band | mouth moves per second |
| --- | --- | --- |
| cross bottle, drift picks the rig, `15 Hz` loop | `92..97%` | `4.2..6.6` |
| straight bottle, drift deleted, `15 Hz` loop | `27..96%` | `1.2..19.8` |
| seat loop on the simulation cadence (`S.STEP`) | `73..99%` | `0.5..11.7` |
| bottle rows `4..6`, away from the mouth bands | `75..99%` | `0.4..6.6` |
| `VENT_SETTLE = 0.4 s` waited out after a pulse | `77..99%` | `0.4..1.4` |
| pulse ends `VENT_AIM_INSET = 0.125` into the band | `93..99%` | `0.4..0.7` |

- **Authority is total and the leak is nil**: `span = 1.00` on every column × row ×
  seed tried, sealed leak `< 0.0001/s`. A sealed pocket keeps what it is given, so
  the task is holdable; `VENT_MIN_SPAN = 0.45` only rejects a rig that is not
  connected at all.
- **Sealed is not still.** The pocket is a small part of its column's air and
  slides toward that column's average for about `0.3 s`. Correcting during the
  slide limit-cycles; waiting it out is one constant and halves the switch rate
  again.
- **The slide runs the way the pulse was pushing.** The column above a charging
  pocket charges further than the pocket did, so a pulse that ends at the band's
  center settles out of the far side. Aiming an eighth of the band in from the
  edge the pulse answers lifts the worst seat from `44%` to `93%` held and cut the
  mean match score's spread to `240..435` points. Aiming *past* the center — the
  obvious compensator — is the worst row measured (`11..96%`).
- **Cadence.** An open mouth moves a pocket by up to a third of the ramp in one
  frame, so a `15 Hz` evaluation cannot land inside a `0.12`-wide band; the seat
  loop runs per `S.STEP` slice and only the panel is throttled (a display key that
  folds pressure, hold and verdict into one integer, so a steady needle rebuilds
  no DOM).
- **Rejected**: drift as a rig-selection criterion (pure relaxation is `≈0.05`
  and exactly `0` over two windows — it discriminates nothing, and it cost two
  seconds of settle per candidate); chamber volume as a way to slow the plant
  (the response is diffusion-dominated, `τ ≈ 0.3 s`, whatever the bulb size); a
  part-turned rotor as a throttle (usable window `10..11.8°`, `12°` is shut); a
  predictive lead from `(p − prev)/EVAL_DT` (solver noise becomes a `0.045`
  prediction error and every seat chatters).

## Teardown: giving the lab its field back

- Each slot's borrowed column is saved per seat — type, chamber, tint, lock,
  owner and **`G.orientationOf(v)`**, the quarter that faces the world — and
  restored with quiet `installValve` calls plus `I.releaseColumn` and a case
  redraw. `teardownVent` runs on leaving the mode, on `resetMatch` over a dirty
  field and before every reseat; `forgetVent` drops the record when the whole
  field is new anyway.
- The first version saved `quarterOf(sim.target[idx])`, which is the auto-rotate
  schedule's *pending* detent, not where the cell is: `17` of `100` cells came
  back already turned. A restore check that compares a rotor's own `ports` cannot
  see this, because `installValve` legitimately re-bases them; the check compares
  `kind + sorted world ports + chamberR + tint + lock + owner` against the sim's
  own pre-vent snapshot, and now reports `0` diffs on every seed run.
- The check was vacuous before that: it looped `for (k < sim.count)` and
  `sim.count` is the **grain** count, which Vent mode drains to zero.

## Files

- `prototype/shared/inlets.js`: `MAX_PLAYERS`, `clearAll`, `claimColumn`,
  `release`, `releaseColumn` — a column can now be borrowed and given back.
- `prototype/shared/render.js`: a fifth seat color (Kai), `renderVents` with
  `drawHoldArc`, `drawGauge` and `drawCellTag`.
- `prototype/shared/game.js`: the `// ---- Vent mode ----` section (rig build,
  span measurement, band fit, seat sampling, hold/alarm/scoring, bot law,
  teardown) and the roster API.
- `prototype/shared/app.js`, `prototype/shared/index.html`,
  `prototype/style.css`: **Vent** radio and mode title, seat rows with a bot box
  and a remove button, `#add-seat`, the vent panel (`#vent-heading`,
  `#vent-list`, `#vent-hint`), refusal notices, help text, drawer gating.
- `vent-plan.md`: the mode as a self-contained specification.
- `README.md`, `findings-pitfalls-skills.md`: the mode paragraph and the lessons.
- `experiments/vent-fixtures.cjs`, `experiments/vent-balance.cjs`,
  `experiments/logs/vent-mode-0.2.4.txt`: the invariants, the balance harness and
  the numbers above. `experiments/render-smoke.cjs` grew a Vent block covering the
  page wiring end to end.

## Validation

- `node experiments/vent-fixtures.cjs`: OK — rig shape (locked, owned, tinted,
  all cells running N,S, bottle chamber `GOAL_CHAMBER`), mouth ownership and
  levels, band fit inside the measured span with the right point tier, seed
  determinism, `pressActor`/`canTurn` refusals, a bot scoring against an idle seat
  that is never driven, add/remove/hand-over, exact teardown restore, re-entry and
  a new match.
- `node experiments/vent-balance.cjs 45 7 21 3 42 101 2024 555 99`: one seat
  `93..99%` held at `0.4..0.7` mouth moves per second, two seats `96..98%` at
  `0.5..0.7`, one bot against an idle seat `96..98%`; `10..11` rounds and
  `240..435` points per `45 s` match, `0..1` lost regulations. Two seats hold
  *better* than one, which is the point of placing the columns far apart. Leaving
  the mode: `2` rigs torn down, `4` mouths back to `20`, auto-rotate `0.05` back
  to `0.9`, `cell state diffs 0` on both seeds checked.
- `node experiments/render-smoke.cjs`: OK — `sprites 100, drawCalls 361043`; the
  Vent block asserts the radio and panel titles, `5%` auto-rotate, disabled
  Pour/Drain and pressure radios, per-seat bot boxes, the seat cap, locating a
  bottle by clicking its row, a locked valve that does not turn, mouth refusals,
  handing a seat to a person, adding and removing seats, the band tag on the
  bottle cell, and the lab's field, tints and twenty mouths on leaving.
- `node experiments/game-fixtures.cjs`: OK, unchanged — bots completed `7` for
  `140 pts`, and Lab/Game play is untouched apart from the seat list.
- Regressions (`gas-fixtures`, `air-fixtures`, `calibration-fixtures`,
  `simulation-fixtures`, `geometry-check`, `pressure-propagation-fixtures`,
  `packed-flow`): all OK.
- Costs: entering Vent mode `8..34 ms`, `45 s` of two seats playing `2.8..6.8 s`
  of CPU headless, so the mode runs several times faster than real time.

## Next step

- Entering Vent trims the seat list to `VENT_MAX = 2` and leaving it **keeps** the
  trimmed list: two people who played Vent and switch back to Game have to press
  **Add competitor** twice. Either remember the list a mode was entered with and
  restore it on the way out, or say so in the status line when the trim happens —
  the second is one line and the first needs a per-mode roster to keep honest.
- Give a person a keyboard path to the mouths they own (`Tab` cycles between the
  seat's two, `Space` seals) and highlight the column and bottle a selected seat
  is regulating; the same highlight answers the `0.2.2` request for a signed
  pressure quest's pocket.
- Flatten the remaining nested ternaries around mode switching into one
  `MODE_*` table each, the way `MODE_AUTO` now is, so a new mode is a row and not
  a branch.
- The idle-seat case shows a seat nobody drives drifting out of its band and
  scoring nothing while it costs the other seat nothing. If that reads as noise on
  the scoreboard, offer "hold this seat" (pause its hold timer and hide its gauge)
  instead of an idle bot.
