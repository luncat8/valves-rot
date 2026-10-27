# Water level and buoyancy plan

## Goal and scope

Add a water inlet (vent/spout) above the field. Opening it supplies water at a controlled rate and raises the water level in reachable passages. Grains have distinct material densities and masses, so some sink and others float. The first implementation shows a changing water level, **not falling drops or a waterfall**. Falling water is a separate, deferred stage.

Keep the existing file-friendly, fixed-step simulation, conserved grains, shared geometry and preallocated hot-path buffers. Water is separate from the current air inlet controls and from the grid's relative potential.

## Physical conventions

- Use one explicit length, simulation-time, mass and out-of-plane depth configuration for all physical conversions. The current air-ramp reference uses 1 mm/px, 1 s/simulation-second, 1 mg/mass unit and 10 mm depth. Its editable Pa span is only a display scale; changing that span must not change water or grain physics.
- A grain is an extruded circular disc in the 2-D slice: `V = π (r_px × metres_per_px)² × depth`, `m = grain_density × V`. Set water density to 1,000 kg/m³ by default; provide deterministic grain material types with densities below, equal to and above water. Density is independent of color and radius, even if colors help identify materials.
- The current gravity is 560 px/s², or 0.56 m/s² under the air reference scales, not Earth gravity. Preserve it explicitly for the initial model, or introduce a shared time/length calibration before offering Earth gravity. If the time scale changes, recompute the air reference, supply rates and all other SI conversions consistently.
- Introduce shared grain mass and inverse-mass arrays. The current grain-pair solver assumes equal masses, kinetic-air contacts use `r²`, and grid drag treats grains as unit mass; make all three consistent, including gas reaction momentum and every buffer compaction, insertion, purge, reset and replacement path. Changing density must not silently alter radius. Unequal-radius dry collisions will change, and air coupling must be rechecked because its particle and cell masses are tuned in simulation units.

## Phase 1 — inlet, levels and buoyancy

### Water supply and state

- Provide one distinct top water vent, an on/off control, a supply rate `Q` in m³/s, and a clear/drain-water action. The existing air mouths and grain Pour/Drain keep their own meanings. The water outlet is closed by default, so supplying water can increase the level; any optional water drain and overflow have explicit counters.
- Attempt `Q × dt` while the vent is open; record admitted and unadmitted supply separately. Track stored, overflowed and drained volume, with `admitted = stored + overflowed + drained` and `attempted = admitted + unadmitted`. Pause and single-step use simulation time, not wall-clock time. A blocked or full inlet never deposits water behind a wall.
- Use the shared geometry and a water-specific passability mask, with closed faces and true seam apertures. The current grid-gas distance solver propagates its potential through metal and must not be reused as a water-connectivity test. Unresolved sub-cell openings may conservatively remain closed, with their resolution stated.
- Represent water as volume and horizontal free-surface level(s), not water particles. Fill and equilibrate communicating reachable voids as a quasi-static approximation. Keep separate volumes and levels for isolated pockets; splitting or joining components as rotors move must preserve volume rather than teleporting it through closed seams. Retain or explicitly account for water displaced by moving walls.
- Compute water level from accessible void volume minus the submerged volume of grains. Handle fully filled compartments, displacement, overflow and blocked inlets explicitly. No hidden source, loss, or instant filling of a sealed dry chamber. The quasi-static approximation does not model jets, sloshing, surface tension or trapped-air compression.

### Grain coupling and display

- For each grain, compute the submerged circular-segment area below its local horizontal water surface, clamped from zero to the full disc area. Multiply by depth to get displaced volume; apply upward `F_b = water_density × gravity × displaced_volume` and gravity using the grain's actual mass. With screen y increasing downward, a fully submerged grain's vertical acceleration is `g × (1 − water_density / grain_density)`.
- Use a bounded, timestep-stable submerged drag toward the phase-1 stationary water; scale it by the submerged fraction and document it as an approximation. It should settle a floating grain near its equilibrium waterline without injecting energy. Dry grains and water-off mode must not receive water forces.
- Draw a translucent water fill and horizontal waterline only inside wetted air passages, behind grains and without painting over metal. Show the top vent, level/volume and inlet state. Water volume transfers quasi-statically from the vent into the modeled connected pool: do not spawn, animate or imply individual falling drops in this phase.
- Avoid claiming a two-phase air solver. Initially require air pressure mode Off while water mode is enabled, including when its vent is closed but water remains; preserve the user's prior selection and restore it when water mode is disabled. This avoids air particles and the porous gas field occupying submerged cells until a validated gas/water interface exists. Make the restriction visible in the controls.

### Acceptance

- Empty, half-submerged and fully submerged disc areas match the analytical circular segment. With drag disabled in a free chamber, light, neutral and heavy equal-size grains accelerate upward, approximately zero, and downward respectively; floating equilibrium has submerged fraction `grain_density / water_density`.
- Check different radii and densities, mass-weighted pair/air impulses, momentum bookkeeping, and per-grain arrays through drain, compaction, reset and valve replacement. With water and air off, retain dry free-fall and equal-radius, equal-density collision regressions; different masses or radii intentionally change collision responses. Preserve grain conservation in every mode.
- At two mask resolutions, test open, narrowing and closed seams, isolated pockets, component split/merge during turns, grain and wall displacement, inlet blockage, overflow and drain. Admitted volume equals stored plus drained/overflowed (within a stated discretization tolerance), with no wetting through a sealed seam.
- Check fixed-step equivalence, pause/single-step, controls and mode restoration, rendering alignment, no new per-frame allocations, and timings at representative grain counts. Document the waterline model's quasi-static and pressure limitations.

## Deferred — falling water

Consider a bounded, preallocated particle stream from the top vent for visibly falling water, splashes and transient delivery. Compare it with a cheaper visual sheet before selecting a model. If particles carry volume, count that volume once while in flight, sweep them against the actual valve/seam geometry, and merge it into the correct pool on impact. Conservation becomes `admitted = stored + in flight + drained + overflowed`; changing the particle budget or timestep must not change the delivered volume. Do not claim that visual droplets alone simulate incompressible fluid or realistic spray.

A later stage can investigate water motion, hydrostatic pressure, air displacement and trapped-air compression, with independently validated two-phase coupling before enabling simultaneous physical air and water forces.
