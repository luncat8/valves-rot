# Pressure models

## Goal

Add optional air effects without changing the conservative colored-grain geometry or making them a requirement for gravity flow. The grid computes a relative potential; its Pa-equivalent ramp is an explicitly scaled visualization, not a thermodynamic pressure solver.

## Inlets

- Each column has one mouth in the pour band and one in the drain band, drawn as an arrow inside a small disc.
- Bottom mouths are high and top mouths low. The grid pins its potential at open mouths; the particle backend uses high mouths as sources and low mouths as vents in its recycling circuit. These are not measurements of reservoir pressure.
- Click a mouth to seal or open it; Shift-click swaps its high/low polarity. Reset restores the default assignment. Mouth state survives mode switching and layout changes.
- With no open mouth of a level, that level simply has no source; with no open mouths at all the field has no boundary and the overlay reports nothing.

## Air force

- One slider scales how hard either backend pushes grains, 0 to 2 with 1 as the default. At 0 the grains fall exactly as they do with pressure off, which is the regression gate; the fixture asserts an identical drop time.

## Modes

- Radios: Off, Air particles, Grid gas. Default is Grid gas with drawing on.
- Checkbox: Draw air field. Independent of the collision debug overlay and the black/white air background.
- Switching modes replaces only pressure state. Grains, counters and valve targets are preserved. Reset, layout change and valve replacement rebuild the selected backend.

## Air particles

- Dilute population of small elastic discs with independent radius, mass, speed and capacity; no gravity, no grain accounting.
- Swept geometry reflection from housing and moving rotor walls, reciprocal impulses on grains through preallocated bins, bounded by an extreme-speed ceiling. Grain impacts are elastic at air force 1; other slider values change that impulse. No air-air collisions.
- Air is lighter than a grain but not negligible (mass 3 against 7.3 for a 2.7 px grain), so a stream of impacts visibly holds a fall back; the slider scales the exchanged impulse on both bodies.
- Reservoir circuit: air inside a band mouth whose inlet is an open vent is moved to a random open source, aimed into the field. Rate is proportional to the number of open source/vent pairs, so sealing a mouth slows or stops the circulation; the population is constant and cycling is counted.
- Particle drawing is a qualitative air-population view, not a pressure map. Count the normal momentum transferred by actual wall reflections in nominal one-second simulation windows; record the realized duration, normal impulse and hit count. Exclude recovery nudges and the speed-cap impulse. A total impulse is not pressure until a known wall area and time are supplied.

## Grid gas

