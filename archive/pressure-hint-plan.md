# Pressure route hint and mouth keys

Standalone specification. It can be implemented from this file and the current
sources without chat or history.

## Problem

A person who signs a pressure goal gets a `hollow cross` bottle with a tag such
as `0.42>0.68` and nothing else. The route to a reservoir, the valves that
still block it and the mouth that feeds it are known only to the bots, which
read them from the quarter-turn route search. The field therefore does not say
what the goal asks for.

A person's own mouths answer only to the pointer. The keyboard can select and
turn every valve, but it cannot seal or open a mouth, so a pressure goal or a
Vent seat cannot be played from the keyboard.

## Scope

1. A route hint for every signed pressure goal whose seat a person plays.
2. A keyboard path to the mouths that seat owns.

Out of scope, and not to be reintroduced: building or turning any part of the
route automatically, shaft columns, threshold fitting, pocket ranking.

## 1. Route hint

### Source of truth

The hint is the result of the existing search, `findAirRoute(sim, goal,
wantHigh, playerId)`: the shortest chain of cells from the bottle to a mouth of
the wanted polarity that quarter turns alone can open. An own sealed mouth
counts, a rival's mouth only while it is open, other goal cells never. A
pressure goal has exactly one bottle, so one route describes the whole goal.

One function, `traceAirRoute`, unrolls the search into a preallocated route
buffer. The bots and the hint both read that buffer, so the hint can never
disagree with what a bot would do and the chain walk exists once.

### Route buffer

`game.routes[seat]`, one per seat, allocated in `Game.create`:

| Field | Meaning |
|---|---|
| `questId`, `targets`, `mouths` | cache key: goal id, `sim.targetVersion`, `sim.inlets.version` |
| `count` | cells on the route, reservoir end first, bottle last; `0` = no route |
| `cells[n]` | cell index |
| `out[n]` | side (`0..3`, `G.DX`/`G.DY`) the air leaves by towards the reservoir |
| `back[n]` | side towards the bottle, `-1` on the bottle itself |
| `turns[n]` | quarter turns still needed: `0`, `1`, `-1` or `2` |
| `pending` | number of cells with `turns != 0` |
| `mouth` | reservoir mouth index, `-1` without a route |
| `text` | one-line readout for the goal card |

`sim.targetVersion` is a new counter in `simulation.js`. It rises whenever a
rotor's target detent changes: `turn`, `setTarget`, auto-rotation, the stall
back-off, `installValve` and a field reset.

### Refresh

`evaluateQuest` refreshes the route of a pressure goal on its settle cadence
(15 Hz) and at signing, only for a seat a person plays. The refresh returns at
once while the three keys match, so a still field costs three comparisons and
the search runs only after a turn or a mouth press. A changed `text` raises
`game.version`, which redraws the goal card. Nothing runs per frame.

The keys cover every input of the search: valve types change only through
`installValve`, which also moves the target counter, and so do the bottles that
other goals place and seal. Two events move a goal between buffers without
touching a counter, so they forget the key instead: signing (quest ids restart
with a new match) and seat renumbering after a seat is removed.

### Readout

- `Route: turn 2 valves → your in mouth, column 4, then open it`
- `Route: valves aligned → your in mouth, column 4, open it`
- `Route open → Ada's out mouth, column 7. If the pressure stalls, close off the branches that bleed it.`
- `No route to a source mouth — every path is blocked.`

The line changes only with a turn or a mouth press, never with the pressure,
so the open form is worded to be true both while the bottle is still charging
and while another branch bleeds it. It names the remaining job instead of
reporting success: the goal's own progress line reports the hold.

The card of the seat's own goal shows the line under its progress.

### Drawing

`R.renderRoutes(ctx, layout, game)` runs before `renderGoals`, above the grains,
in Game mode only. For each hinted goal, over a dark underlay:

- a thread in the seat's accent colour through every route cell short of the
  bottle, from side to side through the hub, rounding a corner on the elbow
  radius; the bottle's own cell stays clear for its hold arc and tag;
- solid where the valve already joins the two sides, dashed where it has to
  turn;
- on each cell to turn a curved arrow round the hub in the selection amber, the
  colour the hand already has in this interface: a quarter arc for one turn, a
  half arc for two, headed the way the rotor goes. It starts and ends on a
  diagonal, so its head never lies on the thread;
- a stub from the field edge into a cup round the reservoir mouth, open towards
  the field so it stays inside the band, dashed while the mouth is sealed.

Paths are batched by pen: underlay, solid legs, dashed legs, then the arrows'
underlay and amber. No per-frame allocation; dash patterns are module
constants.

## 2. Mouth keys

Canvas keys, in dealt modes (Game, Vent):

| Key | Action |
|---|---|
| `Tab` | focus the next mouth a person's seat owns; past the last one the key is not consumed and focus leaves the field |
| `Shift+Tab` | previous own mouth; from the first one back to the valve cursor; from the valve cursor the key is not consumed |
| `Space` / `Enter` | press the focused mouth through the same path as a click; with no mouth focused, turn the selected valve as before |
| arrows, any pointer press | return the cursor to the valves |

Order is the mouth index: top band left to right, then bottom band. Lab mouths
have no owner, so Lab keeps its single tab stop.

The focused mouth wears the hover ring and name label. Each focus move and each
key press writes the mouth, its state and what `Space` will do to the status
line, which is a polite live region. Every way back to the valves — an arrow,
`Shift+Tab` from the first mouth, `Tab` past the last, a pointer press, blur —
writes that the keys are on the valves again, so the line never keeps naming a
mouth that `Space` no longer presses. Focus is dropped silently when the mouth
stops being pressable (mode change, seat removed or handed to a bot), because
those events write their own line.

## Documentation

Shared `index.html`: shortcuts list, `#mouth-hint`, `#vent-hint`, canvas
`aria-label`. README: controls and Game paragraphs.

## Validation

- `experiments/game-fixtures.cjs`: the route buffer is contiguous from a
  boundary cell to the bottle, ends beside its mouth, `pending` matches
  `turns`, applying the listed turns leaves nothing pending, a bot seat gets no
  route, a blocked board reports no route, and the cache does not search again
  on a still field.
- `experiments/game-fixtures.cjs` also covers the seat cases: a goal that moves
  down a seat reads its route again there.
- `experiments/render-smoke.cjs`: `Tab` focuses the first own mouth, `Space`
  seals it, `Shift+Tab` returns to the valve cursor, the last `Tab` is not
  consumed, an arrow or a pointer press returns `Space` to the valve; a signed
  pressure goal draws its thread and one arrow per valve to turn, the card
  carries the readout, following the arrows clears them, and dropping the goal
  clears the thread.
- Regression: every `experiments/*-fixtures.cjs`, `render-smoke`,
  `geometry-check`; `node --check`; `git diff --check`.
