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
- Not verified in a browser (none in this sandbox): the pixel ramp, legend and hover label were checked with an offline raycast of the same geometry, mask and ramp instead.

## Next step

Calibrate rather than add: measure the momentum flux the field delivers to walls and grains so the ramp can carry a physical unit, and validate compression/equalization against analytical seams at two grid resolutions before considering a GPU backend. Until then the field is a normalized relative potential and the legend stays relative.
