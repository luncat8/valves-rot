# Vent mode correction: random-map routes

## Review

The earlier Vent implementation was based on a dedicated borrowed column and a
`hollow-straight` pocket. That did not match the requested mode. It replaced
ordinary map cells with easy straight pipes, assumed every player's mouths
belonged on the same column, and used the wrong collector type. This correction
supersedes that design.

## Implementation

- Kept the normal seeded random field and each existing valve's type. Setup
  searches routes through existing valves, changing only the orientations
  needed to connect a source/vent pair to a tee/cross junction and a
  `hollow-single` collector with a seeded random quarter-turn. It tries branch
  paths for the second source/vent pair; if topology prevents a branch, those
  extra controls stay at random free boundary mouths.
- Added route-cell snapshots rather than whole-column snapshots. Shared route
  cells restore in reverse order; mode exit returns every changed cell's type,
  chamber, world orientation, tint, lock and owner.
- Gave each of one or two seats two randomly placed bottom-band sources and two
  randomly placed top-band vents, matching Game mode's `2 in` / `2 out` layout.
  Each pair uses distinct columns, with source and vent columns drawn
  independently; only the owner can press the four mouths. `canTurn` still rejects every valve, while the normal `5%` auto-rotation
  pool remains active.
- Replaced the tiny pressure text with a larger readout beside the canvas: live
  pressure and requested range are numerically labeled, and a horizontal scale
  shows the requested band plus a high-contrast marker for current pressure.
- Kept pressure regulation on the grid-gas backend and drained grains on entry.
  Target bands fit within the pressure reach measured after route setup, even
  when random-route interactions produce a narrower span.
- Updated the mode hint, help, README, route plan, fixtures and balance survey so
  none describes the superseded dedicated-column rig.

## Validation

- `node experiments/vent-fixtures.cjs`: random valve types are preserved,
  collectors are `hollow-single`, four mouths per seat are distinct and owned,
  target bands fit measured reach, player valve input is refused, seat changes
  work and the lab map is restored exactly.
- `node experiments/vent-balance.cjs`: one- and two-seat coverage and exact
  restore across seeds `7`, `21`, `99`, and `2024`.
- `node experiments/render-smoke.cjs`: mode UI, 5% auto-rotate, mouth-only
  interaction, collector selection, roster controls and return to Lab.
- Regression fixtures passed: geometry, simulation, gas, pressure propagation,
  air, calibration and Game mode.

## Latest verification

- Re-ran Vent fixtures and balance survey on seeds `7`, `21`, `99`, and `2024`;
  each surveyed one- and two-seat game got reachable collectors and exact map
  restoration. The fixture asserts unique columns within each mouth pair.
- Expanded the render smoke test to check the large live-pressure / requested-
  range labels and the target-band/current-marker scale; all render smoke checks
  pass alongside geometry, simulation, gas, pressure propagation, air,
  calibration and Game regression fixtures. `git diff --check` is clean.
- Ran all-bot Vent simulations for 20 seconds on those four seeds: bots completed
  `1`, `3`, `1`, and `2` pressure rounds respectively, using only their mouths.

## Next step

Manually exercise human mouth control and inspect the readout at narrow/mobile
viewports; the current smoke test verifies markup and wiring, not visual fit.

## Stable routes and readable status

- Review found that planned routes and collectors could auto-rotate after the
  initial reach measurement, and later seats could reorient earlier routes.
  Lock planned cells during Vent play and preserve shared cells' orientation;
  restore original locks on exit. Reserve space for later seats by dealing the
  first seat's extra mouths without optional branches in two-seat games.
- Removed the tiny bottle target tag; the side widget retains the range.
- Verified stable source and vent connectivity, including after 20 seconds,
  exact restoration, Vent balance and render smoke. Geometry, simulation, gas,
  pressure propagation, air, calibration and Game fixtures also passed.
- Investigated `f237a20`: branch `old` points at this commit. It and current
  main each have one different commit after common parent `4dd8c5b`; both are
  alternative Vent implementations. History alone does not establish whether the
  branch was intentional, so it was left untouched.

## Next step

Play-test two-seat pressure control: the shared field can narrow the measured
reachable range, and the extra mouths are not guaranteed to have a route.
