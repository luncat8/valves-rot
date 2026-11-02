# Lubrication: a packed passage has to keep flowing (0.2.3)

## Problem
A field of grains in a full passage is held by an arch. Every contact is resolved
positionally: gravity moves each grain by `GRAVITY · h² ≈ 0.04 px` per substep,
the pair solver spends that overlap, and nothing carries the weight of the bed
down the chain. So a packed shaft does not press on the bend below it, the arch
over the bend is stable, and the pipe stops instead of throttling.

Measured on a `j`-shaped route (shaft, one elbow jog east, shaft to the bottom),
pouring 10 grains/s:

| case | first grain out | drained in 12 s |
| --- | --- | --- |
| packed elbow jog | `36.1 s` (only when the whole shaft was full) | `0` |
| six-cell horizontal run, 4 grains/s | never | `0 / 240` |

The threshold is not grain size: a smaller grain (more grains per cross-section)
jammed harder, `ITERATIONS 3 → 6` changed nothing, and a soft contact slop
(`0.3 px` of allowed overlap) changed nothing. It is not a slow solver either:
below about 6 grains/s the same jog flows freely, so the bed *clogs* under load
rather than throttling.

The routes the game asks for are exactly these: `findGravityTopSpout` only allows
vertical drops plus single-cell elbow jogs, so every quest route contains a bend.

## What was added
`sim.lubricant` (`0–2`, default `1`, `S.create({ lubricant })` and
`S.setLubricant`) gives a bed that can arch a little granular temperature, the way
a shaker keeps a hopper running:

- Only grains that touched another grain in the previous step are eligible
  (`sim.contact`, set in `pairContact` inside a `CONTACT_MARGIN = 0.4 px` band,
  because a resolved bed is exactly touching, not overlapping). A lone falling
  grain is never knocked about.
- Only grains slower than `LUBE_SPEED = 60 px/s` are eligible, so a streaming
  grain is left alone.
- A grain is knocked at `LUBE_RATE = 60` times per second × `lubricant`
  (capped at one knock per substep), sideways ±`LUBE_KICK / 2 = 80 px/s` with
  `LUBE_DROP = 0.3` of that vertically.
- Both the gate and the direction are `G.hashUnit(seed, steps, index)`, so a run
  is deterministic and identical at any frame chunking, and nothing allocates in
  the step loop.

## Tuning
A knock has to be big enough to break an arch (there is a threshold: ±30 px/s
barely moves a bed, ±80 px/s does), and the noise costs throughput once the whole
bed boils. Swept over amplitude and rate, measuring a packed jog, a six-cell
horizontal run, and the mean speed of a settled pile in a goal chamber:

| rate / kick | jog drained (12 s) | long run drained (60 s) | settled pile |
| --- | --- | --- | --- |
| `40 / 120` | `23` | `41` | `14 px` drift, quiet |
| `60 / 180` | `33` | `187` | `61 px/s`, boiling |
| `80 / 140` | `31` | `159` | `25 px/s` |
| `60 / 160` (chosen) | `23` | `167` | `18 px/s` |

`60 / 160` keeps the whole `0–2` slider meaningful (the rate cap lands exactly at
`2`) and leaves a settled pile at `18 px/s`, i.e. a grain moves `0.3 px` per
60 fps frame — alive, not boiling. The `2` end is a deliberate over-shake.

## Consequences worth knowing
- A **level** pipe is still slower than a vertical one: gravity gives it no
  thrust, so a full horizontal run creeps at the rate the bed can rearrange
  (hundreds of grains/s are needed to push a column six cells). Bends no longer
  deadlock, which is what the game's routes need; a long horizontal run still
  wants air or a lower outlet.
- Agitation raises the marginal-contact statistics: the full-machine fixture now
  ends with `recovered 12` (`2` dry) and `maxWall 0.028 px`, i.e. a grain grazes
  a wall by hundredths of a pixel and `repair` nudges it back. `maxPush` stays
  `0.05 px`, so nothing crosses a wall; `maxOverlap` stays under `1 px`.
- Nothing about the geometry changed: the lubricant only edits velocities, so
  every wall, seam and aperture guarantee still comes from `sweep`.

## Files
- `prototype/shared/simulation.js`: constants, `sim.contact`, `agitate`,
  `integrate` gate, `setLubricant`.
- `prototype/shared/app.js`, `prototype/shared/index.html`: **Lubricant** slider
  (`#lube`) next to **Air force**, help paragraph.
- `README.md`: one sentence on the slider.
- `experiments/packed-flow.cjs` + `experiments/logs/packed-flow-0.2.txt`: the
  probe and the numbers above.
- `experiments/simulation-fixtures.cjs`: new `packedBend` fixture (dry stays
  packed and barely moves, lubricated drains at least 4× as much), and the
  quarter-turn elbow counts a grain as through the mouth only past `8 px` of the
  cell centre, because a knock may legitimately park one inside the elbow's arc.

## Validation
- `node experiments/simulation-fixtures.cjs`: PASS — `packed bend 29 out
  lubricated`, falling column `6`, sealed reservoir `9`, jammed cluster `21`,
  coincident `3`, rotating pocket `2.70 rad`, frame rates `10/10`, machine `17
  drained`, `maxWall 0.028 px`.
- `node experiments/game-fixtures.cjs`: PASS — bots completed `7` (`140 pts`)
  against `4` (`70 pts`) before.
