// Quasi-static water volume on a coarse passability grid derived from the shared
// geometry (not the gas network). Water is stored as a per-cell volume (slice
// area, px^2; the uniform out-of-plane depth factors out). Each cell is modeled
// as an equal-area rectangle over its sampled vertical extent, so a volume maps
// to a horizontal free surface. A bounded Gauss-Seidel relaxation moves water
// from a higher surface to a lower one; a horizontal face records its deepest
// open point as a spill sill and a source never drains below it, which produces
// perched pools and sill spill instead of one global level. Per-cell state makes
// rotor split/merge conserve volume by construction: water stays in its cells
// and cannot teleport through a shut seam. No rendering and no buoyancy here.
const ValveWater = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	const CELL = 6;
	// Water passes a thin film; a gap must hold at least this clearance disc.
	// Openings finer than the face sampling stay conservatively closed.
	const WATER_MIN = 0.4;
	const SUBDIV = 4;
	const FACE_SAMPLES = 4;
	const RELAX_ITERS = 4;
	// Re-sample turning geometry at 30 Hz like the gas mask; the relaxation still
	// runs every step on the cached grid. STEP divides this evenly, so no drift.
	const MASK_DT = 1 / 30;
	const EPS = 1e-6;
	// Illustrative scales shared with the air reference: 1 mm/px, 10 mm depth.
	const DEPTH_PX = 10;
	const M_PER_PX = 0.001;
	const DEFAULT_RATE = 40; // px^2 of slice area per second
	const MOUTH_ROW = 2;
	const OVERFLOW_ROW = 0;
	const PI = Math.PI;

	// Circular-segment fraction below a surface `depth` px under the centre.
	// Same kernel as the grain solver's submergedFraction; kept local so this
	// module does not depend on the simulation (which depends on this one).
	function segFraction(radius, depth) {
		if (!(radius > 0) || depth <= -radius) return 0;
		if (depth >= radius) return 1;
		const x = depth / radius;
		return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / PI;
	}

	function create(sim, cell) {
		const c = cell > 0 ? cell : CELL;
		const nx = Math.ceil(G.SIZE / c);
		const ny = Math.ceil((G.SIZE + 2 * G.POUR) / c);
		const count = nx * ny;
		const valves = sim.layout.valves.length;
		const w = {
			kind: "water",
			enabled: false,
			cell: c,
			nx, ny, count,
			air: new Uint8Array(count),
			airList: new Int32Array(count),
			airCount: 0,
			area: new Float64Array(count),
			floor: new Float64Array(count),
			ceil: new Float64Array(count),
			width: new Float64Array(count),
			vol: new Float64Array(count),
			// Water a closing wall could not route: the rotor carries it until the
			// passage reopens. Kept so split/merge conserves volume exactly.
			trapped: new Float64Array(count),
			gdisp: new Float64Array(count),
			surf: new Float64Array(count),
			comp: new Int32Array(count),
			openS: new Uint8Array(count),
			openE: new Uint8Array(count),
			sillE: new Float64Array(count),
			cellOwner: new Int32Array(count),
			stamp: new Float64Array(valves),
			dirty: new Uint8Array(valves),
			queue: new Int32Array(count),
			seen: new Int32Array(count),
			seenStamp: 0,
			compVol: new Float64Array(count),
			compLevel: new Float64Array(count),
			compCount: 0,
			built: false,
			maskClock: 0,
			ventColumn: (G.N / 2) | 0,
			ventOpen: false,
			rate: DEFAULT_RATE,
			attempted: 0,
			admitted: 0,
			unadmitted: 0,
			overflowed: 0,
			drained: 0,
		};
		w.stamp.fill(NaN);
		for (let i = 0; i < count; i++) {
			const gx = i % nx;
			const gy = (i / nx) | 0;
			w.cellOwner[i] = G.cellAt((gx + 0.5) * c, (gy + 0.5) * c - G.POUR);
		}
		return w;
	}

	// ---- geometry sampling -------------------------------------------------

	function sampleCell(sim, w, i) {
		const c = w.cell;
		const gx = i % w.nx;
		const gy = (i / w.nx) | 0;
		const x0 = gx * c;
		const y0 = gy * c - G.POUR;
		const sub = c / SUBDIV;
		const subArea = sub * sub;
		let area = 0;
		let floor = -Infinity;
		let ceil = Infinity;
		for (let b = 0; b < SUBDIV; b++) {
			const y = y0 + (b + 0.5) * sub;
			for (let a = 0; a < SUBDIV; a++) {
				const x = x0 + (a + 0.5) * sub;
				if (G.airClearance(sim.layout, x, y) < WATER_MIN) continue;
				area += subArea;
				if (y > floor) floor = y;
				if (y < ceil) ceil = y;
			}
		}
		if (area <= 0) {
			w.air[i] = 0;
			w.area[i] = 0;
			w.width[i] = 0;
			return;
		}
		w.air[i] = 1;
		w.area[i] = area;
		w.floor[i] = floor;
		w.ceil[i] = ceil;
		const span = floor - ceil;
		w.width[i] = span > 1e-6 ? area / span : c;
	}

	function sampleEastFace(sim, w, i) {
		const c = w.cell;
		const gx = i % w.nx;
		const gy = (i / w.nx) | 0;
		const x = (gx + 1) * c;
		const y0 = gy * c - G.POUR;
		let open = 0;
		let sill = -Infinity;
		for (let k = 0; k < FACE_SAMPLES; k++) {
			const y = y0 + ((k + 0.5) / FACE_SAMPLES) * c;
			if (G.airClearance(sim.layout, x, y) < WATER_MIN) continue;
			open = 1;
			if (y > sill) sill = y;
		}
		w.openE[i] = open;
		w.sillE[i] = open ? sill : 0;
	}

	function sampleSouthFace(sim, w, i) {
		const c = w.cell;
		const gx = i % w.nx;
		const gy = (i / w.nx) | 0;
		const y = (gy + 1) * c - G.POUR;
		const x0 = gx * c;
		let open = 0;
		for (let k = 0; k < FACE_SAMPLES; k++) {
			const x = x0 + ((k + 0.5) / FACE_SAMPLES) * c;
			if (G.airClearance(sim.layout, x, y) >= WATER_MIN) { open = 1; break; }
		}
		w.openS[i] = open;
	}

	function labelComponents(w) {
		const comp = w.comp;
		const queue = w.queue;
		comp.fill(-1);
		let count = 0;
		for (let s = 0; s < w.count; s++) {
			if (!w.air[s] || comp[s] >= 0) continue;
			let head = 0;
			let tail = 0;
			queue[tail++] = s;
			comp[s] = count;
			while (head < tail) {
				const i = queue[head++];
				const gx = i % w.nx;
				const gy = (i / w.nx) | 0;
				if (gy + 1 < w.ny && w.openS[i] && comp[i + w.nx] < 0) { comp[i + w.nx] = count; queue[tail++] = i + w.nx; }
				if (gy > 0 && w.openS[i - w.nx] && comp[i - w.nx] < 0) { comp[i - w.nx] = count; queue[tail++] = i - w.nx; }
				if (gx + 1 < w.nx && w.openE[i] && comp[i + 1] < 0) { comp[i + 1] = count; queue[tail++] = i + 1; }
				if (gx > 0 && w.openE[i - 1] && comp[i - 1] < 0) { comp[i - 1] = count; queue[tail++] = i - 1; }
			}
			count++;
		}
		w.compCount = count;
	}

	// A turning wall can close a cell that still holds water. The wall displaces
	// that water into the adjacent void (first hop), then it routes onward through
	// open faces only, so it never crosses a shut seam. This is how a rotor carries
	// its passage water into a new orientation instead of losing it. Any remainder
	// with no reachable void is held as trapped until the passage reopens.
	function pushClosedWater(w) {
		const nx = w.nx;
		const ny = w.ny;
		const queue = w.queue;
		const seen = w.seen;
		for (let i = 0; i < w.count; i++) {
			if (w.air[i] || w.vol[i] <= EPS) continue;
			let excess = w.vol[i];
			w.vol[i] = 0;
			const stamp = ++w.seenStamp;
			let head = 0;
			let tail = 0;
			const gx = i % nx;
			const gy = (i / nx) | 0;
			if (gy > 0 && w.air[i - nx]) { seen[i - nx] = stamp; queue[tail++] = i - nx; }
			if (gy + 1 < ny && w.air[i + nx]) { seen[i + nx] = stamp; queue[tail++] = i + nx; }
			if (gx > 0 && w.air[i - 1]) { seen[i - 1] = stamp; queue[tail++] = i - 1; }
			if (gx + 1 < nx && w.air[i + 1]) { seen[i + 1] = stamp; queue[tail++] = i + 1; }
			while (head < tail && excess > EPS) {
				const j = queue[head++];
				const room = w.area[j] - w.vol[j];
				if (room > EPS) {
					const give = excess < room ? excess : room;
					w.vol[j] += give;
					excess -= give;
					if (excess <= EPS) break;
				}
				const jx = j % nx;
				const jy = (j / nx) | 0;
				if (jy > 0 && w.openS[j - nx] && w.air[j - nx] && seen[j - nx] !== stamp) { seen[j - nx] = stamp; queue[tail++] = j - nx; }
				if (jy + 1 < ny && w.openS[j] && w.air[j + nx] && seen[j + nx] !== stamp) { seen[j + nx] = stamp; queue[tail++] = j + nx; }
				if (jx > 0 && w.openE[j - 1] && w.air[j - 1] && seen[j - 1] !== stamp) { seen[j - 1] = stamp; queue[tail++] = j - 1; }
				if (jx + 1 < nx && w.openE[j] && w.air[j + 1] && seen[j + 1] !== stamp) { seen[j + 1] = stamp; queue[tail++] = j + 1; }
			}
			if (excess > EPS) w.trapped[i] += excess;
		}
	}

	// Re-sample only the cells and faces whose owning valve turned, then relabel
	// components. Mirrors the gas mask's per-owner cache so a still field is free.
	function rebuild(sim) {
		const w = sim.water;
		const valves = sim.layout.valves;
		let any = false;
		for (let v = 0; v < valves.length; v++) {
			const a = valves[v].angle;
			if (w.stamp[v] !== a) { w.dirty[v] = 1; w.stamp[v] = a; any = true; }
			else w.dirty[v] = 0;
		}
		if (!any && w.built) return false;
		const first = !w.built;
		for (let i = 0; i < w.count; i++) {
			if (first || w.dirty[w.cellOwner[i]]) sampleCell(sim, w, i);
		}
		// A passage that reopens returns the water its rotor carried.
		for (let i = 0; i < w.count; i++) {
			if (w.air[i] && w.trapped[i] > 0) { w.vol[i] += w.trapped[i]; w.trapped[i] = 0; }
		}
		for (let i = 0; i < w.count; i++) {
			const gx = i % w.nx;
			const gy = (i / w.nx) | 0;
			if (gx + 1 < w.nx && (first || w.dirty[w.cellOwner[i]] || w.dirty[w.cellOwner[i + 1]])) sampleEastFace(sim, w, i);
			if (gy + 1 < w.ny && (first || w.dirty[w.cellOwner[i]] || w.dirty[w.cellOwner[i + w.nx]])) sampleSouthFace(sim, w, i);
		}
		w.airCount = 0;
		for (let i = 0; i < w.count; i++) if (w.air[i]) w.airList[w.airCount++] = i;
		pushClosedWater(w);
		labelComponents(w);
		w.built = true;
		return true;
	}

	// ---- free surface and transfers ----------------------------------------

	function surface(w, i) {
		if (w.vol[i] <= EPS) return w.floor[i];
		const s = w.floor[i] - (w.vol[i] + w.gdisp[i]) / w.width[i];
		return s < w.ceil[i] ? w.ceil[i] : s;
	}

	// Water volume remaining if the surface fell to `s` (grains keep their share).
	function waterBelow(w, i, s) {
		const v = w.width[i] * (w.floor[i] - s) - w.gdisp[i];
		if (v <= 0) return 0;
		return v > w.vol[i] ? w.vol[i] : v;
	}

	function effCap(w, i) {
		const c = w.area[i] - w.gdisp[i];
		return c > 0 ? c : 0;
	}

	// Vertical face: the two cells act as one column, filling the lower first.
	function verticalTransfer(w, u, d) {
		const total = w.vol[u] + w.vol[d];
		if (total <= EPS) return;
		const capD = effCap(w, d);
		const newD = total < capD ? total : capD;
		w.vol[d] = newD;
		w.vol[u] = total - newD;
	}

	// Horizontal face: equalize surfaces, but the source cannot drain below the
	// face sill and the destination cannot exceed its capacity.
	function horizontalTransfer(w, l, r, sill) {
		const total = w.vol[l] + w.vol[r];
		if (total <= EPS) return;
		const sl = surface(w, l);
		const sr = surface(w, r);
		if (Math.abs(sl - sr) < EPS) return;
		const src = sl < sr ? l : r;
		const dst = sl < sr ? r : l;
		const avail = w.vol[src] - waterBelow(w, src, sill);
		if (avail <= EPS) return;
		const capDst = effCap(w, dst) - w.vol[dst];
		if (capDst <= EPS) return;
		const wsum = w.width[l] + w.width[r];
		if (wsum <= EPS) return;
		const t = (w.width[l] * w.floor[l] + w.width[r] * w.floor[r] - total - w.gdisp[l] - w.gdisp[r]) / wsum;
		let eq = w.vol[src] - waterBelow(w, src, t);
		if (eq < 0) eq = 0;
		let amt = eq < avail ? eq : avail;
		if (amt > capDst) amt = capDst;
		if (amt <= EPS) return;
		w.vol[src] -= amt;
		w.vol[dst] += amt;
	}

	// openS/openE are only set where a face exists, so they encode the boundary;
	// iterating the air list and skipping dry pairs avoids metal cells and the
	// per-cell gx/gy math entirely.
	function relaxPass(w, reverse) {
		const list = w.airList;
		const n = w.airCount;
		const nx = w.nx;
		const vol = w.vol;
		for (let k = 0; k < n; k++) {
			const i = reverse ? list[n - 1 - k] : list[k];
			if (w.openS[i]) {
				const d = i + nx;
				if (vol[i] > EPS || vol[d] > EPS) verticalTransfer(w, i, d);
			}
			if (w.openE[i]) {
				const r = i + 1;
				if (vol[i] > EPS || vol[r] > EPS) horizontalTransfer(w, i, r, w.sillE[i]);
			}
		}
	}

	function relax(w, iters) {
		for (let it = 0; it < iters; it++) relaxPass(w, (it & 1) === 1);
	}

	// Run to equilibrium for fixtures: stop when a full pass barely moves a surface
	// AND no cell is overfull. An overfull cell's surface clamps to its top edge, so
	// a surface-only check would falsely converge while water still needs to rise.
	function settle(w, maxPasses) {
		const list = w.airList;
		for (let k = 0; k < w.airCount; k++) w.surf[list[k]] = surface(w, list[k]);
		for (let p = 0; p < maxPasses; p++) {
			relaxPass(w, (p & 1) === 1);
			let maxD = 0;
			let maxOver = 0;
			for (let k = 0; k < w.airCount; k++) {
				const i = list[k];
				const s = surface(w, i);
				const d = Math.abs(s - w.surf[i]);
				if (d > maxD) maxD = d;
				w.surf[i] = s;
				const over = w.vol[i] - effCap(w, i);
				if (over > maxOver) maxOver = over;
			}
			if (maxD < 1e-4 && maxOver < 1e-4) return p + 1;
		}
		return maxPasses;
	}

	// ---- grain displacement (one-way in this slice) ------------------------

	// The pool waterline is the highest free surface in a component: a full cell
	// reports its own top edge, so only the topmost wet cell carries the true
	// surface. Grains must be tested against that waterline, not their own cell.
	function poolLevels(w) {
		w.compLevel.fill(Infinity, 0, w.compCount);
		const list = w.airList;
		for (let k = 0; k < w.airCount; k++) {
			const i = list[k];
			if (w.vol[i] <= EPS) continue;
			const s = surface(w, i);
			w.surf[i] = s;
			const c = w.comp[i];
			if (s < w.compLevel[c]) w.compLevel[c] = s;
		}
	}

	function displace(sim) {
		const w = sim.water;
		poolLevels(w);
		w.gdisp.fill(0);
		for (let k = 0; k < sim.count; k++) {
			const gx = Math.floor(sim.x[k] / w.cell);
			const gy = Math.floor((sim.y[k] + G.POUR) / w.cell);
			if (gx < 0 || gx >= w.nx || gy < 0 || gy >= w.ny) continue;
			const i = gy * w.nx + gx;
			if (!w.air[i]) continue;
			const level = w.compLevel[w.comp[i]];
			if (!Number.isFinite(level)) continue;
			const r = sim.r[k];
			w.gdisp[i] += PI * r * r * segFraction(r, sim.y[k] - level);
		}
		const list = w.airList;
		for (let k = 0; k < w.airCount; k++) {
			const i = list[k];
			if (w.gdisp[i] > w.area[i]) w.gdisp[i] = w.area[i];
		}
	}

	// ---- supply, drain, overflow -------------------------------------------

	function mouthIndex(w) {
		const x = (w.ventColumn + 0.5) * G.S;
		const gx = Math.min(w.nx - 1, Math.floor(x / w.cell));
		return MOUTH_ROW * w.nx + gx;
	}

	function supply(sim, h) {
		const w = sim.water;
		if (!w.ventOpen || w.rate <= 0) return;
		const want = w.rate * h;
		w.attempted += want;
		const i = mouthIndex(w);
		// A metal mouth is blocked: the supply never enters. An open mouth admits
		// everything; if the system below is full the relaxation backs the excess
		// out of the top boundary as overflow, never behind a wall.
		if (!w.air[i]) { w.unadmitted += want; return; }
		w.vol[i] += want;
		w.admitted += want;
	}

	function boundaries(sim) {
		const w = sim.water;
		const c = w.cell;
		const list = w.airList;
		for (let k = 0; k < w.airCount; k++) {
			const i = list[k];
			if (w.vol[i] <= 0) continue;
			const gy = (i / w.nx) | 0;
			const topY = gy * c - G.POUR;
			if (gy <= OVERFLOW_ROW) { w.overflowed += w.vol[i]; w.vol[i] = 0; }
			else if (topY >= G.SIZE) { w.drained += w.vol[i]; w.vol[i] = 0; }
		}
	}

	function totalVol(w) {
		let v = 0;
		for (let i = 0; i < w.count; i++) v += w.vol[i];
		return v;
	}

	// All accounted water: free volume plus what rotors are carrying.
	function storedVol(w) {
		let v = 0;
		for (let i = 0; i < w.count; i++) v += w.vol[i] + w.trapped[i];
		return v;
	}

	function recount(w) {
		for (let c = 0; c < w.compCount; c++) w.compVol[c] = 0;
		const list = w.airList;
		for (let k = 0; k < w.airCount; k++) {
			const i = list[k];
			w.compVol[w.comp[i]] += w.vol[i];
		}
	}

	// ---- public API --------------------------------------------------------

	function step(sim, h) {
		const w = sim.water;
		if (!w || !w.enabled) return;
		if (!w.built || sim.clock - w.maskClock >= MASK_DT) {
			rebuild(sim);
			w.maskClock = sim.clock;
		}
		displace(sim);
		supply(sim, h);
		relax(w, RELAX_ITERS);
		boundaries(sim);
		recount(w);
	}

	function setVent(w, column, open) {
		w.ventColumn = Math.max(0, Math.min(G.N - 1, column | 0));
		w.ventOpen = !!open;
	}

	function setSupply(w, rate) {
		w.rate = rate > 0 ? rate : 0;
	}

	// Supply rate from SI: Q m^3/s spread over the slice depth becomes px^2/s.
	function supplyFromSI(q) {
		const depthM = DEPTH_PX * M_PER_PX;
		return q / depthM / (M_PER_PX * M_PER_PX);
	}

	function drainAll(w) {
		const v = storedVol(w);
		w.vol.fill(0);
		w.trapped.fill(0);
		w.drained += v;
		return v;
	}

	function reset(w) {
		w.vol.fill(0);
		w.trapped.fill(0);
		w.gdisp.fill(0);
		w.attempted = 0;
		w.admitted = 0;
		w.unadmitted = 0;
		w.overflowed = 0;
		w.drained = 0;
		w.ventOpen = false;
		w.built = false;
		w.maskClock = 0;
		w.stamp.fill(NaN);
	}

	// Pool waterline at a world point (Infinity where there is no water), for the
	// coming buoyancy/display slice. step()/displace() keep compLevel current.
	function surfaceAt(w, x, y) {
		const gx = Math.floor(x / w.cell);
		const gy = Math.floor((y + G.POUR) / w.cell);
		if (gx < 0 || gx >= w.nx || gy < 0 || gy >= w.ny) return Infinity;
		const i = gy * w.nx + gx;
		if (!w.air[i]) return Infinity;
		const level = w.compLevel[w.comp[i]];
		return Number.isFinite(level) ? level : Infinity;
	}

	return {
		CELL, WATER_MIN, DEPTH_PX, M_PER_PX, DEFAULT_RATE, RELAX_ITERS,
		create, step, rebuild, relax, settle, displace, poolLevels,
		setVent, setSupply, supplyFromSI, drainAll, reset,
		totalVol, storedVol, surface, surfaceAt, mouthIndex,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveWater;
