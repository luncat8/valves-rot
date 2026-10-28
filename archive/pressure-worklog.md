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

# Reciprocity: piles resist the air

## Review

The one-way coupling made a pile levitate in an updraft that never noticed it. Two independent reasons, both visible on a frozen packed chamber:

- `update()` ran only when a rotor moved or a mouth changed, so `measureCost` was dead after create. A grain that had fallen still occupied its launch cell; a pile that formed later occupied nothing.
- Fill cost in the distance-ratio potential does not throttle local speed. `p = d_low / (d_high + d_low)` makes `∇p` scale with cost on the only path, and Darcy then divides by the same cost, so a packed cell drops pressure (empty chamber Δp 0.027, packed 0.071) while still flowing at 88% of the empty speed. Cranking `FILL_COST` cannot make a plug. Unused `gain`/`lift` fields and a `maskClock` that never advanced on a still machine were leftovers of that incomplete coupling.

## Changes

- Occupancy and Darcy re-solve on the 1/30 s mask clock even while rotors are still; the mask itself still rebuilds only when a rotor has moved. `maskClock` always advances, so a still field is not reswept every substep.
- Gas velocity is state. Interior cells relax toward Darcy (`RELAX` 0.2 per tick) and pay the impulse they deliver to grains (`CELL_MASS` 1, equal to a grain). Pinned mouths snap to Darcy and so supply or absorb that momentum. A falling grain keeps meeting fresh cells; a sitting pile drains the same ones.
- `experiments/gas-fixtures.cjs` measures a packed hollow chamber against an empty one: pressure drop across the pile, flow after frozen gas steps, live fill on a still machine, and the existing single-grain drop.

## Validation

- Frozen packed chamber (52 grains, valve 44 hollow): Δp 0.071 vs 0.027 empty; after 0.4 s of `GAS.step` (grains held still) mid-chamber speed 124 vs 175 empty and vs 154 at create; `gain` 5e3 vs 0. Live fill: a grain added after create occupies its cell on the next mask tick.
- Single-grain 30 px fall unchanged in character: 0.32 s dry and at force 0 (bit-identical), 0.52 s / 8 px drift at force 1, hovering at force 2, 1.30 s with particles.
- `node experiments/gas-fixtures.cjs`: standing 0.93/0.10, sealed and flipped inlets, pile Δp 0.071 vs 0.027, flow 124 vs 175, drop times above. Grid stays under 3× pressure-off per 120 Hz step on Node v22.22.3 in this sandbox.
- `node experiments/air-fixtures.cjs`, `simulation-fixtures.cjs`, `render-smoke.cjs` pass; pressure off keeps identical grain trajectories.
- Not verified in a browser: the overlay now recolors a still pile on the occupancy clock, which was only checked through the scalar field, not pixels.

## Next step

Calibrate rather than add: measure the momentum flux the field delivers to walls and grains so the ramp can carry a physical unit, and validate compression/equalization against analytical seams at two grid resolutions before considering a GPU backend. Until then the field is a normalized relative potential and the legend stays relative.

# Reference-calibrated air ramp

## Review

The grid's distance ratio is a dimensionless potential, not a pressure measurement: the distance sweep passes through costly metal, and it has no mass-conserving compression or equalization. The previous face mask sampled only endpoints and a midpoint; an offset closed rim could fall between those samples and leave an open velocity face. Also, sealing every mouth left stale colors visible despite the absent boundary reference.

## Changes

- Added one-second kinetic wall-impulse windows, excluding recovery nudges and speed-cap impulse. A grain interception no longer produces a phantom wall reflection, and separating overlaps no longer pin air particles to grains.
- Calibrated an editable equivalent-gauge-Pa ramp from a reproducible, sealed kinetic reference chamber. The display explicitly remains a scaled relative potential; editing the span changes no simulated force. A visible, accessible text range accompanies the canvas legend, which draws above grains. With no open mouth, the unanchored grid and legend are hidden.
- Checked centre-to-centre gas links at geometry-sweep spacing, with an adaptive clearance shortcut. This blocks the missed shut-rim face without claiming that the distance-ratio potential respects closed walls.
- Added `water-plan.md`: top water inlet, volume/level, distinct grain densities and buoyancy in phase 1; falling-water particles are deferred. No water simulation was implemented.

## Validation

