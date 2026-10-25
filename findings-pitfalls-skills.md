# Geometry pitfalls

- A rounded radial elbow needs an offset center at the sum of its port direction vectors times the bend radius. An origin-centered arc joins the radial legs at right angles and bends toward the wrong side.
- When changing arc geometry, update rendering, angular containment and particle sampling together. Tangency and mirrored-midpoint tests catch a visually plausible but inverted bend.
- Node Path2D stubs can test analytical geometry, not actual canvas clipping or file-protocol behavior.
