# Dual-Passage 2+2 Non-Mixing Valves (`solid-bends` & `solid-overpass`)

Date: 2026-11-09

## Summary

Added two 2+2 non-mixing solid rotor valve types to the shared catalogue (`12` -> `14` types):

1. **`solid-bends` `(><)`** (`ports = [0, 3, 1, 2]`, `turns = 2`, `groups = [0b1001, 0b0110]`):
   - Two disjoint offset-arc 90° elbows on the same rotor (`E–N` and `S–W` at `q = 0`, `S–E` and `W–N` at `q = 1`).
   - Uses `BENDS = 0.88 * RV` (`20.06 px` vs standard `ELBOW = 22.80 px`). In a single plane inside `r < RV`, standard `ELBOW` arcs kiss at the origin (`(√2 - 1) * RV - 2 * HALF = -4.33 px` overlap), merging both channels; `0.88 * RV` gives `9.05 px` air-to-air separation (`>= 1.5×` the `6 px` gas/water cell) and `+0.60 px` metal gap between the two `4.2 px` porcelain borders while preserving the full `13.78 px` throat width (`HALF = 6.89 px`).

2. **`solid-overpass` (`|` under `-`)** (`ports = [0, 2, 1, 3]`, `turns = 2`, `groups = [0b0101, 0b1010]`):
   - Two perpendicular straight passages crossing without mixing: Layer 0 (`ports[0]–ports[1]`, `E–W` at `q = 0`) bridges over Layer 1 (`ports[2]–ports[3]`, `S–N` at `q = 0`). Quarter-turn rotation swaps `E–W over S–N` <-> `S–N over W–E`.

## Architecture & Subsystem Invariants

### 1. Ordered-ports orbit encoding (`prototype/shared/geometry.js`)
- Ordered 4-element port arrays partition naturally into three rotation-invariant orbits under `p -> (p + 1) & 3` discriminated by `step = (ports[1] - ports[0]) & 3`:
  - `step === 1`: `solid-cross` (`[0, 1, 2, 3]`, `turns = 1`, `groups = [0b1111]`).
  - `step === 3`: `solid-bends` (`[0, 3, 1, 2]`, `turns = 2`, `groups = [0b1001, 0b0110]`).
  - `step === 2`: `solid-overpass` (`[0, 2, 1, 3]`, `turns = 2`, `groups = [0b0101, 0b1010]`).
- `rotatePorts` preserves element order for `step !== 1` so `makeValve`, `worldPorts`, `typeOf`, and `orientationOf` round-trip losslessly across all 14 types.
- `typeConnectsMask`, `valveConnectsMask`, and `portsConnected` test whether a subset of ports belongs to a **single** passage group rather than merely matching the 4-bit `mask = 15`.
- `createLayout(seed)` draws from the 6 base solid arities first and splits the 4-port slot evenly across `cross`, `bends`, and `overpass`, keeping non-4-port cell layouts stable while populating random boards with ~7 dual-passage valves per 10×10 field; `carveRoute` keeps 4-port percolation-spine cells as `[0, 1, 2, 3]`.
- `rotorBranchAt(v, x, y, prevLayer)` returns `0` outside layered rotors (`r >= RV`), `1` in Layer 0's arm, `2` in Layer 1's arm, and preserves `prevLayer` inside the central `[-HALF, HALF]²` crossing (`d0 > 0 && d1 > 0`) or near metal inside `r < RV`. Non-overpass cells run `useLayer = -1` (bit-identical to baseline).

### 2. Grains & kinetic air (`prototype/shared/simulation.js`, `prototype/shared/air.js`)
- Added `layer` (`Uint8Array`) to `GRAIN_FIELDS` (compacted by `removeGrains`/`drain`) and `air.layer`.
- `syncLayer` / `syncAirLayer` updates each particle's branch from its entry arm and locks it through the central crossing; wall clearance, swept wall contacts, recovery (`nearestAir`), grain-grain contacts, air-grain impulses, and `pinchAt` all isolate `layer === 1` from `layer === 2`.

### 3. Grid gas (`prototype/shared/gas.js`)
- Doubled rotor node slots (`RLAYER = RN * RN`, `RSLOTS = 2 * RLAYER`): Layer 0 occupies `[0, RLAYER)`, Layer 1 (`solid-overpass` underpass) occupies `[RLAYER, 2 * RLAYER)`.
- Interior rotor edges and casing-rotor seam edges (`v.layerSeam[layer]`) are built per layer with zero edges between Layer 0 and Layer 1, so `GAS.components(gas.net)` strictly separates both passages at every rotor angle.
- `project` writes Layer 1 first and Layer 0 on top at shared crossing display cells; `measureCost` and `drag` route `sim.layer[k] === 2` grains to `node + RLAYER`.

