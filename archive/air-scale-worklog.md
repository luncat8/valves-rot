# Air scale calibration — worklog

## Review and cause

`experiments/air-scale-fixtures.cjs` was the only red suite left; every recent
worklog carried it as a pre-existing exception (`1× should balance gravity for
the standard grain, y=570.4`). The fixture predates the material palette and
passed `0`, `1`, `2` as grain colours, which were harmless while every grain's
mass was `r²`.

The water work made the palette a density table (`grainMass = density / 1000 *
r²`), so the lanes silently changed meaning: "light" r 1.7 was dense red
(2000 kg/m³), "standard" r 2.7 was heavy amber (1400), and "heavy" r 3.4 was
neutral (1000). The standard lane therefore weighed 1.4× the mass the 1× air
force was calibrated against, and gas drag — which divides by
`mass / REFERENCE_GRAIN_MASS` — was 1/1.4 as strong, so it fell ~30 px in one
second. The drag model, constants and seams were untouched and correct.

## Fix

- The fixture and `experiments/air-scale.html` now declare one flat lane table
  with real materials: buoyant blue 500 kg/m³ (r 1.7), neutral teal 1000 (r 2.7)
  and dense red 2000 (r 3.4). The neutral r 2.7 grain is exactly
  `REFERENCE_GRAIN_MASS`, which is the mass the shipped 1× setting balances, so
  the documented calibration is restored rather than retuned.
- The lanes now exercise both halves of the mass law: radius and density. 1×
  holds the standard grain while the light grain rises and the heavy one falls;
  2× lifts the standard grain as well. The page legend and stats name the
  material density next to the radius, and its legend dots use the palette
  colours the renderer actually paints.
- README states the reference mass explicitly and mentions the blue/neutral/red
  lanes. `findings-pitfalls-skills.md` records the palette-index trap.

Repairing the calibration was chosen over retiring the page: it is the only
visual and numerical proof of the 0×/1×/2× air behaviour, and the material
palette makes it a better test than before.

## Validation

- `node experiments/air-scale-fixtures.cjs`: PASS — 0× drains all 3; at 1× the
  standard grain sits at y=541.2 (+1.2 px from 540), the light grain rises
  284.5 px and the heavy grain falls 133.0 px; at 2× the light grain rises
  294.2 px and the standard grain lifts 190 px.
- Regression: `air-fixtures`, `gas-fixtures`, `simulation-fixtures`,
  `geometry-fixtures`, `geometry-check`, `calibration-fixtures`,
  `pressure-propagation-fixtures`, `render-smoke`, `game-fixtures`,
  `vent-fixtures`, `water-fixtures`, `water-state-fixtures`,
  `water-color-fixtures`, `heat-fixtures`, `melt-fixtures` all PASS.
- `node --check` clean on the touched scripts; `git diff --check` clean.

## Plan archive

Implemented specifications and their drafts moved from the root into `archive/`:
`0.2-plan.md`, `pressure-plan.md`, `0.3-water-plan.md`,
`0.3-water-color-plan.md`, `0.3-water-sources-plan.md`, `0.4-thermo-plan.md`,
`vent-plan.md`, and the water-colour, water-sources and thermo drafts. The
original raw thermo prompt stays as `archive/0.4-thermo-request.md` so the
polished draft does not overwrite it. README links updated.

## Next step

The remaining suggestions are optional UX passes, not red gates: the pressure
quest's pocket hint and `Tab` cycling of a player's own mouths (from the 0.2/vent
worklogs), and a heat picture at the shipped ±10000 E/s with a shorter window if
that demonstration is wanted.
