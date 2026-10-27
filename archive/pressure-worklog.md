# Kinetic pressure prototype

## Review

The prior grain changes keep collision geometry independent of rendering and use a fixed grain clock, providing a clean pressure hook before grain integration. The existing pressure plan already captures both requested models and the independent drawing checkbox. No changes to the grain contact or skin policies were necessary.

## Changes

- Added optional `pressure.js`: deterministic 900-particle air population, small swept discs, elastic stationary-wall reflection, rotor wall velocities and reciprocal elastic grain impulses through preallocated grain bins. Air has no gravity, injection or drain accounting. No air-air collisions in this dilute kinetic prototype.
- Added pressure radio group (Off default, Air particles, disabled Grid gas planned) and independent drawing checkbox. Kinetic drawing is a qualitative cyan particle-population preview, not scalar pressure. Existing geometry debug overlay and black/white background remain independent.
- Mode changes preserve grain arrays, counters and rotor targets. Reset/layout/replacement rebuild optional air state. End caps reflect air, including at grain inlet/outlet bands; no implicit reservoir or thermostat.
- An extreme-speed ceiling dissipates driven-wall energy. Ordinary grain exchanges conserve momentum/energy; the ceiling is intentionally not a physically calibrated conservation policy. Swept geometry protects walls; short substeps protect grain contacts.
- Expanded standalone pressure plan with staged accuracy, scalar wall-flux visualization and CPU grid acceptance. No GPU work before measurements.

## Validation

- `node experiments/pressure-fixtures.cjs`: grain pushing, reciprocal momentum and elastic energy exchange, static-wall speed preservation, sealed chamber containment, switching and pressure-off trajectory equivalence. Three simulated seconds of turning seed 7: 900 air, 2,447 grain contacts, finite state and bounded speed; 2.69 ms/60 Hz including assertions on Node v22.22.3 in this sandbox (not a browser guarantee).
- `node experiments/render-smoke.cjs`: script order, particle mode, drawing checkbox and switching controls execute under recording canvas/DOM stubs.
- `node experiments/simulation-fixtures.cjs` and `node experiments/geometry-fixtures.cjs` pass after integration; default pressure-off behavior retained.
- Not verified in a real browser: pixels, animation smoothness, file-protocol interaction and narrow-screen control wrapping.

## Next step

Validate moving-wall compression, air containment/recovery and long-run energy across populations; add time-averaged wall momentum-flux pressure coloring. Then implement the CPU-grid solver and enable its radio only after sealed-seam and conservative-flux fixtures pass. The kinetic prototype is not a complete calibrated pressure model.

# Inlets and the standing gradient

## Review

The kinetic prototype met its own gate but could not answer the question it was built to answer: with one closed population and reflecting ends there was no boundary value, so the "pressure" overlay was an even cyan dust and the walls were both source and sink. The plan's Overlay section already asked for a scalar ramp; what it lacked was a reason for the field to have a direction. Hence constant inlets first, then the scalar backend they make meaningful.

- `pressure.js` only ran the kinetic model; its `create`/`step` were reached through the simulation switch, so a second backend needed an interface, not more branches.
- The `pressure` state was a bare object with an implicit mode, which made "switch backends" and "off" indistinguishable from "recreate".

## Changes

- `inlets.js`: one mouth per column per band (bottom = constant high pressure, top = constant low pressure), open by default, click to seal, Shift-click to swap polarity. Mouth state has a version counter so a backend re-pins only when something changed.
- `gas.js`: the CPU grid backend. 6 px cells, air mask and open faces from `airClearance`, and pressure as the ratio of two porous path distances (one fast-sweeping pass per boundary set). Air costs 1, metal 6, grain-filled cells up to 4, so passages are fast lanes, a shut seam only trickles, and the bottom-to-top gradient survives rotor turns. Darcy velocity inside air only, central difference over two cells; grains feel it as drag. Rebuild at most every 1/30 s and only when a rotor moved, so a settled field is free.
- `air.js`: renamed from `pressure.js` (the module is the particle model, not "the pressure"). Added the reservoir circuit: air that reaches an open vent is moved to a random open source aimed into the field, at a rate set by the number of open source/vent pairs. The population stays constant and the cycle count is reported.
- `simulation.js`: `pressureMode`, `pressureFor` and `toggleInlet`; backends are dispatched by mode instead of calling one module. Reset restores the default mouths; layout and valve replacement rebuild the selected backend.
- `render.js`: texel-per-cell scalar field with a blue-cyan-amber-red ramp over the passages only, a low/high legend, and mouth markers (arrow in = source, arrow out = vent, cross = sealed) with a hover label. Markers draw under the grain piles that share the bands.
- `app.js`/`index.html`: Grid gas enabled and default, drawing on by default, pointer routing to mouths before valves, field map reused across frames.

## Validation