### 4. Water, colour & heat (`prototype/shared/water.js`, `prototype/shared/heat.js`)
- `solid-bends` separates naturally on the `5 px` grid thanks to the `9.05 px` metal barrier (`BENDS = 0.88 * RV`).
- For `solid-overpass`, `pickCellLayer` assigns crossing cells (`[-HALF, HALF]²`) to Layer 1 (bridge) and non-crossing underpass arm cells to Layer 2, while `buildTunnels` reflects Layer 2 portal cells across the bridge axis `(p0.ux, p0.uy)` and links them with conservative tunnel faces (`tunnelA`, `tunnelB`, `tunnelVert`, `tunnelOpen`).
- `sampleEastFace` / `sampleSouthFace` block faces between `cellLayer === 1` and `cellLayer === 2` and require `w.air` on both endpoints so corner metal cells cannot bridge the two layers.
- `sampleCell` records `w.switched[i] = 1` when rotation flips an open cell directly between `1` and `2`, and `pushClosedWater` evacuates `w.switched` cells along `oldLayer` before reopening them on `newLayer`, preventing cross-channel colour contamination during rotation.
- Because `move(w, from, to, area)` fires `w.onFlow` on tunnel relaxations identically to grid faces, enthalpy transport (`heat.js`) and 3-channel colour conservation work automatically across underpass tunnels.

### 5. Game & Vent routing (`prototype/shared/game.js`)
- Replaced bitmask-subset checks in quest path planning (`canSatisfyValve`, `bestQuarterForValve`, `canDeflectSideways`, `fMask !== 15` turn penalty) and Vent route search with `G.typeConnectsMask` / `G.valveConnectsMask`.
- Added `pocketAlt` alongside `pocket` on layered rotors so pocket-tracking follows both branches independently.
- Fixed `findRoute` in Vent mode to reject ancestor-chain cell self-intersections (`seenInPath`) so a route never visits the same cell twice with conflicting orientations, initialized Vent mode pressure at steady state (`GAS.steady`), and set minimum controllable Vent span to `0.10`.

### 6. Rendering & UI (`prototype/shared/render.js`, `prototype/shared/app.js`, `prototype/shared/index.html`, `README.md`)
- `paintRotorInto` strokes `v.layerPaths[1]` (underpass), casts a linear-gradient portal shadow along `(p0.ux, p0.uy)` (`±(bridgeHalf + 6.5)`), then strokes `v.layerPaths[0]` (bridge) on top across all three skins (`glm`, `combined`, `gpt`).
- `renderGrains` clips `sim.layer[k] === 2` grains against an `evenodd` bridge-deck cutout rotated by `v.angle + atan2(p0.uy, p0.ux)` so underpass grains visibly disappear beneath the bridge deck and emerge on the far side.
- Added distinct Place-drawer SVG icons (`typeIcon`) for `solid-bends` and `solid-overpass`, and updated the Help drawer and `README.md`.

## Verification

All 16 fixture and smoke suites pass (`node experiments/<suite>.cjs`):
- `geometry-fixtures.cjs` (`300` valves, `14` types, `27000` seams/round-trips, `gap 0.00`)
- `simulation-fixtures.cjs` (including `dualPassageCrossing` for `solid-bends` and both `solid-overpass` orientations, `maxOverlap 0.73`, `maxWall 0.002`)
- `gas-fixtures.cjs` (including `solid-bends` & `solid-overpass` component and high-pressure isolation)
- `water-color-fixtures.cjs` (including stationary Red/Blue crossing on `solid-bends` & `solid-overpass` with `0` cross-mixing + continuous `90°` overpass rotation conservation)
- `vent-fixtures.cjs` (with `G.portsConnected` port-pair `stableReach`)
- `game-fixtures.cjs`, `air-fixtures.cjs`, `calibration-fixtures.cjs`, `pressure-propagation-fixtures.cjs`, `water-fixtures.cjs`, `water-state-fixtures.cjs`, `water-sources-fixtures.cjs`, `water-buoyancy-fixtures.cjs`, `heat-fixtures.cjs`, `melt-fixtures.cjs`, and `render-smoke.cjs` (`NaN`-guarded canvas ops + all 3 skins).