- `node experiments/calibration-fixtures.cjs`: 16,055 actual wall hits over 20 s give 0.7125 Pa against 0.7187 Pa circular-chamber theory under the documented reference units. Impulse, windows, SI scaling, speed-squared, population scaling, recovery and intercepted-wall cases pass. The 1-D serial-seam maximum potential errors are 0.0174 / 0.0101 at 6 / 3 px; rim-aligned aperture errors total 11.27 / 5.14 px. Geometry sweeps verify 16,965 actual rotated-grid faces and a previously missed shut rim. The independent sealed-wall diagnostic reports 0.111 potential error, so the ramp remains equivalent, not physical pressure everywhere.
- An additional 50 rotated seeds checked 210,339 open grid faces against geometry sweeps with no blocked links.
- `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `gas-fixtures`, `air-fixtures`, `render-smoke` and `behavior-probe` pass. One run of `gas-fixtures` measured 0.623 ms/grid step vs 0.240 ms/off at 120 Hz on Node v22.22.3; this is not a browser performance guarantee.
- `node --expose-gc experiments/simulation-bench.cjs` on the same Xeon 2.60 GHz sandbox: turning grid/off at 120 grains 1.65/0.78 ms per 60 Hz frame and at 1,000 grains 7.33/5.92 ms; seeded grid 1.44 ms/60 Hz. The dry retained-heap probe showed no growth.
- Headless Chromium opened the page via `file://` with no browser errors. Checked span editing/invalid input/reference reset, sealing and reopening all mouths, mode switching, pause/step, and desktop, 375 px mobile and 800 × 400 landscape layouts. The numeric range stays readable outside the scaled canvas.

## Next step

Implement the planned water-level and density/buoyancy phase first, preserving water volume across closed seams; leave falling-water animation for the deferred stage. Actual local gas pressure and simultaneous air/water coupling require a validated conservative, time-dependent model.

# Grid gas: a field with a reference, and a readable change

## Review

The solver produced a plausible ramp, but three parts of the user-facing behaviour were wrong, and one of them was a real physics bug.

- A sealed band produced a constant. With every top mouth shut the distance ratio degenerates to `d_low / (d_high + d_low)` with `d_high` infinite, which is exactly `1`; with every bottom mouth shut it is `0`. So "close all vents" flooded the overlay to a single colour, and it arrived on the next solve. The fixture even asserted this as intended (`sealed vents hold source pressure`).
- The distance pass ignored the face mask. The potential could step from one air cell to the next across a shut rotor rim, while the Darcy stencil refuses the same link. The overlay therefore showed gradients the gas could not follow, and a turned rotor barely moved the field (10 turned valves moved the mean potential by 0.011).
- A solved field replaced the shown field on the same tick. Every mouth click and rotor turn was a repaint, so nothing in the overlay read as a consequence of an action.
- `renderField` keyed on `pins` rather than on the existence of a difference, and the app kept its own legend state in step with the same wrong predicate.

## Changes

- `gas.js` reports `anchored = sources > 0 && vents > 0`, along with the two counts. Without a difference the field carries no flow and the overlay is hidden; `pins` stays for compatibility. The legend names the missing side.
- The distance sweep only crosses an air-to-air link when `face` has it, so the potential and the velocity agree about what is open. Metal stays traversable at a raised cost (`METAL` 6 -> 12), which localizes the field: 10 turned valves now move the mean potential by 0.034 instead of 0.011, and the overlay reads as cells reacting to the valve over them rather than as a global top-to-bottom gradient.
- `SWEEPS` 2 -> 3 for the heavier metal cost: against a 12-sweep reference the mean error is 0.3% and the maximum local error 0.10, where two sweeps leave 0.21.
- The shown potential eases toward the solution: pinned mouth cells snap, the rest close 30% of the gap per 1/30 s tick, so a change takes about a third of a second. The velocity state follows the shown potential, so the push and the colours stay consistent.
- The overlay alpha eases out when the field loses its reference instead of cutting, and `renderField` reads `anchored`.
- Skipping work: `measureCost` reports whether any cell's occupancy changed, and the sweeps are skipped when the mask, the mouths and the occupancy all stand still. Metal cost is written once per rebuild. An idle machine now costs only the velocity blend.
- `simulation.js` exposes `settlePressure` and the page frame loop calls it while paused, so a paused overlay still answers mouth clicks and rotor turns.
- `game.js` treats `anchored` as the pressure-quest precondition, and the mouth bots (below) were rewritten around it.
- `gas.js` `probeMouths` solves a hypothetical mouth set into the target buffer; `game.js` uses it at signing to fit a pressure quest to what its cell can actually reach.
- Fixtures: the gas fixture's "sealed vents hold source pressure" became "one polarity leaves the field unanchored", plus reopening a source and a vent, a rotor turn moving at least 20 cells, and an idle machine skipping the sweeps. Calibration builds its 1-D fields with explicit `air`/`face` masks. The game fixture gained a fitted-threshold quest, and now asserts that a sealed field never satisfies one. Render smoke asserts the fade and the new legend text.

## The mouth policy that follows

`anchored` changes what a pressure quest is. The old bot shut every mouth of the opposing band, which now removes the reference, so the target potential becomes literally undefined. The new policy keeps the field defined and moves the drop instead:

