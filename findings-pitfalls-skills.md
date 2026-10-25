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
