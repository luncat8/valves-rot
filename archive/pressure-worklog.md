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