- 6 px cells over the whole field (one grid column per valve column, so a band cell's owner is unambiguous), typed arrays only, solver independent of drawing and DOM.
- Air mask from `airClearance` plus open faces: an axis-aligned centre-to-centre link is sampled at half the clearance threshold, with a fast path where midpoint clearance covers the whole link. This prevents the velocity stencil from connecting through a thin shut rim between the midpoint and endpoint. Openings narrower than the sampling/grid resolution may instead be missed; the cell-centred velocity is not a conservative no-penetration face flux.
- The relative potential is the ratio of two porous path distances — how far each air cell is from a source against how far it is from a vent — from an alternating fast-sweeping pass. Air costs 1, metal costs 6, grain-filled cells cost up to 4, so open passages are fast lanes and the standing bottom-to-top gradient stays readable while the rotors turn. The distance pass does **not** respect closed faces: potential can propagate through metal even when a face is blocked in the velocity stencil. It is not a sealed-wall, conservative flow or transient compression/equalization solver.
- Mask rebuilt when any rotor angle has moved by 0.02 rad; occupancy and Darcy velocity re-solved on the same 1/30 s clock even while the rotors are still, or immediately when an inlet changed.
- Gas velocity is Darcy-like: the central-difference pressure gradient divided by the cell's crossing cost, which is its fill throttle times its tightness (1 / clearance). The pressure drop therefore concentrates where the passage narrows — valve mouths, seam gaps, grain-packed cells — and streams through them like a nozzle while open chambers stay nearly isobaric, so the air punctuates a fall instead of breathing on the whole field at once. Capped at a maximum speed.
- Grains feel two empirical couplings, both scaled by air force: drag toward the local gas velocity, and a lift term along that velocity, which lifts a still grain wherever the field points up. A grain sitting in a cell whose centre is metal (in a wall contact or under a rim) samples the nearest air cell, because those are exactly the grains visible in a pile. Air is left out of the reservoir bands so the field can still be fed through a full pour spout.
- Gas velocity is state, not a fresh Darcy sample every substep. Interior cells relax toward Darcy and pay the impulse they deliver to grains (cell mass 1, equal to a grain); pinned mouths snap to Darcy and so act as momentum reservoirs. A falling grain keeps meeting fresh cells and still feels the lift; a sitting pile drains the same cells and damps the flow through it. Occupancy also warps the potential, so the overlay shows a pressure drop across the pile's thickness. This is a normalized relative potential, not a calibrated thermodynamic gas. Scales: a passage crossing the field flows about 150 px/s, a single dropped grain takes about twice as long to fall 30 px with air on and drifts about 8 px sideways, and about 0.4 g of lift keeps grains lively without suspending a settled pile.
- Bounded work: no per-frame allocation, one mask rebuild when rotors move, one occupancy solve per mask clock.

## Ramp calibration

- The grid continues to store a dimensionless `φ` in [0, 1]. The legend maps it linearly to `P_equivalent = φ × ΔP_reference`, with low gauge reference 0 and high reference `ΔP_reference`, in Pa. The color ramp remains normalized. A positive editable span can represent another known source-to-vent difference; changing it relabels the ramp without changing the field, gas velocities or grain forces. No open mouth means no reference, so the overlay and legend are hidden.
- The default span is an illustrative wall-flux reference, not an in-situ measurement: a sealed circular chamber of wall radius 15 px contains 100 kinetic markers of mass 3 simulation units each, moving at 180 px/s. With 1 mm/px, 1 s per simulation second, 1 mg per mass unit and 10 mm depth, the 20 s reference gives 13,429,587.3 normal-impulse units, or about 0.7125 Pa against a zero-gauge reference. `calibration.js` stores the measurement and converts `impulse / (wall area × elapsed time)` to SI; the known wall area is `2π × wall radius × depth`. This choice is not atmospheric pressure or a measurement of either simulated reservoir.
- In this fixed-speed, collisionless circular reference, the accessible marker-centre radius is `R - particle_radius`. The isotropic kinetic-theory mean over the actual wall is `N m v² / (2π (R - particle_radius) R depth)`; the fixture checks the measured flux against it and verifies population, speed-squared, depth, mass and time scaling. Global live impulse counters alone cannot be divided by the whole layout's unknown wall area to obtain local pressure.
- A unit on the ramp does not make the heuristic field, the independently tuned air-force slider, the speed ceiling, or particle reservoirs physically calibrated. A full device calibration needs measured boundary values and independent validation in the relevant geometry; neither absolute nor local thermodynamic pressure is inferred here.

## Overlay and validation

- Relative potential is drawn as one smoothed texel per gas cell over the passages, tinted by a blue-cyan-amber-red ramp with an equivalent-Pa legend. The air mask keeps metal transparent.
- Fixtures (`experiments/gas-fixtures.cjs`, `experiments/air-fixtures.cjs`): standing gradient with the default mouths, sealed mouths raising the field, flipped polarity inverting it, bounded normalized pressure and gas speed, mask rebuild on rotor turns, grain drag direction, constant population and recycles, reciprocal momentum, static-wall speed preservation, sealed-chamber containment, mode switching, and pressure-off trajectory equivalence and cost.
- The coupling is asserted, not just the field: a single grain dropped through an open chamber is timed dry, at air force 0 (must match dry exactly), at 1, at 2, and in particle mode — slower with air, more drift, longer with more force. A packed chamber drops at least twice the empty pressure across its thickness, and after a few frozen gas steps the flow through the pile is slower than the empty chamber and slower than the pile's own initial Darcy speed. Occupancy re-solves while rotors are still.
- `experiments/calibration-fixtures.cjs` exercises the production potential-distance kernel against a 1-D analytical serial resistance with a narrow open seam at 6 px and 3 px. It also samples the real clearance/face predicate at a rim-aligned chord at both resolutions, including a sub-cell aperture and a shut face; the actual 6 px runtime mask is checked against geometry sweeps across thousands of rotated links. The 3 px tests are reference stencils, not a second runtime grid; they do not establish 2-D pressure accuracy or validate pressure equalization through a closed seam.
- Cost is measured per 120 Hz step; pressure off must keep the existing grain behaviour and cost.

## Later stages

- To report actual device pressure rather than a Pa-equivalent potential, use a mass-conserving connected flow model with explicit physical boundaries and an energy policy. Validate closed-seam isolation, steady parallel/series flow, transient compression and equalization, and local wall-force/area measurements at multiple resolutions. The present instantaneous distance heuristic and dissipative ceiling cannot supply those guarantees.
- Finer grids for narrow passages, aperture-based face conductance rather than centre sampling, and a GPU backend only after the CPU cost is profiled.
- Per-column scaling of the ramp for layouts where one column carries most of the flow.