- `node experiments/game-balance.cjs 120 7 11 42`: `19` signed, `18` completed,
  `1` expired (`5%`, was `33%`), `31` grains poured per completed quest.
- `node experiments/render-smoke.cjs`: PASS — the lubricant slider is wired.
- Regressions (`geometry-check`, `geometry-fixtures`, `gas-fixtures`,
  `pressure-propagation-fixtures`, `air-fixtures`, `calibration-fixtures`,
  `simulation-bench`): all PASS; bench timing is unchanged or better because the
  field drains instead of filling (`1200` grains: `4.70 ms/60Hz` against `6.03`).

## Root-cause complement: gravity creep (0.2.4)

The lubricant broke arches but added noise (settled beds boil). The root cause
is deeper: positional contacts carry no weight, so a grain resting on another
transmits no downward force — a packed column is a stack of independent
equilibria, and an arch over a bend never yields under load.

Added `CREEP_RATE = 0.04` gravity creep in `pairContact`: when one grain rests
on another (contact, no overlap), a fraction of the gravity component along the
contact normal is transmitted as downhill velocity to the lower grain. Over
repeated steps a loaded bed slowly rearranges under its own weight instead of
locking into a stable arch. Applied as velocity only (not position), so it can
never push a grain through a wall — `maxPen` stays `0`.

Tuning (`CREEP_RATE`): `0.08` caused `maxPen = 0.007` in the packed-bend
fixture (velocity applied after `repair`, next-step sweep can graze a wall);
`0.06` positional (`pushGrain`) let grain-grain overlap reach `1.09`;
`0.04` velocity is the sweet spot: `maxPen = 0.000`, `maxOverlap 0.92`, all
fixtures pass.

### Results with creep + lubricant

| case | lub 0.5 | lub 1 | lub 2 |
| --- | --- | --- | --- |
| jog drained (12 s) | `28` (was `21`) | `23` (same) | `27` (was `33`) |
| long run drained (60 s) | `55` (was `40`) | `170` (was `167`) | `183` (was `167`) |
| settled pile mean speed | `19 px/s` | `18 px/s` | `22 px/s` |

Creep alone (`lub 0`) does not break arches at the jog (`0/120` drained) — the
lubricant is still needed there. But with the creep, lower lubricant settings
flow better and stay quieter.

### Files
- `prototype/shared/simulation.js`: `CREEP_RATE` constant, gravity creep in
  `pairContact` for resting contacts.

### Next step
- The bots can now trust a jog: let `findGravityTopSpout`/`botStepGrainQuest`
  accept two lateral steps through elbows (the old single-jog rule was written
  when the second jog could not flow), and prefer a route that ends under a
  bottle over the shortest one.
- Give the human's own mouths a keyboard path (`Tab` cycles, `Space` seals) and
  highlight a signed pressure quest's pocket, still the open item from `0.2.2`.

## Solver correction: curved-wall sliding, contact impulses, and no agitation

The always-on 0.2.3 shake and 0.2.4 per-contact gravity creep did not fix the
contact model. They could move a loaded bend, but injected velocity into resting
piles (the measured bottle drift was still about 18 px/s) and made the apparent
cure noisy. Both are removed from the default behavior. A separate optional
`lubricantStress` slider is now available from `0` to `0.5×` the former kick
amplitude, default off, for deliberately shaking a stubborn jam.

Two omissions were fixed. First, `applyMove` projected a wall collision onto one
straight tangent chord. On a curved passage wall that chord enters the wall;
the sweep clipped it back to the same point every tick while gravity kept
building an unbounded tangential velocity. The remaining part of a wall-hit
step now follows the clearance contour in short, corrected chords, retaining
moving-wall velocity and grain-pair collision guards. Second, `pairContact`
returned immediately for pairs that were exactly touching. Pair impulses now
also solve approaching grains in a narrow `0.4 px` contact band; positional
correction remains overlap-only. Together these resolve the lone-grain elbow
stall and allow a loaded bed to flow without injected energy. Lubricant now has
a literal material meaning: it scales down grain-pair and wall Coulomb friction
caps and never adds velocity.

Regression coverage includes a lone grain through a gravity-fed L-jog, both
walls of a 30-degree passage, quietness in a sealed settled bed, deterministic
bounded optional stress, loaded elbows with lubricant off and on, and a new
three-lane air calibration with light, standard and heavy grains. With Grid gas selected, the Air force slider is calibrated so 1× balances the
standard grain and 2× lifts it; gas drag scales inversely with grain mass. `experiments/air-scale.html` is the visual
vent-in / cell-pipe / vent-out test. Validation:

- `node experiments/simulation-fixtures.cjs`: PASS — lone L-jog drains 1/1,
  loaded elbow drains 87 grains with lubricant off and on, sealed bed averages
  below 5 px/s, and 0.5× stress is bounded and repeatable.
- `node experiments/air-scale-fixtures.cjs`: PASS — at 1× the standard grain
  stays within 2 px of its start after 1 s, the light grain rises 246 px, and
  the heavy grain falls 45 px; at 2× the light grain rises 283 px.
- `node experiments/packed-flow.cjs`: PASS — the jog drains 87–88 of 120
  grains. The six-cell level run never drains dry but drains 217–219/240 with
  lubricant 0.5–2; closed horizontal transport remains dependent on geometry
  and cannot be promised for every isolated particle.

Next step: if another in-game valve arrangement still traps a lone grain,
record its exact valve type, orientation and grain center, then add that layout
as a geometry-specific fixture before changing the solver again.