- Keep the farthest mouth of the opposing band open as the reference.
- Open the favourable band near the goal.
- Shut the opposing mouths nearest the goal first, one per action.

Measured over one second per action, that recipe lifts a central cell from 0.48 to 0.77 (sealing the whole top band gives 0.81 but no field at all) and drops it to 0.39. Across the central rows the reachable range is roughly 0.08-0.54 below the baseline and 0.54-0.92 above it, so a fixed `> 0.72` threshold was frequently unreachable in a given cell. `fitPressureQuest` now solves both best mouth sets, keeps the polarity with more headroom, and puts the threshold 60% of the way from the current potential to that extreme; an unfitable quest falls back to the baseline, so it is never trivially satisfied.

## Validation

- `node experiments/gas-fixtures.cjs`: standing 0.94/0.11, sealed and flipped inlets, unanchored with one polarity, re-anchored by one source plus one vent, a rotor turn moving 100+ cells, idle machine skipping the sweeps, pile Δp 0.057 vs 0.021, flow 109 vs 156, a 30 px fall 0.32 s dry / 0.51 s at force 1 with 9.6 px drift / hovering at force 2 / 1.29 s with particles; 0.28 ms off vs 1.03 ms grid per 120 Hz step on Node v22.22.3 with every rotor turning.
- `node experiments/game-fixtures.cjs`: quest generator, hold/blank seal, an unfitable `> 0.95` quest refitted and completed by the bot recipe, bots completing 3 quests (85 pts) over two seeds.
- `node experiments/calibration-fixtures.cjs`, `air-fixtures`, `simulation-fixtures`, `geometry-fixtures`, `geometry-check`, `behavior-probe` and `render-smoke` pass. The 1-D serial-seam and aperture errors are unchanged; the closed-wall potential error remains 0.111, which is the heuristic's documented limit.
- Not verified in a real browser (none in this sandbox). Overlay pixels were checked by rasterising the same mask, potential and ramp to PPM and comparing the four states: default, all vents sealed, one mouth toggled and a turned valve. `experiments/logs/grid-gas-fix-0.2.webp` is that comparison at half scale: the old field top (standing gradient, then one flat red after the vents closed), the new field bottom (standing gradient, then no field at all).

## Next step

The field is now localized enough that a quest could ask for a *gradient* rather than a level (a drop across two neighbouring bottles), which is what the model actually measures well. Before that, give the legend a second reference for a fully sealed machine: the current "no through-flow" state is honest but gives a player nothing to aim at.

# Grid gas: constant-pressure mouths and a real transient field

## Review

The previous stage fixed the symptom by hiding the overlay. The model itself was still wrong: `p = d_low / (d_high + d_low)` is a distance ratio that needs both polarities, leaks through metal, and is recomputed instantly. The user reported that closing all vents made the whole field one colour immediately, and that the tests were validating the faulty implementation. A sealed machine must keep its air, not repaint.

## Changes

- `gas.js` replaced: 6 px air cells, open-face conductance graph, connected components, band cells outside the 10x10 field pinned to `1`/`0` while their mouth is open, sealed mouths unpinned. One backward-Euler diffusion step per 30 Hz mask tick, solved by Jacobi-preconditioned conjugate gradient on a compact unknown list (up to 400 sweeps; steady startup/snap/quest probes up to 700). Metal and shut rims have zero conductance; a component with no mouth holds its pressure. Gas velocity comes from face flux; piles lower conductance and take reciprocal impulse. Removed `solvePotential`, `anchored`, the SOR sweeps and the distance-ratio buffers.
- A mouth click or rotor turn re-pins/rebuilds at once but does **not** solve; the next mask tick carries the front. `simulation.js` uses a new `GAS.repin` for inlet changes. A settled machine skips the solve. A paused page keeps the mask clock running.
- `render.js` and `app.js`: the overlay and its Pa-equivalent scale stay visible for any grid state, including a fully sealed machine. The legend names `all mouths sealed`, `no source open` or `no vent open`; stats show mean pressure, flow and `sealed`.
- `game.js`: pressure quests install a four-way `hollow cross` bottle and open a shaft of `solid cross` valves in its column, so the bottle has a real route to both bands. `probeMouths` solves the bots' mouth recipe; `fitPressureQuest` snaps the live field, fits the threshold 60% of the way to a reachable extreme and keeps the quest uncommitted at spawn. Sealing every mouth freezes the field, so a quest cannot advance until a boundary reopens.
- Rewrote `experiments/gas-fixtures.cjs` and the grid half of `experiments/calibration-fixtures.cjs`; updated `game-fixtures.cjs`, `render-smoke.cjs` and `simulation-bench.cjs`. New checks: constant-pressure boundary cells, linear steady gradient on a connected machine, sealed field with zero pressure change, 1-D front propagation, valve-gated chambers, no leak through metal, analytical serial seam, closed-wall isolation, huge implicit step stability, pile conductance, grain coupling and cost.
- Rewrote `pressure-plan.md`, README, Help drawer, `findings-pitfalls-skills.md` and small stale comments. `index.html` now documents mouths as cells outside the field and the pressure-quest air shaft.

