# Geometry pitfalls

- A rounded radial elbow needs an offset center at the sum of its port direction vectors times the bend radius. An origin-centered arc joins the radial legs at right angles and bends toward the wrong side.
- When changing arc geometry, update rendering, angular containment and particle sampling together. Tangency and mirrored-midpoint tests catch a visually plausible but inverted bend.
- Node Path2D stubs can test analytical geometry, not actual canvas clipping or file-protocol behavior. A recording stub is still worth it: it proves that the stroke path is built from the same primitives used for collision.

# Seam and clearance pitfalls

- Model a port-to-housing opening as an aperture in the rim, not as a taper. A corridor that narrows toward the rotor silently closes the channel mouth; the corridor should span exactly rim to cell edge, with the rim acting as a wall only where the rotor does not open it.
- Keep one coordinate frame per helper. Mixing strip-local and valve-local coordinates produced two bugs that only the invariant fixtures exposed; the symmetry and "no invented air" checks found them faster than inspection.
- Cap clearance with `min`, never with a chain of `if (a < d) d = a` that skips the assignment when the cap is larger.
- Normalize an arc's end angle when storing it. `a1 - a0` is ambiguous across the ±π branch, so any consumer interpolating the stored angles may sweep the long way while drawing looks correct.
- Walls are zero thickness in this model, so air can resume a fraction of a pixel beyond a contact point. Assert anti-tunnelling against the first blocked sample of the ray, not against a fixed probe distance.
- Adjacent cells that describe the same channel need a small overlap. An exact geometric fit makes the shared edge depend on which cell a point is assigned to, and a rounding error there becomes an invisible lip that traps grains.
- An opening between two regions must not be capped on its far side by the region that owns the other side; a cap at a cell boundary leaves a floating-point wall. Limit the opening where it narrows, not where it ends.
- Render cell-local geometry only after translating to the cell centre, and check the background sheet's size covers every pour spout; a clipped sheet loses them silently.
- Paint crossing corridors in material passes over the whole field (edge, material, air), never strip by strip, or one corridor's dark edge lands on another's air.
- For recovery, project onto each eroded primitive with a clamp and keep the nearest verified candidate. A fixed ring search can fail in a narrow channel; a projection always yields a point that is air by construction, and it stays deterministic if ties keep the first primitive.
- Outside a narrowing seam (`0 < seam < HALF`), a disc centered at `|lat| < seam` still contacts the two solid rim jaws at `(±seam, RV)`. Cap corridor clearance by `hypot(r - RV, seam - |lat|)` (and inside by `hypot(RV - r, seam - |lat|)`): treating `|lat| < seam` as full-width channel air creates a discontinuous cliff the instant `seam` reaches zero, letting grains sink into the rim and stalling the rotor.

# Simulation and rendering pitfalls

- Integrate velocity in the inertial world frame (`orig + v * h`) while sweeping from the passage-carried position. Adding world velocity on top of a carried position double-counts `omega × r`, and rotating or damping inside a central hollow chamber makes empty air drag free-falling grains onto the ceiling.
- Relax passive passage carries across seam mouths in a fixed-point loop before checking forced wall pinches; single-pass index order lets an inner grain rotate into a mouth grain that later drops its carry against a stationary corridor neighbour.
- Initialize per-step stall stamps to `-1` (never `0`, which collides with `steps === 0` and stalls every valve on frame 0). When a stalled valve times out past 45°, back off to the detent behind the turn (`floor` for `+`, `ceil` for `-`), never `Math.round` which re-targets the blocked detent in an infinite loop.
- Distinguish `G.sweep` wall hits from mid-air pile-bisection stops; applying clearance-gradient wall impulses on a mid-air pile contact kicks grains along the distant wall gradient.
- Rotary drain reachability is graph connectivity over `ports.length > 0` (every ported rotor visits all four sides as it turns), not static `angle = 0` port alignment which starves whole seeds.
- Mapping world `[-POUR, SIZE + POUR]` onto canvas `[0, SIZE + 2 * POUR]` requires `ctx.translate(0, +POUR)`, with background and overlay blitted at `(0, -POUR)` every frame even when `putImageData` updates are throttled.

# Liveliness pitfalls
- A pile contact blocks only its normal. Bisecting the whole displacement vector when the straight step dips into the contact circle scales the tangential component to nothing: stacks become stable equilibria, columns never spread, grains "fall and sit". Project the velocity onto the contact tangent (normal of the deepest overlapping pair) and re-sweep the step along it.
- On a curved wall, one straight tangent chord lies outside the passage. Sweeping it clips movement back to the impact point each tick while tangential velocity grows. Consume the remaining time in short chords, correcting each endpoint to the grain-clearance contour and applying the local wall impulse.
- Friction tuning cannot repair a blocked wall sweep. Pair and wall friction are Coulomb caps on collision impulses; higher values can slow a packed bed, but reducing them alone does not make a tangent step follow a curved wall. Keep friction in the material model, and fix geometric sliding independently.
- A packed bed can arch if pair impulses are applied only after positional overlap. Detect near-touching pairs inside a small contact band (`~0.4 px`) and resolve their normal velocity immediately; otherwise gravity is applied particle-by-particle and support is not transmitted through the chain. Do not make random kicks the default cure. A separate, bounded optional stress control can help a stubborn jam, but keep its zero setting quiet and its maximum below the former kick amplitude.
- Keep ordinary lubrication deterministic and material-based: scale the tangential Coulomb cap at grain-grain and grain-wall contacts; it must never add velocity. Verify it with a quiet sealed-bed fixture as well as a loaded elbow, since flow alone can hide agitation.
- Slope fixtures must start a lone grain at both opposing walls and measure displacement along the downhill passage axis. Checking only one side or only visual overlap can miss a wall-normal/sign bug that makes some grains sit on an incline.
- A level pipe is not a bend: gravity gives it no thrust, so even a fluidized full horizontal run creeps only as fast as the bed rearranges. Routes that must move grains sideways want a slope (a jog chain), air, or a lower outlet — say so instead of promising "a full pipe always drains".

