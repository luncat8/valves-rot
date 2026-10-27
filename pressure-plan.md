# Pressure models

## Goal

Add optional pressure without changing the conservative colored-grain geometry or making pressure a requirement for basic gravity flow.

## Controls

- Radio buttons: Off (default), Air particles, Grid gas.
- Checkbox: Draw pressure as air color. Independent of the collision/air-model debug overlay and black/white background choice.
- Switching modes resets only pressure state, never grains, counters or valve targets.

## Air particles

- Small, fast particles reflect from housing and moving rotor walls using the shared geometry.
- Transfer impulses to colored grains through spatial bins; conserve momentum for grain/air interactions and bound energy from moving walls.
- Separate air population, radius and thermal speed from colored-grain settings. Air particles are not injected/drained grain counts.
- Use fixed substeps or swept collisions to prevent tunneling. Pool all state and cap cost.

## Grid gas

- Start with a low-resolution CPU grid and preallocated typed arrays for density, pressure and velocity; keep solver independent of drawing and DOM.
- Derive solid cells and face aperture fractions from shared geometry, including moving rotors and shut seams. Avoid coarse-grid leakage through sealed ports.
- Stable bounded timestep, mass-conserving fluxes, moving-wall boundary velocities, and explicit top/bottom boundary policy.
- Couple pressure gradients/drag to grains with bounded reciprocal momentum exchange.
- Profile before GPU work; preserve a solver interface suitable for a later GPU backend.

## Overlay and validation

- Draw scalar pressure with an air-tinted opacity ramp, readable against both air backgrounds; optionally draw air particles in particle mode.
- Fixtures: sealed chamber pressure, equalization through open ports, blocked seams, moving-wall compression, grain pushing, mode switching, finite state and bounded energy/mass drift.
- Measure CPU update/render cost and memory at several grid resolutions and air populations. Pressure-off must retain existing grain behavior and cost.

## Staged delivery

1. Kinetic prototype: off-by-default air population, swept wall reflection, reciprocal grain impulses, independent air drawing and deterministic fixtures. Treat particle tint as a qualitative air-population view, not a calibrated pressure measurement.
2. Kinetic accuracy: measure wall momentum flux over fixed time windows for a scalar pressure overlay; validate compression and equalization, moving-wall recovery and energy drift at several populations. Replace the dissipative emergency speed ceiling with a validated energy policy if physical calibration is required.
3. CPU grid gas: add the enabled Grid gas radio only with a working conservative compressible solver. Start around 120 × 130 cells, then measure narrower passages at finer resolutions. Validate connected face apertures against analytical seams, not only solid cell centers. Keep pressure/density and velocity separate from render buffers.
4. Compare cost and behavior on identical layouts before considering a GPU backend.

Use reflecting closed end caps for the first kinetic prototype (including the ends of pour/drain bands); atmospheric reservoir boundaries are a separate explicit experiment. Geometry replacement may reinitialize air while preserving grain accounting. Reset and layout changes reinitialize the selected pressure backend; pause and single-step advance it on the grain clock.
