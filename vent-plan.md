# Seat roster and Vent mode plan

## Goal and scope

Two additions to the shared prototype, both playable from `index.html` with no
build step:

1. **Seats come and go at any time.** The competitor list is not a fixed four:
   a seat can be added or removed while a match is running, and every seat has
   its own **bot** checkbox saying whether a bot or a person plays it. The old
   single `Bot control` switch stays, as a pause over the seats that are bots at
   all.
2. **Vent mode**, a third mode beside Lab and Game, for **one or two seats
   only**. The gas routes are built for the players at setup: each seat gets a
   locked pipe down one column with a bottle chamber in it, `5%` of the field's
   valves still turn on their own schedule, and the only controls a seat has are
   **its own two mouths** — no valve can be turned. The task is to hold the
   bottle's pressure **inside a target band** for a hold window, again and again.

Keep the file-friendly runtime (classic `<script>` tags, `module.exports`
guarded for Node), the fixed-step simulation, the shared geometry layer and the
no-allocation rule in the frame loop. Nothing here changes Lab or Game play
except the seat list.

## Why one or two seats

Every open mouth is a Dirichlet pin on one shared corridor mesh, and every rig's
pocket is a volume inside that mesh. Measured with two rigs standing (seed 7):

| seats | held inside band | mouth moves per second |
| --- | --- | --- |
| 1 | `93–99%` | `0.4–0.7` |
| 2 | `96–98%` | `0.5–0.7` |
| 3+ | — | not offered |

(8 seeds × `45 s` each, two seats = 16 seat-runs; `node experiments/vent-balance.cjs`.)

With two seats the field average is still far enough from each band that a seat
has a lever of its own. A third rig pins a third of the bands and pulls every
pocket toward the middle of the ramp, so no seat can hold a band that is not
near `0.5`. `VENT_MAX = 2` is the mode's seat cap; entering Vent trims the seat
list to it, and seats can be added back in any other mode.

## Seat roster

- Seats stay **dense**: `game.players[p].id === p`, seat `0` is always the
  person's, and colors, case tints, goal owners and quest owners are all indexed
  by seat. `R.PLAYERS` carries five names, and `I.MAX_PLAYERS = N / 2 = 5` is
  what the two bands can deal, so `MAX_SEATS = 5`.
- **Add** refuses at the cap (`VENT_MAX` in Vent, `MAX_SEATS` otherwise) and
  answers in the status line instead of failing silently.
- **Remove** refuses seat `0`: the person's own seat stays. Removing a seat
  renumbers every seat behind it — `caseTint`, `goalOwner` and `quest.owner` all
  shift down one, so no bottle keeps a color nobody holds.
- Any change **re-deals what the seat list owns**: Game mode deals the mouth
  bands again (a deal is only balanced for the list it was dealt to), Vent mode
  gives its borrowed columns back and builds rigs for the new list. Scores,
  completions and losses stay with the player.
- A seat's own `bot` flag decides whether the bot code drives it and whether its
  mouths and valves answer the mouse: `Game.pressActor(game, inlet)` returns the
  acting seat for a mouth a person may press and `-1` otherwise, and
  `Game.canTurn(game, index)` is false for a bot-owned goal and for **every**
  cell in Vent mode.
- `Bot control` is the master pause over all bot seats; it does not change which
  seat is a bot.
- The seat list is interactive, so the panel is split by what changed:
  `game.rosterVersion` rebuilds the seat rows, `game.version` rebuilds the mode's
  own list (quests or vent seats) and the status line. A needle that moves every
  frame must not rebuild the seat rows.

## Vent rig

One seat borrows one column for as long as the mode runs, and gives it back
exactly when the mode is left or the seat goes away.

- **Shaft**: `solid-straight` at quarter `1` (ports N,S) in all ten rows, so the
  bore runs from the bottom band to the top band and every rotor is sealed
  sideways. **Bottle**: `hollow-straight` at quarter `1` with
  `GOAL_CHAMBER = RV × 0.53` in one mid-column row — straight, **not** cross.
  A cross opens the pocket directly onto the corridor mesh beside it, and one
  neighbour's pulse then owns the whole band: with cross bottles a rival's drain
  pulse dragged a sealed pocket by `0.3`, with straight ones the same pulse moves
  it by less than a band.
- All ten cells are `autoLocked`, `goalOwner = seat`, `caseTint = seat`, and are
  marked dirty so their sprites and housings are rebuilt once.
- **Mouths**: the column's bottom mouth is claimed as the seat's **source**
  (`HIGH`) and its top mouth as its **vent** (`LOW`). `I.clearAll` empties both
  bands first, so in Vent mode the only mouths in the field are the rigs' own —
  two per seat, four in a two-seat match.
