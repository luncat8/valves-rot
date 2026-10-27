# Pressure models

## Goal

Add optional pressure without changing the conservative colored-grain geometry or making pressure a requirement for gravity flow.

## Inlets

- Each column has one mouth in the pour band and one in the drain band, drawn as an arrow inside a small disc.
- Bottom mouths are constant high pressure. Top mouths are constant low pressure. They are boundary conditions, not particles: a backend pins pressure at every open mouth it reaches.
- Click a mouth to seal or open it; Shift-click swaps its high/low polarity. Reset restores the default assignment. Mouth state survives mode switching and layout changes.
- With no open mouth of a level, that level simply has no source; with no open mouths at all the field has no boundary and the overlay reports nothing.

## Modes

- Radios: Off, Air particles, Grid gas. Default is Grid gas with drawing on.
- Checkbox: Draw pressure as air color. Independent of the collision debug overlay and the black/white air background.
- Switching modes replaces only pressure state. Grains, counters and valve targets are preserved. Reset, layout change and valve replacement rebuild the selected backend.

## Air particles

- Dilute population of small elastic discs with independent radius, mass, speed and capacity; no gravity, no grain accounting.
- Swept geometry reflection from housing and moving rotor walls, reciprocal elastic impulses on grains through preallocated bins, bounded by an extreme-speed ceiling. No air-air collisions.
- Reservoir circuit: air inside a band mouth whose inlet is an open vent is moved to a random open source, aimed into the field. Rate is proportional to the number of open source/vent pairs, so sealing a mouth slows or stops the circulation; the population is constant and cycling is counted.
- Particle drawing is a qualitative air-population view, not calibrated pressure.

## Grid gas

- 6 px cells over the whole field (one grid column per valve column, so a band cell's owner is unambiguous), typed arrays only, solver independent of drawing and DOM.
- Air mask from `airClearance` plus open faces: a face is open only when the wall between cell centres is air too, so a seam thinner than a cell cannot leak a jet.
- Pressure is the ratio of two porous path distances — how far each air cell is from a source against how far it is from a vent — from an alternating fast-sweeping pass. Air costs 1, metal costs 6, grain-filled cells cost up to 4, so open passages are fast lanes, a shut seam only trickles, and the standing bottom-to-top gradient stays readable while the rotors turn.
- Rebuilt when any rotor angle has moved by 0.02 rad (at most every 1/30 s) or an inlet changed; otherwise free.
- Gas velocity is Darcy-like inside air only: the central-difference pressure gradient times conductance, throttled by fill and capped. Grains feel it as velocity drag, so rising gas slows a fall. Momentum is supplied and absorbed by the pinned reservoirs, so grain drag is one-way; this is a normalized relative potential, not a calibrated thermodynamic gas.
- Bounded work: no per-frame allocation, one rebuild per mask clock, no solver iteration when the mask is stable.

## Overlay and validation

- Scalar pressure is drawn as one smoothed texel per gas cell over the passages, tinted by a blue-cyan-amber-red ramp, with a low/high legend. The air mask keeps metal transparent.
- Fixtures (`experiments/gas-fixtures.cjs`, `experiments/air-fixtures.cjs`): standing gradient with the default mouths, sealed mouths raising the field, flipped polarity inverting it, bounded normalized pressure and gas speed, mask rebuild on rotor turns, grain drag direction, constant population and recycles, reciprocal momentum, static-wall speed preservation, sealed-chamber containment, mode switching, and pressure-off trajectory equivalence and cost.
- Cost is measured per 120 Hz step; pressure off must keep the existing grain behaviour and cost.

## Later stages

- Calibrated pressure: measure wall momentum flux over fixed windows, validate compression/equalization against analytical seams, and replace the dissipative speed ceiling with a validated energy policy if physical calibration is required.
- Finer grids for narrow passages, aperture-based face conductance rather than centre sampling, and a GPU backend only after the CPU cost is profiled.