- `node experiments/gas-fixtures.cjs`: standing gradient 0.93 bottom / 0.10 top with the default mouths, 1.00/1.00 with every vent sealed, no pins and a finite field with every mouth sealed, inverted 1.00/0.05 with all polarities flipped, a sealed source dropping its own mouth, normalized pressure and bounded gas speed, mask rebuild on rotor turns, drag along the local gas velocity, and 0.58 ms per 120 Hz step against 0.26 ms with pressure off.
- `node experiments/air-fixtures.cjs` (renamed): previous kinetic checks plus mouth toggling and the reservoir circuit — 70 recycles in three simulated seconds, no cycles with every mouth sealed, air and grain counts constant.
- `node experiments/render-smoke.cjs`: loads the four modules, paints the scalar field over the full field rectangle, and hovers/clicks a band mouth while paused without turning a valve.
- `geometry-fixtures`, `simulation-fixtures`, `behavior-probe` unchanged and passing; pressure off keeps identical grain trajectories.
- Ten simulated seconds of seed 7 with grid gas: mean grain speed 45 px/s against 86 px/s with pressure off, no lost grains, no wall penetration, 256 mask rebuilds.
- `experiments/simulation-bench.cjs` now times both backends at three grain loads (`experiments/logs/simulation-pressure.txt`): 120 × 130 grid cells, 3,300 air cells, 1.31 ms/60 Hz settled and +0.8 ms with every rotor turning; 900 air particles cost 2 to 2.5 ms/60 Hz more than pressure off because of air-grain contacts. No retained heap growth.
- Not verified in a browser (none in this sandbox): the pixel ramp, legend and hover label were checked with an offline raycast of the same geometry, mask and ramp instead.
- Mouths are clickable while paused (the field re-pins and re-solves immediately) and a manual quarter turn re-solves too, so a still frame still answers a click.

## Next step

Calibrate rather than add: measure the momentum flux the field delivers to walls and grains so the ramp can carry a physical unit, and validate compression/equalization against analytical seams at two grid resolutions before considering a GPU backend. Until then the field is a normalized relative potential and the legend stays relative.

# Making the air push

## Review

The first pressure slice was honest about being a field, but the field barely reached the grains, and the visible result was a colour map with grains that fell as if the air were not there. Three separate reasons, found by measuring one dropped grain instead of the whole machine:

- The coupling sampled the gas cell at the grain centre and skipped anything whose cell was metal. A grain resting on a wall or under a rim — which is most of what is visible in a pile or in a mouth — is exactly such a cell, so it felt nothing.
- The force was velocity drag only. Drag vanishes when the relative velocity does, so it could slow a fall but never lift a resting grain.
- While fixing the scale I dropped the `/(2 * CELL)` divisor from the central difference, which saturated the whole field at the speed cap: a uniform gale, uniform lift, and grains levitating at the top of the field.

## Changes

- Gas velocity is now the gradient divided by a crossing cost that is fill throttle times tightness (1 / clearance), so the pressure drop concentrates at valve mouths and seam gaps and the gas streams through them like a nozzle while open chambers stay nearly isobaric. The field is capped, and openness is sampled once per mask rebuild.
- Two grain couplings, both scaled by the new air-force slider: drag toward the local gas velocity, and the pressure force along it. A grain in a metal cell samples the nearest air cell. Air is excluded from the reservoir bands so a full pour spout can still feed the machine.
- Air-force slider (0-2, default 1). At 0 the grain path is bit-identical to pressure off, which the fixture asserts.
- Particle backend: air mass raised from 0.6 to 3 (a 2.7 px grain is r^2 = 7.3) so impacts are not invisible; the slider scales the impulse the grain receives without making the particles heavy.
- `gas.js` exposes `sampleCell`, `GAS_MAX`, `SPEED_SCALE`, `DRAG`, `LIFT`; the unused normalisation-by-mean-gradient code is gone.

## Validation

Tuned against single-grain probes rather than whole-field averages, sweeping `SPEED_SCALE` 115k-600k, `DRAG` 0.55-1.5 and `LIFT` 0.2-1.6, then confirming that transport survives. A grain dropped 30 px through an open chamber (`experiments/logs/simulation-pressure.txt`):

| setting | fall time | lateral drift |
| --- | --- | --- |
| pressure off | 0.32 s | 0.0 px |
| grid, air force 0 | 0.32 s | 0.0 px |
| grid, force 0.5 | 0.42 s | 5.6 px |
| grid, force 1 | 0.71 s | 13.2 px |
| grid, force 1.5 and up | hovering in the updraft | 6 px |
| particles, force 1 | 1.30 s | 4.3 px |
| particles, force 2 | hovering | 17.4 px |

- Chosen defaults: `SPEED_SCALE` 180000, `DRAG` 1.35, `LIFT` 1.15, particle mass 3. A weaker default (0.9 / 0.8) measured only 0.42 s and 5 px of drift, which is what "visually nothing" looked like.
- Transport at force 1 over 60 s across five seeds: 48 grains drained against 51 with pressure off, so the stronger air speeds the machine up slightly rather than jamming it. At force 2 it drops to 11 drained: pinned into the upper half. That is intentional headroom on the slider, not the default.
- `node experiments/gas-fixtures.cjs` now asserts the coupling: force 0 equals dry exactly, force 1 is at least 1.5x slower with at least 4 px of drift, force 2 is slower still or hovering, and particle mode is at least 1.5x slower with contacts recorded.
- `air-fixtures` and `render-smoke` cover the slider wiring and the conserved air population; `geometry-fixtures`, `simulation-fixtures` unchanged and passing.
- Cost unchanged in practice: 1.6 ms/60 Hz with the field settled, 0.6 ms of that the field, and no retained heap growth.

## Next step

Reciprocity: a dense pile should damp the flow it sits in, not only be lifted by it. That needs a grain-to-field feedback term (fill already throttles the flux, so the missing piece is charging the field's momentum, which means giving the pinned reservoirs a way to absorb it) and a fixture that measures a pile's own pressure drop across its thickness.
