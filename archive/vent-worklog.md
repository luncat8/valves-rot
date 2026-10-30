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
  needed to connect each pair of mouths to a tee/cross junction and a
  `hollow-single` collector with a seeded random quarter-turn.
- Added route-cell snapshots rather than whole-column snapshots. Shared route
  cells restore in reverse order; mode exit returns every changed cell's type,
  chamber, world orientation, tint, lock and owner.
- Gave each of one or two seats a distinct source and vent mouth pair. Mouth
  polarity is independent of which external band the mouth occupies. Players
  can press only their own mouths; `canTurn` still rejects every valve, while
  the normal `5%` auto-rotation pool remains active.
- Kept pressure regulation on the grid-gas backend and drained grains on entry.
  Target bands fit within the pressure reach measured after route setup, even
  when random-route interactions produce a narrower span.
- Updated the mode hint, help, README, route plan, fixtures and balance survey so
  none describes the superseded dedicated-column rig.

## Validation

- `node experiments/vent-fixtures.cjs`: random valve types are preserved,
  collectors are `hollow-single`, mouths are distinct and owned, target bands
  fit measured reach, player valve input is refused, seat changes work and the
  lab map is restored exactly.
- `node experiments/vent-balance.cjs`: one- and two-seat coverage and exact
  restore across seeds `7`, `21`, `99`, and `2024`.
- `node experiments/render-smoke.cjs`: mode UI, 5% auto-rotate, mouth-only
  interaction, collector selection, roster controls and return to Lab.
- Regression fixtures passed: geometry, simulation, gas, pressure propagation,
  air, calibration and Game mode.

## Next step

Measure manual control and bot behavior across different random route topologies;
retune the bot pulse policy only if it can be made to respond without changing
valve types or making the routes easier.