## Validation

- `node --check` on every file; `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `air-fixtures`, `calibration-fixtures`, `gas-fixtures`, `game-fixtures`, `render-smoke` all pass on Node v22.22.3.
- `gas-fixtures`: 200 pinned band cells, 1 component / linear 0-1 gradient on a connected machine, sealed field keeps 1.00 of its colour with exactly zero pressure change and flow <1 px/s, 1-D front and steady linear profile, valve gating, pile flow 71 vs empty 97 px/s, 30 px fall 0.32 s dry / 0.48 s at force 1 / hovering at force 2 / 1.69 s with particles and 3.9 px drift; 0.247 ms off vs 0.913 ms grid per 120 Hz step.
- `calibration-fixtures`: steady serial-seam errors 2.98e-7 / 5.96e-7 at 6/3 px, a `1e6` implicit step converging without overshoot, metal splitting a row into two exact boundary values, 16,969 real faces checked against geometry sweeps, 0.7125 Pa reference vs 0.7187 Pa theory.
- `game-fixtures`: fitted quests start uncommitted, a sealed field freezes and never satisfies a quest, the mouth recipe completes it, bots complete 3 quests (85 pts). `render-smoke`: sealed grid still draws 103 images/frame with the ramp and legend; texels follow live pressure.
- `simulation-bench`: grid 1.87 ms/60 Hz with 3,312 air cells and 148 mask rebuilds; coupling on a mouth-connected chamber 0.32 s dry / 0.48 s at force 1 / stalled at force 2.
- Not verified in a real browser (none in this sandbox); `render-smoke.cjs` exercises the page through a DOM/canvas stub, including span editing, inlet toggles, mode switching and the legend.

## Next step

Profile a finer 3 px grid with aperture-based face conductance: the current 6 px centre-sampling mask still misses sub-cell seam openings (aperture errors 11.27 / 5.14 px in the calibration fixture). A multigrid preconditioner would cut the 700-sweep steady solve needed by long corridor chains before increasing resolution.

# Faster fronts through pipes, and rotation in the gas

## Review

The pressure model from the last stage was correct but two of its behaviours did not survive contact with the corridor graphs the game actually builds.

- Propagation was solver-starved, not slow: Jacobi-preconditioned CG needs one sweep per corridor cell, so on long chains it hit the 400-iteration cap every tick and exited with residual 2e-3 (measured: the serpentine probe capped on every early tick and crawled for 60+ ticks). The visible "front" was partly the iteration budget walking outward, which is also why the planned multigrid preconditioner seemed necessary.
- The mask clock was compared as `clock - maskClock < 1/30`, so frame-dt rounding dropped every other tick on alternating frames (measured 15 Hz effective tick rate under steady 1/30 s settling) — front speed depended on frame timing.
- Grid gas ignored rotor rotation entirely. The particle backend reflects off moving rotor walls with `omega x r` (`air.js`), but grid velocity came only from pressure flux: a spinning rotor moved no air, and a sealed machine had no coupling at all, so the two backends disagreed about the same physical event.

## Changes

- **IC(0) preconditioner (`gas.js`)**: the factor shares the 5-point stencil, so its diagonal is fused into the unknown-list build (lower neighbours already carry their factors; pinned mouths are eliminated, not divided by) and each preconditioner application is two allocation-free sweeps over the same list. It is exact along a 1-D pipe: a scrambled 301-cell chain solves in one PCG step. Jacobi division is gone from both apply sites; the caps, tolerance and warm start are unchanged.
- **`DIFFUSE_DT` 2400 → 1200**: with a converged solve, the front profile on a connected machine is 6% → 100% coverage over nine mask ticks (~0.3 s) instead of either an iteration crawl or an instant repaint, and the settle tail is ~0.6 s.
- **Mask clock keeps phase**: `maskClock += MASK_DT`, dropping only a backlog larger than two periods (pause/seek), so ticks run at 30 Hz regardless of frame rounding.
- **Rotor swirl, no inertia**: `velocity()` now takes `sim` and adds the rigid wall velocity `omega x r` inside any turning rotor disc to the target velocity, alongside the pressure flux; the existing easing and `GAS_MAX` cap apply. The velocity array is re-derived every mask tick, so the swirl follows the sign of omega and dies within a few ticks of the rotor stopping — no momentum state anywhere. `drag()` no longer requires an open mouth: rotation, not the pressure boundary, is what stirs the air, so only the force slider gates the grain coupling.
- Fixtures, `pressure-plan.md`, README, the Help drawer and `findings-pitfalls-skills.md` updated; `experiments/front-probe.cjs` kept as the front/iteration diagnostic.

## Validation

- New `gas-fixtures` gates, each verified to fail on the previous build: a scrambled 301-cell pipe steady-solve in ≤10 sweeps (old: 291) with linear error <1e-4; ten full-strength ticks filling a 121-cell pipe to <0.1 error; a mouth change crossing a connected machine within 15 mask ticks with no solve at the 400 cap; swirl on a fully sealed machine — mean tangential disc velocity +25 px/s at omega +2.4, -17 px/s reversed, decaying below 35% within 8 ticks of omega 0 (old code: 0.00 px/s in every case), while `pins == 0`.
- All fixtures pass on Node v22.22.3: `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `air-fixtures`, `calibration` (serial-seam errors unchanged at 2.98e-7 / 5.96e-7), `gas-fixtures`, `game-fixtures` (bots 2 quests / 60 pts), `render-smoke`, `behavior-probe`.
- Cost: off 0.23 ms vs grid 0.89 ms per 120 Hz step (budget 3× headroom); steady solves ~0.7 ms; `simulation-bench` grid 1.69 ms/60 Hz (was 1.87) with 169 rebuilds; coupling unchanged — 0.32 s dry, 0.49 s at force 1, stalled at force 2.
- Front-profile and iteration measurements: `experiments/front-probe.cjs`, numbers in `experiments/logs/grid-gas-rotation-0.2.txt`.
- Not verified in a real browser (none in this sandbox); the swirl and front were checked through the scalar field and fixtures only.

