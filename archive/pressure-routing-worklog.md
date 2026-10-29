# Pressure quest routing correction

## Review

The gas network propagates local pressure through geometric links; it does not use player ownership to transport air. Quest setup, however, replaced whole columns with crosses, ranked pockets by owned boundary share, and fitted thresholds from own-mouth switch policies. Its last fallback could ask for pressure already present. These rules implemented a mouth-switch puzzle rather than a valve-routing puzzle. Earlier shaft/fit completion measurements validate that old policy only, not routing gameplay.

## Changes

- Remove shaft installation, owned-pocket ranking, trial column restoration, threshold fitting/softening, and unused hypothetical-mouth/snap APIs.
- Preserve advertised threshold and polarity; install only the four-way goal bottle. Preserve other valves and mouth states.
- Filter placements with a quarter-turn passage-mask route search to any usable reservoir of the requested polarity. Own sealed mouths are operable; rival mouths must already be open. Refuse signing if no route candidate is found.
- Reuse multi-column route search for pressure bots instead of aligning a vertical shaft. No route-search allocations in the bot loop.
- Keep actual local chamber pressure and hold-window scoring, including legitimate trapped pressure. No steady-state repaint on signing.
- Update help/design documentation and label the old mouth-only probe as a diagnostic baseline, not an acceptance test.

## Validation

- `node experiments/game-fixtures.cjs`: passed, including fixed high/low targets, only-goal mutation at signing, preserved mouth states, blocked target despite an open remote reservoir, bent cross-column connection from a rival reservoir completing each polarity, and refusal rather than softening on a blank board. Existing game lifecycle and bot checks pass.
- `node experiments/gas-fixtures.cjs`: passed.
- `node experiments/pressure-propagation-fixtures.cjs`: passed.
- `node experiments/render-smoke.cjs`: passed.
- `git diff --check`: passed.

## Limits and next step

The route filter checks possible quarter-turn port connectivity, not a proven pressure solution under competing boundaries, changing geometry, or grain resistance. Players may need to isolate competing branches. It conservatively excludes other goal cells. Bots route but do not yet plan branch isolation. Next step: measure human/bot solve difficulty across seeded boards and add isolation planning if desired, without restoring automatic construction or threshold fitting.