- **Column choice**: seat `0` takes any free column; a later seat takes the free
  column **farthest** (circularly) from the rigs already standing, and no column
  within `VENT_COL_GAP - 1` of another rig is free at all. Up to `VENT_TRIES = 5`
  candidates are built and measured; the first that plays is kept, and the
  widest-spanning of the rejects is played if none does.
- **Row choice**: `VENT_ROW_MIN = 4 .. VENT_ROW_MAX = 6`. Near a mouth the pocket
  answers that mouth several times faster than the other one, and a pulse then
  leaves the column so lopsided that the pocket slides back out of its band the
  moment it is sealed.
- Grains are **drained** on entry (a packed shaft would throttle the very pipe
  being regulated), the grid gas backend is **forced on** (a seat reads pressure,
  so `Off` and `Air particles` are disabled in this mode), and auto-rotate is set
  to `VENT_AUTO = 0.05`.
- **Giving the column back** restores type, chamber radius, world orientation,
  case tint, lock and goal owner per cell, releases the mouth pair, and rebuilds
  the pressure network. The saved quarter is the orientation the cell **faces the
  world with** (`G.orientationOf`), not the detent its auto-rotate schedule is
  heading for, and the comparison that proves it uses world ports — a rotor's own
  port list is bookkeeping that `installValve` legitimately re-bases.

## Pocket physics the mode is built around

Measured on a finished rig (`node experiments/vent-balance.cjs`):

- **Authority is total.** With the source mouth open and the vent sealed the
  pocket settles at `1.00`; the other way round at `0.00`. `span = 1.00` for
  every column and every mid-column row on every seed tried, so
  `VENT_MIN_SPAN = 0.45` only rejects a rig that is not connected at all.
- **A sealed pocket does not leak.** Four seconds after both mouths are sealed it
  has moved by less than `0.0001/s`: the shaft is a closed volume, so whatever the
  pocket is left with, it keeps. Holding a band is therefore possible at all.
- **But sealed is not still.** The pocket is a small part of its column's volume,
  so after a pulse it slides toward the average of the whole column for about
  `0.3 s` before it stands still. A control loop that corrects during that slide
  chatters: it produces `5–20` mouth moves per second and holds the band `30–70%`
  of the time. Waiting the slide out (`VENT_SETTLE = 0.4 s`) is what brings the
  same rigs to `0.4–0.7` moves per second and `93–99%` held.
- **The slide runs the way the pulse was pushing.** The column above a charging
  pocket charges further than the pocket itself did, so a sealed pocket keeps
  rising for the length of the pulse it just had (and keeps falling after a
  drain). Measured over 8 seeds at `45 s`, where a pulse ends decides whether a
  tight band is holdable at all:

  | pulse ends at | held inside band | mouth moves per second | points per match |
  | --- | --- | --- | --- |
  | past the center (`+0.5` of the half width) | `11–96%` | `0.7–4.1` | `132` |
  | the center | `44–98%` | `0.4–2.4` | `312` |
  | a quarter in from the answered edge | `84–98%` | `0.5–0.8` | `338` |
  | an eighth in from the answered edge | `93–99%` | `0.4–0.7` | `342` |

  `VENT_AIM_INSET = 0.125` is that last row: a charge ends an eighth of the band
  above `lo`, a drain an eighth below `hi`, and the slide carries the pocket to
  the middle.
- **A pulse is fast.** An open mouth moves the pocket by up to a third of the ramp
  in one frame, so the seat loop runs on the **simulation cadence** (`S.STEP`),
  not on the `15 Hz` evaluation cadence the quest board uses. Only the panel is
  throttled.
- Chamber volume is not a lever: adding bulb volume to the shaft cells does not
  slow the response, which is diffusion-dominated with a time constant near
  `0.3 s` whatever the pocket's size. A part-turned rotor does throttle, but the
  usable window is `10–11.8°` (`12°` is shut, `9°` is unchanged) — too fragile to
  build a mode on. Keep the fast dynamics and design around them.

## Band, scoring and the seat loop

