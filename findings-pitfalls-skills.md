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

