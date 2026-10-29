// Pipe gas. The air network is not a world grid that has to be re-cut against
// turned rotors. Every valve owns two static pieces of geometry:
//   - its rotor passages, divided into cells in the rotor's own unrotated pixel
//     frame (so a turn carries the air in those cells with the passage);
//   - four short casing corridors to the tile edges, fixed in tile coordinates.
// Rotor clearance is sampled once here; a turn only rotates those cells into
// the casing frame and recomputes the short seam links that cross the rim.
// Both kinds of link are checked with a small clearance disc, so no edge can
// cut through metal, and a narrowing seam throttles its links continuously.
//
// Turning valves refresh their seam links on each fixed simulation tick. Still
// fields diffuse at 30 Hz, while boundary and topology changes start a step on
// the next tick. Open mouths outside the field are Dirichlet cells; isolated
// components redistribute their air without exchanging it with other pockets.
// Pressure is a normalized relative quantity, velocity is the actual
// face flux plus the rigid swirl of a turning rotor (no inertia state), and
// packed cells throttle the links through them. A regular texel grid remains
// only as the display, grain-coupling and public index()/p/air projection.
const ValveGas = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const INL = typeof ValveInlets !== "undefined" ? ValveInlets : require("./inlets.js");

	// The world display stays a regular texel grid for the overlay, the grain
	// coupling and the public index()/p/air API. The solver state lives on the
	// per-valve network and is projected onto these texels.
	const CELL = 6;
	const NX = Math.ceil(G.SIZE / CELL);
	const NY = Math.ceil((G.SIZE + 2 * G.POUR) / CELL);
	const COUNT = NX * NY;

	// Rotor-local grid: 8 px cells over the disc, in the prims' own frame.
	const RS = 8;
	const RN = Math.ceil(2 * G.RV / RS);
	const RSLOTS = RN * RN;
	const RSPAN = RN * RS;
	const RHALF = RSPAN / 2;
	// Casing corridors: short pipes, a few lanes across, aligned with the tile.
	const LANES = 3;
	const MAXSEG = 3;
	const CSLOTS = 4 * MAXSEG * LANES;
	const SLOTS = RSLOTS + CSLOTS;
	const NODES = G.N * G.N * SLOTS;
	const LANE_W = 2 * G.HALF / LANES;
	const INNER = G.RV - 1;
	const SEG = 12;
	const BASE = 8;
	const NB = 16;

	const L = 1;
	const R = 2;
	const U = 4;
	const D = 8;

	const MASK_DT = 1 / 30;
	const ANGLE_EPS = 1e-9;
	const AIR_MIN = 0.75;
	const OPEN_MIN = 0.12;
	const FILL_COST = 3;
	const GRAIN_CAPACITY = 1.5;
	// Diffusion strength over one mask interval. Transient sub-tick solves scale
	// this by elapsed time, so fronts begin immediately without changing the
	// modeled diffusion rate per second.
	const DIFFUSE_DT = 1200;
	const PCG_STEADY_ITERS = 700;
	// Live steady solves start from the distance-ratio field, so a dozen sweeps
	// polish it; the full 700-iteration budget belongs to hand-built 1-D fields.
	const PCG_LIVE_STEADY_ITERS = 12;
	const PCG_STEP_ITERS = 16;
	const PCG_TOL = 1e-6;
	const SETTLE_TOL = 2e-4;
	const FLOW_SCALE = 22000;
	const GAS_MAX = 460;
	const DRAG = 1.35;
	const LIFT = 1.5;
	const SWIRL_REACH = CELL * 1.5;
	const RELAX = 0.2;
	const CELL_MASS = 1;
	const DIAGONAL = 0.45;

	const sweepOut = { x: 0, y: 0, hit: false };
	const DX = G.DX;
	const DY = G.DY;

	function index(x, y) {
		let gx = (x / CELL) | 0;
		let gy = ((y + G.POUR) / CELL) | 0;
		if (gx < 0) gx = 0;
		else if (gx >= NX) gx = NX - 1;
		if (gy < 0) gy = 0;
		else if (gy >= NY) gy = NY - 1;
		return gy * NX + gx;
	}

	function casingNode(t, s, seg, lane) {
		return t * SLOTS + RSLOTS + s * MAXSEG * LANES + seg * LANES + lane;
	}

	// Graph state shared by the live pipe network and hand-built 1-D fields.
	// A field is only ever a node graph: the display texels are one node per cell
	// with no edges of their own, and a fixture chain is a row of nodes whose four
	// faces come from `link`. So the `face`/`apR`/`apD` stencil exists only for the
	// 4-slot fields a fixture builds.
	// Node indices are monotonic in the list, which is what IC(0) needs: an edge
	// to a lower index belongs to the forward substitution, a higher one to the
	// backward sweep.
	function blankField(nx, ny, cell, slots) {
		const size = nx * ny;
		const nb = slots === undefined ? 4 : slots;
		const stencil = nb === 4;
		const f = {
			kind: "grid",
			cell,
			nx,
			ny,
			size,
			count: size,
			slots: nb,
			p: new Float32Array(size),
			prev: new Float32Array(size),
			work: new Float32Array(size),
			pTarget: new Float32Array(size),
			air: new Uint8Array(size),
			face: stencil ? new Uint8Array(size) : null,
			pin: new Uint8Array(size),
			open: new Float32Array(size),
			fill: new Float32Array(size),
			fillNow: new Uint16Array(size),
			cond: new Float32Array(size),
			apR: stencil ? new Float32Array(size).fill(1) : null,
			apD: stencil ? new Float32Array(size).fill(1) : null,
			gsum: new Float32Array(size),
			nbr: nb ? new Int32Array(size * nb) : null,
			nbrCount: nb ? new Uint8Array(size) : null,
			baseG: nb ? new Float32Array(size * nb) : null,
			gw: nb ? new Float32Array(size * nb) : null,
			comp: new Int32Array(size),
			compPinned: new Uint8Array(size),
			compDynamic: new Uint8Array(size),
			compMin: new Float32Array(size),
			compMax: new Float32Array(size),
			compDelta: new Float64Array(size),
			compTotal: new Float64Array(size),
			compSize: new Uint32Array(size),
			active: new Uint8Array(size),
			queue: new Int32Array(size),
			list: new Int32Array(size),
			gx: new Float32Array(size),
			gy: new Float32Array(size),
			tvx: new Float32Array(size),
			tvy: new Float32Array(size),
			wx: new Float32Array(size),
			wy: new Float32Array(size),
			owner: new Int32Array(size),
			pcgX: new Float64Array(size),
			pcgR: new Float64Array(size),
			pcgZ: new Float64Array(size),
			pcgD: new Float64Array(size),
			pcgQ: new Float64Array(size),
			pcgB: new Float64Array(size),
			pcgDiag: new Float64Array(size),
			pcgIC: new Float64Array(size),
			pcgInvIC: new Float64Array(size),
			pcgStart: new Int32Array(size + 1),
			pcgSplit: new Int32Array(size),
			pcgNbr: nb ? new Int32Array(size * nb) : null,
			pcgWeight: nb ? new Float32Array(size * nb) : null,
			pcgFactor: nb ? new Float64Array(size * nb) : null,
			unknowns: new Int32Array(size),
			solves: 0,
			pcgIters: 0,
			pcgResidual: 0,
			mean: 0,
			flow: 0,
			delta: 0,
			compCount: 0,
		};
		f.comp.fill(-1);
		return f;
	}

	// A grid field's 5-point stencil is one special case of the node graph.
	// Fixtures build 1-D chains this way; the live network fills `nbr` itself.
	function link(f) {
		const nx = f.nx;
		const ny = f.ny;
		const nb = f.slots;
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			const gx = k % nx;
			const gy = (k / nx) | 0;
			const face = f.face[k];
			const l = gx > 0 && face & L ? k - 1 : k;
			const r = gx + 1 < nx && face & R ? k + 1 : k;
			const u = gy > 0 && face & U ? k - nx : k;
			const d = gy + 1 < ny && face & D ? k + nx : k;
			let m = 0;
			let e = k * nb;
			if (l !== k) {
				f.nbr[e] = l;
				f.baseG[e] = f.apR[l];
				e++;
				m++;
			}
			if (r !== k) {
				f.nbr[e] = r;
				f.baseG[e] = f.apR[k];
				e++;
				m++;
			}
			if (u !== k) {
				f.nbr[e] = u;
				f.baseG[e] = f.apD[u];
				e++;
				m++;
			}
			if (d !== k) {
				f.nbr[e] = d;
				f.baseG[e] = f.apD[k];
				m++;
			}
			f.nbrCount[k] = m;
		}
	}

	function conductance(f) {
		const list = f.list;
		const cond = f.cond;
		const nb = f.slots;
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			cond[k] = f.open[k] / (1 + FILL_COST * f.fill[k]);
		}
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			const ca = cond[k];
			let sum = 0;
			const e0 = k * nb;
			for (let m = 0; m < f.nbrCount[k]; m++) {
				const e = e0 + m;
				const cb = cond[f.nbr[e]];
				const g = f.baseG[e] * (ca + cb > 0 ? 2 * ca * cb / (ca + cb) : 0);
				f.gw[e] = g;
				sum += g;
			}
			f.gsum[k] = sum;
		}
	}

	// The conductance of one link, for a fixture that wants to compare an edge
	// against the analytical resistance of the same chain.
	function syncConductance(f) {
		if (!f.dirty) return;
		f.dirty = false;
		conductance(f);
	}

	function faceConductance(f, a, b) {
		const e0 = a * f.slots;
		for (let m = 0; m < f.nbrCount[a]; m++) {
			if (f.nbr[e0 + m] === b) return f.gw[e0 + m];
		}
		return 0;
	}

	// Flood fill the open-edge graph. A component containing a mouth can
	// exchange air with a reservoir; other components conserve their own air.
	function components(f) {
		const comp = f.comp;
		const list = f.list;
		const queue = f.queue;
		const nb = f.slots;
		comp.fill(-1);
		let groups = 0;
		for (let n = 0; n < f.count; n++) {
			const root = list[n];
			if (comp[root] >= 0) continue;
			let head = 0;
			let tail = 0;
			queue[tail++] = root;
			comp[root] = groups;
			while (head < tail) {
				const k = queue[head++];
				const e0 = k * nb;
				for (let m = 0; m < f.nbrCount[k]; m++) {
					const e = e0 + m;
					if (f.baseG[e] <= 0) continue;
					const j = f.nbr[e];
					if (comp[j] >= 0) continue;
					comp[j] = groups;
					queue[tail++] = j;
				}
			}
			groups++;
		}
		f.compCount = groups;
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

	// Uniform components need no work, but a newly joined pocket with different
	// pressures must diffuse even if it has no reservoir boundary.
	function markDynamic(f) {
		const low = f.compMin;
		const high = f.compMax;
		const dynamic = f.compDynamic;
		low.fill(1, 0, f.compCount);
		high.fill(0, 0, f.compCount);
		dynamic.fill(0, 0, f.compCount);
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			const c = f.comp[k];
			const p = f.pin[k] ? pinnedValue(f, k) : f.prev[k];
			if (p < low[c]) low[c] = p;
			if (p > high[c]) high[c] = p;
		}
		let count = 0;
		for (let c = 0; c < f.compCount; c++) {
			if (high[c] - low[c] <= 1e-7) continue;
			dynamic[c] = 1;
			count++;
		}
		return count;
	}

	// Iteration limits and clamping can otherwise create or remove air from an
	// isolated component. Correct its residual in proportion to available slack,
	// preserving both its previous sum and the pressure bounds.
	function conserveIsolated(f, out) {
		const delta = f.compDelta;
		const total = f.compTotal;
		const size = f.compSize;
		delta.fill(0, 0, f.compCount);
		total.fill(0, 0, f.compCount);
		size.fill(0, 0, f.compCount);
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			const c = f.comp[k];
			if (f.active[k] || !f.compDynamic[c]) continue;
			delta[c] += f.prev[k] - out[k];
			total[c] += out[k];
			size[c]++;
		}
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			const c = f.comp[k];
			if (f.active[k] || !f.compDynamic[c] || delta[c] === 0) continue;
			const p = out[k];
			const slack = delta[c] > 0 ? size[c] - total[c] : total[c];
			if (slack <= 0) continue;
			out[k] = p + delta[c] * (delta[c] > 0 ? 1 - p : p) / slack;
		}
	}

	function pinnedValue(f, k) {
		return f.pin[k] === 2 ? 1 : 0;
	}

	// Compact the unknown-to-unknown edges once per solve. The two IC sweeps
	// then need neither pin/order checks nor divisions on every iteration.
	function prepareOperator(f, w, nu) {
		const uk = f.unknowns;
		const diag = f.pcgDiag;
		const inv = f.pcgInvIC;
		const start = f.pcgStart;
		const split = f.pcgSplit;
		const adj = f.pcgNbr;
		const weight = f.pcgWeight;
		const factor = f.pcgFactor;
		const nbr = f.nbr;
		const gw = f.gw;
		const nb = f.slots;
		for (let i = 0; i < nu; i++) inv[uk[i]] = 1 / f.pcgIC[uk[i]];
		let used = 0;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			const e0 = k * nb;
			const end = e0 + f.nbrCount[k];
			start[i] = used;
			for (let e = e0; e < end; e++) {
				const j = nbr[e];
				if (j >= k || diag[j] <= 0 || gw[e] <= 0) continue;
				adj[used] = j;
				weight[used] = gw[e];
				factor[used++] = w * gw[e] * inv[j];
			}
			split[i] = used;
			for (let e = e0; e < end; e++) {
				const j = nbr[e];
				if (j <= k || diag[j] <= 0 || gw[e] <= 0) continue;
				adj[used] = j;
				weight[used] = gw[e];
				factor[used++] = w * gw[e] * inv[k];
			}
		}
		start[nu] = used;
	}

	// Pinned mouths are eliminated and contribute through the right-hand side.
	function matvec(f, src, dst, w, nu, dotv) {
		const uk = f.unknowns;
		const start = f.pcgStart;
		const nbr = f.pcgNbr;
		const weight = f.pcgWeight;
		const diag = f.pcgDiag;
		let dot = 0;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			let s = 0;
			for (let e = start[i]; e < start[i + 1]; e++) s += weight[e] * src[nbr[e]];
			const v = diag[k] * src[k] - w * s;
			dst[k] = v;
			if (dotv) dot += dotv[k] * v;
		}
		return dot;
	}

	// IC(0) is exact along a 1-D pipe, so a front does not crawl one cell per
	// iteration. The compact edges are ordered into lower and upper sweeps.
	function applyIC(f, src, dst, nu) {
		const uk = f.unknowns;
		const start = f.pcgStart;
		const split = f.pcgSplit;
		const nbr = f.pcgNbr;
		const factor = f.pcgFactor;
		const inv = f.pcgInvIC;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			let s = src[k];
			for (let e = start[i]; e < split[i]; e++) s += factor[e] * dst[nbr[e]];
			dst[k] = s * inv[k];
		}
		for (let i = nu - 1; i >= 0; i--) {
			const k = uk[i];
			let s = dst[k];
			for (let e = split[i]; e < start[i + 1]; e++) s += factor[e] * dst[nbr[e]];
			dst[k] = s * inv[k];
		}
	}

	function solve(f, out, w, mass, limit) {
		const list = f.list;
		const active = f.active;
		const pin = f.pin;
		const uk = f.unknowns;
		const nbr = f.nbr;
		const gw = f.gw;
		const nb = f.slots;
		const x = f.pcgX;
		const r = f.pcgR;
		const z = f.pcgZ;
		const d = f.pcgD;
		const q = f.pcgQ;
		const b = f.pcgB;
		const diag = f.pcgDiag;
		const prev = f.prev;
		if (mass > 0 && !markDynamic(f)) {
			for (let n = 0; n < f.count; n++) {
				const k = list[n];
				if (pin[k]) out[k] = pinnedValue(f, k);
			}
			f.pcgIters = 0;
			f.pcgResidual = 0;
			return;
		}
		let nu = 0;
		let scale = 1;
		for (let n = 0; n < f.count; n++) {
			const k = list[n];
			diag[k] = 0;
			if (pin[k] || f.gsum[k] <= 0) continue;
			if (mass > 0 ? !f.compDynamic[f.comp[k]] : !active[k]) continue;
			uk[nu++] = k;
			diag[k] = mass + w * f.gsum[k];
			x[k] = out[k];
			let bp = 0;
			let pivot = diag[k];
			const e0 = k * nb;
			for (let m = 0; m < f.nbrCount[k]; m++) {
				const e = e0 + m;
				const j = nbr[e];
				if (gw[e] <= 0) continue;
				if (pin[j]) {
					bp += gw[e] * pinnedValue(f, j);
					continue;
				}
				if (j < k && diag[j] > 0) {
					const c = w * gw[e] / f.pcgIC[j];
					pivot -= c * c;
				}
			}
			const floor = diag[k] * 1e-10;
			f.pcgIC[k] = Math.sqrt(pivot > floor ? pivot : floor);
			b[k] = mass * prev[k] + w * bp;
			const ab = Math.abs(b[k]);
			if (ab > scale) scale = ab;
		}
		prepareOperator(f, w, nu);
		matvec(f, x, q, w, nu, null);
		const tol = PCG_TOL * scale;
		let rz = 0;
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			r[k] = b[k] - q[k];
		}
		applyIC(f, r, z, nu);
		for (let i = 0; i < nu; i++) {
			const k = uk[i];
			d[k] = z[k];
			rz += r[k] * z[k];
		}
		let iters = 0;
		let residual = 0;
		if (rz > 0) {
			for (; iters < limit; iters++) {
				const dq = matvec(f, d, q, w, nu, d);
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
				applyIC(f, r, z, nu);
				let rzNext = 0;
				for (let i = 0; i < nu; i++) {
					const k = uk[i];
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
			if (diag[k] <= 0) continue;
			const v = x[k];
			out[k] = v < 0 ? 0 : v > 1 ? 1 : v;
		}
		if (mass > 0) conserveIsolated(f, out);
		f.pcgIters = iters;
		f.pcgResidual = residual;
		f.solves++;
	}

	// ---- live field: network state -> display texels ------------------------

	function projectP(gas, src, dst) {
		const map = gas.map;
		const list = gas.list;
		let mean = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const p = src[map[k]];
			dst[k] = p;
			if (dst === gas.p) mean += p;
		}
		if (dst === gas.p) gas.mean = gas.count ? mean / gas.count : 0;
	}

	// Steady harmonic pressure on the live network. `out` is a display texel
	// buffer: either the live field or a quest's hypothetical target.
	// A distance ratio from the two pin polarities is the exact harmonic field
	// on a single pipe and a good warm start on a branched one. Two graph BFS
	// passes cost far less than the low-frequency PCG sweeps they replace.
	function bfsDistance(net, dist, pinValue) {
		const INF = 1 << 29;
		const queue = net.queue;
		const nb = NB;
		dist.fill(INF);
		let head = 0;
		let tail = 0;
		for (let n = 0; n < net.count; n++) {
			const k = net.list[n];
			if (net.pin[k] !== pinValue) continue;
			dist[k] = 0;
			queue[tail++] = k;
		}
		while (head < tail) {
			const k = queue[head++];
			const d = dist[k] + 1;
			const e0 = k * nb;
			for (let m = 0; m < net.nbrCount[k]; m++) {
				const e = e0 + m;
				if (net.gw[e] <= 0) continue;
				const j = net.nbr[e];
				if (dist[j] <= d) continue;
				dist[j] = d;
				queue[tail++] = j;
			}
		}
	}

	function warmHarmonic(net, out) {
		const INF = 1 << 29;
		bfsDistance(net, net.distH, 2);
		bfsDistance(net, net.distL, 1);
		for (let n = 0; n < net.count; n++) {
			const k = net.list[n];
			const h = net.distH[k];
			const l = net.distL[k];
			if (h >= INF && l >= INF) {
				out[k] = net.p[k];
				continue;
			}
			if (h >= INF) out[k] = 0;
			else if (l >= INF) out[k] = 1;
			else out[k] = l / (h + l);
		}
	}

	// Steady harmonic pressure on the live network. `out` is a display texel
	// buffer: either the live field or a quest's hypothetical target.
	function steadyLive(gas, out, quick) {
		const net = gas.net;
		// Startup and snaps only need the field's shape: the next ticks finish
		// the relaxation. A hypothetical mouth set used as a measurement gets
		// a fully converged reference unless the caller asks for a quick fit.
		const limit = out === gas.p || quick ? PCG_LIVE_STEADY_ITERS : PCG_STEADY_ITERS;
		syncConductance(net);
		markActive(net);
		warmHarmonic(net, net.work);
		solve(net, net.work, 1, 0, limit);
		if (out === gas.p) {
			net.p.set(net.work);
			projectP(gas, net.p, gas.p);
		} else projectP(gas, net.work, out);
		gas.solves = net.solves;
		gas.pcgIters = net.pcgIters;
		gas.pcgResidual = net.pcgResidual;
		return out;
	}

	function diffuseLive(gas, dt) {
		const net = gas.net;
		syncConductance(net);
		net.prev.set(net.p);
		solve(net, net.p, dt, 1, PCG_STEP_ITERS);
		projectP(gas, net.p, gas.p);
		let delta = 0;
		for (let n = 0; n < net.count; n++) {
			const k = net.list[n];
			if (net.pin[k]) continue;
			const d = Math.abs(net.p[k] - net.prev[k]);
			if (d > delta) delta = d;
		}
		gas.delta = delta;
		gas.solves = net.solves;
		gas.pcgIters = net.pcgIters;
		gas.pcgResidual = net.pcgResidual;
		return delta;
	}

	function steady(f, out, quick) {
		if (f.net) return steadyLive(f, out, quick);
		out.set(f.p);
		markActive(f);
		solve(f, out, 1, 0, PCG_STEADY_ITERS);
		return out;
	}

	function diffuse(f, dt) {
		if (f.net) return diffuseLive(f, dt);
		f.prev.set(f.p);
		markActive(f);
		solve(f, f.p, dt, 1, PCG_STEP_ITERS);
		let delta = 0;
		for (let n = 0; n < f.count; n++) {
			const k = f.list[n];
			if (f.pin[k]) continue;
			const d = Math.abs(f.p[k] - f.prev[k]);
			if (d > delta) delta = d;
		}
		f.delta = delta;
		return delta;
	}

	// A geometry-only link test used by the validation scripts, independent of
	// the runtime graph. `G.sweep` samples at a fraction of AIR_MIN.
	function openFace(layout, x, y, dx, dy) {
		G.sweep(layout, x, y, x + dx, y + dy, AIR_MIN, sweepOut);
		return !sweepOut.hit;
	}

	// ---- network construction ----------------------------------------------

	function makeNet() {
		const net = blankField(NODES, 1, RS, NB);
		net.kind = "net";
		net.count = 0;
		net.edges = 0;
		// Static edges occupy the first slots of every node; only the seam
		// edges after staticCount are rewritten when a rotor turns.
		net.staticCount = new Uint8Array(NODES);
		// Seam links and grain occupancy both move the edge weights; the graph
		// recomputes them at most once per tick, whichever caller needs them.
		net.dirty = false;
		net.distH = new Int32Array(NODES);
		net.distL = new Int32Array(NODES);
		return net;
	}

	function create(sim) {
		const gas = blankField(NX, NY, CELL, 0);
		gas.kind = "grid";
		gas.net = makeNet();
		gas.map = new Int32Array(COUNT).fill(-1);
		gas.tile = new Int32Array(COUNT);
		gas.rimFlag = new Uint8Array(COUNT);
		gas.staticNode = new Int32Array(COUNT).fill(-1);
		gas.rimStart = new Int32Array(G.N * G.N + 1);
		gas.rimCells = new Int32Array(COUNT);
		gas.rimDX = new Float32Array(COUNT);
		gas.rimDY = new Float32Array(COUNT);
		gas.moved = new Int32Array(G.N * G.N);
		gas.listPos = new Int32Array(COUNT).fill(-1);
		gas.staticAir = new Int32Array(COUNT);
		gas.staticAirCount = 0;
		gas.displayReady = false;
		gas.band = new Int32Array(COUNT);
		gas.bandSide = new Uint8Array(COUNT);
		gas.bandColumn = new Uint8Array(COUNT);
		gas.bandCount = 0;
		gas.segCount = new Uint8Array(G.N * G.N * 4);
		gas.segLen = new Float32Array(G.N * G.N * 4);
		gas.far = new Float32Array(G.N * G.N * 4);
		gas.valveRef = new Array(G.N * G.N).fill(null);
		gas.layoutRef = null;
		gas.angles = new Float64Array(G.N * G.N);
		gas.pins = 0;
		gas.sources = 0;
		gas.vents = 0;
		gas.inletVersion = -1;
		gas.clock = 0;
		gas.maskClock = 0;
		gas.solveClock = 0;
		gas.updates = 0;
		gas.rebuilds = 0;
		gas.drags = 0;
		gas.gain = 0;
		gas.settled = false;
		gas.fastPending = false;
		rebuild(sim, gas);
		applyPins(sim, gas);
		steady(gas, gas.p);
		velocity(sim, gas, true);
		return gas;
	}

	// Node templates: rotor cells from the unrotated prims, casing cells from
	// the static strips. Both are rebuilt only when a valve object is replaced;
	// a turn never re-samples clearance.
	function buildStructure(sim, gas) {
		const net = gas.net;
		const valves = sim.layout.valves;
		let count = 0;
		for (let t = 0; t < valves.length; t++) {
			const v = valves[t];
			const base = t * SLOTS;
			for (let slot = 0; slot < SLOTS; slot++) {
				const k = base + slot;
				net.air[k] = 0;
				net.open[k] = 0;
				net.owner[k] = t;
			}
			for (let iy = 0; iy < RN; iy++) {
				const py = (iy + 0.5) * RS - RHALF;
				for (let ix = 0; ix < RN; ix++) {
					const px = (ix + 0.5) * RS - RHALF;
					const clear = G.passageClearance(v, px, py);
					if (clear < AIR_MIN) continue;
					const k = base + iy * RN + ix;
					net.air[k] = 1;
					const open = clear / G.HALF;
					net.open[k] = open > 1 ? 1 : open < OPEN_MIN ? OPEN_MIN : open;
					net.wx[k] = v.cx + px * v.cos - py * v.sin;
					net.wy[k] = v.cy + px * v.sin + py * v.cos;
				}
			}
			for (let s = 0; s < 4; s++) {
				const v4 = t * 4 + s;
				const spout = v.strips[s].spout;
				const far = spout ? G.S / 2 + 0.5 + G.POUR : G.S / 2 + 0.5;
				const segments = Math.max(1, Math.round((far - INNER) / SEG));
				gas.segCount[v4] = segments;
				gas.segLen[v4] = (far - INNER) / segments;
				gas.far[v4] = far;
				for (let seg = 0; seg < segments; seg++) {
					const a = INNER + (seg + 0.5) * gas.segLen[v4];
					for (let lane = 0; lane < LANES; lane++) {
						const lat = (lane + 0.5) * LANE_W - G.HALF;
						const k = casingNode(t, s, seg, lane);
						const clear = G.HALF - Math.abs(lat);
						if (clear < AIR_MIN) continue;
						if (DX[s]) {
							net.wx[k] = v.cx + DX[s] * a;
							net.wy[k] = v.cy + lat;
						} else {
							net.wx[k] = v.cx + lat;
							net.wy[k] = v.cy + DY[s] * a;
						}
						net.air[k] = 1;
						const open = clear / G.HALF;
						net.open[k] = open > 1 ? 1 : open < OPEN_MIN ? OPEN_MIN : open;
					}
				}
			}
		}
		for (let k = 0; k < NODES; k++) if (net.air[k]) net.list[count++] = k;
		net.count = count;
	}

	function updateRotation(sim, gas, moved, count) {
		const net = gas.net;
		const valves = sim.layout.valves;
		for (let n = 0; n < count; n++) {
			const t = moved[n];
			const v = valves[t];
			const base = t * SLOTS;
			for (let iy = 0; iy < RN; iy++) {
				const py = (iy + 0.5) * RS - RHALF;
				for (let ix = 0; ix < RN; ix++) {
					const k = base + iy * RN + ix;
					if (!net.air[k]) continue;
					const px = (ix + 0.5) * RS - RHALF;
					net.wx[k] = v.cx + px * v.cos - py * v.sin;
					net.wy[k] = v.cy + px * v.sin + py * v.cos;
				}
			}
		}
	}

	function addEdge(net, a, b, geo) {
		if (geo <= 0 || net.nbrCount[a] >= NB || net.nbrCount[b] >= NB) return;
		net.dirty = true;
		let e = a * NB + net.nbrCount[a]++;
		net.nbr[e] = b;
		net.baseG[e] = geo;
		e = b * NB + net.nbrCount[b]++;
		net.nbr[e] = a;
		net.baseG[e] = geo;
		net.edges++;
	}

	function harmonicGeo(net, a, b, factor) {
		const dx = net.wx[b] - net.wx[a];
		const dy = net.wy[b] - net.wy[a];
		const dist = Math.sqrt(dx * dx + dy * dy);
		return dist > 0.01 ? BASE / dist * factor : factor;
	}

	// Rotor-local cell containing an inverse-rotated rim point. A lane can land
	// between cells, so the nearest air cell in the 3x3 block still carries it.
	// A seam edge is only legal if a small disc can travel between the two
	// cell centres. Sampling the local valve clearance is cheaper than a
	// machine-wide sweep and, unlike an analytical chord, also rejects links
	// that would cut across a curved rotor passage.
	// Rotor neighbours are sampled in the unrotated prims frame, so the check
	// is valid for every angle and only runs when a valve is replaced.
	function localEdgeOpen(v, ax, ay, bx, by) {
		const dx = bx - ax;
		const dy = by - ay;
		const steps = Math.max(2, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (AIR_MIN * 0.75)));
		const need = AIR_MIN - 1e-7;
		for (let n = 1; n < steps; n++) {
			const f = n / steps;
			if (G.passageClearance(v, ax + dx * f, ay + dy * f) < need) return false;
		}
		return true;
	}

	function seamPathOpen(v, ax, ay, bx, by) {
		const dx = bx - ax;
		const dy = by - ay;
		const steps = Math.max(2, Math.ceil(Math.sqrt(dx * dx + dy * dy) / (AIR_MIN * 0.5)));
		const need = AIR_MIN - 1e-7;
		for (let n = 1; n < steps; n++) {
			const f = n / steps;
			if (G.valveClearance(v, v.cx + ax + dx * f, v.cy + ay + dy * f) < need) return false;
		}
		return true;
	}

	// Seam edges are the only angle-dependent part of the graph. Each rotor
	// cell near the rim is rotated into the static casing frame; if it faces an
	// open chord and a small disc can travel to the corridor cell, the two are
	// linked. Clearance is sampled once per rotor in buildStructure, never here.
	function seamEdgesFor(sim, gas, t) {
		const net = gas.net;
		const v = sim.layout.valves[t];
		const base = t * SLOTS;
		const near = G.RV - 1.6 * RS;
		const near2 = near * near;
		for (let iy = 0; iy < RN; iy++) {
			const py = (iy + 0.5) * RS - RHALF;
			for (let ix = 0; ix < RN; ix++) {
				const px = (ix + 0.5) * RS - RHALF;
				const k = base + iy * RN + ix;
				if (!net.air[k] || px * px + py * py < near2) continue;
				// Rotate the local cell centre into the casing frame: this is the
				// only place where valve cells meet static pipe cells.
				const ux = px * v.cos - py * v.sin;
				const uy = px * v.sin + py * v.cos;
				for (let s = 0; s < 4; s++) {
					const a = DX[s] ? DX[s] * ux : DY[s] * uy;
					if (a < near) continue;
					const lat = DX[s] ? uy : ux;
					const half = v.seam[s] - AIR_MIN;
					if (half <= 0 || Math.abs(lat) >= half) continue;
					let lane = ((lat + G.HALF) / LANE_W) | 0;
					if (lane < 0) lane = 0;
					else if (lane >= LANES) lane = LANES - 1;
					const casing = casingNode(t, s, 0, lane);
					if (!net.air[casing]) continue;
					if (!seamPathOpen(v, ux, uy, net.wx[casing] - v.cx, net.wy[casing] - v.cy)) continue;
					const aperture = (half - Math.abs(lat)) / LANE_W;
					addEdge(net, k, casing, harmonicGeo(net, k, casing, aperture < 1 ? aperture : 1));
				}
			}
		}
	}

	// A valve's seam edges live in the node slots after its static ones.
	function refreshSeams(sim, gas, moved, count) {
		const net = gas.net;
		for (let n = 0; n < count; n++) {
			const t = moved[n];
			const base = t * SLOTS;
			for (let slot = 0; slot < SLOTS; slot++) net.nbrCount[base + slot] = net.staticCount[base + slot];
			seamEdgesFor(sim, gas, t);
		}
	}

	function staticEdges(sim, gas) {
		const net = gas.net;
		const valves = sim.layout.valves;
		for (let t = 0; t < G.N * G.N; t++) {
			const v = valves[t];
			// Rotor passages: axial and diagonal neighbours join the same pipe,
			// but only when a disc can travel between their centres in the
			// rotor's own frame. Curved elbows otherwise leak through metal.
			for (let iy = 0; iy < RN; iy++) {
				const py = (iy + 0.5) * RS - RHALF;
				for (let ix = 0; ix < RN; ix++) {
					const px = (ix + 0.5) * RS - RHALF;
					const a = t * SLOTS + iy * RN + ix;
					if (!net.air[a]) continue;
					if (ix + 1 < RN) {
						const b = a + 1;
						if (net.air[b] && localEdgeOpen(v, px, py, px + RS, py)) addEdge(net, a, b, BASE / RS);
					}
					if (iy + 1 < RN) {
						const b = a + RN;
						if (net.air[b] && localEdgeOpen(v, px, py, px, py + RS)) addEdge(net, a, b, BASE / RS);
						if (ix > 0 && net.air[b - 1] && localEdgeOpen(v, px, py, px - RS, py + RS)) {
							addEdge(net, a, b - 1, BASE / (RS * 1.4142) * DIAGONAL * 1.4142);
						}
						if (ix + 1 < RN && net.air[b + 1] && localEdgeOpen(v, px, py, px + RS, py + RS)) {
							addEdge(net, a, b + 1, BASE / (RS * 1.4142) * DIAGONAL * 1.4142);
						}
					}
				}
			}
			// Casing corridors: along the pipe and across its lanes.
			for (let s = 0; s < 4; s++) {
				const segments = gas.segCount[t * 4 + s];
				for (let seg = 0; seg < segments; seg++) {
					for (let lane = 0; lane < LANES; lane++) {
						const a = casingNode(t, s, seg, lane);
						if (!net.air[a]) continue;
						if (lane + 1 < LANES) {
							const b = casingNode(t, s, seg, lane + 1);
							if (net.air[b]) addEdge(net, a, b, harmonicGeo(net, a, b, 1));
						}
						if (seg + 1 < segments) {
							const b = casingNode(t, s, seg + 1, lane);
							if (net.air[b]) addEdge(net, a, b, harmonicGeo(net, a, b, 1));
						}
					}
				}
			}
			// Neighbouring tiles share the far end of their corridor (E and S
			// only, so each shared edge is added once).
			const i = t % G.N;
			const j = (t / G.N) | 0;
			for (let s = 0; s < 2; s++) {
				const ni = i + DX[s];
				const nj = j + DY[s];
				if (ni < 0 || ni >= G.N || nj < 0 || nj >= G.N) continue;
				const nt = nj * G.N + ni;
				const back = (s + 2) & 3;
				const segA = gas.segCount[t * 4 + s] - 1;
				const segB = gas.segCount[nt * 4 + back] - 1;
				if (segA < 0 || segB < 0) continue;
				for (let lane = 0; lane < LANES; lane++) {
					const a = casingNode(t, s, segA, lane);
					const b = casingNode(nt, back, segB, lane);
					if (!net.air[a] || !net.air[b]) continue;
					addEdge(net, a, b, harmonicGeo(net, a, b, 1));
				}
			}
		}
	}

	function buildStaticEdges(sim, gas) {
		const net = gas.net;
		net.nbrCount.fill(0);
		net.edges = 0;
		net.dirty = true;
		staticEdges(sim, gas);
		net.staticCount.set(net.nbrCount);
		for (let t = 0; t < G.N * G.N; t++) seamEdgesFor(sim, gas, t);
	}

	// Texels outside every rotor rim map to static casing cells; the lookup is
	// done once. Texels inside a rim are resolved per turn in the rotor's frame.
	function casingNodeAt(gas, t, dx, dy) {
		const net = gas.net;
		for (let s = 0; s < 4; s++) {
			const a = DX[s] ? dx * DX[s] : dy * DY[s];
			const lat = DX[s] ? dy : dx;
			if (a < INNER || a >= gas.far[t * 4 + s] || Math.abs(lat) >= G.HALF) continue;
			const segCount = gas.segCount[t * 4 + s];
			let seg = ((a - INNER) / gas.segLen[t * 4 + s]) | 0;
			if (seg < 0) seg = 0;
			else if (seg >= segCount) seg = segCount - 1;
			let lane = ((lat + G.HALF) / LANE_W) | 0;
			if (lane < 0) lane = 0;
			else if (lane >= LANES) lane = LANES - 1;
			const k = casingNode(t, s, seg, lane);
			if (net.air[k]) return k;
		}
		return -1;
	}

	function precomputeDisplay(sim, gas) {
		const valves = sim.layout.valves;
		const counts = new Int32Array(G.N * G.N);
		gas.bandCount = 0;
		gas.staticAirCount = 0;
		for (let gy = 0; gy < NY; gy++) {
			const y = gy * CELL + CELL / 2 - G.POUR;
			for (let gx = 0; gx < NX; gx++) {
				const k = gy * NX + gx;
				const x = gx * CELL + CELL / 2;
				const t = G.cellAt(x, y);
				const v = valves[t];
				const dx = x - v.cx;
				const dy = y - v.cy;
				gas.tile[k] = t;
				if (dx * dx + dy * dy < G.RV * G.RV) {
					gas.rimFlag[k] = 1;
					gas.rimDX[k] = dx;
					gas.rimDY[k] = dy;
					gas.map[k] = -1;
					counts[t]++;
					continue;
				}
				gas.rimFlag[k] = 0;
				const node = casingNodeAt(gas, t, dx, dy);
				gas.staticNode[k] = node;
				gas.map[k] = node;
				gas.air[k] = node >= 0 ? 1 : 0;
				if (node < 0) continue;
				gas.staticAir[gas.staticAirCount++] = k;
				if (y < 0 || y > G.SIZE) addBand(gas, k, x, y);
			}
		}
		let total = 0;
		for (let t = 0; t < G.N * G.N; t++) {
			gas.rimStart[t] = total;
			total += counts[t];
		}
		gas.rimStart[G.N * G.N] = total;
		const cursor = new Int32Array(G.N * G.N);
		for (let k = 0; k < COUNT; k++) {
			if (!gas.rimFlag[k]) continue;
			const t = gas.tile[k];
			const at = gas.rimStart[t] + cursor[t]++;
			gas.rimCells[at] = k;
			gas.air[k] = 0;
			gas.map[k] = -1;
		}
		gas.listPos.fill(-1);
		gas.count = gas.staticAirCount;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.staticAir[n];
			gas.list[n] = k;
			gas.listPos[k] = n;
		}
		gas.displayReady = true;
	}

	function setDisplayCell(gas, k, node) {
		if (gas.map[k] === node) return;
		if (node >= 0 && !gas.air[k]) {
			gas.air[k] = 1;
			gas.listPos[k] = gas.count;
			gas.list[gas.count++] = k;
		} else if (node < 0 && gas.air[k]) {
			gas.air[k] = 0;
			gas.active[k] = 0;
			gas.pin[k] = 0;
			const pos = gas.listPos[k];
			const last = gas.list[--gas.count];
			gas.list[pos] = last;
			gas.listPos[last] = pos;
			gas.listPos[k] = -1;
		}
		gas.map[k] = node;
	}

	function addBand(gas, k, x, y) {
		if (gas.bandCount >= gas.band.length) return;
		const column = (x / G.S) | 0;
		gas.band[gas.bandCount] = k;
		gas.bandSide[gas.bandCount] = y < 0 ? 0 : 1;
		gas.bandColumn[gas.bandCount] = column < 0 ? 0 : column > G.N - 1 ? G.N - 1 : column;
		gas.bandCount++;
	}

	function project(sim, gas, moved, count) {
		const net = gas.net;
		const valves = sim.layout.valves;
		for (let n = 0; n < count; n++) {
			const t = moved[n];
			const v = valves[t];
			const base = t * SLOTS;
			for (let m = gas.rimStart[t]; m < gas.rimStart[t + 1]; m++) {
				const k = gas.rimCells[m];
				const dx = gas.rimDX[k];
				const dy = gas.rimDY[k];
				const px = dx * v.cos + dy * v.sin;
				const py = dy * v.cos - dx * v.sin;
				const ix = ((px + RHALF) / RS) | 0;
				const iy = ((py + RHALF) / RS) | 0;
				let node = -1;
				if (ix >= 0 && ix < RN && iy >= 0 && iy < RN) {
					const id = base + iy * RN + ix;
					if (net.air[id]) node = id;
				}
				setDisplayCell(gas, k, node);
			}
		}
		const map = gas.map;
		const list = gas.list;
		let mean = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = list[n];
			const node = map[k];
			const p = gas.p[k] = net.p[node];
			gas.active[k] = net.active[node];
			gas.pin[k] = net.pin[node];
			mean += p;
		}
		gas.mean = gas.count ? mean / gas.count : 0;
	}

	function rebuild(sim, gas) {
		const valves = sim.layout.valves;
		const net = gas.net;
		let structure = gas.layoutRef !== sim.layout || !gas.displayReady;
		gas.layoutRef = sim.layout;
		for (let t = 0; t < valves.length; t++) {
			if (gas.valveRef[t] === valves[t]) continue;
			gas.valveRef[t] = valves[t];
			structure = true;
		}
		let count = 0;
		for (let t = 0; t < valves.length; t++) {
			if (structure || Math.abs(valves[t].angle - gas.angles[t]) > 1e-9) gas.moved[count++] = t;
		}
		if (structure) {
			buildStructure(sim, gas);
			precomputeDisplay(sim, gas);
			buildStaticEdges(sim, gas);
			count = valves.length;
			for (let t = 0; t < valves.length; t++) gas.moved[t] = t;
		} else {
			updateRotation(sim, gas, gas.moved, count);
			refreshSeams(sim, gas, gas.moved, count);
		}
		// Components follow the graph as it now stands. The edge weights are
		// recomputed once, by the first solve or velocity pass that needs them.
		components(gas.net);
		gas.compCount = gas.net.compCount;
		for (let t = 0; t < valves.length; t++) gas.angles[t] = valves[t].angle;
		project(sim, gas, gas.moved, count);
		gas.settled = false;
		gas.fastPending = true;
		gas.rebuilds++;
	}

	function applyPins(sim, gas) {
		const net = gas.net;
		const inlets = sim.inlets;
		net.pin.fill(0);
		gas.pin.fill(0);
		gas.pins = 0;
		gas.sources = 0;
		gas.vents = 0;
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const inlet = gas.bandSide[n] * G.N + gas.bandColumn[n];
			if (!inlets.open[inlet]) continue;
			const high = inlets.level[inlet] === INL.HIGH;
			const pin = high ? 2 : 1;
			const node = gas.map[k];
			gas.pin[k] = pin;
			gas.p[k] = high ? 1 : 0;
			if (node >= 0) {
				net.pin[node] = pin;
				net.p[node] = gas.p[k];
			}
			if (high) gas.sources++;
			else gas.vents++;
			gas.pins++;
		}
		markActive(net);
		gas.inletVersion = inlets.version;
		gas.settled = false;
		gas.fastPending = true;
		// Project which air reaches a reservoir for the overlay and the probes.
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			const node = gas.map[k];
			gas.active[k] = net.active[node];
			gas.p[k] = net.p[node];
		}
	}

	// Occupancy throttles the links through a cell. Returns whether the graph
	// moved, so a settled machine can skip both the rebuild and the solve.
	function measureCost(sim, gas) {
		const net = gas.net;
		const now = net.fillNow;
		const fill = net.fill;
		now.fill(0);
		for (let k = 0; k < sim.count; k++) {
			const y = sim.y[k];
			if (y < 0 || y > G.SIZE) continue;
			const cell = index(sim.x[k], y);
			const sample = gas.air[cell] ? cell : sampleCell(gas, sim.x[k], y);
			if (sample < 0) continue;
			const node = gas.map[sample];
			if (now[node] < 65535) now[node]++;
		}
		let changed = false;
		for (let n = 0; n < net.count; n++) {
			const k = net.list[n];
			let f = now[k] / GRAIN_CAPACITY;
			if (f > 1) f = 1;
			if (fill[k] === f) continue;
			fill[k] = f;
			changed = true;
		}
		if (changed) net.dirty = true;
		return changed;
	}

	function mouthOpenAt(v, dx, dy) {
		const horizontal = Math.abs(dx) > Math.abs(dy);
		const s = horizontal ? (dx < 0 ? 2 : 0) : dy < 0 ? 3 : 1;
		const gap = v.seam[s] - (horizontal ? Math.abs(dy) : Math.abs(dx));
		return gap > AIR_MIN;
	}

	// Target velocity per network cell: the actual edge fluxes projected along
	// the pipe direction, plus the rigid wall velocity of a turning rotor disc.
	// No momentum is stored; the display velocity only eases toward this target.
	function velocity(sim, gas, snap, elapsed) {
		const net = gas.net;
		syncConductance(net);
		const relax = elapsed > 0
			? 1 - Math.pow(1 - RELAX, Math.min(elapsed, MASK_DT) / MASK_DT)
			: RELAX;
		const p = net.p;
		const nb = NB;
		const valves = sim.layout.valves;
		const omega = sim.omega;
		let spinning = false;
		for (let k = 0; k < omega.length; k++) {
			if (omega[k] !== 0) {
				spinning = true;
				break;
			}
		}
		for (let n = 0; n < net.count; n++) {
			const k = net.list[n];
			let vx = 0;
			let vy = 0;
			const e0 = k * nb;
			const c = p[k];
			for (let m = 0; m < net.nbrCount[k]; m++) {
				const e = e0 + m;
				const g = net.gw[e];
				if (g <= 0) continue;
				const j = net.nbr[e];
				const dx = net.wx[j] - net.wx[k];
				const dy = net.wy[j] - net.wy[k];
				const len = Math.sqrt(dx * dx + dy * dy);
				if (len < 0.01) continue;
				const q = g * (c - p[j]) / len;
				vx += q * dx;
				vy += q * dy;
			}
			vx *= FLOW_SCALE;
			vy *= FLOW_SCALE;
			if (spinning) {
				const t = net.owner[k];
				const om = omega[t];
				if (om !== 0) {
					const v = valves[t];
					const dx = net.wx[k] - v.cx;
					const dy = net.wy[k] - v.cy;
					const d2 = dx * dx + dy * dy;
					let w = 0;
					if (k % SLOTS < RSLOTS) w = 1;
					else {
						const out = Math.sqrt(d2) - G.RV;
						if (out < SWIRL_REACH && mouthOpenAt(v, dx, dy)) w = 1 - out / SWIRL_REACH;
					}
					if (w > 0) {
						vx += -om * dy * w;
						vy += om * dx * w;
					}
				}
			}
			const speed = Math.sqrt(vx * vx + vy * vy);
			if (speed > GAS_MAX) {
				const s = GAS_MAX / speed;
				vx *= s;
				vy *= s;
			}
			net.tvx[k] = vx;
			net.tvy[k] = vy;
		}
		let flow = 0;
		for (let n = 0; n < gas.count; n++) {
			const k = gas.list[n];
			const node = gas.map[k];
			const vx = net.tvx[node];
			const vy = net.tvy[node];
			if (snap) {
				gas.gx[k] = vx;
				gas.gy[k] = vy;
			} else {
				gas.gx[k] += (vx - gas.gx[k]) * relax;
				gas.gy[k] += (vy - gas.gy[k]) * relax;
			}
			const ax = gas.gx[k];
			const ay = gas.gy[k];
			const speed = Math.sqrt(ax * ax + ay * ay);
			if (speed > GAS_MAX) {
				const s = GAS_MAX / speed;
				gas.gx[k] *= s;
				gas.gy[k] *= s;
			}
			flow += speed > GAS_MAX ? GAS_MAX : speed;
		}
		gas.flow = gas.count ? flow / gas.count : 0;
	}

	function update(sim, gas, elapsed) {
		const velocityElapsed = gas.settled ? MASK_DT : elapsed;
		const changed = measureCost(sim, gas);
		if (changed || !gas.settled || gas.fastPending) {
			const fraction = Math.min(elapsed, MASK_DT) / MASK_DT;
			gas.settled = diffuse(gas, DIFFUSE_DT * fraction) < SETTLE_TOL * fraction;
			gas.fastPending = false;
		}
		velocity(sim, gas, false, velocityElapsed);
		gas.updates++;
	}

	function maybeSolve(sim, gas) {
		const maskTick = gas.clock - gas.maskClock + 1e-9 >= MASK_DT;
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
		} else if (gas.inletVersion !== sim.inlets.version) applyPins(sim, gas);
		if (!maskTick && !gas.fastPending) return;
		const elapsed = gas.clock - gas.solveClock;
		if (!(elapsed > 0)) return;
		update(sim, gas, elapsed);
		gas.solveClock = gas.clock;
		if (!maskTick) return;
		gas.maskClock += MASK_DT;
		if (gas.clock - gas.maskClock > 2 * MASK_DT) gas.maskClock = gas.clock;
	}

	// A grain resting on a wall sits in a texel whose centre is metal, so the
	// nearest air texel stands in for the flow around it.
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

	function drag(sim, gas, h) {
		const force = sim.airForce;
		if (force <= 0) return;
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
	// is open, with one far mouth of the other band as the reference.
	function probeMouths(sim, wantHigh, column) {
		const gas = sim.pressure;
		if (!gas || gas.kind !== "grid" || !gas.count) return false;
		const net = gas.net;
		const far = column <= G.N / 2 ? G.N - 1 : 0;
		const farSide = wantHigh ? 0 : 1;
		let pins = 0;
		net.pin.fill(0);
		gas.pin.fill(0);
		for (let n = 0; n < gas.bandCount; n++) {
			const k = gas.band[n];
			const favourable = (gas.bandSide[n] === 1) === wantHigh;
			if (!favourable && !(gas.bandSide[n] === farSide && gas.bandColumn[n] === far)) continue;
			const pin = wantHigh ? (favourable ? 2 : 1) : (favourable ? 1 : 2);
			gas.pin[k] = pin;
			const node = gas.map[k];
			if (node >= 0) net.pin[node] = pin;
			pins++;
		}
		steady(gas, gas.pTarget, true);
		applyPins(sim, gas);
		return pins > 0;
	}

	function refresh(sim, snap) {
		const gas = sim.pressure;
		rebuild(sim, gas);
		applyPins(sim, gas);
		if (snap) steady(gas, gas.p);
		velocity(sim, gas, !!snap);
		gas.updates++;
		gas.maskClock = gas.clock;
	}

	// Only the boundary changed: schedule a first transient step without
	// rebuilding the graph or solving synchronously inside the UI event.
	function repin(sim) {
		const gas = sim.pressure;
		applyPins(sim, gas);
		velocity(sim, gas, false);
		gas.updates++;
	}

	function settle(sim, dt) {
		const gas = sim.pressure;
		gas.clock += dt;
		maybeSolve(sim, gas);
	}

	function step(sim, h) {
		const gas = sim.pressure;
		gas.clock += h;
		maybeSolve(sim, gas);
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
		syncConductance,
		faceConductance,
		AIR_MIN,
		GAS_MAX,
		DIFFUSE_DT,
		SWIRL_REACH,
		SLOTS,
		RSLOTS,
		LANES,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveGas;