# Pressure pitfalls
- Distance-ratio pressure with Darcy `v = ∇p / cost` is almost invariant to a *local* fill cost: both the gradient and the divisor scale with cost, so occupancy warps the overlay without slowing the gas. A uniform fill does throttle. Sitting grains have to charge cell momentum (and pinned mouths restore it) rather than relying on FILL_COST.
- Re-solve occupancy on a clock even when rotors are still. Measuring fill only at mask rebuilds leaves cost stuck on the cells grains have left, so a pile never becomes a plug.
- A falling grain keeps meeting fresh cells, so it still feels the lift; a sitting pile drains the same cells. That difference is the reciprocity, not a stronger one-way force.
- Air-cell endpoints plus a midpoint do not prove an open face: a thin shut rotor rim can lie between samples. Check the full link against clearance and compare runtime faces with `G.sweep` on rotated valves.
- A wall impulse is not a pressure without a known wall area, elapsed time and physical units. An independently scaled relative potential is only an equivalent-pressure visualization; distance paths through metal and instantaneous solves cannot establish sealed-wall or transient gas physics.
- A potential-difference field needs both polarities. `p = d_low / (d_high + d_low)` with one polarity sealed degenerates to a constant (all `1` or all `0`), so "seal every vent" paints the whole field one colour. Report a separate `anchored` flag and hide the overlay, and let the legend say which side is missing; do not fake a colour.
- Do not let a distance sweep cross a face the velocity stencil has blocked. If the potential can step from air to air across a shut rim while Darcy cannot, the overlay shows a gradient the gas never follows. Compare each air-to-air link against the face mask and let it leak only through metal cost.
- With a fixed sweep count, a heavier metal cost needs a few more passes: three directional sweep pairs converge the 6 px machine grid to a mean error under 0.4% while two leave local errors of 0.13 potential. Localizing the field (metal 12 rather than 6) is what makes a valve placement visibly change the overlay instead of shifting a global gradient.
- A solved field that is shown immediately reads as a repaint, not as a cause. Ease the shown value toward the new solution (30% per 30 Hz tick, pinned mouths snapped) and run that clock while the page is paused, otherwise clicks on a paused page look inert.
- Zero-cost paths through cells that never got a cost assigned (a new scratch buffer, a metal cell skipped by an "air only" loop) produce `NaN` that poisons the whole field silently. Initialize every buffer `rebuild` owns, and keep the reset in the same loop that changes it.

# Skin fidelity pitfalls
- A skin named after a prototype page must copy its exact colour lists and band structure, including the bands the page does NOT draw (the gpt page has no light material band and no screws); an "inspired by" palette reads as a different product. Rasterise both headlessly and compare crops before calling a skin done.
- A hub bolt at a rotor centre only reads as machining where channels leave the centre solid; on a blank plug it looks like a foreign axis object. Gate decorative centre details on the passage actually existing.

# Game mode, press-drag, and goal-bottle pitfalls
- Assigning each cell a seeded permutation rank `autoRank[i] ∈ [0..99]` (`autoRank[i] < round(autoRotate * 100)`) makes sliding **Auto-rotate** from `0%` to `100%` monotonic and flicker-free; re-rolling booleans on slider input scrambles which valves move on every pixel of drag.
- Pointer release after a press-drag rotation fires a native `click` on the canvas at the same cell. Track whether pointer travel crossed the drag deadzone (`6 px`) and suppress the trailing `click`, or every drag release adds an unintended extra quarter-turn.
- Never call `R.buildScene` (`101` new offscreen `<canvas>` allocations) on single-cell valve placement, case retinting, or quest lifecycle events. Repaint `scene.bg` in place via `rebuildBackground` and re-bake only the touched cell's rotor sprite via `rebuildRotor`.
- Replacing a small random hollow cell (`chamberR ≈ 0.30..0.42 RV`) with a quest goal bottle via `installValve` must pass an explicit `GOAL_CHAMBER` radius (`0.53 RV`) rather than inheriting the old `chamberR`, or `8+` grain quests physically overflow the bottle before reaching target count.
- Never spawn a `hollow-single` (`↑ N`) goal bottle directly above an existing goal bottle (`idx + N`) or stack multiple bottles in the same column when free columns exist: a 1-port bottle has no South outlet, so placing it at `(col, row - 1)` corks `(col, row)` shut.
- Under pure gravity, lateral `N -> E/W` deflection works reliably through curved `elbow` ramps (`solid-elbow` / `hollow-elbow`), whereas a `tee` or `cross` oriented with South closed traps single grains on its flat floor; both spout-reachability checks and bot BFS must distinguish curved deflectors from flat-floor junctions.
- Circular-mean average-hue matching (`atan2(Σ sin θ, Σ cos θ)`) requires a resultant vector-length floor (`R = hypot(Σ cos θ, Σ sin θ) / n >= 0.42`); without a coherence check, near-cancelling rainbow mixtures produce an arbitrary residual angle that spuriously satisfies narrow `6`-band quests.
- Prevent bots from simultaneously signing opposite-polarity pressure quests (`> x` vs `< x`): otherwise two bots toggle the same top/bottom boundary vents in an endless tug-of-war.


