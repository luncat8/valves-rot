# GUI: help drawer and place-valve brush (from archive/draft.md)

## Review

Previous work (pressure calibration) left two things this task touches:

- The combined page carried all of its static help in the main view: a long header paragraph and the calibration `<details>` between the controls and the field.
- `replaceValve` excluded the old valve by comparing raw port lists. Layout valves can carry ports pre-rotated by a base quarter, so a rotated list of the same shape compared unequal and random replacement could re-pick the shape it was replacing.

## Changes

- `prototype/shared/index.html`, `prototype/style.css`: the header help paragraph and the calibration note moved out of the main view into a non-modal **Help** drawer (playing, a shortcuts list, controls/air, calibration, stats legend). The main view keeps the title, the in-game controls, a one-line brush summary and the stats. Drawers are fixed side panels, one at a time, toggled by buttons or `?`/`H` and `V`, closed by `Esc`; the short-landscape rail layout dropped its calibration row.
- `prototype/shared/geometry.js`: valve type catalogue as the single source of names — `TYPES` (12 entries: solid/hollow × straight, elbow, tee, cross, single, blank, with distinct-turn counts), `typeOf` (rotation-invariant, fixes the raw-port comparison above), `typeById`, `orientationOf`, `worldPorts`, `rotatePorts`, `quarterOf`, `portsText`, `DIR_NAMES`.
- `prototype/shared/simulation.js`: `placeValve(sim, index, brush)` where type is a type id / `"random"` / `null` (not change) and direction is a quarter / `"random"` / `null`, resolved independently so type-only, direction-only and combined changes work. A type change rebuilds the valve and clears its cell (hollow-to-hollow keeps the chamber size); a direction-only change turns the rotor and keeps its grains; both "not change" is a no-op. Returns `"replace"` / `"turn"` / `false`. `replaceValve` is now `placeValve` with a random-type brush.
- `prototype/shared/app.js`: **Place valve** drawer listing every type (plus `?` random) with a schematic icon, its 0° ports and a ⧉ button that copies the type name to the clipboard as text (async Clipboard API with a `file://` fallback and a status line); a direction picker (→ E 0°, ↓ S 90°, ← W 180°, ↑ N 270°, `?`); a "double-click will place" summary mirrored in the main controls; Apply / `P`; and a field-valve readout (`cell (5,3) · solid elbow · ports E,S · direction ↓ S · 90°`) with **Copy to brush** and **Copy its name**. Default brush (`?` type, direction not change) preserves the old double-click. Double-click first undoes the turn its own first click made, so "not change" is measured from before the gesture. The readout refreshes only when the selection/valve/target detent changes, keeping the frame loop allocation-free.
- Fixtures: catalogue/orientation invariants in `experiments/geometry-fixtures.cjs`; placement semantics (no-op, turn keeps grains and valve object, replace clears only its cell, deterministic random type+direction, symmetric types, invalid brushes, chamber preservation, random never repeats a shape) in `experiments/simulation-fixtures.cjs`; drawer markup, picker generation, clipboard capture and a click+double-click placement end-to-end in `experiments/render-smoke.cjs`.
- `README.md`: documents both drawers and the brush semantics.

## Validation

- `node experiments/render-smoke.cjs`, `geometry-fixtures.cjs` (300 layout valves typed, orientations consistent at every quarter), `simulation-fixtures.cjs`, `geometry-check.cjs`, `air-fixtures.cjs`, `gas-fixtures.cjs`, `calibration-fixtures.cjs` all pass with unchanged headline numbers (falling column 6 drained, sealed reservoir 9 kept, machine 77 seeded / 69 active / 8 drained, calibration 0.7125 Pa).
- Served over HTTP and the page plus both new asset paths return 200; the headless smoke drives the real `app.js` for drawer toggling, picking, copying and placing. No browser is available in the sandbox, so drawer layout, clipboard behaviour on `file://` in a real browser, and double-click feel still need the user's own check.

## Follow-up (user feedback)

- Removed both "not change" buttons: clicking an already selected type or direction button again unselects it, and unselected means not change (default direction starts unselected; type starts on `?`). The brush summary still spells out "not change" for an unselected half, and both-unselected keeps its "changes nothing" note.
- Combined page header is now one line: the "All prototypes" link and the title sit on a shared baseline at 18 px (16 px in the short-landscape rail), with no heading margins.
- `experiments/render-smoke.cjs` now asserts there are no keep buttons, that re-clicking `?`, a type and a direction unselects them, and that an unselected/unselected double-click is still a no-op.

## Follow-up 2 (user feedback)

The user still saw the old buttons/header and no unselect: their preview tab was running the pre-change page. Verified that disk and the preview server both already served the new files (no keep buttons, toggle handlers, one-line header CSS), then hardened all three anyway:

- Header is now `flex-wrap: nowrap` with a responsive `clamp(13px, 3.8vw, 17px)` title and a 13 px back link, so the line cannot wrap in a narrow rail or phone viewport either (14 px in the short-landscape rail).
- Brush wording no longer says "not change" anywhere in the GUI: unselected reads "keep current type / direction".
- Type-row ⧉ copy now appends the selected direction and rotated ports (`hollow tee · direction ↓ S · 90° (ports S,W,N)`); with no direction selected it still copies just the name. The copy button carries the type id (`data-copy-type`) so the text is built at click time by `typeText()` from the live brush.
- The preview server was restarted with `Cache-Control: no-store`; a hard refresh (Ctrl+Shift+R) drops any pre-change cached scripts.

## Next step

Open the combined page in a browser and check both drawers at desktop and short-landscape sizes, clipboard copy from `file://`, and double-click placement with each combination (`?` / fixed / not change × type / direction). If the brush feels right, `water-plan.md` is the next unimplemented plan.
