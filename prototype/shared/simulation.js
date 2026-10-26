// Grain solver on top of the shared geometry. Fixed step, contact limited and
// conservative: every move is swept through ValveGeometry, so a closed port
// stays closed and a grain can never cross a wall between two steps.
//
// Frames. Grains inside a rotor disc live in the material frame of that disc:
// the disc carries the passages, so the grain's frame coordinates are preserved
// while the disc turns, and the frame's gravity, centrifugal and Coriolis terms
// describe the slide. Grains in the housing channels live in the world frame.
// Both halves advance in the same substep, with the wall angle and the particles
// sharing one elapsed simulation time.
const ValveSimulation = (() => {
	"use strict";

	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

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
	const R_MIN = 2.05;
	const R_MAX = 2.45;
	const R_GRAIN = 2.25;
	const GRAVITY = 560;
	const RESTITUTION = 0.1;
	const REST_SPEED = 30;
	const FRICTION = 0.35;
	const DAMPING = 0.35;
	const MAX_SPEED = 300;
	const ITERATIONS = 3;
	// Overlap the solver tolerates before it calls a contact a touch. Kept tight on
	// purpose: a loose slack lets a pile creep into itself one substep at a time.
	const TOUCH = 1e-3;
	const TURN_DWELL_MIN = 0.35;
	const STALL_LIMIT = 0.4;
	// How far a closing rim may shove a grain to clear its mouth before the valve
	// is considered jammed and holds still instead.
	const WALL_PUSH = 1.2;
	const TURN_RATE = TAU * 0.5;

	const BIN = 6;
	const BX = Math.ceil(SIZE / BIN);
	const BY = Math.ceil((SIZE + 2 * POUR) / BIN);
	const BIN_COUNT = BX * BY;

	const GRAIN_COLORS = ["#f07a5f", "#e9b64b", "#4fb8ab", "#7f93dd", "#d978b4", "#8cbf5a"];

	// Pour reservoirs: two files of five slots in the band above every open
	// top-row spout. The stagger keeps the two files more than a grain apart.
	const SLOT_FILES = [-2.8, 2.8];
	const SLOT_ROWS = 5;
	const SLOT_DY = 5.9;
	const SLOT_STAGGER = 2.95;
	const SLOT_TOP = -POUR + 4.2;

	// Scratch shared by the solver: nothing in the hot path allocates.
	const sweepOut = { x: 0, y: 0, hit: false };
	const nearest = { x: 0, y: 0, dist: 0, found: false };
	const nrm = { x: 0, y: 0 };
	const target = { x: 0, y: 0 };

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	function binX(x) {
		const b = (x * (1 / BIN)) | 0;
		return b < 0 ? 0 : b >= BX ? BX - 1 : b;
	}

	function binY(y) {
		const b = ((y + POUR) * (1 / BIN)) | 0;
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

	// A top-row spout only receives grains on the columns the seed selects, which
	// is what makes the seeded reservoirs look scattered instead of uniform. A
	// column that cannot reach the drain through the port graph is skipped: the
	// band above it is a pocket, and pouring into one buries grains for good.
	function slotUsed(sim, i) {
		if (!sim.reach[i]) return false;
		return G.hashUnit(sim.layout.seed | 0, i, 21) <= 0.62;
	}

	function create(layout, options) {
		const o = options || {};
		const capacity = Math.max(64, o.capacity || CAPACITY);
		const slots = N * N;
		const sim = {
			layout,
			turning: o.turning !== false,
			speed: o.speed === undefined ? 1 : o.speed,
			capacity,
			count: 0,
			x: new Float64Array(capacity),
			y: new Float64Array(capacity),
			vx: new Float64Array(capacity),
			vy: new Float64Array(capacity),
			r: new Float64Array(capacity),
			color: new Uint8Array(capacity),
			order: new Int32Array(capacity),
			reach: G.drainReach(layout),
			binCount: new Int32Array(BIN_COUNT),
			binStart: new Int32Array(BIN_COUNT + 1),
			// wall schedule
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
		initSchedule(sim);
		return sim;
	}

	// Per-valve quarter-turn schedule. The angles themselves stay in the layout,
	// which is the single owner of the geometry state.
	function initSchedule(sim) {
		const seed = sim.layout.seed | 0;
		const valves = sim.layout.valves;
		for (let k = 0; k < valves.length; k++) {
			const v = valves[k];
			const angle = sim.turning ? ((G.hashUnit(seed, k, 1) * 4) | 0) * HALF_PI : v.angle;
			G.setAngle(v, angle);
			sim.target[k] = angle;
			sim.cos0[k] = v.cos;
			sim.sin0[k] = v.sin;
			sim.rate[k] = (0.9 + G.hashUnit(seed, k, 13) * 0.7) * TURN_RATE;
			sim.dir[k] = G.hashUnit(seed, k, 7) < 0.5 ? -1 : 1;
			sim.dwell[k] = 0.4 + G.hashUnit(seed, k, 2) * 3;
			sim.omega[k] = 0;
		}
	}

	// Wall motion for one substep, with the angular velocity taken from the angle
	// the disc actually turned through in this substep. A disc that would close a
	// seam on a grain stalls instead of crushing it: the valve waits, the grain
	// gets the step to slide clear, and nothing has to be teleported.
	function updateTurns(sim, h) {
		const seed = sim.layout.seed | 0;
		const valves = sim.layout.valves;
		let moved = 0;
		for (let k = 0; k < valves.length; k++) {
			const v = valves[k];
			const before = v.angle;
			sim.cos0[k] = v.cos;
			sim.sin0[k] = v.sin;
			let target = sim.target[k];
			if (sim.turning && before === target) {
				sim.dwell[k] -= h;
				if (sim.dwell[k] <= 0) {
					// one way round, so the disc visits every quarter of the cell
					target = sim.target[k] = before + sim.dir[k] * HALF_PI;
					sim.dwell[k] = TURN_DWELL_MIN + G.hashUnit(seed, k, 11) * 1.2;
				}
			}
			const remaining = target - before;
			if (remaining === 0) {
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

	// A turn can leave grains on the wrong side of a moving wall. The rim first
	// shoves such a grain back into its corridor, which is what a closing mouth
	// does to a pile. A grain the shove cannot reach within WALL_PUSH holds the
	// valve back instead: the step is undone and, after STALL_LIMIT seconds of
	// refusing, the valve gives the quarter up and tries the other way round, so
	// a jam clears itself and nothing has to be crushed.
	function settleWalls(sim, h) {
		const layout = sim.layout;
		const valves = layout.valves;
		sim.stalled = 0;
		for (let k = 0; k < sim.count; k++) {
			sim.pushFlag[k] = 0;
			const x = sim.x[k];
			const y = sim.y[k];
			const vi = G.cellAt(x, y);
			const om = sim.omega[vi];
			if (om === 0 || sim.stalledList[vi] === sim.steps) continue;
			const v = valves[vi];
			const dx = x - v.cx;
			const dy = y - v.cy;
			let tx = x;
			let ty = y;
			if (dx * dx + dy * dy < RV * RV) {
				const c0 = sim.cos0[vi];
				const s0 = sim.sin0[vi];
				const rx = dx * c0 + dy * s0;
				const ry = dy * c0 - dx * s0;
				tx = v.cx + rx * v.cos - ry * v.sin;
				ty = v.cy + rx * v.sin + ry * v.cos;
			}
			if (G.airClearance(layout, tx, ty) >= sim.r[k] - 1e-6) continue;
			// The rim sweeping across a mouth shoves a grain out of the way; only a
			// grain that would have to jump holds the valve back.
			G.nearestAir(layout, tx, ty, sim.r[k], nearest);
			if (nearest.found && nearest.dist <= WALL_PUSH) {
				sim.pushX[k] = nearest.x;
				sim.pushY[k] = nearest.y;
				sim.pushFlag[k] = 1;
				continue;
			}
			sim.stalledList[vi] = sim.steps;
			sim.stalled++;
		}
		for (let k = 0; k < valves.length; k++) {
			if (sim.stalledList[k] !== sim.steps) {
				sim.stallTime[k] = 0;
				continue;
			}
			const v = valves[k];
			G.setAngle(v, v.angle - sim.omega[k] * h);
			sim.omega[k] = 0;
			sim.stallTime[k] += h;
			if (sim.stallTime[k] <= STALL_LIMIT) continue;
			// Give the turn up and spring back to the nearest detent, where every
			// port lines up with a channel again: a valve left stuck mid-turn would
			// hold its seams half shut and throttle the cells around it.
			sim.target[k] = Math.round(v.angle / HALF_PI) * HALF_PI;
			sim.dir[k] = -sim.dir[k];
			sim.stallTime[k] = 0;
			sim.stalls++;
		}
	}

	// Clearance gradient points away from the nearest wall, which is exactly the
	// contact normal of a distance field.
	function normalAt(layout, x, y) {
		const e = 0.55;
		const gx = G.airClearance(layout, x + e, y) - G.airClearance(layout, x - e, y);
		const gy = G.airClearance(layout, x, y + e) - G.airClearance(layout, x, y - e);
		const len = Math.sqrt(gx * gx + gy * gy);
		if (len < 1e-7) return false;
		nrm.x = gx / len;
		nrm.y = gy / len;
		return true;
	}

	// Impulse against a wall moving with (wvx, wvy). Restitution only acts on the
	// closing part of the relative velocity, so a grain riding a wall feels no
	// kick. Friction is limited by the normal impulse plus the weight the contact
	// carries, which is what lets a grain rest on a slope instead of creeping.
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
		if (ny < 0) press += -GRAVITY * ny * h;
		const tx = -ny;
		const ty = nx;
		const ut = (vx - wvx) * tx + (vy - wvy) * ty;
		const jt = clamp(ut, -FRICTION * press, FRICTION * press);
		sim.vx[k] = vx - jt * tx;
		sim.vy[k] = vy - jt * ty;
	}

	// Deepest overlap of grain k if it sat at (x, y), read from the bins of this
	// step. Used both to stop a fall from diving into a pile and to keep a
	// correction from pressing a grain deeper into its neighbours.
	function penetrationAt(sim, k, x, y) {
		const rad = sim.r[k];
		const bx = binX(x);
		const by = binY(y);
		let worst = 0;
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
					if (pen > worst) worst = pen;
				}
			}
		}
		return worst;
	}

	// Pushes a grain by at most (dx, dy) and returns the fraction it managed. Walls
	// come first, then the pile: the move may not leave the grain deeper inside a
	// neighbour than `limit`, the overlap the correction is resolving. A stack
	// hands its overlap upwards one contact at a time; refusing outright instead
	// froze every correction, and a dead end then kept its load compressed.
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

	// One substep inside a rotor disc, done in the material frame of the disc:
	// the disc carries its passages, so gravity, centrifugal and Coriolis terms
	// belong in that frame. The world velocity is what the sweep and the contact
	// solver use, so it is converted back once and the target is a plain step
	// along it from the position the disc has already carried the grain to.
	function rotorStep(sim, k, v, vi, h, damp) {
		const om = sim.omega[vi];
		const dx = sim.x[k] - v.cx;
		const dy = sim.y[k] - v.cy;
		const rx = dx * v.cos + dy * v.sin;
		const ry = dy * v.cos - dx * v.sin;
		const ux = sim.vx[k] + om * dy;
		const uy = sim.vy[k] - om * dx;
		const c = v.cos;
		const sn = v.sin;
		let fx = (ux * c + uy * sn) * damp;
		let fy = (uy * c - ux * sn) * damp;
		fx += (GRAVITY * sn + om * om * rx + 2 * om * fy) * h;
		fy += (GRAVITY * c + om * om * ry - 2 * om * fx) * h;
		const speed2 = fx * fx + fy * fy;
		if (speed2 > MAX_SPEED * MAX_SPEED) {
			const scale = MAX_SPEED / Math.sqrt(speed2);
			fx *= scale;
			fy *= scale;
		}
		sim.vx[k] = fx * c - fy * sn - om * dy;
		sim.vy[k] = fx * sn + fy * c + om * dx;
		target.x = sim.x[k] + sim.vx[k] * h;
		target.y = sim.y[k] + sim.vy[k] * h;
	}

	function worldStep(sim, k, h, damp) {
		sim.vx[k] *= damp;
		sim.vy[k] = (sim.vy[k] + GRAVITY * h) * damp;
		clampSpeed(sim, k);
		target.x = sim.x[k] + sim.vx[k] * h;
		target.y = sim.y[k] + sim.vy[k] * h;
	}

	function applyMove(sim, k, v, vi, inRotor, h) {
		const x0 = sim.x[k];
		const y0 = sim.y[k];
		G.sweep(sim.layout, x0, y0, target.x, target.y, sim.r[k], sweepOut);
		// The pile in the way limits the move as well: bisect to the first sample
		// that is not deeper inside a neighbour than the grain already is, so a
		// falling grain lands on the pile instead of diving into it.
		let tx = sweepOut.x;
		let ty = sweepOut.y;
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
				sweepOut.hit = true;
			}
		}
		sweepOut.x = tx;
		sweepOut.y = ty;
		sim.x[k] = tx;
		sim.y[k] = ty;
		if (!sweepOut.hit) return;
		if (!normalAt(sim.layout, sweepOut.x, sweepOut.y)) {
			const mx = target.x - x0;
			const my = target.y - y0;
			const len = Math.sqrt(mx * mx + my * my) || 1;
			nrm.x = -mx / len;
			nrm.y = -my / len;
		}
		let wvx = 0;
		let wvy = 0;
		if (inRotor) {
			const om = sim.omega[vi];
			wvx = -om * (sweepOut.y - v.cy);
			wvy = om * (sweepOut.x - v.cx);
		}
		wallContact(sim, k, nrm.x, nrm.y, wvx, wvy, h);
	}

	// The disc carries what sits in its passages. This runs before any move is
	// swept, so the sweep never starts from a position the disc has already
	// turned past, and it also applies the shove a closing rim gave a grain.
	function carryWalls(sim) {
		const valves = sim.layout.valves;
		for (let k = 0; k < sim.count; k++) {
			const vi = G.cellAt(sim.x[k], sim.y[k]);
			const v = valves[vi];
			const c0 = sim.cos0[vi];
			const s0 = sim.sin0[vi];
			const dx = sim.x[k] - v.cx;
			const dy = sim.y[k] - v.cy;
			if ((v.cos !== c0 || v.sin !== s0) && dx * dx + dy * dy < RV * RV) {
				const rx = dx * c0 + dy * s0;
				const ry = dy * c0 - dx * s0;
				sim.x[k] = v.cx + rx * v.cos - ry * v.sin;
				sim.y[k] = v.cy + rx * v.sin + ry * v.cos;
			}
			if (!sim.pushFlag[k]) continue;
			sim.pushFlag[k] = 0;
			if (sim.stalledList[vi] === sim.steps) continue;
			sim.x[k] = sim.pushX[k];
			sim.y[k] = sim.pushY[k];
			sim.pushed++;
		}
	}

	function integrate(sim, h) {
		const layout = sim.layout;
		const damp = 1 - DAMPING * h;
		for (let k = 0; k < sim.count; k++) {
			const vi = G.cellAt(sim.x[k], sim.y[k]);
			const v = layout.valves[vi];
			const dx = sim.x[k] - v.cx;
			const dy = sim.y[k] - v.cy;
			const inRotor = dx * dx + dy * dy < RV * RV;
			if (inRotor) rotorStep(sim, k, v, vi, h, damp);
			else worldStep(sim, k, h, damp);
			applyMove(sim, k, v, vi, inRotor, h);
		}
	}

	// Rotating a disc can close a seam under a grain that has not moved at all, so
	// the solver puts such a grain back into verified air and records how far it
	// had to travel instead of deleting it or leaving it inside metal.
	function repair(sim) {
		const layout = sim.layout;
		for (let k = 0; k < sim.count; k++) {
			const rad = sim.r[k];
			const clear = G.airClearance(layout, sim.x[k], sim.y[k]);
			if (clear >= rad - 1e-6) continue;
			// how far inside metal the grain got before the repair, i.e. what the
			// wall motion did to it, not what the repair left behind
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

	// Counting sort into a uniform grid. Every grain is smaller than half a cell,
	// so a 3x3 scan of bins is enough to see every touching pair exactly once.
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
			// Coincident grains have no axis of their own. The direction is derived
			// from the index pair so the split is deterministic and repeatable.
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
			// A side held by a wall or by a pile hands its share to the other one,
			// which is what lets a stack open upwards instead of locking up.
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

	// Iterative reconciliation: the pair corrections are positional and wall
	// limited, so a pile relaxes towards non-overlap without ever opening a wall.
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

	// Only the drain lip removes a grain, and it is counted. Anything trapped in
	// the machine stays in the machine and stays counted.
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
		updateTurns(sim, h);
		carryWalls(sim);
		buildBins(sim);
		integrate(sim, h);
		repair(sim);
		buildBins(sim);
		for (let it = 0; it < ITERATIONS; it++) resolvePairs(sim);
		measurePairs(sim);
		compact(sim);
		sim.clock += h;
		sim.steps++;
	}

	// Fixed-step accumulator with bounded catch-up: a long stall advances at most
	// MAX_STEPS substeps and drops the rest instead of spiralling.
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

	// Called when the page becomes visible again: drop the backlog rather than
	// fast-forwarding a hidden tab through seconds of simulation.
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

	// Seeded upper reservoirs: a few top-row spouts, each with two files of
	// grains in the pour band, fully determined by the layout seed.
	function seed(sim) {
		let added = 0;
		for (let i = 0; i < N; i++) {
			if (!slotUsed(sim, i)) continue;
			for (let f = 0; f < SLOT_FILES.length; f++) {
				for (let row = 0; row < SLOT_ROWS; row++) if (addAtSlot(sim, i, f, row)) added++;
			}
		}
		return added;
	}

	// Fills the lowest free slot first, so a pour lands on top of the pile.
	function pour(sim, n) {
		const want = n === undefined ? 24 : n;
		let added = 0;
		for (let row = SLOT_ROWS - 1; row >= 0 && added < want; row--) {
			for (let f = 0; f < SLOT_FILES.length && added < want; f++) {
				for (let i = 0; i < N && added < want; i++) {
					if (!slotUsed(sim, i)) continue;
					if (addAtSlot(sim, i, f, row)) added++;
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
		sim.maxPush = 0;
		sim.maxOverlap = 0;
		sim.maxPen = 0;
		sim.stalled = 0;
		sim.stalls = 0;
		sim.stalledList.fill(0);
		sim.stallTime.fill(0);
		sim.pushFlag.fill(0);
		sim.pushed = 0;
		initSchedule(sim);
	}

	// Quarters of a turn on one valve, used by the fixtures and by the controls.
	function turn(sim, index, quarters) {
		if (index < 0 || index >= sim.layout.valves.length) return false;
		sim.target[index] = sim.layout.valves[index].angle + quarters * HALF_PI;
		return true;
	}

	function setSpeed(sim, speed) {
		sim.speed = speed > 0 ? speed : 0;
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
		setSpeed,
		seed,
		pour,
		drain,
		reset,
		addGrain,
		active,
	};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ValveSimulation;