# Grid gas replacement (2026-10-27)
- The distance-ratio potential was the wrong model, not just a badly tuned one. A `p = d_low / (d_high + d_low)` field needs both polarities, hides itself when one is missing, and lets pressure step through metal. Tests that asserted the resulting all-one-colour state were validating the bug.
- Make open mouths **Dirichlet cells outside the 10x10 field** (1 or 0) and solve a transient diffusion on the graph of open faces only. Then a single mouth is a valid boundary, a shut rim is a real wall, and a component with no mouth holds the air it has. With every mouth sealed there are no pins, so the field is frozen rather than repainted.
- Do not force a solve on every mouth click. Re-pin at once and let the 1/30 s mask clock carry the front; otherwise a large implicit step reads as an instant global repaint, which is the symptom the user reported.
- Jacobi-preconditioned CG converges in one sweep per corridor cell, so on long 1-D pipes it needs a sweep per cell, hits the iteration cap and the visible "front" degrades into solver starvation. IC(0) shares the 5-point stencil (factor fused into the unknown-list build, two triangular sweeps per apply), is exact along a chain — a scrambled 301-cell pipe solves in one step — and replaces the planned multigrid preconditioner at a fraction of the complexity. Plain SOR was still worse; keep the unknown list compact (only active, unpinned air cells) and fuse the matrix-vector product with the PCG dot product.
- A mask clock compared as `clock - maskClock < 1/30` loses ticks to frame-dt rounding (the effective rate drops to 15 Hz on alternating frames) and makes front speed frame-rate dependent. Advance the clock by exactly the mask period and drop only a large backlog.
- Rotation can enter the gas without any inertia model: add the rigid wall velocity `ω × r` inside a turning rotor disc to the velocity target alongside the pressure flux. The velocity array is already re-derived every mask tick, so the swirl follows ω's sign, needs no pressure boundary, and dies out with the same easing once the rotor stops — the same kinematics the particle backend gets from moving-wall reflections.
- Verify a new pressure model with a connected cross-valve layout: one component and a linear 0-1 gradient from the high band to the low band. Repainting the whole field on a click is not "air filling".
- Strict connectivity means a random machine can isolate a goal chamber from both mouth bands. Pressure quests must open a real air route (a four-way bottle plus a shaft of cross valves) and probe the same mouth recipe the bots use, otherwise fitted thresholds are unreachable.

# Mask resolution and turning apertures (2026-10-27)
- A mask that samples only the centre line between two cells silently closes every aperture that opens **off-centre**. In this geometry that is the norm: a rotor seam is a slot centred on the port axis, while the cell centres sit up to 3 px to one side, so as soon as the rotors left their detents the air graph fell apart (all 100 valves at 0.12 rad: 1743 → 40 mouth-connected cells, 78 → 310 components) and the pressure field looked like it "did not reach the pipes". Measure the **face**, not the centre line.
- Test a face laterally by solving the link's crossings with the rotor rim circle. The seam slot is the only hole in that rim, so two exact crossing samples decide an off-centre aperture — and they cannot miss it, which sparse straight-line probes can: the blocked annulus where clearance < `AIR_MIN` is only ~1.5 px thick on each side of the rim. A cheap two-sample probe at 1/3 and 2/3 of the link found +6 false links across a shut rim in the calibration fixture; the crossing test found none.
- Confirm the crossing with the full throat test only on the widest lane, not on every lane: the crossing sees the slot, the lane has to reach it through the housing. That kept the rebuild at 3.6 ms instead of 4.8 ms while leaving 0 of 18,284 open faces without a lane that crosses no metal.
- Keep the aperture as a **factor** on the face conductance (open lanes / lanes, scaled by the slot throat) instead of a boolean: a part-open port then throttles its link, and the steady solve honours it as an ordinary serial resistance.
- Validate a mask against a fine (1.5 px) flood fill of the same clearance predicate, not only against its own links: "every open link is legal" passes while half the real links are missing. Compare the mouth-connected share of the air and the component count per rotation state.
- A kinematic swirl should fade out through the port mouth, not stop at the rim. Extend ω × r one cell past the rim, but only inside an open seam's lateral span, or a portless chamber starts dragging air outside its own wall.
- Cache derived geometry per *owner*, not per frame: a gas cell's clearance depends only on its own valve and a face's aperture on its two cells' valves, so one stamp per changed valve makes a rebuild cost proportional to the rotors that actually moved (0.08 / 0.41 / 2.9 ms for none / one / all of 100) instead of to the whole grid. Two traps found the hard way: store the *negative* result too (keeping only open apertures let a shut rim come back to life on the next rebuild), and build the signature from what the object actually owns — a valve carries `ports` and `kind`, while the type mask lives on the type, so `v.mask` silently made every valve look identical and a type change went unnoticed. Keep stamp arrays on Float64 when comparing a stored copy of a float64 field, or a float32 stamp value never matches again and the cache is bypassed forever.
- When adding a cache, add a fixture that compares the incremental result to a build from scratch over many intermediate states (and one structural change), then break the cache on purpose and watch it fail. "It looks right" is not evidence for a cache.

