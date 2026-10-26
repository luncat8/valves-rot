const ValveGeometry = (() => {
	"use strict";

	const N = 10;
	const S = 72;
	const SIZE = N * S;
	const RV = S * 0.435;
	const HALF = RV * 0.22;
	const WALL = RV * 0.135;
	const EDGE = 1.95;
	const ELBOW = RV * 0.5;
	const POUR = 30;
	const TAU = Math.PI * 2;
	const HALF_PI = Math.PI / 2;
	const DX = [1, 0, -1, 0];
	const DY = [0, 1, 0, -1];
	const PORT_ANG = [0, HALF_PI, Math.PI, -HALF_PI];

	const T_TUBE = 0;
	const T_ARC = 1;
	const T_DISK = 2;

	const SOLID_SHAPES = [
		[0, 2],
		[0, 3],
		[0, 1, 2],
		[0, 1, 2, 3],
		[0],
		[],
	];
	const HOLLOW_SHAPES = [[0], [0, 2], [0, 3], [0, 1, 2], [0, 1, 2, 3]];

	function hash(seed, i, j) {
		let h = (seed | 0) ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca6b);
		h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
		h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
		return (h ^ (h >>> 15)) >>> 0;
	}
	function hashUnit(seed, i, j) {
		return hash(seed, i, j) / 4294967296;
	}
	function rng(state) {
		let a = state | 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function tube(cx, cy, ux, uy, hx, openLo, openHi) {
		return { t: T_TUBE, cx, cy, ux, uy, hx, openLo, openHi };
	}
	// Normalized end angle keeps a0 -> a1 the short way for drawing and sampling.
	function arc(cx, cy, r, a0, a1) {
		let d = a1 - a0;
		while (d > Math.PI) d -= TAU;
		while (d < -Math.PI) d += TAU;
		return { t: T_ARC, cx, cy, r, a0, a1: a0 + d, mid: a0 + d / 2, span: Math.abs(d), ccw: d < 0 };
	}
	function disk(r) {
		return { t: T_DISK, r };
	}

	// Two adjacent ports become a tangent offset-center elbow; both legs stop at
	// the bend so the arc is the only rounded corner of the passage.
	function elbowPrims(ports) {
		const p = ports[0];
		const q = ports[1];
		const cx = (DX[p] + DX[q]) * ELBOW;
		const cy = (DY[p] + DY[q]) * ELBOW;
		const px = DX[p] * ELBOW;
		const py = DY[p] * ELBOW;
		const qx = DX[q] * ELBOW;
		const qy = DY[q] * ELBOW;
		const legP = tube(
			(DX[p] * (RV + ELBOW)) / 2,
			(DY[p] * (RV + ELBOW)) / 2,
			DX[p],
			DY[p],
			(RV - ELBOW) / 2,
			true,
			true,
		);
		const legQ = tube(
			(DX[q] * (RV + ELBOW)) / 2,
			(DY[q] * (RV + ELBOW)) / 2,
			DX[q],
			DY[q],
			(RV - ELBOW) / 2,
			true,
			true,
		);
		return [
			legP,
			arc(cx, cy, ELBOW, Math.atan2(py - cy, px - cx), Math.atan2(qy - cy, qx - cx)),
			legQ,
		];
	}

	// Passages always reach the rim, so their rim end is open: the rotor disc clip
	// shapes the mouth and leaves the rim as a wall only where the seam is shut.
	// A passage that stops at the center is capped there unless the other axis
	// joins it.
	function axisPrims(ports) {
		const has = (p) => ports.indexOf(p) >= 0;
		const prims = [];
		const leg = (dir, openCenter) => {
			prims.push(tube((DX[dir] * RV) / 2, (DY[dir] * RV) / 2, DX[dir], DY[dir], RV / 2, openCenter, true));
		};
		for (let axis = 0; axis < 2; axis++) {
			const pos = axis;
			const neg = axis + 2;
			const joined = has(1 - axis) || has(3 - axis);
			if (has(pos) && has(neg)) {
				prims.push(tube(0, 0, DX[pos], DY[pos], RV, true, true));
				continue;
			}
			if (has(pos)) leg(pos, joined);
			else if (has(neg)) leg(neg, joined);
		}
		return prims;
	}

	function hollowPrims(ports, chamberR) {
		const prims = [disk(chamberR)];
		for (const p of ports) prims.push(tube((DX[p] * RV) / 2, (DY[p] * RV) / 2, DX[p], DY[p], RV / 2, true, true));
		return prims;
	}

	function buildPrims(kind, ports, chamberR) {
		if (kind === "hollow") return hollowPrims(ports, chamberR);
		if (ports.length === 2 && (ports[0] - ports[1]) % 2 !== 0) return elbowPrims(ports);
		return axisPrims(ports);
	}

	// Housing channel from the rotor rim to the cell edge, extended upward or
	// downward at the field border so grains can be poured in and drained out.
	// Adjacent cells describe the same channel, so corridors overlap by a hair:
	// the shared edge must not depend on which cell a grain is assigned to.
	// The inner end also tucks under the rim: a straight corridor edge against a
	// circular rim leaves a crescent of air belonging to neither, and a grain
	// could sit in that seam of nothing.
	const OVERLAP = 0.5;
	const INNER = 1;
	function buildStrips(i, j) {
		const strips = [];
		for (let s = 0; s < 4; s++) {
			const spout = (s === 3 && j === 0) || (s === 1 && j === N - 1);
			const ux = DX[s];
			const uy = DY[s];
			const far = S / 2 + OVERLAP + (spout ? POUR : 0);
			const inner = RV - INNER;
			const openOuter = !(s === 0 && i === N - 1) && !(s === 2 && i === 0);
			strips.push({
				ux,
				uy,
				ax: (ux * (inner + far)) / 2,
				ay: (uy * (inner + far)) / 2,
				hx: (far - inner) / 2,
				inner,
				far,
				spout,
				openOuter,
			});
		}
		return strips;
	}

	// Stroke path for the passages. Chambers are drawn as filled discs, so the
	// disk prim is skipped here: stroking its outline would paint a ring.
	function buildPath(prims) {
		if (typeof Path2D === "undefined") return null;
		const path = new Path2D();
		for (const pr of prims) {
			if (pr.t === T_TUBE) {
				path.moveTo(pr.cx - pr.ux * pr.hx, pr.cy - pr.uy * pr.hx);
				path.lineTo(pr.cx + pr.ux * pr.hx, pr.cy + pr.uy * pr.hx);
			} else if (pr.t === T_ARC) {
				path.moveTo(pr.cx + Math.cos(pr.a0) * pr.r, pr.cy + Math.sin(pr.a0) * pr.r);
				path.arc(pr.cx, pr.cy, pr.r, pr.a0, pr.a1, pr.ccw);
			}
		}
		return path;
	}

	// A port only feeds the housing when the rotated passage still covers the
	// channel cross-section at the rim; the overlap narrows as the rotor turns.
	function updateSeams(v) {
		const seam = v.seam;
		seam[0] = seam[1] = seam[2] = seam[3] = 0;
		for (let k = 0; k < v.ports.length; k++) {
			const u = PORT_ANG[v.ports[k]] + v.angle;
			for (let s = 0; s < 4; s++) {
				let d = u - PORT_ANG[s];
				while (d > Math.PI) d -= TAU;
				while (d <= -Math.PI) d += TAU;
				if (d <= -HALF_PI || d >= HALF_PI) continue;
				const a = (HALF - RV * Math.abs(Math.sin(d))) / Math.cos(d);
				if (a > seam[s]) seam[s] = a < HALF ? a : HALF;
			}
		}
	}

	function setAngle(v, angle) {
		v.angle = angle;
		v.cos = Math.cos(angle);
		v.sin = Math.sin(angle);
		updateSeams(v);
	}

	function makeValve(i, j, kind, ports, base, chamberR) {
		const quarter = ((Math.round(base / HALF_PI) % 4) + 4) % 4;
		const body = [];
		for (let k = 0; k < ports.length; k++) body.push((ports[k] + quarter) & 3);
		const prims = buildPrims(kind, body, chamberR);
		const v = {
			i,
			j,
			cx: (i + 0.5) * S,
			cy: (j + 0.5) * S,
			kind,
			ports: body,
			prims,
			path: buildPath(prims),
			chamberR: kind === "hollow" ? chamberR : 0,
			angle: 0,
			cos: 1,
			sin: 0,
			seam: new Float64Array(4),
			strips: buildStrips(i, j),
		};
		updateSeams(v);
		return v;
	}

	// Every layout needs one continuous route from the pour band to the drain;
	// random port sets alone almost never percolate, and a field with no route
	// cannot demonstrate a fall however well the solver behaves. The walk drifts
	// sideways now and then so the route is not a straight shaft.
	function carveRoute(specs, seed) {
		const cols = new Int32Array(N);
		let i = 1 + ((hashUnit(seed, N, N) * (N - 2)) | 0);
		for (let j = 0; j < N; j++) {
			cols[j] = i;
			const drift = hashUnit(seed, i, j + N);
			if (drift < 0.28 && i > 0) i--;
			else if (drift > 0.72 && i < N - 1) i++;
		}
		addPort(specs[cols[0]], 3);
		for (let j = 0; j < N; j++) {
			const cur = cols[j];
			const cell = specs[j * N + cur];
			if (j > 0) addPort(cell, 3);
			if (j === N - 1) {
				addPort(cell, 1);
				break;
			}
			const next = cols[j + 1];
			const down = next === cur ? cell : specs[j * N + next];
			if (next !== cur) {
				addPort(cell, next < cur ? 2 : 0);
				addPort(down, next < cur ? 0 : 2);
			}
			addPort(down, 1);
		}
	}

	// Specs hold port directions in the rotor's own frame, so a world direction
	// has to be brought back through the cell's base quarter.
	function addPort(spec, world) {
		const local = (world - spec.quarter) & 3;
		if (spec.ports.indexOf(local) < 0) spec.ports.push(local);
	}

	function createLayout(seed) {
		const specs = [];
		for (let j = 0; j < N; j++) {
			for (let i = 0; i < N; i++) {
				const rnd = rng(hash(seed, i, j));
				const hollow = rnd() < 0.4;
				const shapes = hollow ? HOLLOW_SHAPES : SOLID_SHAPES;
				const base = ((rnd() * 4) | 0) * HALF_PI;
				const chamberR = hollow ? RV * (0.3 + rnd() * 0.12) : 0;
				const quarter = ((Math.round(base / HALF_PI) % 4) + 4) % 4;
				specs.push({
					i,
					j,
					kind: hollow ? "hollow" : "solid",
					ports: shapes[(rnd() * shapes.length) | 0].slice(),
					base,
					chamberR,
					quarter,
				});
			}
		}
		carveRoute(specs, seed);
		const valves = [];
		for (let k = 0; k < specs.length; k++) {
			const sp = specs[k];
			valves.push(makeValve(sp.i, sp.j, sp.kind, sp.ports, sp.base, sp.chamberR));
		}
		return { seed, valves };
	}

	// Cells that can pass grains to a drain spout under rotor turns. Only 0-port
	// cells are permanently sealed; any cell with at least one port visits all
	// four housing sides as it rotates.
	function drainReach(layout) {
		const reach = new Uint8Array(N * N);
		const queue = new Int32Array(N * N);
		let head = 0;
		let tail = 0;
		for (let i = 0; i < N; i++) {
			const k = (N - 1) * N + i;
			if (!layout.valves[k].ports.length) continue;
			reach[k] = 1;
			queue[tail++] = k;
		}
		while (head < tail) {
			const k = queue[head++];
			const i = k % N;
			const j = (k / N) | 0;
			for (let s = 0; s < 4; s++) {
				const ni = i + DX[s];
				const nj = j + DY[s];
				if (ni < 0 || ni >= N || nj < 0 || nj >= N) continue;
				const nk = nj * N + ni;
				if (reach[nk] || !layout.valves[nk].ports.length) continue;
				reach[nk] = 1;
				queue[tail++] = nk;
			}
		}
		return reach;
	}

	function tubeDepth(pr, x, y) {
		const dx = x - pr.cx;
		const dy = y - pr.cy;
		const a = dx * pr.ux + dy * pr.uy;
		if (a < -pr.hx || a > pr.hx) return 0;
		const l = dy * pr.ux - dx * pr.uy;
		if (l < -HALF || l > HALF) return 0;
		let d = HALF - Math.abs(l);
		if (!pr.openLo) {
			const t = a + pr.hx;
			if (t < d) d = t;
		}
		if (!pr.openHi) {
			const t = pr.hx - a;
			if (t < d) d = t;
		}
		return d > 0 ? d : 0;
	}

	function arcDepth(pr, x, y) {
		const dx = x - pr.cx;
		const dy = y - pr.cy;
		const rr = Math.sqrt(dx * dx + dy * dy);
		const t = HALF - Math.abs(rr - pr.r);
		if (t <= 0) return 0;
		let d = Math.atan2(dy, dx) - pr.mid;
		while (d > Math.PI) d -= TAU;
		while (d < -Math.PI) d += TAU;
		return Math.abs(d) <= pr.span / 2 ? t : 0;
	}

	// Housing channel from the rotor rim to the cell edge. The corridor spans
	// exactly [RV, far] along its axis, so the rim is its mouth, not a taper.
	function stripDepth(st, x, y) {
		const dx = x - st.ax;
		const dy = y - st.ay;
		const a = dx * st.ux + dy * st.uy;
		if (a < -st.hx || a > st.hx) return 0;
		const l = dy * st.ux - dx * st.uy;
		if (l < -HALF || l > HALF) return 0;
		let d = HALF - Math.abs(l);
		if (!st.openOuter) {
			const outer = st.hx - a;
			if (outer < d) d = outer;
		}
		return d > 0 ? d : 0;
	}

	function cellAt(x, y) {
		let i = (x / S) | 0;
		if (i < 0) i = 0;
		else if (i > N - 1) i = N - 1;
		let j = (y / S) | 0;
		if (j < 0) j = 0;
		else if (j > N - 1) j = N - 1;
		return j * N + i;
	}

	function airClearance(layout, x, y) {
		if (x < 0 || x > SIZE || y < -POUR || y > SIZE + POUR) return 0;
		return valveClearance(layout.valves[cellAt(x, y)], x, y);
	}

	// Clearance is the largest disc that fits at a point, evaluated against the
	// unions actually present rather than each primitive separately:
	// - inside the rotor, the passages clipped by the rim, plus the seam opening
	//   that removes the rim wall where a port covers the housing channel;
	// - outside the rotor, the housing corridor, whose mouth is walled by the rim
	//   wherever the seam is shut.
	// The opening is an aperture, so it limits a grain to its current width and a
	// shut seam leaves nothing to pass through.
	function valveClearance(v, x, y) {
		const lx = x - v.cx;
		const ly = y - v.cy;
		const r2 = lx * lx + ly * ly;
		const r = Math.sqrt(r2);
		let best = 0;
		if (r < RV) {
			const room = RV - r;
			const px = lx * v.cos + ly * v.sin;
			const py = ly * v.cos - lx * v.sin;
			const prims = v.prims;
			for (let k = 0; k < prims.length; k++) {
				const pr = prims[k];
				let d;
				if (pr.t === T_TUBE) d = tubeDepth(pr, px, py);
				else if (pr.t === T_ARC) d = arcDepth(pr, px, py);
				else d = pr.r - Math.sqrt(px * px + py * py);
				if (d > best) best = d;
			}
			let rim = room;
			for (let s = 0; s < 4; s++) {
				const seam = v.seam[s];
				if (seam <= 0) continue;
				const a = lx * DX[s] + ly * DY[s];
				if (a <= 0) continue;
				const gap = seam - Math.abs(ly * DX[s] - lx * DY[s]);
				if (gap <= 0) continue;
				const jaw = Math.sqrt(room * room + gap * gap);
				if (jaw > rim) rim = jaw;
			}
			if (best > rim) best = rim;
			return best;
		}
		// Outside the rotor only the corridor grants air; the rim jaws at ±seam
		// bound any disc centered near a narrowing or shut aperture continuously.
		const rimOut = r - RV;
		for (let s = 0; s < 4; s++) {
			const ux = DX[s];
			const uy = DY[s];
			const face = stripDepth(v.strips[s], lx, ly);
			if (face <= 0) continue;
			const gap = v.seam[s] - Math.abs(ly * ux - lx * uy);
			const jaw = gap > 0 ? Math.sqrt(rimOut * rimOut + gap * gap) : rimOut;
			const clear = jaw < face ? jaw : face;
			if (clear > best) best = clear;
		}
		return best;
	}

	function isAir(layout, x, y, radius) {
		return airClearance(layout, x, y) >= radius - 1e-7;
	}

	// Contact-limited travel: sample at half the particle radius, then bisect the
	// first blocked sample so nothing can tunnel across a closed seam.
	function sweep(layout, x0, y0, x1, y1, radius, out) {
		out.x = x0;
		out.y = y0;
		out.hit = false;
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len < 1e-9) return out;
		const step = Math.min(radius * 0.5, 2);
		const count = Math.ceil(len / step);
		const need = radius - 1e-7;
		let last = 0;
		for (let k = 1; k <= count; k++) {
			const t = k / count;
			if (airClearance(layout, x0 + dx * t, y0 + dy * t) >= need) {
				last = t;
				continue;
			}
			let lo = last;
			let hi = t;
			for (let n = 0; n < 10; n++) {
				const m = (lo + hi) * 0.5;
				if (airClearance(layout, x0 + dx * m, y0 + dy * m) >= need) lo = m;
				else hi = m;
			}
			out.x = x0 + dx * lo;
			out.y = y0 + dy * lo;
			out.hit = true;
			return out;
		}
		out.x = x1;
		out.y = y1;
		return out;
	}

	const probe = {
		x: 0,
		y: 0,
		bx: 0,
		by: 0,
		best: 0,
		ax: 0,
		ay: 0,
		alt: 0,
		tx: 0,
		ty: 0,
		r: 0,
		v: null,
		layout: null,
		inside: false,
	};

	// Air is connected along the cavity, not across metal. A projection that has
	// to cross a wall to reach its candidate has left the grain's corridor and the
	// hop would be a teleport, however short it looks.
	function reachable(layout, x0, y0, x1, y1, radius) {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len < 1e-9) return true;
		const count = Math.ceil(len / Math.max(radius * 0.5, 0.5));
		const need = radius - 1e-6;
		for (let k = 1; k <= count; k++) {
			const t = k / count;
			if (airClearance(layout, x0 + dx * t, y0 + dy * t) < need) return false;
		}
		return true;
	}

	function probeConsider(x, y) {
		const dx = x - probe.tx;
		const dy = y - probe.ty;
		const d2 = dx * dx + dy * dy;
		if (d2 >= probe.best && d2 >= probe.alt) return;
		// Recovery never crosses the rim: the two sides of the rotor are different
		// cavities, and a candidate on the far side is only reachable through metal.
		const rx = x - probe.v.cx;
		const ry = y - probe.v.cy;
		if ((rx * rx + ry * ry < RV * RV) !== probe.inside) return;
		// Verify against the same field the solver queries, bounds included: a
		// projection onto a pour spout can land outside the air region, and a
		// candidate there is not air even though its cell still reports some.
		if (airClearance(probe.layout, x, y) < probe.r - 1e-6) return;
		if (!reachable(probe.layout, probe.tx, probe.ty, x, y, probe.r)) {
			// A grain the closing rim has just caught starts inside metal, so no
			// straight line out of it can stay in air; keep the nearest verified
			// air as the fallback rather than stranding the grain.
			if (d2 < probe.alt) {
				probe.alt = d2;
				probe.ax = x;
				probe.ay = y;
			}
			return;
		}
		if (d2 >= probe.best) return;
		probe.best = d2;
		probe.bx = x;
		probe.by = y;
	}

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	// Nearest verified air position for a grain pushed into metal by a turning
	// rotor. Candidates are the clamp projections onto each eroded primitive, so
	// every candidate is air by construction and only then distance-ranked. This
	// keeps recovery deterministic and never invents a position, unlike a ring
	// search that can fail and leave a grain to be recycled.
	function nearestAir(layout, x, y, radius, out) {
		out.x = x;
		out.y = y;
		out.dist = 0;
		out.found = false;
		if (x < 0 || x > SIZE || y < -POUR || y > SIZE + POUR) return out;
		const v = layout.valves[cellAt(x, y)];
		if (valveClearance(v, x, y) >= radius - 1e-6) {
			out.found = true;
			return out;
		}
		probe.tx = x;
		probe.ty = y;
		probe.r = radius;
		probe.v = v;
		probe.layout = layout;
		probe.inside = (x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy) < RV * RV;
		probe.best = Infinity;
		probe.alt = Infinity;
		probe.bx = x;
		probe.by = y;
		probe.ax = x;
		probe.ay = y;
		// Shallow cases first: climb the clearance gradient, which is the minimal
		// nudge that leaves a grain in contact. A primitive projection would hop it
		// to that primitive's own eroded centre line, which for a grain grazing a
		// wall is a jump of most of a radius, and for a grain in a pocket mouth it
		// can be most of the passage. The climb is capped so it can never double as
		// a teleport; deeper cases fall through to the projections below.
		let wx = x;
		let wy = y;
		let climbed = 0;
		for (let n = 0; n < 4 && climbed < radius * 2.5; n++) {
			const level = airClearance(layout, wx, wy);
			if (level >= radius - 1e-6) break;
			const e = 0.5;
			const gx = airClearance(layout, wx + e, wy) - airClearance(layout, wx - e, wy);
			const gy = airClearance(layout, wx, wy + e) - airClearance(layout, wx, wy - e);
			const len = Math.sqrt(gx * gx + gy * gy);
			if (len < 1e-9) break;
			const step = radius - level + 0.05;
			wx += (gx / len) * step;
			wy += (gy / len) * step;
			climbed += step;
			if (wx < 0 || wx > SIZE || wy < -POUR || wy > SIZE + POUR) break;
			probeConsider(wx, wy);
		}
		const band = HALF - radius;
		if (band > 0) {
			const px = x - v.cx;
			const py = y - v.cy;
			const cos = v.cos;
			const sin = v.sin;
			const lx = px * cos + py * sin;
			const ly = py * cos - px * sin;
			for (let k = 0; k < v.prims.length; k++) {
				const pr = v.prims[k];
				if (pr.t === T_TUBE) {
					const a = (lx - pr.cx) * pr.ux + (ly - pr.cy) * pr.uy;
					const l = (ly - pr.cy) * pr.ux - (lx - pr.cx) * pr.uy;
					const lo = -pr.hx + (pr.openLo ? 0 : radius);
					const hi = pr.hx - (pr.openHi ? 0 : radius);
					if (hi < lo) continue;
					const ca = clamp(a, lo, hi);
					const cl = clamp(l, -band, band);
					const ox = pr.cx + pr.ux * ca - pr.uy * cl;
					const oy = pr.cy + pr.uy * ca + pr.ux * cl;
					probeConsider(v.cx + ox * cos - oy * sin, v.cy + ox * sin + oy * cos);
				} else if (pr.t === T_ARC) {
					const dx = lx - pr.cx;
					const dy = ly - pr.cy;
					const reach = Math.sqrt(dx * dx + dy * dy);
					const rlo = pr.r - band;
					const rhi = pr.r + band;
					const rr = clamp(reach, rlo, rhi);
					const spread = Math.atan2(band, Math.max(pr.r, 1e-6));
					let da = Math.atan2(dy, dx) - pr.mid;
					while (da > Math.PI) da -= TAU;
					while (da < -Math.PI) da += TAU;
					const lim = pr.span / 2 + spread;
					const ca = pr.mid + clamp(da, -lim, lim);
					const ox = pr.cx + Math.cos(ca) * rr;
					const oy = pr.cy + Math.sin(ca) * rr;
					probeConsider(v.cx + ox * cos - oy * sin, v.cy + ox * sin + oy * cos);
				} else {
					const reach = Math.sqrt(lx * lx + ly * ly);
					const rr = Math.min(reach, Math.max(0, pr.r - radius));
					const scale = reach > 1e-9 ? rr / reach : 0;
					const ox = lx * scale;
					const oy = ly * scale;
					probeConsider(v.cx + ox * cos - oy * sin, v.cy + ox * sin + oy * cos);
				}
			}
			// The rim and the seam caps limit clearance by a circle and by a plane,
			// so inside the rotor the way out is one radial or lateral shift. The
			// primitive projections cannot see either, and the gradient is flat
			// across a cap, which leaves a grain at a closing mouth stranded.
			if (probe.inside) {
				const reach = Math.sqrt((x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy)) || 1;
				const inward = RV - radius;
				if (inward > 0) probeConsider(v.cx + ((x - v.cx) / reach) * inward, v.cy + ((y - v.cy) / reach) * inward);
				for (let s = 0; s < 4; s++) {
					const seam = v.seam[s];
					if (seam <= 0) continue;
					const ux = DX[s];
					const uy = DY[s];
					const lat = (y - v.cy) * ux - (x - v.cx) * uy;
					const gap = seam - Math.abs(lat);
					if (gap > 0 && gap < radius) {
						const jawIn = RV - Math.sqrt(radius * radius - gap * gap) - 1e-4;
						if (jawIn > 0) probeConsider(v.cx + ((x - v.cx) / reach) * jawIn, v.cy + ((y - v.cy) / reach) * jawIn);
					}
					if (seam <= radius) continue;
					const slack = seam - radius;
					if (Math.abs(lat) <= slack) continue;
					const shift = Math.sign(lat) * (Math.abs(lat) - slack);
					probeConsider(x + shift * uy, y - shift * ux);
				}
			}
			for (let s = 0; s < 4; s++) {
				const st = v.strips[s];
				const mid = (st.inner + st.far) / 2;
				const a = (px - st.ax) * DX[s] + (py - st.ay) * DY[s];
				const l = (py - st.ay) * DX[s] - (px - st.ax) * DY[s];
				let ca = clamp(a, -st.hx, st.hx - (st.openOuter ? 0 : radius));
				const cl = clamp(l, -band, band);
				// Beside a shut or narrowing seam the rim jaws bound the mouth, so the
				// corridor projection stops far enough out to clear both jaws.
				const gap = v.seam[s] - Math.abs(cl);
				if (gap < radius) {
					const push = (gap > 0 ? Math.sqrt(radius * radius - gap * gap) : radius) + 1e-4;
					if (mid + ca < RV + push) ca = RV + push - mid;
				}
				const ox = st.ax + DX[s] * ca - DY[s] * cl;
				const oy = st.ay + DY[s] * ca + DX[s] * cl;
				probeConsider(v.cx + ox, v.cy + oy);
			}
		}
		if (probe.best === Infinity) {
			if (probe.alt === Infinity) return out;
			out.x = probe.ax;
			out.y = probe.ay;
			out.dist = Math.sqrt(probe.alt);
			out.found = true;
			return out;
		}
		out.x = probe.bx;
		out.y = probe.by;
		out.dist = Math.sqrt(probe.best);
		out.found = true;
		return out;
	}

	function describe(v) {
		return {
			kind: v.kind,
			ports: v.ports.slice(),
			prims: v.prims.map((pr) => Object.assign({}, pr)),
			chamberR: v.chamberR,
		};
	}

	return {
		N,
		S,
		SIZE,
		RV,
		HALF,
		WALL,
		EDGE,
		ELBOW,
		POUR,
		TAU,
		HALF_PI,
		DX,
		DY,
		PORT_ANG,
		T_TUBE,
		T_ARC,
		T_DISK,
		SOLID_SHAPES,
		HOLLOW_SHAPES,
		hashUnit,
		rng,
		createLayout,
		drainReach,
		makeValve,
		setAngle,
		cellAt,
		valveClearance,
		airClearance,
		isAir,
		sweep,
		nearestAir,
		buildPath,
		describe,
	};
})();
if (typeof module !== "undefined") module.exports = ValveGeometry;
