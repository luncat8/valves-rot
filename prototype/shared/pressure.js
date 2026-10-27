// Optional kinetic air. Independent state and counters; no DOM or drawing.
const ValvePressure = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const RADIUS = 0.65;
	const MASS = 0.035;
	const SPEED = 180;
	const LIMIT = 450;
	const BIN = 8;
	const W = Math.ceil(G.SIZE / BIN);
	const H = Math.ceil((G.SIZE + 2 * G.POUR) / BIN);

	function cell(x, y) {
		const bx = Math.max(0, Math.min(W - 1, Math.floor(x / BIN)));
		const by = Math.max(0, Math.min(H - 1, Math.floor((y + G.POUR) / BIN)));
		return by * W + bx;
	}

	function create(sim, capacity = 900) {
		const p = {
			count: 0, capacity, collisions: 0, recoveries: 0,
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

	function reflect(p, k, nx, ny, wx, wy) {
		const incoming = (p.vx[k] - wx) * nx + (p.vy[k] - wy) * ny;
		if (incoming >= 0) return;
		p.vx[k] -= 2 * incoming * nx;
		p.vy[k] -= 2 * incoming * ny;
		cap(p, k);
	}

	function wall(sim, p, k, dx, dy) {
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
		reflect(p, k, nx, ny, -omega * ry, omega * rx);
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
					if (incoming < 0) {
						const mass = sim.r[j] * sim.r[j];
						const impulse = -2 * incoming / (1 / MASS + 1 / mass);
						p.vx[k] += impulse * nx / MASS;
						p.vy[k] += impulse * ny / MASS;
						sim.vx[j] -= impulse * nx / mass;
						sim.vy[j] -= impulse * ny / mass;
						// Safety ceiling dissipates only extreme driven-wall energy.
						cap(p, k);
						p.collisions++;
					}
					return true;
				}
			}
		}
		return false;
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
				wall(sim, p, k, -dx, -dy);
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
				if (!contact(sim, p, k, p.sweep.x, p.sweep.y)) {
					p.x[k] = p.sweep.x;
					p.y[k] = p.sweep.y;
				}
				if (hit) wall(sim, p, k, dx, dy);
			}
		}
	}

	return { create, step, RADIUS, MASS, LIMIT };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValvePressure;