## Next step

The remaining propagation caveat is still resolution, not the solver: the 6 px centre-sampled mask misses sub-cell seam openings (aperture errors 11.27 / 5.14 px). A finer grid with aperture-based face conductance can now lean on IC(0) directly instead of needing multigrid first. On the visual side, the swirl is local to the disc by construction — carrying it one step into the adjacent corridor as a divergence-free advection would be the next increment if a spinning rotor should visibly push air down a pipe.

# Aperture faces: pressure that survives a turning machine

## Review

The previous stage fixed the solver and the clock, but it validated the mask only at valve detents. Two behaviours did not survive contact with a turning machine.

- The face test sampled the **centre line** between two cell centres. A rotor seam is a slot centred on the port axis, and the cell centres sit up to 3 px to one side of it, so the centre line crosses the rim wherever the slot is not. Rotating all 100 valves by 0.113 rad (6.5°) dropped the mouth-connected air from 1743 cells to 40 and split the graph into 310 components; a 1.5 px flood fill of the same clearance predicate keeps 60.5% of the air connected throughout. Since auto-rotate leaves most valves mid-turn most of the time, the overlay read as "pressure does not reach the pipes" for a reason that had nothing to do with the solver or the front.
- The swirl added last stage stopped at the rim, so a turning rotor moved no air in the corridor its port opens onto: measured 0.00 px/s one cell outside an open port, against 25 px/s inside the disc. The particle backend drags air through the mouth; the grid backend did not.

## Changes