# Local valve pipe cells (2026-10-28)
- A world-space grid is the wrong state container for a rotating valve. Re-cutting `6 px` texels against a turned rotor either loses a `1.5 px` seam between samples or forces the whole mask to be rebuilt for every angle. Give each rotor its own cell lattice in **the prims' unrotated frame**, sample its clearance once, and keep the casing pipes static in tile coordinates. A turn is then a coordinate transform, not a re-sampling.
- The seam is the only place the two coordinate systems meet. Rotate each near-rim rotor cell centre into the casing frame, pick the corridor lane its lateral offset lands on, and connect them only when the analytical seam chord is open. Precomputing static edges plus a per-node `staticCount` means a rebuild rewrites only the turned valves' seam slots and rim texels; the display projection can keep a static half and an incremental air list.
- "Both cell centres are air" is **not** a valid edge. On this geometry 95–127 diagonal rotor links per machine cut straight through the metal of a curved elbow. Sample a `0.75 px` clearance disc along every candidate link — `passageClearance` in the rotor's own frame for static links, world `valveClearance` for the short seam links — and then check the whole graph independently with `G.sweep`, which is the same predicate the grains use. A world-grid face check would not have found these.
- Caching a mask is not enough on its own: check that a rotor turn changes the **carried pressure** rather than leaving every texel identical. The old "changing connectivity does not repaint the pressure" assertion was validating the world-grid architecture; with rotor-local cells the pressure inside the valve moves into new world texels while static casing texels stay put. Assert that the tile's pressure sum and range are conserved and that the field still evolves afterwards.
- Explicit conservative diffusion is *not* a cheap way to get a visible front on a fine pipe graph. Even with a per-edge rate of `alpha / max(deg_a, deg_b)` (stable and much faster than a global rate), crossing an `L`-cell pipe needs O(L²) sweeps: 2,560 sweeps left 95% of a connected machine untouched. In-place SOR on a radially ordered graph took 400 sweeps with 0.05–0.99 error. One implicit IC(0)-PCG step per `1/30 s` tick with a **16-iteration transient budget** gives the same front in 11 ticks for a fraction of the work; the "no substeps" requirement is about the frame loop, not about forbidding a sparse solve.
- A steady solve from zero is expensive on a 4,000-node graph (~32 ms). Two multi-source BFS passes from the high and low pins give a distance-ratio warm field that is within `0.004` mean / `0.015` max of the converged steady on a connected cross machine; a dozen PCG sweeps then polish it. Keep the exact 700-iteration budget for measurement references (front target fields, hand-built 1-D fixtures) and let gameplay callers ask for the quick version.
- Degree-normalizing the face flux hides the conductance drop a pile should cause: `pile flow 55.5 vs empty 39.5` was backwards until the velocity summed raw `g * (p - p_neighbour)` again. The empirical `FLOW_SCALE` is strongly non-monotonic against a falling grain (drift 3.7 px at 22,000 but 1.0 px at 20,000 and 0.3 px at 28,000 because the grain bounces off a wall) — sweep it and pick a stable plateau, do not extrapolate.
- Old diagnostic scripts encode the old architecture. `calibration-fixtures` was asserting that world-grid faces have an open lane; replace it with a **network-level** check (seam links clear `G.sweep`, shut rotors have no seam links, narrowing seams throttle conductance, turns never resample rotor air). `aperture-probe`'s "open faces" section became meaningless once `face` was derived from component equality.

# Refactor leftovers and mode balance (2026-10-28)

- A display mirror the UI never reads is still a maintenance liability, and it fails *loudly* when it goes stale: `face/apR/apD/comp/open/fill/cond` were copied onto the projection so the overlay could show them, and the rebuild path had grown extra `syncConductance()` calls purely to keep them warm. Delete the mirror and move the reader onto the live array instead of re-feeding a copy — but grep the whole tree first, `experiments/` included: two diagnostics read the deleted fields and had to be repointed, and `aperture-probe`'s aperture-weighted mask share turned out to be within a point of the plain area share anyway.
- When two owners want the same one-way flag, put a refcount between them, not a write. Signing a quest set `sim.spoutMask[column] = 1` directly, so the next `installValve` — which rebuilds the mask from the layout seed — silently took the promotion away again, and dropping the quest could clear a column the seeded layout owns. A per-column claim count that the mask builder ORs into its own rule keeps one owner of the mask and makes release automatic.
- A per-goal hold timer is not more general than a shared one while the quest still demands *every* goal at the same instant: the minimum over per-cell streaks resets exactly when the shared timer resets, so the refactor changes nothing but the field count. A two-bottle quest that never completes has a feeding problem, not a timer problem — measure which before touching the rule. (Writing the loop did catch one trap worth remembering: seeding a `min` reduction with the completion threshold makes an empty contribution read as "already done", so an unsatisfied goal has to pin the result at `0`.)
- Bots that think in half-second cooldowns starve a human out of a freshly generated quest. A short grace window on the time a quest has been open, bypassed by the board a match starts on and honouring nothing else, costs bots ~4 s per replacement slot and buys the player a chance to read the card.
- Judge a difficulty tier by the rate a player earns it, not by the points constant. Measured solve times clustered at 4.4–8.3 s across all three tiers, which put a 6× points-per-minute spread entirely in the generator's favour: an easy `2–8` band quest was worth 110 pts/min and a single-hue exact quest 1208. Scale the clock with the demand a quest actually places (per required grain, per extra bottle) and let a tight clock buy the higher difficulty *rating*, so rewards track effort without renumbering every template.
- A probe that measures against a stochastic reference engine is not a gate: `behavior-probe`'s `glm*` rows swing by hundreds of pixels between two runs of the *same* tree. Compare only the rows the solver itself produced, and expect the reference rows to differ — or a cleanup looks like a regression.
- A patch script that asserts before it writes applies **nothing** when one hunk misses, and reports success. Grep the file after every scripted edit; match the file's real indentation (2 tabs inside `step`, 3 inside the bot loop) instead of what looks right.

# Measuring a live gas field, and regulating one (2026-10-29)

