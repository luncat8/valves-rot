# Prototypes against the draft

The source specification is `draft.md`. Comparison is based on source inspection; visual quality and realistic flow require browser observation and measured fixtures.

| Draft requirement | GLM 5.3f | GLM 5.3 Max | GPT 6 Sol Max |
| --- | --- | --- | --- |
| 10 × 10 independent circular rotors | Yes | Yes | Yes |
| Fixed solid, tinted gray four-port housings | Yes | Yes, cached machining detail | Yes |
| Cutaway outline, material and air | Yes | Strong explicit three-pass treatment | Wall and air treatment, simpler edges |
| Solid passages and hollow variants | I/L/T/X; hollow 0–3 ports | I/L/T/X, pocket, blank; hollow 1–4 ports | I/L/T; hollow 1–4 ports, adjacent/opposite pairs |
| Channels confined to rotor | Rotor drawing | Circular sprite clip | Circular drawing/mask clips; slightly different radii |
| Matching housing/rotor air width | Shared width | Shared CW | Shared CHANNEL_WIDTH |
| Rounded L bend | Filleted path | Offset-center tangent arc | Quadratic bend |
| One air color toggle | Near-white/dark reference | Exact white/black | Exact white/black in converted page |
| Random rotation | Yes | Eased quarter-turn sequences, dwell | Constant-rate quarter-turns, dwell |
| Colored grains initially near top | Absent | Mixed external/top-valve seeding; some lower seeds | Selected upper hollow reservoirs |
| Realistic falling/transfer | Absent | Gravity, pair impulses, moving-wall velocity | Gravity, pair impulses, passage carry |
| Interaction | Air toggle | Pause, speed, reset, repour | Same plus pointer/keyboard rotor control |

## Selection

Use GLM Max's cached cutaway presentation and analytical geometry as the starting architecture. Adopt GPT's deliberate upper reservoirs and accessible valve selection. Keep the simple GLM reference for shape comparison, not as another physics engine.

## Important gaps

- Neither particle solver establishes robust conservation or nonpenetration under moving walls.
- GLM escape search can fail and later recycle a trapped grain; stochastic shakes hide stable jams. Independent erosion of joined primitives is not exact erosion of their union. Pair correction can push grains into walls. Rotation currently advances before all particle substeps.
- GPT raster readback allocates a full pixel image per active frame. Drawing callbacks and passage port arrays also allocate. Its visible and mask clip radii differ. Failed recovery deletes grains; automatic replenishment obscures losses.
- Both pair solvers are quadratic. Neither has deterministic seeded regression fixtures or a measured performance budget.
- The vanilla port intentionally shares a simpler semantic toolbar rather than preserving React/Tailwind layouts, SVG samples and editorial sidebars. Simulations remain distinct for comparison.
- The draft's most important goal, convincing granular flow through intermittently aligned ports, remains the acceptance gate for a combined version.