- **Aperture faces (`gas.js`)**. `openFace` is split into `throat` (smallest clearance sampled along a link, wide middles answered by one Lipschitz-bounded sample) and a boolean gate at `AIR_MIN`, so the centre-line test and its thin-rim guarantee are unchanged. `faceAperture` then measures the whole shared edge: if the centre line passes, the face is 1; if it is blocked, six lateral lanes are probed and each lane is decided by solving the link's crossings with the **rotor rim circle** — the seam slot is the only hole in that rim, and the blocked annulus is only ~1.5 px thick on each side, which is why a two-sample lateral probe found false links through shut rims and the exact crossings find none. The widest lane is confirmed with the full `throat` test, and the face carries `open lanes / lanes`, scaled by the slot throat against one cell.
- **Conductance** multiplies the harmonic mean of the two cell open-nesses by that aperture (`apR`/`apD`, one factor per shared face), so a part-open port throttles its link instead of switching it off; the solver, the IC(0) factor and the transient are untouched. A hand-built fixture graph defaults to fully open apertures.
- **Stamped geometry cache**: a cell's clearance depends only on its own valve and a face's aperture on its two cells' valves, so `rebuild` bumps one stamp per valve whose angle, type or chamber changed and re-samples only those cells (via a static cell→valve map) and faces. Nothing changed → the rebuild returns without touching the graph (0.08 ms); one rotor turning costs 0.41 ms, all 100 cost 2.9 ms. The cache has to store a closed aperture too — leaving the last open value behind let a shut rim come back to life on the next rebuild, which the new incremental-versus-fresh fixture catches — and a valve object carries its ports rather than the type mask, so the signature is built from `ports` and `kind`.
- **Swirl through the port mouth**: `velocity()` keeps the rigid `ω × r` inside the disc and now fades it linearly over one and a half cells outside the rim, but only inside an open seam's lateral span (`mouthOpenAt`). A turning rotor therefore stirs the pipe its port opens onto; a portless chamber still drags nothing outside its own wall.
- Fixtures: `gas-fixtures` gains "a small turn keeps the air graph" (two angle recipes, live cells within 10% and components within 15% of the aligned state), "a rotor turned past its ports still seals the chamber", and swirl gates for the port corridor, its stop and the portless chamber. Its cost gate now takes the best of three runs per mode: a scheduling hiccup on a loaded machine was deciding a ratio whose honest value sits near five. `calibration-fixtures` gains a quarter-open face reproducing its own serial resistance, and its link check now asks the honest question — every open face must have **a lane** that crosses no metal at `AIR_MIN`, not necessarily the centre one — over four rotation states, 17,038 faces, 73 of them off-centre.
- `experiments/aperture-probe.cjs`: mask against the 1.5 px reference per seed and rotation state, lane validity, rebuild cost. `experiments/aperture-picture.cjs`: the same machine's field from a reference git revision beside the working tree, written to `experiments/logs/grid-gas-aperture-0.2.png` (seed 7, all 100 rotors at 0.113 rad, 200 mouths open: a733b2d keeps 240 of 3511 air cells on a mouth in 310 components, the working tree keeps 2098 in 78, against 60.5% for the 1.5 px reference). Numbers in `experiments/logs/grid-gas-aperture-0.2.txt`. `pressure-plan.md`, README, the Help drawer and `findings-pitfalls-skills.md` updated.

## Validation

