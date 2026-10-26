# Rotary valve field

Open `index.html` directly in a browser to choose a prototype. No install, build, network access or server is required.

- `prototype/draft.md`: original specification.
- `prototype/comparison.md`: requirements comparison and solver limitations.
- `0.1.1-plan.md`: standalone combined-version design and acceptance gates.
- `prototype/shared/`: combined implementation. `geometry.js` is the single source of truth for housings, passages, seam apertures and clearance; `simulation.js` advances conserved grains through `sweep` with moving-wall contact and spatial bins; `render.js` strokes those same primitives and batches grains.
- `experiments/`: Node validation and timing scripts (`geometry-check.cjs`, `geometry-fixtures.cjs`, `simulation-fixtures.cjs`, `render-smoke.cjs`, `simulation-bench.cjs`).

Click any valve, or focus the canvas and use arrow keys plus Enter/Space (Shift to reverse), to turn a selected valve by 90°. Rotation speed controls valves, not gravity.
