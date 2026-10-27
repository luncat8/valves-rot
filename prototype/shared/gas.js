// Grid gas. The band cells outside the 10x10 field are constant-pressure mouths:
// an open high mouth holds 1, an open low mouth holds 0, and a sealed mouth is
// just another air pocket with no reservoir behind it. Interior air cells exchange
// a conserved amount of air through open faces. Metal and shut rims have zero
// conductance, so the valves decide which pockets fill, drain or stay sealed.
//
// One backward-Euler diffusion step runs on the 30 Hz mask clock, solved with a
// preconditioned conjugate gradient on the real face-conductance graph. Pressure therefore starts at the mouths and
// travels as a front instead of being recomputed as one global distance ratio. A
// connected region without any mouth keeps the air it had: there is nowhere for
// that air to go. Gas velocity is the local face flux, and grains feel empirical
// drag and lift from it; packed cells lower the conductance and pay back the
// impulse they deliver. The field is a normalized relative pressure, not a
// calibrated thermodynamic gas.
const ValveGas = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const INL = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");

	// One grid column per valve column keeps a band cell's owner unambiguous.
	const CELL = 6;
	const NX = Math.ceil(G.SIZE / CELL);
	const NY = Math.ceil((G.SIZE + 2 * G.POUR) / CELL);
	const COUNT = NX * NY;

	const L = 1;
	const R = 2;
	const U = 4;
	const D = 8;

	const MASK_DT = 1 / 30;
	const ANGLE_EPS = 0.02;
	const AIR_MIN = 0.75;
	// A corridor cell is about half a cell free, so it counts as fully open and a
	// tight mouth a fraction of that. Openness is both the cell volume fraction
	// and the limit on how fast its faces can carry air.
	const OPEN_CLEAR = CELL * 0.5;
	const OPEN_MIN = 0.12;
	const FILL_COST = 3;
	const GRAIN_CAPACITY = 1.5;
	// Implicit step per mask tick. In cell units this spreads the front about
	// sqrt(DIFFUSE_DT) cells per tick; the implicit solve stays stable at any dt.
	const DIFFUSE_DT = 2400;
	// The graph is a maze of long corridors, so plain relaxation crawls. A Jacobi-
	// preconditioned conjugate gradient solves the same sparse system in tens of
	// sweeps and needs no relaxation factor tuned to the layout.
	const PCG_STEADY_ITERS = 700;
	const PCG_STEP_ITERS = 400;
	const PCG_TOL = 1e-6;
	// A field that no longer moves skips the solve until the mask or a mouth does.
	const SETTLE_TOL = 2e-4;
	// Face flux to gas speed, px/s per unit pressure difference across a cell.
	const FLOW_SCALE = 30000;
	const GAS_MAX = 460;
	const DRAG = 1.35;
	const LIFT = 1.5;
	const RELAX = 0.2;
	const CELL_MASS = 1;

	function index(x, y) {
		let gx = (x / CELL) | 0;
		let gy = ((y + G.POUR) / CELL) | 0;
		if (gx < 0) gx = 0;
		else if (gx >= NX) gx = NX - 1;
		if (gy < 0) gy = 0;
		else if (gy >= NY) gy = NY - 1;
		return gy * NX + gx;
	}

	// Preallocated graph state shared by the live field and the 1-D fixtures.
	function blankField(nx, ny, cell) {
		const size = nx * ny;
		const f = {
			kind: "grid",
			cell,
			nx,
			ny,
			size,
			count: size,
			p: new Float32Array(size),
			prev: new Float32Array(size),
			pTarget: new Float32Array(size),
			air: new Uint8Array(size),
			face: new Uint8Array(size),
			pin: new Uint8Array(size),
			open: new Float32Array(size),
			fill: new Float32Array(size),
			fillNow: new Uint16Array(size),
			cond: new Float32Array(size),
			gL: new Float32Array(size),
			gR: new Float32Array(size),
			gU: new Float32Array(size),
			gD: new Float32Array(size),
			gsum: new Float32Array(size),
			nL: new Int32Array(size),
			nR: new Int32Array(size),
			nU: new Int32Array(size),
			nD: new Int32Array(size),
			comp: new Int32Array(size),
			compPinned: new Uint8Array(size),
			active: new Uint8Array(size),
			queue: new Int32Array(size),
			list: new Int32Array(size),
			gx: new Float32Array(size),
			gy: new Float32Array(size),
			pcgX: new Float64Array(size),
			pcgR: new Float64Array(size),
			pcgZ: new Float64Array(size),
			pcgD: new Float64Array(size),
			pcgQ: new Float64Array(size),
			pcgB: new Float64Array(size),
			pcgDiag: new Float64Array(size),
			unknowns: new Int32Array(size),
			solves: 0,
			pcgIters: 0,
			pcgResidual: 0,
			mean: 0,
			flow: 0,
			delta: 0,
		};
		f.comp.fill(-1);
		return f;
	}

	// Neighbour indices point at the cell itself when a face is shut, so the SOR
	// and flux kernels never branch on grid edges or index -1.
	function link(f) {
		const nx = f.nx;
		const ny = f.ny;
		for (let k = 0; k < f.size; k++) {
			const gx = k % nx;
			const gy = (k / nx) | 0;
			const face = f.face[k];
			f.nL[k] = gx > 0 && face & L ? k - 1 : k;
			f.nR[k] = gx + 1 < nx && face & R ? k + 1 : k;
			f.nU[k] = gy > 0 && face & U ? k - nx : k;
			f.nD[k] = gy + 1 < ny && face & D ? k + nx : k;
		}
	}

	// Flood fill the open-face graph. Only a component containing a mouth can
	// exchange air with a reservoir; the rest hold whatever pressure they have.
	function components(f) {
		const comp = f.comp;
		const list = f.list;
		const queue = f.queue;
		const count = f.count;
		comp.fill(-1);
		let groups = 0;
		for (let n = 0; n < count; n++) {
			const root = list[n];
			if (comp[root] >= 0) continue;
			let head = 0;
			let tail = 0;
			queue[tail++] = root;
			comp[root] = groups;
			while (head < tail) {
				const k = queue[head++];
				let nb = f.nL[k];
				if (nb !== k && comp[nb] < 0) {
					comp[nb] = groups;
					queue[tail++] = nb;
				}
				nb = f.nR[k];
				if (nb !== k && comp[nb] < 0) {
					comp[nb] = groups;
					queue[tail++] = nb;
				}
				nb = f.nU[k];
				if (nb !== k && comp[nb] < 0) {
					comp[nb] = groups;
					queue[tail++] = nb;
				}
				nb = f.nD[k];
				if (nb !== k && comp[nb] < 0) {
					comp[nb] = groups;
					queue[tail++] = nb;
				}
			}
			groups++;
		}
		f.compCount = groups;
	}

	// Harmonic mean of the two cell permeabilities: a narrow seam or a packed
	// cell is the resistance of the whole link, not of just one side of it.
	function conductance(f) {
		const list = f.list;
		const cond = f.cond;
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			cond[k] = f.open[k] / (1 + FILL_COST * f.fill[k]);
		}
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			const c = cond[k];
			const l = f.nL[k];
			const r = f.nR[k];
			const u = f.nU[k];
			const d = f.nD[k];
			const gl = l === k ? 0 : 2 * c * cond[l] / (c + cond[l]);
			const gr = r === k ? 0 : 2 * c * cond[r] / (c + cond[r]);
			const gu = u === k ? 0 : 2 * c * cond[u] / (c + cond[u]);
			const gd = d === k ? 0 : 2 * c * cond[d] / (c + cond[d]);
			f.gL[k] = gl;
			f.gR[k] = gr;
			f.gU[k] = gu;
			f.gD[k] = gd;
			f.gsum[k] = gl + gr + gu + gd;
		}
	}

	function markActive(f) {
		const pinned = f.compPinned;
		const comp = f.comp;
		const list = f.list;
		pinned.fill(0, 0, f.compCount);
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			if (f.pin[k]) pinned[comp[k]] = 1;
		}
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			f.active[k] = pinned[comp[k]];
		}
	}

	function pinValues(f, out) {
		const list = f.list;
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			if (f.pin[k]) out[k] = f.pin[k] === 2 ? 1 : 0;
		}
	}

	// Sparse operator on the unknown (unpinned) cells of every component that
	// has a mouth. Pinned mouths are Dirichlet values: they contribute to the
	// right-hand side and are zero in the unknown vector. w scales the graph
	// Laplacian; mass is 1 for a backward-Euler step and 0 for steady state.
	//   A x = (mass + w*gsum) x - w * sum(g * x_neighbour)
	// Only the compact unknown list is visited, and the dot product with `dotv`
	// is fused into the same pass.
	function matvec(f, src, dst, w, mass, nu, dotv) {
		const uk = f.unknowns;
		const gL = f.gL;
		const gR = f.gR;
		const gU = f.gU;
		const gD = f.gD;
		const nL = f.nL;
		const nR = f.nR;
		const nU = f.nU;
		const nD = f.nD;
		const gsum = f.gsum;
		let dot = 0;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			const s = gL[k] * src[nL[k]] + gR[k] * src[nR[k]] + gU[k] * src[nU[k]] + gD[k] * src[nD[k]];
			const v = (mass + w * gsum[k]) * src[k] - w * s;
			dst[k] = v;
			if (dotv) dot += dotv[k] * v;
		}
		return dot;
	}

	function pinnedValue(f, k) {
		return f.pin[k] === 2 ? 1 : 0;
	}

	function solve(f, out, w, mass, limit) {
		const list = f.list;
		const active = f.active;
		const pin = f.pin;
		const uk = f.unknowns;
		const x = f.pcgX;
		const r = f.pcgR;
		const z = f.pcgZ;
		const d = f.pcgD;
		const q = f.pcgQ;
		const b = f.pcgB;
		const diag = f.pcgDiag;
		const prev = f.prev;
		let nu = 0;
		let scale = 1;
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			x[k] = r[k] = z[k] = d[k] = q[k] = b[k] = diag[k] = 0;
			if (!active[k] || pin[k] || f.gsum[k] <= 0) continue;
			uk[nu++] = k;
			diag[k] = mass + w * f.gsum[k];
			x[k] = out[k];
			let bp = 0;
			const l = f.nL[k];
			const rr = f.nR[k];
			const u = f.nU[k];
			const dd = f.nD[k];
			if (l !== k && pin[l]) bp += f.gL[k] * pinnedValue(f, l);
			if (rr !== k && pin[rr]) bp += f.gR[k] * pinnedValue(f, rr);
			if (u !== k && pin[u]) bp += f.gU[k] * pinnedValue(f, u);
			if (dd !== k && pin[dd]) bp += f.gD[k] * pinnedValue(f, dd);
			b[k] = mass * prev[k] + w * bp;
			const ab = Math.abs(b[k]);
			if (ab > scale) scale = ab;
		}
		matvec(f, x, q, w, mass, nu, null);
		const tol = PCG_TOL * scale;
		let rz = 0;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			r[k] = b[k] - q[k];
			z[k] = r[k] / diag[k];
			d[k] = z[k];
			rz += r[k] * z[k];
		}
		let iters = 0;
		let residual = 0;
		if (rz > 0) {
			for (; iters < limit; iters++) {
				const dq = matvec(f, d, q, w, mass, nu, d);
				if (!(dq > 0)) break;
				const alpha = rz / dq;
				residual = 0;
				for (let i = 0; i < nu; i++) {
					const k = uk[i];
					x[k] += alpha * d[k];
					r[k] -= alpha * q[k];
					const ar = Math.abs(r[k]);
					if (ar > residual) residual = ar;
				}
				if (residual < tol) break;
				let rzNext = 0;
				for (let i = 0; i < nu; i++) {
					const k = uk[i];
					z[k] = r[k] / diag[k];
					rzNext += r[k] * z[k];
				}
				const beta = rzNext / rz;
				rz = rzNext;
				for (let i = 0; i < nu; i++) {
					const k = uk[i];
					d[k] = z[k] + beta * d[k];
				}
			}
		}
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			if (pin[k]) {
				out[k] = pinnedValue(f, k);
				continue;
			}
			if (!active[k] || diag[k] <= 0) continue;
			const v = x[k];
			out[k] = v < 0 ? 0 : v > 1 ? 1 : v;
		}
		f.pcgIters = iters;
		f.pcgResidual = residual;
		f.solves++;
	}

	// Steady harmonic pressure: pins are constant-pressure boundaries, every
	// other cell is the conductance-weighted mean of its open neighbours. Used
	// for the startup field, a snap, and hypothetical mouth sets of a quest.
	function steady(f, out) {
		out.set(f.p);
		markActive(f);
		solve(f, out, 1, 0, PCG_STEADY_ITERS);
		return out;
	}

	// One backward-Euler step: cap*(p - p0) = dt * sum(g * (p_neighbour - p)).
	// Pins supply or absorb the difference; components without a mouth hold the
	// air they already have. No allocations inside the solve.
	function diffuse(f, dt) {
		f.prev.set(f.p);
		markActive(f);
		solve(f, f.p, dt, 1, PCG_STEP_ITERS);
		let delta = 0;
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			if (!f.active[k] || f.pin[k]) continue;
			const d = Math.abs(f.p[k] - f.prev[k]);
			if (d > delta) delta = d;
		}
		f.delta = delta;
		return delta;
	}

	// Endpoints must also be air cells. Sampling the whole link catches a thin
	// rim that lies between the midpoint and either endpoint.
	function openFace(layout, x, y, dx, dy) {
		const hx = dx * 0.5;
		const hy = dy * 0.5;
		const middle = G.airClearance(layout, x + hx, y + hy);
		if (middle < AIR_MIN) return false;
		const length = Math.max(Math.abs(dx), Math.abs(dy));
		if (middle >= AIR_MIN + length * 0.5 || length <= AIR_MIN) return true;
		return openFace(layout, x, y, hx, hy) && openFace(layout, x + hx, y + hy, hx, hy);
	}

	function create(sim) {
		const gas = blankField(NX, NY, CELL);
		gas.band = new Int32Array(COUNT);
		gas.bandSide = new Uint8Array(COUNT);
		gas.bandColumn = new Uint8Array(COUNT);
		gas.bandCount = 0;
		gas.pins = 0;
		gas.sources = 0;
		gas.vents = 0;
		gas.angles = new Float64Array(G.N * G.N);
		gas.inletVersion = -1;
		gas.clock = 0;
		gas.maskClock = 0;
		gas.updates = 0;
		gas.rebuilds = 0;
		gas.drags = 0;
		gas.gain = 0;
		gas.settled = false;
		rebuild(sim, gas);
		applyPins(sim, gas);
		steady(gas, gas.p);
		markActive(gas);
		velocity(gas, true);
		measure(gas);
		gas.settled = true;
		return gas;
	}

	// Air mask, open faces, band cells and the conductance graph. Metal cells are
	// not in the list at all: no potential, no velocity, no leak through a wall.
	function rebuild(sim, gas) {
		const layout = sim.layout;
		const air = gas.air;
		const face = gas.face;
		air.fill(0);
		face.fill(0);
		gas.count = 0;
		for (let gy = 0; gy < NY; gy++) {
			const y = gy * CELL + CELL / 2 - G.POUR;
			for (let gx = 0; gx < NX; gx++) {
				const clear = G.airClearance(layout, gx * CELL + CELL / 2, y);
				if (clear < AIR_MIN) continue;
				const k = gy * NX + gx;
				air[k] = 1;
				gas.list[gas.count++] = k;
				const open = clear / OPEN_CLEAR;
				gas.open[k] = open > 1 ? 1 : open < OPEN_MIN ? OPEN_MIN : open;
			}
		}
		const list = gas.list;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const gx = k % NX;
			const gy = (k / NX) | 0;
			const x = gx * CELL + CELL / 2;
			const y = gy * CELL + CELL / 2 - G.POUR;
			if (gx + 1 < NX && air[k + 1] && openFace(layout, x, y, CELL, 0)) {
				face[k] |= R;
				face[k + 1] |= L;
			}
			if (gy + 1 < NY && air[k + NX] && openFace(layout, x, y, 0, CELL)) {
				face[k] |= D;
				face[k + NX] |= U;
			}
		}
		// Band cells are the reservoir mouths, outside the 10x10 field. Every air
		// cell there is pinned by its column's inlet while that inlet is open.
		gas.bandCount = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const y = ((k / NX) | 0) * CELL + CELL / 2 - G.POUR;
			if (y < 0) addBand(gas, k, 0);
			else if (y > G.SIZE) addBand(gas, k, 1);
		}
		link(gas);
		components(gas);
		conductance(gas);
		const valves = layout.valves;
		for (let k = 0; k < valves.length; k++) gas.angles[k] = valves[k].angle;
		gas.settled = false;
		gas.rebuilds++;
	}

	function addBand(gas, k, side) {
		if (gas.bandCount >= gas.band.length) return;
		const column = (((k % NX) * CELL + CELL / 2) / G.S) | 0;
		gas.band[gas.bandCount] = k;
		gas.bandSide[gas.bandCount] = side;
		gas.bandColumn[gas.bandCount] = column < 0 ? 0 : column > G.N - 1 ? G.N - 1 : column;
		gas.bandCount++;
	}

	// An open mouth is a constant-pressure boundary at 1 (high) or 0 (low). A
	// sealed mouth is neither a source nor a sink; its band cells are ordinary
	// trapped air. One open mouth is enough: the field is always defined.
	function applyPins(sim, gas) {
		const inlets = sim.inlets;
		gas.pin.fill(0);
		gas.pins = 0;
		gas.sources = 0;
		gas.vents = 0;
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const inlet = gas.bandSide[n] * G.N + gas.bandColumn[n];
			if (!inlets.open[inlet]) continue;
			const high = inlets.level[inlet] === INL.HIGH;
			gas.pin[k] = high ? 2 : 1;
			gas.p[k] = high ? 1 : 0;
			if (high) gas.sources++;
			else gas.vents++;
			gas.pins++;
		}
		gas.inletVersion = inlets.version;
		gas.settled = false;
		markActive(gas);
	}

	// Occupancy throttles the face conductance. Returns whether the graph moved,
	// so a settled machine can skip both the rebuild and the solve.
	function measureCost(sim, gas) {
		const now = gas.fillNow;
		const fill = gas.fill;
		const air = gas.air;
		for (let n = 0; n < gas.count; n++) now[gas.list[n]] = 0;
		for (let k = 0; k < sim.count; k++) {
			const idx = index(sim.x[k], sim.y[k]);
			if (air[idx]) now[idx]++;
		}
		let changed = false;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			let f = now[k] / GRAIN_CAPACITY;
			if (f > 1) f = 1;
			if (fill[k] === f) continue;
			fill[k] = f;
			changed = true;
		}
		if (changed) conductance(gas);
		return changed;
	}

	// Cell-centred velocity from the actual face fluxes. A sealed component has no
	// reservoir and therefore no through-flow; its cells carry no gas velocity.
	function velocity(gas, snap) {
		const p = gas.p;
		const list = gas.list;
		const open = gas.open;
		const active = gas.active;
		const gx = gas.gx;
		const gy = gas.gy;
		const gL = gas.gL;
		const gR = gas.gR;
		const gU = gas.gU;
		const gD = gas.gD;
		const nL = gas.nL;
		const nR = gas.nR;
		const nU = gas.nU;
		const nD = gas.nD;
		let flow = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			let vx = 0;
			let vy = 0;
			if (active[k]) {
				const c = p[k];
				const scale = FLOW_SCALE / open[k] * 0.5;
				vx = (gL[k] * (p[nL[k]] - c) + gR[k] * (c - p[nR[k]])) * scale;
				vy = (gU[k] * (p[nU[k]] - c) + gD[k] * (c - p[nD[k]])) * scale;
				const speed = Math.sqrt(vx * vx + vy * vy);
				if (speed > GAS_MAX) {
					const s = GAS_MAX / speed;
					vx *= s;
					vy *= s;
				}
			}
			if (snap) {
				gx[k] = vx;
				gy[k] = vy;
			} else {
				gx[k] += (vx - gx[k]) * RELAX;
				gy[k] += (vy - gy[k]) * RELAX;
			}
			flow += Math.sqrt(gx[k] * gx[k] + gy[k] * gy[k]);
		}
		gas.flow = gas.count ? flow / gas.count : 0;
	}

	function measure(gas) {
		let sum = 0;
		for (let n = 0; n < gas.count; n++) sum += gas.p[gas.list[n]];
		gas.mean = gas.count ? sum / gas.count : 0;
	}

	function update(sim, gas, snap, force) {
		const changed = measureCost(sim, gas);
		if (snap) {
			steady(gas, gas.p);
			gas.settled = true;
		} else if (force || changed || !gas.settled) {
			gas.settled = diffuse(gas, DIFFUSE_DT) < SETTLE_TOL;
		}
		velocity(gas, snap);
		measure(gas);
		gas.updates++;
	}

	function maybeSolve(sim, gas) {
		if (gas.clock - gas.maskClock < MASK_DT) return;
		const valves = sim.layout.valves;
		let moved = false;
		for (let k = 0; k < valves.length; k++) {
			if (Math.abs(valves[k].angle - gas.angles[k]) > ANGLE_EPS) {
				moved = true;
				break;
			}
		}
		if (moved) {
			rebuild(sim, gas);
			applyPins(sim, gas);
		}
		update(sim, gas, false, moved);
		gas.maskClock = gas.clock;
	}

	// A grain resting on a wall or a rim sits in a cell whose centre is metal, so
	// the nearest air cell stands in for the flow around it.
	function sampleCell(gas, x, y) {
		const k = index(x, y);
		if (gas.air[k]) return k;
		const gx = k % NX;
		const gy = (k / NX) | 0;
		let best = -1;
		let bestD = Infinity;
		for (let oy = gy - 1; oy <= gy + 1; oy++) {
			if (oy < 0 || oy >= NY) continue;
			for (let ox = gx - 1; ox <= gx + 1; ox++) {
				if (ox < 0 || ox >= NX) continue;
				const j = oy * NX + ox;
				if (!gas.air[j]) continue;
				const dx = (ox + 0.5) * CELL - x;
				const dy = (oy + 0.5) * CELL - (y + G.POUR);
				const d = dx * dx + dy * dy;
				if (d >= bestD) continue;
				bestD = d;
				best = j;
			}
		}
		return best;
	}

	// Drag toward the gas and lift along its velocity, both scaled by air force.
	// The cell pays that impulse back; a dense pile damps the flow through it.
	// Grains in the reservoir bands are left alone so a full spout still feeds.
	function drag(sim, gas, h) {
		const force = sim.airForce;
		if (force <= 0 || !gas.pins) return;
		const dragRate = DRAG * force;
		const lift = LIFT * force;
		const invMass = 1 / CELL_MASS;
		const gx = gas.gx;
		const gy = gas.gy;
		const pin = gas.pin;
		for (let k = 0; k < sim.count; k++) {
			const y = sim.y[k];
			if (y < 0 || y > G.SIZE) continue;
			const idx = sampleCell(gas, sim.x[k], y);
			if (idx < 0) continue;
			const gvx = gx[idx];
			const gvy = gy[idx];
			if (gvx === 0 && gvy === 0) continue;
			const jx = (dragRate * (gvx - sim.vx[k]) + lift * gvx) * h;
			const jy = (dragRate * (gvy - sim.vy[k]) + lift * gvy) * h;
			sim.vx[k] += jx;
			sim.vy[k] += jy;
			if (!pin[idx]) {
				gx[idx] -= jx * invMass;
				gy[idx] -= jy * invMass;
				const sp = Math.sqrt(gx[idx] * gx[idx] + gy[idx] * gy[idx]);
				if (sp > GAS_MAX) {
					const s = GAS_MAX / sp;
					gx[idx] *= s;
					gy[idx] *= s;
				}
			}
			gas.gain += (jx < 0 ? -jx : jx) + (jy < 0 ? -jy : jy);
			gas.drags++;
		}
	}

	// Solve the standard quest mouth set into pTarget: the whole favourable band
	// is open, with one far mouth of the other band as the reference. Probing the
	// same recipe the bots use means a fitted threshold is actually reachable.
	// The caller restores the live field with refresh(sim, true).
	function probeMouths(sim, wantHigh, column) {
		const gas = sim.pressure;
		if (!gas || gas.kind !== "grid" || !gas.count) return false;
		const far = column <= G.N / 2 ? G.N - 1 : 0;
		const farSide = wantHigh ? 0 : 1;
		gas.pin.fill(0);
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const favourable = (gas.bandSide[n] === 1) === wantHigh;
			if (!favourable && !(gas.bandSide[n] === farSide && gas.bandColumn[n] === far)) continue;
			gas.pin[k] = wantHigh ? (favourable ? 2 : 1) : (favourable ? 1 : 2);
		}
		steady(gas, gas.pTarget);
		applyPins(sim, gas, true);
		return gas.pins > 0;
	}

	// A mouth or rotor change re-pins and rebuilds at once, but only `snap` moves
	// the pressure. Otherwise the next mask tick carries the front from the new
	// boundary, so one click never repaints the whole machine.
	function refresh(sim, snap) {
		const gas = sim.pressure;
		rebuild(sim, gas);
		applyPins(sim, gas);
		if (snap) steady(gas, gas.p);
		gas.settled = !!snap;
		velocity(gas, !!snap);
		measure(gas);
		gas.updates++;
		gas.maskClock = gas.clock;
	}

	// Only the boundary changed: no mask rebuild, no implicit step.
	function repin(sim) {
		const gas = sim.pressure;
		applyPins(sim, gas);
		velocity(gas, false);
		measure(gas);
		gas.updates++;
	}

	function settle(sim, dt) {
		const gas = sim.pressure;
		gas.clock += dt;
		maybeSolve(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas, false, true);
		}
	}

	function step(sim, h) {
		const gas = sim.pressure;
		gas.clock += h;
		maybeSolve(sim, gas);
		if (gas.inletVersion !== sim.inlets.version) {
			applyPins(sim, gas);
			update(sim, gas, false, true);
		}
		drag(sim, gas, h);
	}

	return {
		create,
		step,
		settle,
		refresh,
		repin,
		probeMouths,
		index,
		sampleCell,
		openFace,
		blankField,
		link,
		components,
		conductance,
		markActive,
		steady,
		diffuse,
		CELL,
		NX,
		NY,
		AIR_MIN,
		DRAG,
		LIFT,
		FLOW_SCALE,
		GAS_MAX,
		RELAX,
		DIFFUSE_DT,
		CELL_MASS,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveGas;