- `node experiments/gas-fixtures.cjs`: PASS. The lifted-seam gates fail on the previous build (aligned 1743 → turned 1158 cells / 109 components; the uniform-recipe gate 1743 → 40 / 310), and the corridor swirl gate measures 0.0 px/s there. New build: 1898 live cells / 78 components at 0.113 rad, corridor swirl 26.4 px/s outside an open mouth, 0.0 one reach further and 0.0 outside a portless chamber.
- `node experiments/calibration-fixtures.cjs`: PASS — serial seam errors unchanged (2.98e-7 / 5.96e-7), 17,038 real faces clear across four rotation states, 73 of them through an off-centre seam, 0 without a lane, quarter-open face profile error 1.99e-8 (mid span 0.313 vs 0.500 full bore).
- All fixtures pass on Node v22.22.3: `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `air-fixtures`, `gas-fixtures`, `calibration-fixtures`, `game-fixtures` (bots 3 quests / 85 pts), `render-smoke`, `behavior-probe`, `front-probe`.
- Front on a cross machine: 9 mask ticks aligned (unchanged), 12 with every valve at 0.12 rad and the machine still one component; no solve at the iteration cap.
- Cost: `gas-fixtures` measures 0.19 ms off vs 0.88 ms grid per 120 Hz step (the previous build measured 0.19 / 0.98 with the same procedure) and `simulation-bench` reports 1.84 ms/60 Hz with 120 grains (was 2.02). A rebuild costs 0.08 ms unchanged, 0.41 ms with one rotor turning and 2.9 ms with all 100, at most 30 times a second; the stamped cache more than pays for the aperture lanes.
- Not verified in a real browser (none in this sandbox); the field, the lanes and the cost were checked through the scalar arrays and a DOM/canvas stub.

## Next step

The remaining propagation limit is resolution, not connectivity: a lane still needs a cell-wide opening at `AIR_MIN`, so at 0.3-0.4 rad of rotor travel the 6 px mask keeps 79-92% of the reference's mouth-connected area while the reference threads apertures narrower than a cell. A 3 px mask is affordable now that IC(0) exists but costs about 4x the cells; the cheaper half-step is a per-face *sub-cell throat factor* measured from the rim crossing for every face (not only blocked ones), which would throttle near-shut ports continuously instead of at the cell threshold. On the visual side, the swirl now reaches one cell into the corridor; advecting the pressure field with it (conservative upwind, no momentum state) is the next increment if a spinning rotor should actually push a front down a pipe rather than shear the air at the mouth.

# Local valve pipe cells: rotation without repaint (2026-10-28)

## Review

The aperture-face build still stored pressure on a **world grid of 6 px texels**. Every rotor turn had to re-cut those texels against the new angle, and the only way to keep a 1.5 px seam from vanishing between samples was to measure each shared face across its whole width. That made the geometry cache — not the gas solver — the architecture's centre of gravity, and it could never represent a valve carrying its own air: pressure belonged to fixed world cells, so a turn either repainted the field or left it frozen.

The user's diagnosis was that this was the wrong decomposition. Their proposal: divide the pipes *inside* each valve into cells using that valve's own coordinate system that does not rotate internally; keep the short pipes in the casing tiles static; compute, for the current rotation, which valve cells connect to which casing cells; then diffuse in a few steps with no inertia and without very slow performance.

## Changes

- **`geometry.js`**: factored `primDepth(v, px, py)` out of `valveClearance` and exported `passageClearance(v, px, py)` — the largest disc inside a rotor passage at rotor-local coordinates, clipped by the rim with no seam opening. `valveClearance` is unchanged behaviourally (all geometry fixtures pass).
- **`gas.js` rewritten as a pipe network.** `RS = 8` rotor-local cells per valve sampled once with `passageClearance`; `LANES = 3` casing lanes × up to 3 segments per side, static in tile coordinates; adjacent tiles share their far corridor cells. `SLOTS = 100`, `NODES = 10,000`, `NB = 16` neighbours per node, typed arrays only. Static edges (rotor neighbours, casing lanes/segments, cross-tile links) are built once per structural change and cached as each node's first `staticCount` neighbours; only **seam edges** are rewritten for a turned valve.
- **Seam links** rotate each near-rim rotor cell centre into the casing frame, pick the corridor lane its lateral offset lands on, gate by the analytical chord `v.seam[s] - AIR_MIN`, and throttle by the remaining width. Both seam links (world `valveClearance`) and rotor links (local `passageClearance`) are checked with a `0.75 px` disc along the segment. This removed 95–127 diagonal rotor links per machine that had cut through elbow metal; an independent `G.sweep` over the whole graph now reports 0 blocked links at spin 0.2 for seeds 7/42/1234.
- **One implicit diffusion step per 1/30 s mask tick**, `DIFFUSE_DT = 1200`, IC(0)-PCG with a 16-iteration transient budget — no per-frame substeps, no geometry sampling in the solve, no inertia state. Explicit conservative sweeps (global and per-edge rates, up to 128 sweeps/tick) and in-place SOR were implemented and measured, then rejected: O(L²) sweeps to cross an L-cell pipe left 95% of a connected machine untouched after 2,560 sweeps, and SOR took 400 sweeps with 0.05–0.99 error. Live steady solves start from a two-BFS distance-ratio warm field and polish with 12 iterations; exact hypothetical/1-D references keep 700.
- **Display compatibility projection**: the 6 px `120 × 130` grid remains for the renderer, UI, quests and grain coupling. Casing texels map to static nodes once; rim texels are resolved into rotor-local indices per turn; `list`/`listPos` maintain the air list incrementally, so a rebuild touches only the turned valves' rim texels. `air`, `p`, `face`, `apR`, `apD`, `active`, `comp`, `pin`, `open`, `fill`, `cond`, `pTarget` and the band arrays keep their previous meaning.
- **Velocity** sums raw edge flux `g * (p_neighbour - p)` (degree normalization had inverted the pile-flow gate) plus rigid `ω × r` swirl with only display relaxation. `FLOW_SCALE` swept to 22,000: 0.32 s dry, 0.62 s at force 1, hover at force 2, drift 3.8 px.
- **Fixtures updated for the new contract**: `gas-fixtures` now asserts a quarter-turn carries rotor pressure into new texels, leaves casing texels exactly equal, conserves the tile's pressure sum/range and still evolves afterwards. `calibration-fixtures` replaces the obsolete world-face lane check with network checks — 500 seam links clear `G.sweep` (340 off-centre), a solid blank has no seam links, a narrowing seam throttles conductance monotonically, a turn never resamples rotor air, and incremental masks still equal fresh ones. `aperture-probe` reports seam-link validity instead of face lanes. `aperture-picture` defaults to `HEAD` so it runs in this checkout.

## Validation

- All scripts pass on Node v22.22.3: `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `air-fixtures`, `calibration-fixtures`, `gas-fixtures`, `game-fixtures` (bots 3 quests / 85 pts), `render-smoke`, `behavior-probe`, `front-probe`, `aperture-probe`, `aperture-picture`, `simulation-bench`. Full output in `experiments/logs/grid-gas-valve-cells.txt`.
- `gas-fixtures`: 0.25 ms off vs 0.66 ms grid per 120 Hz step (gate `off * 6`); one component with a linear 0–1 gradient; sealed field keeps 1.00 of colour; 1-D front; valve gating; pile flow 95 vs empty 126; 30 px fall 0.32 / 0.62 s / hover; drift 3.8 px.
- `front-probe`: connected cross machine, coverage within 0.02 of steady by tick — `5 7 11 19 27 36 47 59 73 90 100` at `dt = 1200` (11 ticks ≈ 0.37 s); `dt = 2400` reaches 100% at tick 6; serpentine settles at tick 85; creation+steady ~13.7 ms.
- `calibration-fixtures`: serial seam errors 2.98e-7 / 5.96e-7 (unchanged), 500 seam links clear with 340 off-centre, 0 blocked, aperture errors 11.27 / 5.14 px for the legacy face stencil.
- `aperture-probe`: 2,031 seam links over four rotation states (1,596 off-centre, 0 blocked, conductance 339.8); rebuild 0.51 ms unchanged, 0.43 ms one rotor, 1.51 ms all 100. `aperture-picture` at 0.113 rad: `HEAD` 2098/3511 (59.8%) in 78 components, working tree 2495/4125 (60.5%) in 78, 1.5 px reference 60.5%.
- `simulation-bench`: grid 1.47 ms/60 Hz with 120 grains and 169 rebuilds. Worst case measured separately: a fully connected cross machine with all rotors turning costs ~1.54 ms per 120 Hz step (off 0.06 ms) — about 3 ms of a 16.7 ms frame at 60 fps. Graph checks at spin 0.2: 5,668–6,033 links per machine, 0 blocked by `G.sweep`.
- Classic-script loading was verified through `render-smoke`'s VM (real `geometry.js`/`gas.js`/`app.js` as globals with a recording canvas/DOM stub). No browser binary exists in this sandbox, so pixels and the live overlay were not visually confirmed.

