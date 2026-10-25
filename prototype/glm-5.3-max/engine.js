const ValveEngine = (() => {
	"use strict";

	const N = 10;
	const S = 72;
	const SIZE = N * S;
	const RV = S * 0.435;
	const CW = RV * 0.44;
	const WALL = RV * 0.135;
	const EDGE = 1.95;
	const ELBOW = RV * 0.5;
	const TAU = Math.PI * 2;
	const DX = [1, 0, -1, 0];
	const DY = [0, 1, 0, -1];
	const PORT_ANG = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
	const rnd = (a, b) => a + Math.random() * (b - a);
	const pick = (arr) => arr[(Math.random() * arr.length) | 0];
	function hsl(h, s, l) {
		return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
	}
	function rot(x, y, a) {
		const c = Math.cos(a);
		const s = Math.sin(a);
		return { x: x * c - y * s, y: x * s + y * c };
	}
	const SOLID_SHAPES = [
		[0, 2],
		// straight through
		[0, 3],
		// L
		[0, 1, 2],
		// T
		[0, 1, 2, 3],
		// X
		[0],
		// blind pocket
		[],
		// blank plug
		[0],
		// (extra weight on pocket)
	];
	const HOLLOW_SHAPES = [
		[0],
		// one outlet
		[0, 2],
		// two opposite
		[0, 3],
		// two adjacent
		[0, 1, 2],
		// three
		[0, 1, 2, 3],
		// four
		[0, 1, 2, 3],
	];
	const adjacent = (a, b) => {
		const d = Math.abs(a - b);
		return d === 1 || d === 3;
	};
	function buildPrims(ports, kind, base, chamberR) {
		const prims = [];
		const path = new Path2D();
		const addSeg = (ax, ay, bx, by) => {
			const a = rot(ax, ay, base);
			const b = rot(bx, by, base);
			prims.push({ t: 0, ax: a.x, ay: a.y, bx: b.x, by: b.y });
			path.moveTo(a.x, a.y);
			path.lineTo(b.x, b.y);
		};
		if (kind === "hollow") {
			prims.push({ t: 2, r: chamberR });
			for (const p of ports) addSeg(0, 0, DX[p] * RV, DY[p] * RV);
			return { prims, path };
		}
		const has = (p) => ports.indexOf(p) >= 0;
		const two = ports.length === 2;
		if (two && adjacent(ports[0], ports[1])) {
			const [p, q] = ports;
			// Offset the bend center so both radial legs meet the arc tangentially.
			const center = rot(
				(DX[p] + DX[q]) * ELBOW,
				(DY[p] + DY[q]) * ELBOW,
				base,
			);
			const a1 = rot(DX[p] * RV, DY[p] * RV, base);
			const a2 = rot(DX[p] * ELBOW, DY[p] * ELBOW, base);
			const b2 = rot(DX[q] * ELBOW, DY[q] * ELBOW, base);
			const b1 = rot(DX[q] * RV, DY[q] * RV, base);
			const angP = Math.atan2(a2.y - center.y, a2.x - center.x);
			const angQ = Math.atan2(b2.y - center.y, b2.x - center.x);
			let d = angQ - angP;
			while (d > Math.PI) d -= TAU;
			while (d < -Math.PI) d += TAU;
			prims.push({ t: 0, ax: a1.x, ay: a1.y, bx: a2.x, by: a2.y });
			prims.push({
				t: 1,
				cx: center.x,
				cy: center.y,
				r: ELBOW,
				mid: angP + d / 2,
				span: Math.PI / 2,
			});
			prims.push({ t: 0, ax: b2.x, ay: b2.y, bx: b1.x, by: b1.y });
			path.moveTo(a1.x, a1.y);
			path.lineTo(a2.x, a2.y);
			path.arc(center.x, center.y, ELBOW, angP, angQ, d < 0);
			path.lineTo(b1.x, b1.y);
			return { prims, path };
		}
		if (has(0) || has(2)) {
			const x0 = has(2) ? -RV : 0;
			const x1 = has(0) ? RV : 0;
			if (x1 !== x0) addSeg(x0, 0, x1, 0);
		}
		if (has(1) || has(3)) {
			const y0 = has(3) ? -RV : 0;
			const y1 = has(1) ? RV : 0;
			if (y1 !== y0) addSeg(0, y0, 0, y1);
		}
		return { prims, path };
	}
	function arcCovers(pr, x, y, h) {
		const dx = x - pr.cx;
		const dy = y - pr.cy;
		if (Math.abs(Math.hypot(dx, dy) - pr.r) > h) return false;
		let d = Math.atan2(dy, dx) - pr.mid;
		while (d > Math.PI) d -= TAU;
		while (d < -Math.PI) d += TAU;
		return Math.abs(d) <= pr.span / 2;
	}
	function primCovers(prims, x, y, h) {
		for (const pr of prims) {
			if (pr.t === 2) {
				if (Math.hypot(x, y) <= pr.r) return true;
			} else if (pr.t === 1) {
				if (arcCovers(pr, x, y, h)) return true;
			} else if (distSeg(x, y, pr.ax, pr.ay, pr.bx, pr.by) <= h) {
				return true;
			}
		}
		return false;
	}
	function makeValve(i, j) {
		const kind = Math.random() < 0.4 ? "hollow" : "solid";
		const shape = kind === "hollow" ? pick(HOLLOW_SHAPES) : pick(SOLID_SHAPES);
		const base = ((Math.random() * 4) | 0) * (Math.PI / 2);
		const chamberR = kind === "hollow" ? RV * rnd(0.3, 0.42) : 0;
		const { prims, path } = buildPrims(shape, kind, base, chamberR);
		const hv = rnd(-12, 12);
		const hs = rnd(5, 11);
		const hl = rnd(43, 56);
		const vh = rnd(-10, 10);
		const vl = rnd(23, 31);
		return {
			i,
			j,
			cx: (i + 0.5) * S,
			cy: (j + 0.5) * S,
			kind,
			ports: shape,
			prims,
			path,
			chamberR,
			solidCenter: !primCovers(prims, 0, 0, CW / 2),
			angle: 0,
			from: 0,
			delta: 0,
			t: 1,
			dur: 1,
			dwell: rnd(0.2, 3.4),
			omega: 0,
			bodyHi: hsl(214 + vh, hs, vl + 8),
			bodyLo: hsl(214 + vh, hs, vl),
			tileHi: hsl(210 + hv, hs, hl + 5),
			tileLo: hsl(210 + hv, hs, hl - 5),
		};
	}
	function createWorld() {
		const valves = [];
		for (let j = 0; j < N; j++)
			for (let i = 0; i < N; i++) valves.push(makeValve(i, j));
		return { valves, particles: [] };
	}
	function distSeg(px, py, ax, ay, bx, by) {
		const dx = bx - ax;
		const dy = by - ay;
		const l2 = dx * dx + dy * dy;
		let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
		t = t < 0 ? 0 : t > 1 ? 1 : t;
		const cx = ax + dx * t;
		const cy = ay + dy * t;
		return Math.hypot(px - cx, py - cy);
	}
	function isAir(w, x, y, s) {
		if (x < 0.5 || x > SIZE - 0.5 || y < -30 || y > SIZE + 30) return false;
		const h0 = CW / 2 - s;
		if (h0 <= 0.35) return false;
		if (y < 0.5 || y > SIZE - 0.5) {
			const i2 = Math.min(N - 1, Math.max(0, (x / S) | 0));
			const v2 = w.valves[(y < 0.5 ? 0 : N - 1) * N + i2];
			return Math.abs(x - v2.cx) <= h0;
		}
		const i = Math.min(N - 1, Math.max(0, (x / S) | 0));
		const j = Math.min(N - 1, Math.max(0, (y / S) | 0));
		const v = w.valves[j * N + i];
		const lx = x - v.cx;
		const ly = y - v.cy;
		const h = CW / 2 - s;
		if (h <= 0.35) return false;
		const r = Math.hypot(lx, ly);
		if (r < RV + s) {
			const c = Math.cos(-v.angle);
			const sn = Math.sin(-v.angle);
			const px = lx * c - ly * sn;
			const py = lx * sn + ly * c;
			for (let k = 0; k < v.prims.length; k++) {
				const pr = v.prims[k];
				if (pr.t === 0) {
					if (distSeg(px, py, pr.ax, pr.ay, pr.bx, pr.by) <= h) return true;
				} else if (pr.t === 1) {
					if (arcCovers(pr, px, py, h)) {
						let d = Math.atan2(py - pr.cy, px - pr.cx) - pr.mid;
						while (d > Math.PI) d -= TAU;
						while (d < -Math.PI) d += TAU;
						if (Math.abs(d) <= pr.span / 2 + 0.05) return true;
					}
				} else if (Math.hypot(px, py) <= pr.r - s) {
					return true;
				}
			}
			return false;
		}
		return Math.abs(lx) <= h || Math.abs(ly) <= h;
	}
	const G = 820;
	const DRAG = 2.4;
	const VMAX = 250;
	const SUB = 3;
	const PALETTE = [
		[4, 78, 58],
		[24, 88, 60],
		[42, 92, 62],
		[160, 72, 52],
		[190, 80, 55],
		[205, 82, 60],
		[268, 70, 64],
		[300, 72, 62],
		[336, 80, 62],
	];
	function newParticle(x, y) {
		const c = pick(PALETTE);
		const r = rnd(2.2, 3);
		return {
			x,
			y,
			vx: rnd(-12, 12),
			vy: rnd(-10, 20),
			r,
			color: hsl(c[0], c[1], c[2]),
			rim: hsl(c[0], Math.min(90, c[1] + 10), Math.max(12, c[2] - 34)),
			stuck: 0,
		};
	}
	function airPointInValve(w, v, s) {
		for (let tries = 0; tries < 40; tries++) {
			const pr = v.prims[(Math.random() * v.prims.length) | 0];
			let lx = 0;
			let ly = 0;
			if (pr.t === 0) {
				const u = Math.random();
				lx = pr.ax + (pr.bx - pr.ax) * u;
				ly = pr.ay + (pr.by - pr.ay) * u;
			} else if (pr.t === 1) {
				const a = pr.mid + (Math.random() - 0.5) * pr.span * 0.8;
				lx = pr.cx + Math.cos(a) * pr.r;
				ly = pr.cy + Math.sin(a) * pr.r;
			} else {
				const a = Math.random() * TAU;
				const rr = Math.sqrt(Math.random()) * Math.max(1, pr.r - s - 1.5);
				lx = Math.cos(a) * rr;
				ly = Math.sin(a) * rr;
			}
			lx += rnd(-1.2, 1.2);
			ly += rnd(-1.2, 1.2);
			const p = rot(lx, ly, v.angle);
			const x = v.cx + p.x;
			const y = v.cy + p.y;
			if (isAir(w, x, y, s)) return { x, y };
		}
		return null;
	}
	function spawnTop(w, p) {
		const i = (Math.random() * N) | 0;
		const cx = (i + 0.5) * S;
		p.x = cx + rnd(-1, 1) * (CW / 2 - p.r - 0.4);
		p.y = rnd(-9, -1.5);
		p.vx = rnd(-8, 8);
		p.vy = rnd(0, 30);
		p.stuck = 0;
		if (!isAir(w, p.x, p.y, p.r)) {
			p.x = cx;
			p.y = -3;
		}
	}
	function setParticleCount(w, count) {
		while (w.particles.length > count) w.particles.pop();
		let guard = 0;
		while (w.particles.length < count && guard++ < count * 40) {
			const p = newParticle(0, 0);
			if (Math.random() < 0.6) {
				spawnTop(w, p);
				w.particles.push(p);
			} else {
				const top = w.valves.filter((v2) => v2.j < 4 && v2.prims.length > 0);
				const any = w.valves.filter((v2) => v2.prims.length > 0);
				if (!any.length) {
					spawnTop(w, p);
					w.particles.push(p);
					continue;
				}
				const v = Math.random() < 0.75 && top.length ? pick(top) : pick(any);
				const pt = airPointInValve(w, v, p.r);
				if (pt) {
					p.x = pt.x;
					p.y = pt.y;
					w.particles.push(p);
				}
			}
		}
	}
	function dropAll(w) {
		for (const p of w.particles) spawnTop(w, p);
	}
	function nextMove(v) {
		const q = 1 + ((Math.random() * 3) | 0);
		const sign = Math.random() < 0.5 ? -1 : 1;
		v.from = v.angle;
		v.delta = (sign * q * Math.PI) / 2;
		v.t = 0;
		v.dur = rnd(1, 2.3);
	}
	function stepValves(w, dt) {
		for (const v of w.valves) {
			const prev = v.angle;
			if (v.t < 1) {
				v.t = Math.min(1, v.t + dt / v.dur);
				const u = v.t;
				const e = u * u * (3 - 2 * u);
				v.angle = v.from + v.delta * e;
			} else {
				v.dwell -= dt;
				if (v.dwell <= 0) {
					nextMove(v);
					v.dwell = rnd(0.9, 4.2);
				}
			}
			v.omega = dt > 0 ? (v.angle - prev) / dt : 0;
		}
	}
	const escapeResult = { nx: 0, ny: 0, d: 0 };
	const escapeCandidates = new Float64Array(14);
	function findEscape(w, x, y, r) {
		const DIRS = 14;
		for (let ring = 1; ring <= 5; ring++) {
			const d = ring * 1.5;
			let sx = 0;
			let sy = 0;
			let cnt = 0;
			const cand = escapeCandidates;
			for (let k = 0; k < DIRS; k++) {
				const a = (k / DIRS) * TAU + ring * 0.31;
				const ax = Math.cos(a);
				const ay = Math.sin(a);
				if (isAir(w, x + ax * d, y + ay * d, r)) {
					cand[cnt] = a;
					sx += ax;
					sy += ay;
					cnt++;
				}
			}
			if (cnt) {
				const ml = Math.hypot(sx, sy) || 1;
				let best = cand[0];
				let score = -2;
				for (let k = 0; k < cnt; k++) {
					const a = cand[k];
					const dot = (Math.cos(a) * sx + Math.sin(a) * sy) / ml;
					if (dot > score) {
						score = dot;
						best = a;
					}
				}
				escapeResult.nx = Math.cos(best);
				escapeResult.ny = Math.sin(best);
				escapeResult.d = d;
				return escapeResult;
			}
		}
		return null;
	}
	function collideWorld(w, p) {
		if (isAir(w, p.x, p.y, p.r)) {
			p.stuck = 0;
			return;
		}
		const esc = findEscape(w, p.x, p.y, p.r);
		if (!esc) {
			p.stuck++;
			return;
		}
		let lo = 0;
		let hi = esc.d;
		for (let k = 0; k < 7; k++) {
			const m = (lo + hi) * 0.5;
			if (isAir(w, p.x + esc.nx * m, p.y + esc.ny * m, p.r)) hi = m;
			else lo = m;
		}
		p.x += esc.nx * hi;
		p.y += esc.ny * hi;
		let wvx = 0;
		let wvy = 0;
		const i = Math.min(N - 1, Math.max(0, (p.x / S) | 0));
		const j = Math.min(N - 1, Math.max(0, (p.y / S) | 0));
		const v = w.valves[j * N + i];
		const lx = p.x - v.cx;
		const ly = p.y - v.cy;
		if (v.omega !== 0 && Math.hypot(lx, ly) < RV + p.r) {
			wvx = -v.omega * ly;
			wvy = v.omega * lx;
		}
		let rvx = p.vx - wvx;
		let rvy = p.vy - wvy;
		const vn = rvx * esc.nx + rvy * esc.ny;
		if (vn < 0) {
			const rest = 0.14;
			rvx -= (1 + rest) * vn * esc.nx;
			rvy -= (1 + rest) * vn * esc.ny;
			const tx = -esc.ny;
			const ty = esc.nx;
			const vt = rvx * tx + rvy * ty;
			rvx -= vt * 0.14 * tx;
			rvy -= vt * 0.14 * ty;
			p.vx = rvx + wvx;
			p.vy = rvy + wvy;
		}
		if (Math.abs(p.vx) < 6 && Math.abs(p.vy) < 14 && Math.random() < 0.035) {
			p.vx += rnd(-16, 16);
		}
		p.stuck = 0;
	}
	function collideParticles(ps) {
		for (let a = 0; a < ps.length; a++) {
			const p = ps[a];
			for (let b = a + 1; b < ps.length; b++) {
				const q = ps[b];
				const dx = q.x - p.x;
				const dy = q.y - p.y;
				const rr = p.r + q.r;
				const d2 = dx * dx + dy * dy;
				if (d2 >= rr * rr || d2 <= 1e-4) continue;
				const d = Math.sqrt(d2);
				const nx = dx / d;
				const ny = dy / d;
				const push = (rr - d) * 0.5;
				p.x -= nx * push;
				p.y -= ny * push;
				q.x += nx * push;
				q.y += ny * push;
				const rvx = q.vx - p.vx;
				const rvy = q.vy - p.vy;
				const vn = rvx * nx + rvy * ny;
				if (vn < 0) {
					const imp = -vn * 0.55;
					p.vx -= nx * imp;
					p.vy -= ny * imp;
					q.vx += nx * imp;
					q.vy += ny * imp;
				}
			}
		}
	}
	function stepParticles(w, dt) {
		const ps = w.particles;
		const h = dt / SUB;
		for (let s = 0; s < SUB; s++) {
			const drag = Math.exp(-DRAG * h);
			for (const p of ps) {
				p.vy += G * h;
				p.vx *= drag;
				p.vy *= drag;
				const sp = Math.hypot(p.vx, p.vy);
				if (sp > VMAX) {
					p.vx *= VMAX / sp;
					p.vy *= VMAX / sp;
				}
				p.x += p.vx * h;
				p.y += p.vy * h;
				collideWorld(w, p);
			}
			collideParticles(ps);
			for (const p of ps) if (!isAir(w, p.x, p.y, p.r)) collideWorld(w, p);
		}
		for (const p of ps) {
			if (p.y > SIZE + 6 || p.x < -6 || p.x > SIZE + 6 || p.stuck > 45) {
				spawnTop(w, p);
			}
		}
	}

	return {
		N,
		S,
		SIZE,
		RV,
		CW,
		WALL,
		EDGE,
		ELBOW,
		TAU,
		DX,
		DY,
		PORT_ANG,
		createWorld,
		isAir,
		setParticleCount,
		dropAll,
		stepValves,
		stepParticles,
	};
})();
if (typeof module !== "undefined") module.exports = ValveEngine;
