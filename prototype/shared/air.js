// Optional kinetic air. Independent state and counters; no DOM or drawing.
// Air is a dilute population of elastic discs; the inlets drive it as a
// reservoir circuit, cycling particles that reach a low-pressure vent back into
// a high-pressure source so the cloud circulates bottom to top.
const ValveAir = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const I = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");
	const RADIUS = 0.65;
	// Air is lighter than a grain (r^2 = 7.3 for a 2.7 px grain) and deliberately
	// not negligible: a 180 px/s impact moves a grain a few px/s, and a stream of
	// impacts through a chamber visibly holds a fall back.
	const MASS = 3;
	const SPEED = 180;
	const LIMIT = 450;
	const WALL_WINDOW = 1;
	const BIN = 8;
	// Particles recycled per second per open source/vent pair, and how deep into a
	// band a particle has to reach before a vent takes it.
	const CYCLE_RATE = 26;
	const VENT_DEPTH = 9;
	const W = Math.ceil(G.SIZE / BIN);
	const H = Math.ceil((G.SIZE + 2 * G.POUR) / BIN);

	function cell(x, y) {
		const bx = Math.max(0, Math.min(W - 1, Math.floor(x / BIN)));
		const by = Math.max(0, Math.min(H - 1, Math.floor((y + G.POUR) / BIN)));
		return by * W + bx;
	}

	function create(sim, capacity = 900) {
		const p = {
			kind: "particles",
			count: 0, capacity, collisions: 0, recoveries: 0, cycles: 0,
			exchange: 0, cursor: 0,
			wallImpulse: 0, wallHits: 0, wallTime: 0,
			lastWallImpulse: 0, lastWallHits: 0, lastWallTime: 0, wallWindows: 0,
			random: G.rng((sim.layout.seed | 0) ^ 0x2f1d5),
			x: new Float64Array(capacity), y: new Float64Array(capacity),
			vx: new Float64Array(capacity), vy: new Float64Array(capacity),
			head: new Int32Array(W * H), next: new Int32Array(sim.capacity),
			sweep: { x: 0, y: 0, hit: false },
			nearest: { x: 0, y: 0, dist: 0, found: false },
		};
		const random = G.rng(sim.layout.seed ^ 0x51a17);
		for (let trial = 0; trial < capacity * 100 && p.count < capacity; trial++) {
			const x = random() * G.SIZE;
			const y = random() * (G.SIZE + 2 * G.POUR) - G.POUR;
			if (G.airClearance(sim.layout, x, y) < RADIUS) continue;
			let blocked = false;
			for (let k = 0; k < sim.count; k++) {
				if (Math.hypot(x - sim.x[k], y - sim.y[k]) < sim.r[k] + RADIUS) { blocked = true; break; }
			}
			if (blocked) continue;
			const k = p.count++;
			const angle = random() * G.TAU;
			p.x[k] = x;
			p.y[k] = y;
			p.vx[k] = Math.cos(angle) * SPEED;
			p.vy[k] = Math.sin(angle) * SPEED;
		}
		return p;
	}

	function cap(p, k) {
		const speed = Math.hypot(p.vx[k], p.vy[k]);
		if (speed <= LIMIT) return;
		p.vx[k] *= LIMIT / speed;
		p.vy[k] *= LIMIT / speed;
	}

	function reflect(p, k, nx, ny, wx, wy, measure) {
		const incoming = (p.vx[k] - wx) * nx + (p.vy[k] - wy) * ny;
		if (incoming >= 0) return;
		if (measure) {
			p.wallImpulse -= 2 * incoming * MASS;
			p.wallHits++;
		}
		p.vx[k] -= 2 * incoming * nx;
		p.vy[k] -= 2 * incoming * ny;
		cap(p, k);
	}

	function wall(sim, p, k, dx, dy, measure) {
		const x = p.x[k];
		const y = p.y[k];
		const e = 0.3;
		let nx = G.airClearance(sim.layout, x + e, y) - G.airClearance(sim.layout, x - e, y);
		let ny = G.airClearance(sim.layout, x, y + e) - G.airClearance(sim.layout, x, y - e);
		let len = Math.hypot(nx, ny);
		if (len < 1e-8) { nx = -dx; ny = -dy; len = Math.hypot(nx, ny) || 1; }
		nx /= len;
		ny /= len;
		const vi = G.cellAt(x, y);
		const v = sim.layout.valves[vi];
		const rx = x - v.cx;
		const ry = y - v.cy;
		const distance = Math.hypot(rx, ry);
		const rotor = distance < G.RV || (distance < G.RV + RADIUS + 0.8 && nx * rx + ny * ry > 0.7 * distance);
		const omega = rotor ? sim.omega[vi] : 0;
		reflect(p, k, nx, ny, -omega * ry, omega * rx, measure);
	}

	function contact(sim, p, k, x, y) {
		const b = cell(x, y);
		const bx = b % W;
		const by = Math.floor(b / W);
		for (let oy = Math.max(0, by - 1); oy <= Math.min(H - 1, by + 1); oy++) {
			for (let ox = Math.max(0, bx - 1); ox <= Math.min(W - 1, bx + 1); ox++) {
				for (let j = p.head[oy * W + ox]; j !== -1; j = p.next[j]) {
					const dx = x - sim.x[j];
					const dy = y - sim.y[j];
					const reach = sim.r[j] + RADIUS;
					const d = Math.hypot(dx, dy);
					if (d >= reach) continue;
					const nx = d > 1e-9 ? dx / d : 1;
					const ny = d > 1e-9 ? dy / d : 0;
					const incoming = (p.vx[k] - sim.vx[j]) * nx + (p.vy[k] - sim.vy[j]) * ny;
					if (incoming >= 0) continue;
					const mass = sim.r[j] * sim.r[j];
					const impulse = (-2 * incoming / (1 / MASS + 1 / mass)) * sim.airForce;
					p.vx[k] += impulse * nx / MASS;
					p.vy[k] += impulse * ny / MASS;
					sim.vx[j] -= impulse * nx / mass;
					sim.vy[j] -= impulse * ny / mass;
					// Safety ceiling dissipates only extreme driven-wall energy.
					cap(p, k);
					p.collisions++;
					return true;
				}
			}
		}
		return false;
	}

	function band(y) {
		if (y <= -G.POUR + VENT_DEPTH) return I.TOP;
		if (y >= G.SIZE + G.POUR - VENT_DEPTH) return I.BOTTOM;
		return -1;
	}

	// Moves one particle from the vent it reached back to a random high-pressure
	// source, aimed into the field. The population stays constant; only its
	// placement circulates.
	function respire(sim, p, k) {
		const inlets = sim.inlets;
		for (let trial = 0; trial < 12; trial++) {
			const idx = (p.random() * inlets.count) | 0;
			if (!inlets.open[idx] || inlets.level[idx] !== I.HIGH) continue;
			const side = inlets.side[idx];
			const spread = (p.random() * 2 - 1) * (G.HALF - RADIUS - 0.5);
			const depth = p.random() * (G.POUR - 2 * RADIUS - 3);
			const x = inlets.x[idx] + spread;
			const y = side === I.BOTTOM ? inlets.y[idx] - depth : inlets.y[idx] + depth;
			if (G.airClearance(sim.layout, x, y) < RADIUS) continue;
			const angle = p.random() * G.TAU;
			const inward = (side === I.BOTTOM ? -1 : 1) * SPEED * 0.7;
			p.x[k] = x;
			p.y[k] = y;
			p.vx[k] = Math.cos(angle) * SPEED * 0.5;
			p.vy[k] = Math.sin(angle) * SPEED * 0.5 + inward;
			p.cycles++;
			return true;
		}
		return false;
	}

	function exchange(sim, p, h) {
		const inlets = sim.inlets;
		const pairs = Math.min(I.count(inlets, I.HIGH), I.count(inlets, I.LOW));
		if (pairs === 0) return;
		p.exchange += h * CYCLE_RATE * pairs;
		const moves = p.exchange | 0;
		if (moves <= 0) return;
		p.exchange -= moves;
		// A rolling cursor keeps the recycles spread over the population.
		for (let moved = 0, scanned = 0; moved < moves && scanned < p.count; scanned++) {
			const k = p.cursor;
			p.cursor = k + 1 >= p.count ? 0 : k + 1;
			const side = band(p.y[k]);
			if (side < 0) continue;
			const column = Math.max(0, Math.min(G.N - 1, (p.x[k] / G.S) | 0));
			const idx = side * G.N + column;
			if (!inlets.open[idx] || inlets.level[idx] !== I.LOW) continue;
			if (!respire(sim, p, k)) continue;
			moved++;
		}
	}

	function step(sim, h) {
		const p = sim.pressure;
		p.head.fill(-1);
		for (let j = 0; j < sim.count; j++) {
			const b = cell(sim.x[j], sim.y[j]);
			p.next[j] = p.head[b];
			p.head[b] = j;
		}
		for (let k = 0; k < p.count; k++) {
			if (G.airClearance(sim.layout, p.x[k], p.y[k]) < RADIUS - 1e-6) {
				G.nearestAir(sim.layout, p.x[k], p.y[k], RADIUS, p.nearest);
				if (!p.nearest.found) continue;
				const dx = p.nearest.x - p.x[k];
				const dy = p.nearest.y - p.y[k];
				p.x[k] = p.nearest.x;
				p.y[k] = p.nearest.y;
				wall(sim, p, k, -dx, -dy, false);
				p.recoveries++;
			}
			cap(p, k);
			// Short travel plus geometry sweep prevents wall and grain tunnelling.
			const steps = Math.max(1, Math.ceil(Math.hypot(p.vx[k], p.vy[k]) * h / 0.4));
			const dt = h / steps;
			for (let n = 0; n < steps; n++) {
				const dx = p.vx[k] * dt;
				const dy = p.vy[k] * dt;
				G.sweep(sim.layout, p.x[k], p.y[k], p.x[k] + dx, p.y[k] + dy, RADIUS, p.sweep);
				const hit = p.sweep.hit;
				if (contact(sim, p, k, p.sweep.x, p.sweep.y)) continue;
				p.x[k] = p.sweep.x;
				p.y[k] = p.sweep.y;
				if (hit) wall(sim, p, k, dx, dy, true);
			}
		}
		exchange(sim, p, h);
		p.wallTime += h;
		if (p.wallTime + 1e-9 >= WALL_WINDOW) {
			p.lastWallImpulse = p.wallImpulse;
			p.lastWallHits = p.wallHits;
			p.lastWallTime = p.wallTime;
			p.wallImpulse = 0;
			p.wallHits = 0;
			p.wallTime = 0;
			p.wallWindows++;
		}
	}

	return { create, step, RADIUS, MASS, SPEED, LIMIT, CYCLE_RATE, WALL_WINDOW };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveAir;