## Next step

The remaining cost is the 16-iteration PCG on fully connected machines (~1.5 ms/step). A fixed-slot lower/upper stencil (no `nbrCount` loop or `j < k` branches in `matvec`/`applyIC`) should cut each iteration several-fold, as the old 5-point kernel did; if a browser check is available, also confirm that the carried-pressure front reads as rotation rather than repaint at animation speed.

# Connected pressure during fast turns (2026-10-28)

## Review and changes

- The local-cell geometry already separated rotor and casing air, but transient solves excluded every component without a reservoir. A disconnected six-node casing pipe with pressures 1 and 0 therefore never exchanged air. Also, the 30 Hz seam refresh could skip a straight-port opening at the UI's 3× turn speed.
- Transient diffusion now includes nonuniform unpinned components. A bounded, per-component correction preserves isolated air despite PCG's finite iteration budget; steady solves remain pinned-only. Uniform components are skipped.
- Moving seams are refreshed and solved on each 120 Hz simulation tick; still fields settle at 30 Hz. The implicit diffusion strength and settling tolerance scale with elapsed time, and zero elapsed time cannot consume a pending update. Snapped steady refreshes leave isolated gradients scheduled for relaxation.
- PCG compacts unknown edges and precomputes sweep factors once per solve to offset the extra work; the 16-iteration cap is retained for accuracy. Fixed the grain-occupancy fallback to translate display texels through `gas.map` before indexing network cells.
- Updated sealed-air and pressure-quest gates, help and specification. Added `pressure-propagation-fixtures.cjs` for isolated casing exchange, conservation and projection, fast openings in both directions and four clock phases, all ported valve types, high/low reservoirs, paused/zero-time behavior, clock scaling, sealed rotation and wall occupancy.

## Validation

- All pass sequentially on Node v22.22.3: `geometry-check`, `geometry-fixtures`, `simulation-fixtures`, `gas-fixtures`, `pressure-propagation-fixtures`, `air-fixtures`, `calibration-fixtures`, `game-fixtures`, and `render-smoke`; `front-probe`, `aperture-probe` and `simulation-bench` also ran. Fast openings transferred at least 0.571 pressure to the adjacent casing; a 720-angle sweep of all 10 ported types found linked openings at least 0.393 rad wide, compared with a maximum 0.126 rad/tick at speed 3. After 240 sealed speed-3 ticks, total-pressure drift was under 0.000067 for seeds 7 and 42.
- A real headless Chromium 153 `file://` smoke test found no page errors, exercised the overlay and fast-turn and isolated-casing scenarios, and reported 60 fps in the UI at speed 3. The seeded whole simulation measured 3.05 ms per 120 Hz step in that browser. These timings are hardware-dependent.
- Sequential Node cost with 120 grains and turning: 3.59 ms per 60 Hz frame, versus 0.98 ms with pressure off. A speed-3 seeded run measured 2.37–2.46 ms per 120 Hz step, versus 0.81–0.90 before; all-cross rotors measured 2.31–2.36 ms. The previous solver skipped these exchanges, so the increased cost is explicit; `experiments/logs/grid-gas-propagation.txt` records comparisons and the updated gas budget.

## Next step

Profile on a lower-power browser and consider caching unaffected component operators during one-valve turns; preserve next-tick exchange and sealed-component conservation when optimizing further.