- **Fitting**: `measureVentSpan` snaps the field, opens one mouth at a time and
  solves to convergence (`GAS.steady(gas, gas.pTarget)`, not the 12-iteration live
  snap, which undershoots a mouth pair by up to `0.2`), giving `spanLo`/`spanHi`.
  The band's half width is drawn from `VENT_HALF_MIN = 0.06 .. VENT_HALF_MAX =
  0.11`, clamped to half the reachable span, and its center lands at least
  `VENT_EDGE_MARGIN = 0.15` inside either end.
- **Points**: a half width of `0.10` or more is `10` points, `0.08` or more is
  `25`, narrower is `50`. A tight band pays better and is harder to hold.
- **Rounds**: `VENT_HOLD = 4 s` continuously inside the band scores the band's
  points, counts a completion, and fits the next band. The next band moves **a
  step** (`VENT_BAND_STEP = 0.22`, either direction) from where the pocket is,
  never across the field: a long transit is what upsets the other seat's pocket.
  The first band of a rig may land anywhere reachable.
- **Losses**: leaving the band by more than `VENT_ALARM = 0.18` counts **once**
  per excursion (the alarm re-arms at half that margin) as a lost regulation.
- **Reading the pocket** costs no allocation: `sampleSeat` writes
  `seat.pressure`, `seat.ok` and `seat.holdRatio` into the preallocated seat, and
  `markSeatShown` folds pressure, hold and verdict into one integer key so a
  steady needle rebuilds no DOM and no string.
- **On the field** the bottle cell carries the band as a tag, the live pocket
  pressure as a gauge needle beside the rotor (drawn after the hold arc, which
  crosses it), and the hold as an arc. The panel row carries the same four
  numbers plus the seat's color, and clicking the row selects the bottle cell.
- **Bot law** (a seat whose `bot` flag is on, while `Bot control` is on): an edge
  of the band starts a pulse, `VENT_AIM_INSET` into the band from that edge ends
  it, inside the band both mouths stay sealed, and a finished pulse is waited out
  (`VENT_SETTLE`). Ending at the far edge overshoots by rate × latency (about
  `0.16`); keeping the previous mouth state inside the band turns every hold into
  a full charge or drain excursion; ending at the center leaves the slide to
  carry the pocket out of the far side (table above).
- **Judging** is one path for both: `holdSeat` runs for every seat, bot or
  person, resetting the hold and counting the alarm outside the band, and scoring
  and re-fitting once `VENT_HOLD` has run inside it. Only the *driving* differs —
  a person clicks the mouths (`pressActor` decides whose click may touch one) and
  a bot seat's mouths follow `seat.drive` through `applyVentDrive`. Both are read
  by the same `sampleSeat`/`markSeatShown` pair, so a balance run measures a seat
  a person could play.

## Costs

Headless, seed 7, grid gas already on: entering Vent mode costs `8–34 ms` for
one or two rigs (building the shafts, `GAS.refresh`, two converged span
measurements each), and `45 s` of two seats playing costs `3–7 s` of CPU, so the
mode runs several times faster than real time in a browser frame budget. A
converged `GAS.steady` is `3.6 ms`, `GAS.refresh(sim, true)` is `25 ms`, and
`1 s` of `GAS.settle(sim, 1/30)` is `30 ms` — which is why the mode measures
spans instead of simulating seconds at setup.

## Acceptance

- `node experiments/vent-fixtures.cjs` — rig shape (locked, owned, tinted, all
  cells running N,S, bottle chamber `GOAL_CHAMBER`), mouth ownership and levels,
  band fit inside the measured span with the right point tier, seed determinism,
  `pressActor`/`canTurn` refusals, a bot scoring against an idle seat that is
  never driven, add/remove/hand-over, exact teardown restore, re-entry, and a new
  match on the same and on a fresh field.
- `node experiments/vent-balance.cjs [seconds] [seeds...]` — rig authority and
  sealed leak, per-seat held share, mouth moves per second, rounds, points and
  losses for one seat, two seats and one bot against one idle seat, plus what
  leaving the mode gives back.
- `node experiments/render-smoke.cjs` — the page wiring: Vent radio and panel
  titles, `5%` auto-rotate, disabled Pour/Drain and pressure radios, per-seat bot
  boxes and remove buttons, the seat cap, clicking a vent row to locate its
  bottle, a locked valve that does not turn, mouth refusals for an unborrowed
  column and for a bot seat, handing a seat to a person, adding and removing
  seats, the band tag drawn on the bottle cell, and the lab's field, tints and
  twenty mouths back on leaving.
- `node experiments/game-fixtures.cjs` and the rest of the fixtures keep passing
  unchanged: Lab and Game play is untouched apart from the seat list.

## Deferred

- A keyboard path for a seat's own mouths (`Tab` to cycle between them, `Space`
  to seal), which Game mode also still lacks.
- Highlighting the whole borrowed column while a seat is being played, so a
  player can see the volume their pocket equilibrates with.
- Three or more seats would need more than one field: separate meshes, or bands
  that are not shared pins, before a third pocket can have a lever of its own.
