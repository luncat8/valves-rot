// Grain solver on top of the shared geometry. Fixed step, contact limited and
// conservative: every move is swept through ValveGeometry, so a closed port
// stays closed and a grain can never cross a wall between two steps.
//
// Grains integrate velocity in the inertial world frame (gravity and air drag
// never spin with a rotor). Inside a turning rotor disc, the sweep starts from
// the passage-carried point and sweeps to the world inertial target: free air
// inside a chamber exerts zero torque, while a moving passage wall intercepts
// the sweep and transfers the exact rotor wall velocity and friction.
const ValveSimulation = (() => {
	"use strict";

	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	const AIR = typeof ValveAir !== "undefined" ? ValveAir : require("./air.js");
	const GAS = typeof ValveGas !== "undefined" ? ValveGas : require("./gas.js");
	const INL = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");
	const N = G.N;
	const SIZE = G.SIZE;
	const POUR = G.POUR;
	const TAU = G.TAU;
	const HALF_PI = G.HALF_PI;
	const RV = G.RV;
	const BOTTOM = SIZE + POUR;

	const STEP = 1 / 120;
	const MAX_STEPS = 10;
	const CAPACITY = 1600;
	const R_MIN = 2.3;
	const R_MAX = 3.1;
	const R_GRAIN = 2.7;
	const GRAVITY = 560;
	const RESTITUTION = 0.1;
	const REST_SPEED = 30;
	// Round grains have almost no tangential grip: pair friction near zero lets
	// stacks and pyramids push themselves apart and piles spread like the
	// prototypes, while a small wall friction keeps rolling visibly damped.
	const FRICTION = 0.02;
	const DAMPING = 0.05;
	const WALL_FRICTION = 0.04;
	const MAX_SPEED = 300;
	const ITERATIONS = 3;
	// Overlap the solver tolerates before it calls a contact a touch. Kept tight
	// so a pile cannot creep into itself one substep at a time.
	const TOUCH = 1e-3;
	const TURN_DWELL_MIN = 0.35;
	const STALL_LIMIT = 0.4;
	// How far a closing rim may shove a grain to clear its mouth before the valve
	// holds still and lets the grain slide clear.
	const WALL_PUSH = 1.25;
	const TURN_RATE = TAU * 0.5;

	// Bin size >= 2 * max grain radius guarantees a 3x3 scan catches every pair.
	const BIN = 8;
	const INV_BIN = 1 / BIN;
	const BX = Math.ceil(SIZE / BIN);
	const BY = Math.ceil((SIZE + 2 * POUR) / BIN);
	const BIN_COUNT = BX * BY;

	const GRAIN_COLORS = ["#f07a5f", "#e9b64b", "#4fb8ab", "#7f93dd", "#d978b4", "#8cbf5a"];

	// Pour reservoirs: two staggered files in the band above top-row spouts.
	const SLOT_FILES = [-3.2, 3.2];
	const SLOT_ROWS = 4;
	const SLOT_DY = 6.6;
	const SLOT_STAGGER = 3.3;
	const SLOT_TOP = -POUR + 4.6;

	// Preallocated scratch shared by the solver: nothing in the hot path allocates.
	const sweepOut = { x: 0, y: 0, hit: false };
	const nearest = { x: 0, y: 0, dist: 0, found: false };
	const nrm = { x: 0, y: 0 };
	const target = { x: 0, y: 0 };
	// Contact normal of the deepest pair overlap found by penetrationAt.
	const penNrm = { x: 0, y: -1 };

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	function binX(x) {
		const b = (x * INV_BIN) | 0;
		return b < 0 ? 0 : b >= BX ? BX - 1 : b;
	}

	function binY(y) {
		const b = ((y + POUR) * INV_BIN) | 0;
		return b < 0 ? 0 : b >= BY ? BY - 1 : b;
	}

	function slotX(i, f) {
		return (i + 0.5) * G.S + SLOT_FILES[f];
	}

	function slotY(f, row) {
		return SLOT_TOP + SLOT_DY * row + (f ? SLOT_STAGGER : 0);
	}

	function grainRadius(seed, key) {
		return R_MIN + G.hashUnit(seed, key, 41) * (R_MAX - R_MIN);
	}

	// Deterministic subset of drain-reachable top-row spouts, with a fallback so
	// every seed activates at least three spouts when the layout allows it.
	// A signed goal adds its own column (`goalFeed`), because a valve replacement
	// recomputes this base and would otherwise drop it.
	function buildSpoutMask(sim) {
		const mask = sim.spoutMask;
		const reach = sim.reach;
		const feed = sim.goalFeed;
		const seed = sim.layout.seed | 0;
		let chosen = 0;
		mask.fill(0);
		for (let i = 0; i < N; i++) {
			if (!reach[i] || G.hashUnit(seed, i, 21) > 0.55) continue;
			mask[i] = 1;
			chosen++;
		}
		const start = (seed >>> 0) % N;
		for (let n = 0; n < N && chosen < 3; n++) {
			const i = (start + n) % N;
			if (!reach[i] || mask[i]) continue;
			mask[i] = 1;
			chosen++;
		}
		for (let i = 0; i < N; i++) if (feed[i] > 0) mask[i] = 1;
	}

	// Refcounted, because two routes can be fed from the same column: releasing one
	// must leave the other promoted. The mask only cares whether anyone claims it.
	function setGoalFeed(sim, column, on) {
		if (column < 0 || column >= N) return;
		const had = sim.goalFeed[column] > 0;
		sim.goalFeed[column] = on ? sim.goalFeed[column] + 1 : Math.max(0, sim.goalFeed[column] - 1);
		if ((sim.goalFeed[column] > 0) !== had) buildSpoutMask(sim);
	}

	function create(layout, options) {
		const o = options || {};
		const capacity = Math.max(64, o.capacity || CAPACITY);
		const slots = N * N;
		const reach = G.drainReach(layout);
		const sim = {
			layout,
			pressure: null,
			pressureMode: "off",
			// Page slider: multiplies how hard the pressure backend pushes grains.
			airForce: 1,
			inlets: INL.create(),
			turning: o.turning !== false,
			autoRotate: o.autoRotate === undefined ? 1 : clamp(o.autoRotate, 0, 1),
			speed: o.speed === undefined ? 1 : o.speed,
			capacity,
			count: 0,
			x: new Float64Array(capacity),
			y: new Float64Array(capacity),
			origX: new Float64Array(capacity),
			origY: new Float64Array(capacity),
			vx: new Float64Array(capacity),
			vy: new Float64Array(capacity),
			r: new Float64Array(capacity),
			color: new Uint8Array(capacity),
			order: new Int32Array(capacity),
			reach,
			goalFeed: new Uint8Array(N),
			spoutMask: new Uint8Array(N),
			binCount: new Int32Array(BIN_COUNT),
			binStart: new Int32Array(BIN_COUNT + 1),
			// wall schedule and goal ownership
			autoRank: new Uint8Array(slots),
			autoLocked: new Uint8Array(slots),
			goalOwner: new Int8Array(slots),
			caseTint: new Int8Array(slots),
			prevAngle: new Float64Array(slots),
			cos0: new Float64Array(slots),
			sin0: new Float64Array(slots),
			target: new Float64Array(slots),
			dir: new Int8Array(slots),
			rate: new Float64Array(slots),
			dwell: new Float64Array(slots),
			omega: new Float64Array(slots),
			stalledList: new Int32Array(slots),
			pushX: new Float64Array(capacity),
			pushY: new Float64Array(capacity),
			pushFlag: new Uint8Array(capacity),
			stallTime: new Float64Array(slots),
			stalled: 0,
			stalls: 0,
			// clocks and counters
			clock: 0,
			accumulator: 0,
			steps: 0,
			injected: 0,
			drained: 0,
			purged: 0,
			recovered: 0,
			pushed: 0,
			maxPush: 0,
			maxOverlap: 0,
			maxPen: 0,
		};
		sim.stalledList.fill(-1);
		sim.goalOwner.fill(-1);
		sim.caseTint.fill(-1);
		buildSpoutMask(sim);
		initSchedule(sim);
		return sim;
	}

	// Per-valve quarter-turn schedule. Angles live on the layout, which remains
	// the single owner of geometry state. `autoRank` is a seeded permutation of
	// cell indices so an X% auto-rotate setting turns an exact X% subset.
	function initSchedule(sim) {
		const seed = sim.layout.seed | 0;
		const valves = sim.layout.valves;
		const rankRnd = G.rng((seed ^ 0x6a09e667) | 0);
		for (let k = 0; k < valves.length; k++) sim.autoRank[k] = k;
		for (let k = valves.length - 1; k > 0; k--) {
			const m = (rankRnd() * (k + 1)) | 0;
			const tmp = sim.autoRank[k];
			sim.autoRank[k] = sim.autoRank[m];
			sim.autoRank[m] = tmp;
		}
		for (let k = 0; k < valves.length; k++) {
			const v = valves[k];
			const angle = sim.turning ? ((G.hashUnit(seed, k, 1) * 4) | 0) * HALF_PI : v.angle;
			G.setAngle(v, angle);
			sim.prevAngle[k] = angle;
			sim.target[k] = angle;
			sim.cos0[k] = v.cos;
			sim.sin0[k] = v.sin;
			sim.rate[k] = (0.9 + G.hashUnit(seed, k, 13) * 0.7) * TURN_RATE;
			sim.dir[k] = G.hashUnit(seed, k, 7) < 0.5 ? -1 : 1;
			sim.dwell[k] = 0.4 + G.hashUnit(seed, k, 2) * 3;
			sim.omega[k] = 0;
		}
	}

	function canAutoRotate(sim, k) {
		if (!sim.turning || sim.autoLocked[k]) return false;
		return sim.autoRank[k] < Math.round(sim.autoRotate * sim.autoRank.length);
	}

	function updateTurns(sim, h) {
		const seed = sim.layout.seed | 0;
		const valves = sim.layout.valves;
		let moved = 0;
		for (let k = 0; k < valves.length; k++) {
			const v = valves[k];
			const before = v.angle;
			sim.prevAngle[k] = before;
			sim.cos0[k] = v.cos;
			sim.sin0[k] = v.sin;
			let goal = sim.target[k];
			if (before === goal && canAutoRotate(sim, k)) {
				sim.dwell[k] -= h;
				if (sim.dwell[k] <= 0) {
					goal = sim.target[k] = before + sim.dir[k] * HALF_PI;
					sim.dwell[k] = TURN_DWELL_MIN + G.hashUnit(seed, k, 11) * 1.2;
				}
			}
			const remaining = goal - before;
			if (remaining === 0 || sim.speed <= 0) {
				sim.omega[k] = 0;
				continue;
			}
			const limit = sim.rate[k] * sim.speed * h;
			const move = remaining > 0 ? Math.min(remaining, limit) : Math.max(remaining, -limit);
			sim.omega[k] = move / h;
			G.setAngle(v, before + move);
			moved++;
		}
		if (moved > 0) settleWalls(sim, h);
	}

	// Checks whether a rotor substep leaves every grain in valid air without
	// scissor-pinching two grains across a closing mouth. A small mouth nudge
	// within WALL_PUSH is allowed when the pile behind it has room; otherwise the
	// valve stalls and, after STALL_LIMIT seconds, backs off to the previous detent.
	function pinchAt(sim, k, tx, ty, stamp, limit) {
		const rad = sim.r[k];
		const x0 = sim.x[k];
		const y0 = sim.y[k];
		const bx = binX(tx);
		const by = binY(ty);
		for (let oy = by - 1; oy <= by + 1; oy++) {
			if (oy < 0 || oy >= BY) continue;
			for (let ox = bx - 1; ox <= bx + 1; ox++) {
				if (ox < 0 || ox >= BX) continue;
				const b = oy * BX + ox;
				const end = sim.binStart[b + 1];
				for (let p = sim.binStart[b]; p < end; p++) {
					const j = sim.order[p];
					if (j === k) continue;
					const jv = G.cellAt(sim.x[j], sim.y[j]);
					const jMoved = sim.pushFlag[j] > 0 && sim.stalledList[jv] !== stamp;
					const jx = jMoved ? sim.pushX[j] : sim.x[j];
					const jy = jMoved ? sim.pushY[j] : sim.y[j];
					const minD = rad + sim.r[j];
					const dx = jx - tx;
					const dy = jy - ty;
					const d2 = dx * dx + dy * dy;
					if (d2 >= minD * minD) continue;
					const newPen = minD - Math.sqrt(d2);
					if (newPen <= limit) continue;
					const dx0 = sim.x[j] - x0;
					const dy0 = sim.y[j] - y0;
					const oldPen = minD - Math.sqrt(dx0 * dx0 + dy0 * dy0);
					if (newPen > oldPen + 0.02) return true;
				}
			}
		}
		return false;
	}

	function settleWalls(sim, h) {
		const layout = sim.layout;
		const valves = layout.valves;
		const stamp = sim.steps;
		sim.stalled = 0;
		for (let k = 0; k < sim.count; k++) {
			const x = sim.x[k];
			const y = sim.y[k];
			sim.pushX[k] = x;
			sim.pushY[k] = y;
			sim.pushFlag[k] = 0;
			const vi = G.cellAt(x, y);
			const om = sim.omega[vi];
			if (om === 0 || sim.stalledList[vi] === stamp) continue;
			const v = valves[vi];
			const dx = x - v.cx;
			const dy = y - v.cy;
			const d2 = dx * dx + dy * dy;
			const freeR = v.chamberR - sim.r[k];
			let tx = x;
			let ty = y;
			let kind = 0;
			if (d2 < RV * RV && (freeR <= 0 || d2 > freeR * freeR)) {
				const c0 = sim.cos0[vi];
				const s0 = sim.sin0[vi];
				const rx = dx * c0 + dy * s0;
				const ry = dy * c0 - dx * s0;
				tx = v.cx + rx * v.cos - ry * v.sin;
				ty = v.cy + rx * v.sin + ry * v.cos;
				kind = 1;
			}
			if (G.airClearance(layout, tx, ty) < sim.r[k] - 1e-6) {
				G.nearestAir(layout, tx, ty, sim.r[k], nearest);
				if (!nearest.found || nearest.dist > WALL_PUSH) {
					sim.stalledList[vi] = stamp;
					sim.stalled++;
					continue;
				}
				tx = nearest.x;
				ty = nearest.y;
				kind = 2;
			}
			sim.pushX[k] = tx;
			sim.pushY[k] = ty;
			sim.pushFlag[k] = kind;
		}
		for (let pass = 0; pass < 4; pass++) {
			let dropped = 0;
			for (let k = 0; k < sim.count; k++) {
				if (sim.pushFlag[k] !== 1) continue;
				const x = sim.x[k];
				const y = sim.y[k];
				const vi = G.cellAt(x, y);
				if (sim.stalledList[vi] === stamp) continue;
				if (!pinchAt(sim, k, sim.pushX[k], sim.pushY[k], stamp, 0.25)) continue;
				if (G.airClearance(layout, x, y) < sim.r[k] - 1e-6) continue;
				sim.pushX[k] = x;
				sim.pushY[k] = y;
				sim.pushFlag[k] = 0;
				dropped++;
			}
			if (!dropped) break;
		}
		for (let k = 0; k < sim.count; k++) {
			if (!sim.pushFlag[k]) continue;
			const vi = G.cellAt(sim.x[k], sim.y[k]);
			if (sim.stalledList[vi] === stamp) continue;
			if (!pinchAt(sim, k, sim.pushX[k], sim.pushY[k], stamp, 0.55)) continue;
			sim.stalledList[vi] = stamp;
			sim.stalled++;
		}
		for (let k = 0; k < valves.length; k++) {
			if (sim.stalledList[k] !== stamp) {
				sim.stallTime[k] = 0;
				continue;
			}
			const v = valves[k];
			G.setAngle(v, sim.prevAngle[k]);
			sim.omega[k] = 0;
			sim.stallTime[k] += h;
			if (sim.stallTime[k] <= STALL_LIMIT) continue;
			const pos = sim.target[k] >= v.angle;
			sim.target[k] = (pos ? Math.floor((v.angle + 1e-6) / HALF_PI) : Math.ceil((v.angle - 1e-6) / HALF_PI)) * HALF_PI;
			sim.dir[k] = -sim.dir[k];
			sim.dwell[k] = TURN_DWELL_MIN;
			sim.stallTime[k] = 0;
			sim.stalls++;
		}
	}

	function normalAt(layout, x, y) {
		const e = 0.25;
		const gx = G.airClearance(layout, x + e, y) - G.airClearance(layout, x - e, y);
		const gy = G.airClearance(layout, x, y + e) - G.airClearance(layout, x, y - e);
		const len = Math.sqrt(gx * gx + gy * gy);
		if (len < 1e-7) return false;
		nrm.x = gx / len;
		nrm.y = gy / len;
		return true;
	}

	function wallContact(sim, k, nx, ny, wvx, wvy, h) {
		let vx = sim.vx[k];
		let vy = sim.vy[k];
		const un = (vx - wvx) * nx + (vy - wvy) * ny;
		let press = 0;
		if (un < 0) {
			const e = -un > REST_SPEED ? RESTITUTION : 0;
			press = -(1 + e) * un;
			vx += press * nx;
			vy += press * ny;
		}
		const tx = -ny;
		const ty = nx;
		const ut = (vx - wvx) * tx + (vy - wvy) * ty;
		const jt = clamp(ut, -WALL_FRICTION * press, WALL_FRICTION * press);
		sim.vx[k] = vx - jt * tx;
		sim.vy[k] = vy - jt * ty;
	}

	function penetrationAt(sim, k, x, y) {
		const rad = sim.r[k];
		const bx = binX(x);
		const by = binY(y);
		let worst = 0;
		penNrm.x = 0;
		penNrm.y = -1;
		for (let oy = by - 1; oy <= by + 1; oy++) {
			if (oy < 0 || oy >= BY) continue;
			for (let ox = bx - 1; ox <= bx + 1; ox++) {
				if (ox < 0 || ox >= BX) continue;
				const b = oy * BX + ox;
				const end = sim.binStart[b + 1];
				for (let p = sim.binStart[b]; p < end; p++) {
					const j = sim.order[p];
					if (j === k) continue;
					const dx = sim.x[j] - x;
					const dy = sim.y[j] - y;
					const minD = rad + sim.r[j];
					const d2 = dx * dx + dy * dy;
					if (d2 >= minD * minD) continue;
				const pen = minD - Math.sqrt(d2);
				if (pen > worst) {
					worst = pen;
					const d = Math.sqrt(d2);
					if (d > 1e-8) {
						penNrm.x = (x - sim.x[j]) / d;
						penNrm.y = (y - sim.y[j]) / d;
					}
				}
			}
		}
	}
	return worst;
}

	function pushGrain(sim, k, dx, dy, limit) {
		const len2 = dx * dx + dy * dy;
		if (len2 < 1e-12) return 0;
		const x0 = sim.x[k];
		const y0 = sim.y[k];
		G.sweep(sim.layout, x0, y0, x0 + dx, y0 + dy, sim.r[k], sweepOut);
		const f = clamp(((sweepOut.x - x0) * dx + (sweepOut.y - y0) * dy) / len2, 0, 1);
		if (f <= 0) return 0;
		const deep = penetrationAt(sim, k, sweepOut.x, sweepOut.y);
		if (deep > TOUCH && deep > penetrationAt(sim, k, x0, y0) + limit) return 0;
		sim.x[k] = sweepOut.x;
		sim.y[k] = sweepOut.y;
		return f;
	}

	function clampSpeed(sim, k) {
		const vx = sim.vx[k];
		const vy = sim.vy[k];
		const speed2 = vx * vx + vy * vy;
		if (speed2 <= MAX_SPEED * MAX_SPEED) return;
		const scale = MAX_SPEED / Math.sqrt(speed2);
		sim.vx[k] = vx * scale;
		sim.vy[k] = vy * scale;
	}

	// Advances the sweep start point with any passage rotation while recording the
	// grain's pre-step inertial world coordinates in (origX, origY).
	function carryWalls(sim, h) {
		const valves = sim.layout.valves;
		const stamp = sim.steps;
		for (let k = 0; k < sim.count; k++) {
			let ox = sim.x[k];
			let oy = sim.y[k];
			const kind = sim.pushFlag[k];
			sim.pushFlag[k] = 0;
			if (kind > 0) {
				const vi = G.cellAt(ox, oy);
				if (sim.stalledList[vi] !== stamp) {
					const px = sim.pushX[k];
					const py = sim.pushY[k];
					sim.x[k] = px;
					sim.y[k] = py;
					if (kind === 2) {
						ox = px;
						oy = py;
						sim.pushed++;
						const mx = px - sim.origX[k];
						const my = py - sim.origY[k];
						const v = valves[vi];
						const om = sim.omega[vi];
						if (normalAt(sim.layout, px, py)) {
							wallContact(sim, k, nrm.x, nrm.y, -om * (py - v.cy), om * (px - v.cx), h);
						} else if (mx * mx + my * my > 0) {
							sim.vx[k] *= 0.5;
							sim.vy[k] *= 0.5;
						}
					}
				}
			}
			sim.origX[k] = ox;
			sim.origY[k] = oy;
		}
	}

	function applyMove(sim, k, h) {
		const x0 = sim.x[k];
		const y0 = sim.y[k];
		G.sweep(sim.layout, x0, y0, target.x, target.y, sim.r[k], sweepOut);
		let tx = sweepOut.x;
		let ty = sweepOut.y;
		let wallHit = sweepOut.hit;
		if (penetrationAt(sim, k, tx, ty) > TOUCH) {
			const deep0 = penetrationAt(sim, k, x0, y0);
			if (penetrationAt(sim, k, tx, ty) > deep0 + TOUCH) {
				let lo = 0;
				let hi = 1;
				for (let n = 0; n < 5; n++) {
					const m = (lo + hi) * 0.5;
					const deep = penetrationAt(sim, k, x0 + (tx - x0) * m, y0 + (ty - y0) * m);
					if (deep > deep0 + TOUCH) hi = m;
					else lo = m;
				}
				tx = x0 + (tx - x0) * lo;
				ty = y0 + (ty - y0) * lo;
				wallHit = false;
				// A pile contact blocks only its normal: project the velocity
				// onto the contact tangent and spend the step sliding there.
				// Without this the dip of the straight path into the contact
				// circle scales the whole move down and stacks freeze instead
				// of rolling apart.
				const nx = penNrm.x;
				const ny = penNrm.y;
				let vx = sim.vx[k];
				let vy = sim.vy[k];
				const vn = vx * nx + vy * ny;
				if (vn < 0) {
					vx -= vn * nx;
					vy -= vn * ny;
					sim.vx[k] = vx;
					sim.vy[k] = vy;
				}
				G.sweep(sim.layout, x0, y0, x0 + vx * h, y0 + vy * h, sim.r[k], sweepOut);
				if (penetrationAt(sim, k, sweepOut.x, sweepOut.y) <= deep0 + TOUCH) {
					tx = sweepOut.x;
					ty = sweepOut.y;
					wallHit = sweepOut.hit;
					target.x = x0 + vx * h;
					target.y = y0 + vy * h;
				}
			}
		}
		sim.x[k] = tx;
		sim.y[k] = ty;
		if (!wallHit) return;
		if (!normalAt(sim.layout, tx, ty)) {
			const mx = target.x - x0;
			const my = target.y - y0;
			const len = Math.sqrt(mx * mx + my * my) || 1;
			nrm.x = -mx / len;
			nrm.y = -my / len;
		}
		const vi = G.cellAt(tx, ty);
		const om = sim.omega[vi];
		let wvx = 0;
		let wvy = 0;
		if (om !== 0) {
			const v = sim.layout.valves[vi];
			const rx = tx - v.cx;
			const ry = ty - v.cy;
			const rHit = Math.sqrt(rx * rx + ry * ry);
			// Rotor walls inside the rim, plus the outer rim face itself (radial
			// normal), carry the rotor's tangential velocity; housing side walls stay fixed.
			if (rHit < RV || (rHit < RV + sim.r[k] + 0.8 && nrm.x * rx + nrm.y * ry > 0.7 * rHit)) {
				wvx = -om * ry;
				wvy = om * rx;
			}
		}
		wallContact(sim, k, nrm.x, nrm.y, wvx, wvy, h);
		// Consume the remaining time tangentially instead of sticking at first impact.
		const dx = target.x - x0;
		const dy = target.y - y0;
		const length2 = dx * dx + dy * dy;
		const used = length2 > 1e-12 ? clamp(((tx - x0) * dx + (ty - y0) * dy) / length2, 0, 1) : 1;
		const remaining = h * (1 - used);
		G.sweep(sim.layout, tx, ty, tx + sim.vx[k] * remaining, ty + sim.vy[k] * remaining, sim.r[k], sweepOut);
		if (penetrationAt(sim, k, sweepOut.x, sweepOut.y) > TOUCH) return;
		sim.x[k] = sweepOut.x;
		sim.y[k] = sweepOut.y;
	}

	function integrate(sim, h) {
		const damp = 1 - DAMPING * h;
		for (let k = 0; k < sim.count; k++) {
			sim.vx[k] *= damp;
			sim.vy[k] = (sim.vy[k] + GRAVITY * h) * damp;
			clampSpeed(sim, k);
			target.x = sim.origX[k] + sim.vx[k] * h;
			target.y = sim.origY[k] + sim.vy[k] * h;
			applyMove(sim, k, h);
		}
	}

	function repair(sim) {
		const layout = sim.layout;
		for (let k = 0; k < sim.count; k++) {
			const rad = sim.r[k];
			const clear = G.airClearance(layout, sim.x[k], sim.y[k]);
			if (clear >= rad - 1e-6) continue;
			const wall = rad - clear;
			if (wall > sim.maxPen) sim.maxPen = wall;
			G.nearestAir(layout, sim.x[k], sim.y[k], rad, nearest);
			if (!nearest.found) continue;
			sim.recovered++;
			if (nearest.dist > sim.maxPush) sim.maxPush = nearest.dist;
			const mx = nearest.x - sim.x[k];
			const my = nearest.y - sim.y[k];
			const len = Math.sqrt(mx * mx + my * my);
			if (len > 1e-6) {
				const ux = mx / len;
				const uy = my / len;
				const un = sim.vx[k] * ux + sim.vy[k] * uy;
				if (un < 0) {
					sim.vx[k] -= un * ux;
					sim.vy[k] -= un * uy;
				}
			}
			sim.x[k] = nearest.x;
			sim.y[k] = nearest.y;
		}
	}

	function buildBins(sim) {
		const counts = sim.binCount;
		const starts = sim.binStart;
		const order = sim.order;
		counts.fill(0);
		for (let k = 0; k < sim.count; k++) counts[binY(sim.y[k]) * BX + binX(sim.x[k])]++;
		let sum = 0;
		for (let b = 0; b < BIN_COUNT; b++) {
			starts[b] = sum;
			sum += counts[b];
			counts[b] = starts[b];
		}
		starts[BIN_COUNT] = sum;
		for (let k = 0; k < sim.count; k++) {
			const b = binY(sim.y[k]) * BX + binX(sim.x[k]);
			order[counts[b]++] = k;
		}
	}

	function pairContact(sim, i, j) {
		const dx = sim.x[j] - sim.x[i];
		const dy = sim.y[j] - sim.y[i];
		const minD = sim.r[i] + sim.r[j];
		const d2 = dx * dx + dy * dy;
		if (d2 >= minD * minD) return;
		let nx;
		let ny;
		let d;
		if (d2 < 1e-8) {
			const a = ((i * 5 + j * 3) % 32) * (TAU / 32) + 0.37;
			nx = Math.cos(a);
			ny = Math.sin(a);
			d = 0;
		} else {
			d = Math.sqrt(d2);
			nx = dx / d;
			ny = dy / d;
		}
		const pen = minD - d;
		if (pen > 1e-3) {
			const half = pen * 0.5 + 1e-4;
			const fi = pushGrain(sim, i, -nx * half, -ny * half, pen);
			const fj = pushGrain(sim, j, nx * half, ny * half, pen);
			if (fi < 0.99 || fj < 0.99) {
				const rest = pen - (fi + fj) * half;
				if (rest > 1e-3) {
					if (fi >= fj) pushGrain(sim, i, -nx * rest, -ny * rest, pen);
					else pushGrain(sim, j, nx * rest, ny * rest, pen);
				}
			}
		}
		const rvx = sim.vx[j] - sim.vx[i];
		const rvy = sim.vy[j] - sim.vy[i];
		const un = rvx * nx + rvy * ny;
		const e = un < -REST_SPEED ? RESTITUTION : 0;
		const jn = -(1 + e) * un * 0.5;
		if (jn > 0) {
			sim.vx[i] -= jn * nx;
			sim.vy[i] -= jn * ny;
			sim.vx[j] += jn * nx;
			sim.vy[j] += jn * ny;
		}
		const tx = -ny;
		const ty = nx;
		const ut = (sim.vx[j] - sim.vx[i]) * tx + (sim.vy[j] - sim.vy[i]) * ty;
		const jt = clamp(ut, -FRICTION * jn, FRICTION * jn);
		sim.vx[i] += jt * tx;
		sim.vy[i] += jt * ty;
		sim.vx[j] -= jt * tx;
		sim.vy[j] -= jt * ty;
	}

	function resolvePairs(sim) {
		const order = sim.order;
		const starts = sim.binStart;
		for (let oi = 0; oi < sim.count; oi++) {
			const k = order[oi];
			const kx = binX(sim.x[k]);
			const ky = binY(sim.y[k]);
			for (let by = ky - 1; by <= ky + 1; by++) {
				if (by < 0 || by >= BY) continue;
				for (let bx = kx - 1; bx <= kx + 1; bx++) {
					if (bx < 0 || bx >= BX) continue;
					const b = by * BX + bx;
					const end = starts[b + 1];
					for (let p = starts[b]; p < end; p++) {
						const j = order[p];
						if (j > k) pairContact(sim, k, j);
					}
				}
			}
		}
	}

	function measurePairs(sim) {
		const order = sim.order;
		const starts = sim.binStart;
		for (let oi = 0; oi < sim.count; oi++) {
			const k = order[oi];
			const kx = binX(sim.x[k]);
			const ky = binY(sim.y[k]);
			for (let by = ky - 1; by <= ky + 1; by++) {
				if (by < 0 || by >= BY) continue;
				for (let bx = kx - 1; bx <= kx + 1; bx++) {
					if (bx < 0 || bx >= BX) continue;
					const b = by * BX + bx;
					const end = starts[b + 1];
					for (let p = starts[b]; p < end; p++) {
						const j = order[p];
						if (j <= k) continue;
						const dx = sim.x[j] - sim.x[k];
						const dy = sim.y[j] - sim.y[k];
						const minD = sim.r[k] + sim.r[j];
						const d2 = dx * dx + dy * dy;
						if (d2 >= minD * minD) continue;
						const pen = minD - Math.sqrt(d2);
						if (pen > sim.maxOverlap) sim.maxOverlap = pen;
					}
				}
			}
		}
	}

	function compact(sim) {
		let w = 0;
		for (let k = 0; k < sim.count; k++) {
			if (sim.y[k] > BOTTOM - sim.r[k] - 0.6) {
				sim.drained++;
				continue;
			}
			if (w !== k) {
				sim.x[w] = sim.x[k];
				sim.y[w] = sim.y[k];
				sim.vx[w] = sim.vx[k];
				sim.vy[w] = sim.vy[k];
				sim.r[w] = sim.r[k];
				sim.color[w] = sim.color[k];
			}
			w++;
		}
		sim.count = w;
	}

	function step(sim, dt) {
		const h = dt > 0 ? dt : STEP;
		buildBins(sim);
		updateTurns(sim, h);
		carryWalls(sim, h);
		buildBins(sim);
		if (sim.pressureMode === "grid") GAS.step(sim, h);
		else if (sim.pressureMode === "particles") AIR.step(sim, h);
		integrate(sim, h);
		repair(sim);
		buildBins(sim);
		for (let it = 0; it < ITERATIONS; it++) resolvePairs(sim);
		measurePairs(sim);
		compact(sim);
		sim.clock += h;
		sim.steps++;
	}

	function advance(sim, wallDt) {
		if (!(wallDt > 0)) return 0;
		const cap = STEP * MAX_STEPS;
		sim.accumulator += wallDt > cap ? cap : wallDt;
		let steps = 0;
		while (sim.accumulator >= STEP && steps < MAX_STEPS) {
			step(sim, STEP);
			sim.accumulator -= STEP;
			steps++;
		}
		return steps;
	}

	function resume(sim) {
		sim.accumulator = 0;
	}

	function addGrain(sim, x, y, radius, color) {
		if (sim.count >= sim.capacity) return -1;
		const rad = radius === undefined ? R_GRAIN : radius;
		if (G.airClearance(sim.layout, x, y) < rad - 1e-6) return -1;
		const k = sim.count++;
		sim.x[k] = x;
		sim.y[k] = y;
		sim.vx[k] = 0;
		sim.vy[k] = 0;
		sim.r[k] = rad;
		sim.color[k] =
			color === undefined ? (G.hashUnit(sim.layout.seed | 0, sim.injected, 31) * GRAIN_COLORS.length) | 0 : color;
		sim.injected++;
		return k;
	}

	function slotFree(sim, x, y, rad) {
		if (G.airClearance(sim.layout, x, y) < rad + 0.2) return false;
		for (let k = 0; k < sim.count; k++) {
			const dx = sim.x[k] - x;
			const dy = sim.y[k] - y;
			const reach = sim.r[k] + rad + 0.35;
			if (dx * dx + dy * dy < reach * reach) return false;
		}
		return true;
	}

	function addAtSlot(sim, i, f, row) {
		const x = slotX(i, f);
		const y = slotY(f, row);
		const rad = grainRadius(sim.layout.seed | 0, i * 32 + f * 8 + row);
		if (!slotFree(sim, x, y, rad)) return false;
		return addGrain(sim, x, y, rad) >= 0;
	}

	// Non-overlapping cluster inside an upper hollow reservoir.
	function seedChamber(sim, v, idx) {
		const seed = sim.layout.seed | 0;
		let added = 0;
		const cRad = grainRadius(seed, idx * 16);
		if (slotFree(sim, v.cx, v.cy, cRad) && addGrain(sim, v.cx, v.cy, cRad) >= 0) added++;
		const ring = v.chamberR - R_MAX - 0.65;
		if (ring < 2 * R_MAX + 0.4) return added;
		const base = G.hashUnit(seed, idx, 29) * TAU;
		const spokes = ring >= 6.8 ? 6 : 5;
		for (let s = 0; s < spokes; s++) {
			const a = base + (s * TAU) / spokes;
			const rad = grainRadius(seed, idx * 16 + s + 1);
			const x = v.cx + Math.cos(a) * ring;
			const y = v.cy + Math.sin(a) * ring;
			if (slotFree(sim, x, y, rad) && addGrain(sim, x, y, rad) >= 0) added++;
		}
		return added;
	}

	// Seeds selected upper hollow chambers and top-row pour spouts, both strictly
	// from the drain-reachable set and deterministic from layout.seed.
	function seed(sim) {
		const layout = sim.layout;
		const s = layout.seed | 0;
		let added = 0;
		let chambers = 0;
		for (let k = 0; k < N * 3 && chambers < 7; k++) {
			const v = layout.valves[k];
			if (v.kind !== "hollow" || !sim.reach[k]) continue;
			if (G.hashUnit(s, k, 23) > 0.78) continue;
			added += seedChamber(sim, v, k);
			chambers++;
		}
		for (let i = 0; i < N; i++) {
			if (!sim.spoutMask[i]) continue;
			for (let f = 0; f < SLOT_FILES.length; f++) {
				for (let row = 0; row < SLOT_ROWS; row++) if (addAtSlot(sim, i, f, row)) added++;
			}
		}
		return added;
	}

	// Fills the lowest free pour-spout slots first across active spouts, then any
	// remaining drain-reachable spouts if more space is needed.
	function pour(sim, n) {
		const want = n === undefined ? 24 : n;
		let added = 0;
		for (let pass = 0; pass < 2 && added < want; pass++) {
			for (let row = SLOT_ROWS - 1; row >= 0 && added < want; row--) {
				for (let f = 0; f < SLOT_FILES.length && added < want; f++) {
					for (let i = 0; i < N && added < want; i++) {
						const primary = sim.spoutMask[i] === 1;
						if (pass === 0 ? !primary : primary || !sim.reach[i]) continue;
						if (addAtSlot(sim, i, f, row)) added++;
					}
				}
			}
		}
		return added;
	}

	function drain(sim) {
		const n = sim.count;
		sim.purged += n;
		sim.count = 0;
		return n;
	}

	function reset(sim) {
		for (let k = 0; k < sim.count; k++) {
			sim.vx[k] = 0;
			sim.vy[k] = 0;
		}
		sim.count = 0;
		sim.clock = 0;
		sim.accumulator = 0;
		sim.steps = 0;
		sim.injected = 0;
		sim.drained = 0;
		sim.purged = 0;
		sim.recovered = 0;
		sim.pushed = 0;
		sim.maxPush = 0;
		sim.maxOverlap = 0;
		sim.maxPen = 0;
		sim.stalled = 0;
		sim.stalls = 0;
		sim.stalledList.fill(-1);
		sim.stallTime.fill(0);
		sim.pushFlag.fill(0);
		sim.autoLocked.fill(0);
		sim.goalOwner.fill(-1);
		sim.caseTint.fill(-1);
		sim.goalFeed.fill(0);
		buildSpoutMask(sim);
		initSchedule(sim);
		INL.reset(sim.inlets);
		sim.pressure = pressureFor(sim, sim.pressureMode);
	}

	// Snaps from the current target detent so repeated clicks mid-turn always
	// land on exact quarter-turn port alignments.
	function turn(sim, index, quarters) {
		if (index < 0 || index >= sim.layout.valves.length) return false;
		const base = Math.round(sim.target[index] / HALF_PI) * HALF_PI;
		sim.target[index] = base + quarters * HALF_PI;
		sim.dwell[index] = TURN_DWELL_MIN + 1;
		sim.stallTime[index] = 0;
		if (sim.pressureMode === "grid") GAS.refresh(sim);
		return true;
	}

	function setTarget(sim, index, angle) {
		if (index < 0 || index >= sim.layout.valves.length) return false;
		const snapped = Math.round(angle / HALF_PI) * HALF_PI;
		if (sim.target[index] === snapped) return false;
		sim.target[index] = snapped;
		sim.dwell[index] = TURN_DWELL_MIN + 1.5;
		sim.stallTime[index] = 0;
		if (sim.pressureMode === "grid") GAS.refresh(sim);
		return true;
	}

	function setAutoRotate(sim, fraction) {
		sim.autoRotate = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
	}

	function setCaseTint(sim, index, tint) {
		if (index < 0 || index >= sim.caseTint.length) return false;
		const next = tint === null || tint === undefined || tint < 0 ? -1 : tint | 0;
		if (sim.caseTint[index] === next) return false;
		sim.caseTint[index] = next;
		return true;
	}

	function clearValve(sim, index) {
		let w = 0;
		for (let k = 0; k < sim.count; k++) {
			if (G.cellAt(sim.x[k], sim.y[k]) === index) {
				sim.purged++;
				continue;
			}
			for (const key of ["x", "y", "vx", "vy", "r", "color"]) sim[key][w] = sim[key][k];
			w++;
		}
		sim.count = w;
	}

	// Rebuilds the valve in a cell as a catalogue type facing direction
	// `quarter`. Only a type change rebuilds (and clears that cell's grains);
	// a hollow replacement keeps the old chamber size unless `chamberR` is given.
	function installValve(sim, index, type, quarter, chamberR) {
		const old = sim.layout.valves[index];
		clearValve(sim, index);
		let chamber = 0;
		if (type.kind === "hollow") {
			chamber = chamberR !== undefined ? chamberR : old.kind === "hollow" && old.chamberR > 0 ? old.chamberR : G.RV * 0.53;
		}
		const v = G.makeValve(old.i, old.j, type.kind, type.ports, 0, chamber);
		G.setAngle(v, quarter * HALF_PI);
		sim.layout.valves[index] = v;
		sim.prevAngle[index] = sim.target[index] = v.angle;
		sim.cos0[index] = v.cos;
		sim.sin0[index] = v.sin;
		sim.omega[index] = sim.stallTime[index] = 0;
		sim.stalledList[index] = -1;
		sim.dwell[index] = 1;
		sim.reach = G.drainReach(sim.layout);
		buildSpoutMask(sim);
		if (sim.pressureMode === "grid" && sim.pressure) GAS.refresh(sim);
		else sim.pressure = pressureFor(sim, sim.pressureMode);
	}

	function randomType(oldType, rnd) {
		const eligible = G.TYPES.filter(type => type !== oldType);
		return eligible[(rnd() * eligible.length) | 0];
	}

	// Places a brush on a cell: type is a G.TYPES id, "random" or null (not
	// change); dir is a quarter 0-3, "random" or null (not change); optional
	// tint is -1 (default grey), 0..3 (player color), or null/undefined.
	// Active quest goal cells reject type replacement.
	function placeValve(sim, index, brush, random) {
		const old = sim.layout.valves[index];
		if (!old || !brush) return false;
		const oldType = G.typeOf(old);
		if (!oldType) return false;
		const rnd = random || Math.random;
		let type = oldType;
		if (brush.type === "random") type = randomType(oldType, rnd);
		else if (brush.type) {
			type = G.typeById(brush.type);
			if (!type) return false;
		}
		if (sim.goalOwner[index] >= 0 && type !== oldType) return false;
		const oldDir = G.orientationOf(old, G.quarterOf(sim.target[index]));
		let dir = oldDir;
		if (brush.dir === "random") dir = (rnd() * 4) | 0;
		else if (brush.dir !== null && brush.dir !== undefined) {
			if (!Number.isFinite(brush.dir)) return false;
			dir = ((brush.dir % 4) + 4) % 4;
		}
		dir %= type.turns;
		const tinted = brush.tint !== null && brush.tint !== undefined ? setCaseTint(sim, index, brush.tint) : false;
		if (type !== oldType) {
			installValve(sim, index, type, dir);
			return "replace";
		}
		if (dir !== oldDir) {
			let delta = (dir - oldDir) & 3;
			if (delta === 3) delta = -1;
			if (turn(sim, index, delta)) return tinted ? "replace" : "turn";
		}
		return tinted ? "tint" : false;
	}

	function replaceValve(sim, index, random) {
		return placeValve(sim, index, { type: "random", dir: null }, random) === "replace";
	}

	function fillValve(sim, index, color) {
		const v = sim.layout.valves[index];
		if (!v) return 0;
		const chosen = color === undefined ? (Math.random() * GRAIN_COLORS.length) | 0 : color;
		let added = 0;
		const spacing = 2 * R_GRAIN + 0.4;
		for (let y = -RV + R_GRAIN; y < RV; y += spacing) {
			for (let x = -RV + R_GRAIN; x < RV; x += spacing) {
				if (x * x + y * y > (RV - R_GRAIN) ** 2) continue;
				if (!slotFree(sim, v.cx + x, v.cy + y, R_GRAIN)) continue;
				if (addGrain(sim, v.cx + x, v.cy + y, R_GRAIN, chosen) >= 0) added++;
			}
		}
		return added;
	}

	function setAirForce(sim, force) {
		sim.airForce = force > 0 ? force : 0;
	}

	function setSpeed(sim, speed) {
		sim.speed = speed > 0 ? speed : 0;
	}

	function pressureFor(sim, mode) {
		if (mode === "grid") return GAS.create(sim);
		if (mode === "particles") return AIR.create(sim);
		return null;
	}

	// Switching only replaces pressure state: grains, counters and valve targets
	// are untouched.
	function setPressure(sim, mode) {
		if (mode !== "off" && mode !== "particles" && mode !== "grid") return false;
		if (sim.pressureMode === mode) return true;
		sim.pressureMode = mode;
		sim.pressure = pressureFor(sim, mode);
		return true;
	}

	// `actor` is the player asking; a mouth dealt in Game mode answers only to
	// its owner, while an unowned Lab mouth takes anyone's press.
	function toggleInlet(sim, index, flip, actor) {
		const changed = INL.press(sim.inlets, index, flip, actor === undefined ? INL.UNOWNED : actor);
		if (changed && sim.pressureMode === "grid") GAS.repin(sim);
		return changed;
	}

	function canPressInlet(sim, index, actor) {
		return INL.canPress(sim.inlets, index, actor === undefined ? INL.UNOWNED : actor);
	}

	// Game mode deals and returns whole mouth sets; keep the pressure pins in
	// step so a new deal repaints on the next tick.
	function setInletOwnership(sim) {
		if (sim.pressureMode === "grid") GAS.repin(sim);
	}

	// A paused page still lets the air field settle, so a mouth click or a rotor
	// turn stays readable without advancing grains.
	function settlePressure(sim, dt) {
		if (sim.pressureMode === "grid") GAS.settle(sim, dt);
	}

	function active(sim) {
		return sim.count;
	}

	return {
		STEP,
		MAX_STEPS,
		CAPACITY,
		R_MIN,
		R_MAX,
		R_GRAIN,
		GRAVITY,
		RESTITUTION,
		FRICTION,
		MAX_SPEED,
		ITERATIONS,
		BIN,
		GRAIN_COLORS,
		create,
		step,
		advance,
		resume,
		turn,
		setTarget,
		setAutoRotate,
		canAutoRotate,
		setCaseTint,
		installValve,
		setGoalFeed,
		setSpeed,
		setAirForce,
		setPressure,
		toggleInlet,
		canPressInlet,
		setInletOwnership,
		settlePressure,
		placeValve,
		replaceValve,
		fillValve,
		seed,
		pour,
		drain,
		reset,
		addGrain,
		active,
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ValveSimulation;