- `GAS.steady(gas, gas.p)` takes the **12-iteration** live path (`PCG_LIVE_STEADY_ITERS`) whenever `out === gas.p`, and undershoots a mouth pair by up to `0.2`. A measurement wants `GAS.steady(gas, gas.pTarget)` (700 iterations into the scratch field); `steady` with zero pins is a no-op, so check the pins are on before believing the number.
- `S.installValve(..., quiet = true)` swaps the rotor without touching the network, so `gas.net`, `gas.map` and the components are stale afterwards. Any measurement taken after a quiet install must call `GAS.refresh(sim)` first — a rig built from ten quiet installs measured a span of `0.00` on a field that was fully connected, purely because the network still described the previous layout.
- A transient starts from `net.p`, not from the display field, and one 12-iteration snap does not arrive at a mouth pair's equilibrium. Snap three times before reading a starting value, or the drift you measure is the distance the solve still owed you.
- Typed arrays swallow an out-of-range write silently. A seat whose mouth indices were still the `-1` sentinel "toggled" `inlets.open[-1]`, measured charge and drain with the same mouth state, and reported `span 0.00` for every candidate — a wrong number, not a missing one, and the fallback then played arbitrary columns. Fill the sentinel before measuring anything through it.
- Print a decision's inputs where the decision is made. The band that a report showed after 45 s of play was the one fitted after the last completed round, not the one the rig was chosen for, so two runs of the same seed "disagreed" about a deterministic setup.
- A criterion can outlive the design it was written for. Sealed-pocket drift was measured to pick a rig that a seat could answer with two switches; once the bottle stopped opening onto the lateral mesh, the first second after sealing measured the relaxation from the flow equilibrium (`0.05` everywhere) and the second measured nothing at all (`0.0000` everywhere). The check cost two seconds of settle per candidate and rejected nothing. When a fix removes what a measurement discriminated, delete the measurement with it.
- Two seats in one field share a volume before they share a control loop. A `hollow-cross` bottle connects the pocket to the corridor mesh beside it, and a rival's drain pulse dragged a *sealed* pocket by `0.3` — twice the band it was supposed to hold. The same rig with a `hollow-straight` bottle, in the same field, moved less than a band. Fix the topology before tuning the law: every control tweak measured on the cross bottle was fitting to another seat's pulses.
- "Sealed" is not "still". The pocket is a small part of its column's air, so after a pulse it slides toward the column's average for about `0.3 s`. A bang-bang loop that corrects during that slide limit-cycles at `5–20` mouth moves per second and holds the band `30–70%` of the time; waiting the slide out costs one constant and lands at `0.4–1.4` moves per second and `77–99%` held.
- Match the control cadence to the plant, not to the display. An open mouth moves a pocket by up to a third of the ramp in one frame, so a `15 Hz` evaluation cannot land inside a `0.12`-wide band at all; the seat loop runs on `S.STEP` and only the panel is throttled. Throttle the DOM with a key that folds what the row shows into one integer, so a steady needle rebuilds nothing.
- Do not derive a rate from one sample of a diffusive solver to feed a predictive lead. `(p - prev) / EVAL_DT` turned solver noise into a `0.045` prediction error and made every seat chatter; the structural fixes above removed the need for it.
- Restore a borrowed field by its **world** state. `installValve` re-bases `v.ports` onto the canonical type and moves the rotation into `v.angle`, so a byte-exact port comparison reported 17 broken cells that faced exactly the same directions; compare `G.worldPorts(v)`. And save `G.orientationOf(v)` — the orientation the cell faces the world with — not `quarterOf(sim.target)`, or the column comes back already turned to where its auto-rotate schedule was heading.
- A green check that never ran is worse than no check. `sim.count` is the **grain** count, so a teardown comparison looping `for (k < sim.count)` over a drained field compared zero cells and printed "0 diffs"; `G.describe()` has no `.type`, so a "type mismatch" count compared `undefined` with `undefined`. Assert the loop bound, and print the count of things compared next to the count of things that differed.

# Drawing controls, pacing bots, and turn-based modes (2026-10-30)

- A control that cannot move anything must not be drawn as machinery. A fallback
  mouth in Vent mode pins pressure in its own column but has no route to any
  collector; drawing the same owner stem and flow arrow as a routed mouth made
  players press it expecting the gauge to move. Mark the owner — a ring, no stem,
  no arrow, no field-edge plate — and leave the machinery to the mouths that
  actually reach a bottle. The label can stay: hovering still has to say why.
- Derive "where is this valve?" from the solver's own graph, not from the display
  field. `GAS.index(x, y)` is the 6 px display texel; the live network indexes
  `t * SLOTS + rotor cell` and `casingNode(...)`, so a component lookup through
  the display index returned `-1` or `undefined` while a fully connected valve
  sat in a real component. The network already stores each node's valve in
  `net.owner`, so one sweep of `net.list` labels every valve's pocket.
- Pace a bot per seat, not per frame. A cooldown of `1 / rate` decremented by the
  frame `dt` and refilled at the action is a hard ceiling — a long frame still
  buys exactly one map change — while a cooldown drawn from a range lets the rate
  drift with `dt` and with how often a frame lands. Keep the jitter on the slow
  side so the advertised number is the maximum.
- A turn-based loop needs an expiry even when the rule says "the turn ends when
  it is spent". A person who does nothing keeps the turn, and a bot behind that
  seat never plays. Ten seconds per turn plus a pass button keeps the order
  moving without making the human fight a clock during a two-second decision.
- A one-detent turn means the press-drag dial has to be off in that mode. The
  dial's whole point is that one gesture buys several detents; leaving it on
  turns a single "turn" into a multi-quarter-turn move and quietly breaks the
  rule the HUD states.

## Mass-weighted grain contacts (0.3 slice 1)
- Full inverse-mass positional+impulse weighting destabilises packed mixed
  beds: heavy grains squeeze wall-pinned light grains out sideways
  ("watermelon seed"), sealed-bed mean speed 22 px/s vs <5 limit. Keep
  resting support and positional split equal; apply clamped (2:1)
  inverse-mass shares only on the restitution/impact branch.
- Keep solver mass in the historical `r^2` units (`mass=(rho/1000)*r^2`) so
  existing air/gas tuning stays exact for the neutral material.

## Quasi-static water volume (0.3 slice 2)
- A per-cell "surface" is NOT the pool waterline: a fully submerged cell reports
  its own top edge, so only the topmost wet cell carries the true free surface.
  Test grain submersion against the component's highest surface (the waterline),
  not the grain's own cell, or a submerged grain reads as half-submerged.
- A relaxation convergence check based only on surface change falsely converges
  when a cell is overfull: its surface clamps to the top edge and stops moving
  while water still needs to rise. Also require no cell over capacity before
  declaring equilibrium, or displaced water never backs up.
- "Fill the lower cell first" vertical transfer is right for falling water but
  needs a reverse (bottom-up) sweep to push excess back up when a lower cell's
  capacity shrinks; alternate sweep directions each pass.
