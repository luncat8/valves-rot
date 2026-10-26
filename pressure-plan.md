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
