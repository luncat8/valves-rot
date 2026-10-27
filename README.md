# Rotary valve field

Open `index.html` directly in a browser to choose a prototype. No install, build, network access or server is required.

- `prototype/draft.md`: original specification.
- `prototype/comparison.md`: requirements comparison and solver limitations.
- `0.1.1-plan.md`: standalone combined-version design and acceptance gates.
- `pressure-plan.md`: inlet boundaries, the two pressure backends and their validation.
- `prototype/shared/`: combined implementation. `geometry.js` is the single source of truth for housings, passages, seam apertures and clearance; `simulation.js` advances conserved grains through `sweep` with moving-wall contact and spatial bins; `render.js` strokes those same primitives and batches grains.
- `experiments/`: Node validation and timing scripts (`geometry-check.cjs`, `geometry-fixtures.cjs`, `simulation-fixtures.cjs`, `gas-fixtures.cjs` and `air-fixtures.cjs` for the pressure backends, `render-smoke.cjs`, `simulation-bench.cjs`, `behavior-probe.cjs` for grain liveliness against the GLM reference).

Click any valve, or focus the canvas and use arrow keys plus Enter/Space (Shift to reverse), to turn a selected valve by 90°. Rotation speed controls valves, not gravity.

Pressure is controlled by the mouths in the two bands: every column has one inlet above the field (constant low pressure) and one below it (constant high pressure). Click a mouth to seal or open it, Shift-click to swap its polarity. **Grid gas** (default) shows the scalar pressure field as a blue-to-red overlay over the passages with a legend and pushes grains with the pressure force, so a fall is held back and blown sideways; a packed pile drops the pressure across its thickness and slows the air that tries to lift it. **Air particles** shows a cyan kinetic air population that circulates from the bottom sources to the top vents and knocks grains about. **Air force** scales the push from 0 (grains behave exactly as with pressure off) to 2 (updrafts can hold a grain). **Off** leaves the grains untouched. Switching modes does not reset grains or valve targets. See `pressure-plan.md` for the models and their limits; run `node experiments/gas-fixtures.cjs` and `node experiments/air-fixtures.cjs` for pressure checks, and see `experiments/logs/simulation-pressure.txt` for coupling and cost measurements.