- A coarse Eulerian grid cannot carry water around a rotating passage. When a
  wall closes a wet cell, displace into adjacent void, route onward through open
  faces only, and hold any unreachable remainder as rotor-carried `trapped`
  volume returned when the passage reopens. That conserves volume across
  split/merge without teleporting through a shut seam.
- The top-row spout corridor is real void even when the port below is shut, so a
  "blocked inlet" still admits water into the spout — the guarantee to assert is
  that nothing lands BEHIND the shut port, not that admitted == 0. Distinguish a
  metal mouth (blocked → unadmitted) from a full open mouth (admits, then backs
  excess out the top → overflow).
- Buoyancy must act BETWEEN a waterline and a grain, not between a cell and its
  own surface. A cell holds one or two grains, so a floating grain's own
  displacement can empty the cell it occupies; reading that cell's surface then
  flips the grain between dry and submerged each step and it buzzes at the cell
  height. Fill the *vertical run* from its floor (capacity first, the last cell
  that runs out carries the surface) and hand every cell of the run that one
  level. Measured on a lone buoyant grain: from a jittering 2 px swing at ~1 Hz
  to < 0.01 px, and the floating fraction lands on the density ratio.
- A pool line quantises to the coarse cell floor, so a 6 px cell gives the
  waterline ~1 px of slack: two grains of different radius in the same pool can
  settle at 0.03 and 0.5 of a 6 px cell and both be right. Judging buoyancy
  against the pool's level is the honest test; judging it against one grain's
  fractional submersion is not.
- Charge a body's displacement where the body IS, not on the cell holding its
  centre. One 6 px cell shared by a 28 px² disc makes cell capacity, and with it
  the waterline a float reads, step as soon as the grain crosses an edge — and if
  that cell is a 2 px floor sliver (24 px² of capacity), the cell alternates
  between "full" and not, so the water is pumped up and drains back at ~0.5 Hz.
  Spreading the submerged area over the ≤ 3×3 cells the disc covers, weighted by
  overlap, removed every measured cycle except a float in a vessel that holds
  barely more than its own displacement. This replaces the earlier guess that the
  limit came from the grain being taller than one cell: the grain never changed
  cell at all in the failing case.
- When a limit is written up as inherent ("the grain spans cells, so it must
  step"), reproduce it with an instrumented probe before believing it: log the
  quantity the body actually reads each step (here `levelUp` at the grain's cell,
  its cell's `vol`/`gdisp`/`area`) rather than the quantity you assume it reads.
  The wrong note cost a slice: the level swung 3.5 px while x was constant, which
  one dump made obvious.
- A function that is implemented, exported and unit-tested can still be dead: the
  water surface line existed for a whole slice with no caller. For a renderer,
  prove the call by recording assigned pen colours in the headless context stub
  and asserting the layer's colour was used; pixels are not otherwise observable.
- Pick the metric before the threshold, and check its components. Scoring a
  separation by thirds of the pool marked correct sinks as misses because a pile
  of grains is taller than a third of a shallow pool; halves plus a per-material
  table showed the separation was 100% while the aggregate said 88%. Also exclude
  neutral material from a "light vs dense" score — it is weightless in water, so
  it can only ever count against you.
- A gravity-side obstruction at the waterline is not a water bug. Two floats
  side by side ride the solver's `CONTACT_MARGIN` (~1.2 px) above the cell floor
  because the lower one rests on the bottom; the upper one then has its floor
  above the pool line and cannot be wet at all. Read the float's own numbers
  before touching the water model.
- Re-sampling a world water grid every tick while valves turn is the dominant
  cost, not the relaxation. Cache per valve angle and throttle the rebuild to a
  30 Hz mask clock (relaxation still runs each step): 4.4 → 1.4 ms/step turning,
  0.48 ms/step static. Iterate an air-cell list and skip dry pairs instead of
  scanning metal cells and recomputing gx/gy per cell.

## Water colour channels (0.3 colour slice 1)
- Give liquid ONE move primitive that splits an area across the donor's channels
  in proportion, and let every path (vertical fill, sill spill, closed-cell push,
  trapped return, supply, overflow, drain) call it. Duplicating the proportional
  split per path is how a colour silently disappears on the one path nobody
  tested. Give a remainder back so a move is exact instead of drifting by an ulp
  per transfer — but give it to the LARGEST channel, not the last one; see the
  measurement notes below for the negative dust the last channel produces.
- Keep the per-cell total (`vol`) as a cache of the channel sum and publish the
  residual in the fixtures. Every existing reader — surface, displacement,
  capacity, scenarios — keeps working on a total, while the channels stay
  authoritative. Measured residual after a 20 s closed box with two pours:
  1.4e-14 px² against 3.3e3 px² held.
- Derive phases from the mixability flags instead of storing phase volumes: a
  phase is a sum of channels, so a checkbox toggle rewrites no state and cannot
  lose volume. Only the partition changes, and the sort is over at most three
  numbers.
- Dominant normalization (`255*v/max(v)`) makes an equal mix white, and white
  over the pale porcelain reads as a brighter wall, not as liquid: the pool
  vanished in the picture. Paint the color view at a fixed shade (~55%) and keep
  the unshaded triple in the display field, so the ratio/hue mapping and the
  pigment anchors stay testable while the sheet still reads as water.
- Compute the normalized triple once per water cell per frame, then address it
  from the texel loop through precomputed row/column offsets. Dividing channels
  per texel (or multiplying an index per texel at 140k texels) showed up as
  ~0.2 ms of a 1 ms display pass; with offset tables the pass is within noise of
  the single-colour baseline (0.98 → 1.05-1.17 ms).
- A display fixture must read the cell that HOLDS the liquid, not the cell it was
  poured into: `setLiquid` into a valve centre settles into the chamber floor
  cells, and the injected cell was already dry by the time the field was
  sampled. Look up the fullest wet cell (and assert every wet cell's triple).
- Per-channel books are easy to read one channel short: summing
  `trappedCh[k]` instead of `trappedCh[i*3+k]` passes "carried volume > 0" and
  fails "carried colours > 0". Assert the sum of a cell's channel stride against
  its own total on the paths that move whole cells.

## Water display and capture (0.3 slices 4-5)
- Do not re-derive in the render what the mask already sampled. A per-texel
  geometry query for the water fill cost 4.9 ms a frame (62k clearance calls at
  3 px) and repeated work the solver did at 15 Hz. Keep the mask's own
  sub-samples (three states: metal / too tight for water / water), draw on that
  sample grid, and the pass costs 1.3 ms. Index the sample grid the way it is
  built: a per-cell packing addressed row-major reads plausible garbage and only
  a fixture that walks the grid catches it.
- A tuning constant that only exists as a module `const` cannot be swept by a
  script, so a published balance table becomes folklore. Make the knob a sim
  field (`sim.waterDrag`, `setWaterDrag`) and commit the sweep next to the
  acceptance run, sharing one scenario module so the two cannot drift.
- A control with no page wiring is a dead API: `setVent(w, column, open)` existed
  while every caller passed the state's own column, so the pour was fixed. Drive
  the new control from the page smoke test, including a value that must clamp.
- A float has buoyancy and nothing else: it cannot be pushed sideways. An open
  pocket at the surface level takes none of them (measured 0 of 24 in 14 s), so
  "skim the layer into a side chamber" is not a mechanic this model can offer.
  Capture vertically: lift the layer over a gate, shut the gate under it, drain.
- A float that starts under a pile in a two-grain-wide passage is jammed (a
  rotor arm is 13.8 px wide and its roof is flat, so there is no force to slide
  along). Pour the mixture into the water at the top of a shaft instead: the
  dense grains sink, the floats stay at the surface, and nothing has to pass
  through the pile.
- A hole in the floor drains grains with the water. Opening a bottom port to
  empty "the lower half" of a split pool removed 20 of 24 grains. Either drain
  through something a grain cannot pass, or keep the water and count the state.
- The surface must not outrun the slowest float: net buoyancy `0.2 g` at 6 /s
  drag caps a green float near 19 px/s, so a vent rate that lifts the level
  faster than that leaves the layer behind. Stage a slow final raise.

## Water colour phases (0.3-water-color slice 2)
- Vertical swaps alone cannot settle a basin: heavy beside light at one surface
  is the lock-exchange setup, the surface solver reads it as settled and
  freezes, and the light phase stays trapped sideways. Trade heavy for light
  down the lateral mean-density gradient in equal areas with an exact
  non-crossing cap, and let the vertical swaps cash the result into sorted
  columns. Equal-density phases must never trade, or a mixed pool stirs itself.
- Gate settling with centroid order plus the heavy-over-light residue across
  open vertical faces, never with a flat depth-thirds fraction: side pools
  perched on sills with dry centres read 41% "wrong" while every column is
  locally sorted. Gate the residue at 1e-3 px², not zero: settled dust sits at
  ~1e-6, below the swap gate, and never reads exact zero.
- A below-surface cell that empties into a hole keeps no bands of its own; if
  nothing inherits the water below it, buoyancy reads NaN and the trajectories
  diverge from the single-liquid solver. Inherit bands (and level) from below,
  and prove bit-identity per step, not just at the end.
- `G.setAngle` without `S.setTarget` swings back on `S.step`: the per-step
  rotor update animates every valve toward its target, so a fixture that snaps
  a gate shut and then steps watches the gate slowly reopen (here: a phantom
  20 px² "leak" through a perfectly tight connector). Snap the angle and set
  the target together. `W.settle` does not step, so settle-only cases are safe.
- Place probe grains by absolute dust, not by share: the interface cell reads
  99% red and passes a ratio test while straddling the split. Require the
  foreign channel under 1e-6, use one fresh settled pool per grain (a disc's
  own displacement shifts the interface for the next placement), and assert
  display texels away from the band split — float dust decides the boundary
  texel either way.
- When a regenerated picture differs from its committed blob, sample pixels
  before believing your eyes about which is which: image-viewer ordering
  misled twice, and both times the blob was the stale one (blue water from
  before slice 1) while the fresh output was the correct gray.

## Water colour measurement (0.3-water-color slice 3)
- A proportional split is `channel * (area / total)` for every channel but one,
  and the remainder for the last. The last channel is the one that can be empty,
  and the remainder is a rounding error of magnitude `area`, so a dust-sized move
  against a large cell charges a positive share to a zero channel: the long
  closed-box run went to -6.8e-21 px². Charge the remainder to the largest
  channel instead — it holds at least a third of the move, so it is far from
  either bound — clamp each share to its own channel, and advance the cell cache
  by what actually moved. Strict nonnegativity is then a property of the split,
  not a tolerance. The all-mixable golden stayed bit-identical through the change
  (an emptying move transfers every channel exactly, so the common path is
  unchanged in value and only changes which channel absorbs the last ulp).
- Scan for the invariant after EVERY step, not once per second. The ledger closed
  to 1e-12 px² and the fixture asserted `min >= -1e-9` while the negative dust
  accumulated for a whole simulated minute; a per-second scan reported the same
  minimum and hid when it happened. 7200 step scans over 46800 channels cost
  ~0.1 ms a step on this machine — 2% of the run, and the difference between
  "bounded" and "cannot happen".
- An invariant test needs a case that fails on the old code. `move` of 3.6e-4 px²
  out of a 27 / 9 / 0 cell overdraws the empty blue channel by 1.4e-20, and
  `movePhase` of 1.89e-3 px² out of a 27 / 0 / 9 cell overdraws green by
  2.2e-19: two four-line fixtures that fail loudly on the remainder-as-last rule.
- `W.rebuild` returns false without sampling when no rotor moved, so a rebuild
  benchmark that calls it twice measures 0.000 ms. Time the three paths the page
  actually takes: an idle tick (free), a full mask after a layout change
  (~10 ms for 15600 cells), and one turned rotor (~0.32 ms).
- Time the display path with the field and the map allocated once. Allocating
  `makeDisplay` inside the timed block measured GC instead of pixels and spread
  the layered frame across 1.2-5.4 ms; with the buffers reused the two views and
  both phase counts land at 1.18-1.21 ms.
- One-shot timing on freshly poured scenes is the noisiest number in the bench:
  the first second after a pour came out 0.26-0.44 ms across identical runs. Take
  a median of 5 fresh scenes, report it, and say in the log that deltas under
  0.1 ms are run-to-run noise, so nobody reads 0.03 ms as a regression.

## Classic-script page wiring
- The shared modules resolve dependencies with `typeof ValveX !== "undefined" ? ValveX : require("./x.js")`. In a classic-script page a missing `<script>` tag does not fail as a module load; it fails as `require is not defined` at the dependency line, aborts that file, and leaves its global in a half-initialized state. Every later module then reports a misleading `X is not defined` at its own dependency line. Read the page's script list, not just the module, when a global is missing.
- `experiments/render-smoke.cjs` now derives the script list from `index.html` and `air-scale.html` and asserts dependency order, so a stale page list fails the smoke test instead of the browser. Keep new shared modules in both the page and this guard.

# Heat field pitfalls (2026-11-07)

- Price a material parcel at the donor's live derived temperature, never at the last published one. The water relaxation sloshes the same parcel up and back within one step, so a published-snapshot price goes stale the moment composition moves; the flow guard then clamps, the receiver gets under-energized liquid, and in a phase-change model the cold parcels trip the freeze plateaus and the whole pour band turns into pinned 120/100/80 cells hoarding energy. `liveT` recomputes `(H − latent)/capacity` from the current `vol`/`ch`/`CG` inside the hook and costs ~10 flops.
- A melting grain's own displacement must not count against its melt's room. Counting `gdisp` makes a grain in a wet cell its own blocker: the melt defers forever, the melt pin caps the cell's exports, and the pending excess grows without bound.
- A settled grain sits in the chamber's bottom sliver, where a cell's open area can be smaller than the grain's melt volume. "An eligible open cell" needs a deterministic neighbour search (own cell, then E/S/W/N), with the liquid's plateau enthalpy moved cross-cell — which is exactly the grain's sensible share plus the threshold excess, so both cells stay consistent.
- A puddle spreads across the bottom row at a few px² per cell, and each channel needs its own minimum grain mass *per cell* to freeze. Red (10.58 mg) stays liquid from any single-grain melt; blue (2.65 mg) is the only round-trip material for thin pools. Test scenes need pools sized against `mMin = rho/1000 · R_MIN²`, not against the total.
- Freeze probes must vary with the step (fold `sim.steps` into the `hashUnit` call) and fall back to the minimum-radius grain: a fixed six probe points re-fail forever in a shallow cell, and a full-radius grain never fits a puddle two cells deep.
- The freeze inventory is intent, not material. Keeping the earmarked liquid in its channel until a grain is placed is what makes "defer without consuming mass or energy" literal; counting the inventory as mass double-books it the moment the liquid flows elsewhere.
- The E/W chamber pair at equal height does not exchange until both pools reach the port sill, but an S-over-N pair drains freely — vertical faces have no sill. Use the vertical pair when a fixture needs liquid to actually move between chambers.
- The field's top row is spout geometry: "solid" filler valves there have empty prims and open funnels, so pour water runs into the field through them. A pour fixture is not sealed just because every valve is solid.
- Order a scan that both resets a per-cell aggregate and prices moves with that aggregate: price the moves first against last step's aggregate, rebuild the aggregate after. `grainsScan` zeroed the per-cell grain capacity before the crossings, so a grain leaving a dry cell was priced at a `DRY_CAP`-floored capacity, the flow guard clamped the parcel to the whole donor, and one grain carried the entire cell across — the receiver pinned at its melt plateau and the donor collapsed to ~0 °C, the seed of the water-vent runaway. A lone grain never trips it (the clamp then moves exactly its own share), so the gate only fails with a settled pile.
- A DRY_CAP cell's temperature is a fiction over floor capacity: filling an empty passage at 60 °C books only 0.6 units, and the first grain to land there raises the real capacity while the phantom floor energy stays, so the cell legitimately reads above its fill. A transport fixture that needs "unchanged temperature on arrival" must land material in a cell with real (partially open → metal) capacity, not a floor-capped open cell.

# Power balance and measurement logs (2026-11-08)

- A committed measurement log is a claim about the code. `heat-0.4.txt` still said "left chamber T 120.0 °C / frozen 337.6 mg" two model changes later — numbers no reachable code path could produce any more — because regenerating it was never part of either fix. When a change alters what a logged scenario measures, regenerate the log in the same change; the history of a stale log is archaeology, not evidence.
- Tune the power scale against the melt, not the freeze. Freezing consumes the deficit incrementally (any energy below the pin converts at once), while melting must first accumulate the whole-grain threshold in one cell, so at a power where the freeze looks brisk the melt can still be inert. Measure the knee, then pick the smallest round number above it: ±5000 E/s melts a frozen pool back in 103 s, where ±150 never starts and ±1500 never finishes.
- A valve's power spreads over every cell it owns (144 for a standard valve) and only some are wet, so report chamber temperatures as wet-cell means with a spread, never a single cell: the center cell can go dry and dive while the pool it left behind stays pinned at the freeze point.
- A sustained cooler has no lower floor: its dry cells settle into a quasi-steady dive (−74 °C at the shipped default, −569 at 4×), while every cell that still holds liquid stays pinned at its freeze point. The °C view clipping at 0 is a display choice, not a modelled state — gate the floor over liquid cells only, and log the dive.
