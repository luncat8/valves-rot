// Quasi-static water volume on a coarse passability grid derived from the shared
// geometry (not the gas network). Water is stored as a per-cell volume (slice
// area, px^2; the uniform out-of-plane depth factors out). Each cell is modeled
// as an equal-area rectangle over its sampled vertical extent, so a volume maps
// to a horizontal free surface. A bounded Gauss-Seidel relaxation moves water
// from a higher surface to a lower one; a horizontal face records its deepest
// open point as a spill sill and a source never drains below it, which produces
// perched pools and sill spill instead of one global level. Per-cell state makes
// rotor split/merge conserve volume by construction: water stays in its cells
// and cannot teleport through a shut seam. No rendering, no buoyancy force here.
const ValveWater = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");

	const CELL = 6;
	// Water passes a thin film; a gap must hold at least this clearance disc.
	// Openings finer than the face sampling stay conservatively closed.
	const WATER_MIN = 0.4;
	// Sample counts per cell and per face. Two pixels per sample is the coarsest
	// that still resolves a chamber floor against its rim; finer costs rebuilds
	// time that the turning mask pays 15 times a second.
	const SUBDIV = 3;
	const FACE_SAMPLES = 4;
	const RELAX_ITERS = 2;
	// Re-sample turning geometry at 15 Hz; the relaxation still runs every step on
	// the cached grid. Sampling a turned valve costs its whole block (a rebuild
	// with every rotor moving is the dominant water cost), and the water itself is
	// quasi-static, so a 66 ms mask lag is invisible while 30 Hz is not free.
	// STEP divides this evenly, so no drift.
	const MASK_DT = 1 / 15;
	const EPS = 1e-6;
	// Illustrative scales shared with the air reference: 1 mm/px, 10 mm depth.
	const DEPTH_PX = 10;
	const M_PER_PX = 0.001;
	const M3_PER_PX2 = M_PER_PX * M_PER_PX * DEPTH_PX * M_PER_PX;
	const DEFAULT_RATE = 40; // px^2 of slice area per second
	// Rows of the grid that open onto the pour/overflow band and the drain band.
	const MOUTH_ROW = 2;
	const OVERFLOW_ROW = 0;
	// How far up a column the waterline search may pass over dry cells: a cell
	// that the relaxation has not filled yet must not read as dry under a pool,
	// and a long dry shaft must not borrow a distant pool's surface.
	const DRY_SKIP = 3;
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

	// Cell indices owned by each valve, in contiguous blocks, so a turned rotor
	// resamples its own ~150 cells instead of the whole 15,600-cell grid.
	function buildBlocks(w, valves) {
		const count = w.count;
		const per = new Int32Array(valves);
		for (let i = 0; i < count; i++) per[w.cellOwner[i]]++;
		const start = new Int32Array(valves + 1);
		for (let v = 0; v < valves; v++) start[v + 1] = start[v] + per[v];
		const cell = new Int32Array(count);
		const fill = start.slice(0, valves);
		for (let i = 0; i < count; i++) cell[fill[w.cellOwner[i]]++] = i;
		// One-cell margin: a face belongs half to the neighbour across it.
		const box = new Int32Array(valves * 4);
		for (let v = 0; v < valves; v++) {
			let x0 = w.nx, y0 = w.ny, x1 = -1, y1 = -1;
			for (let k = start[v]; k < start[v + 1]; k++) {
				const i = cell[k];
				const gx = i % w.nx;
				const gy = (i / w.nx) | 0;
				if (gx < x0) x0 = gx;
				if (gx > x1) x1 = gx;
				if (gy < y0) y0 = gy;
				if (gy > y1) y1 = gy;
			}
			if (x1 < 0) { x0 = y0 = 0; x1 = y1 = -1; }
			box[v * 4] = x0 > 0 ? x0 - 1 : 0;
			box[v * 4 + 1] = y0 > 0 ? y0 - 1 : 0;
			box[v * 4 + 2] = x1 + 1 < w.nx ? x1 + 1 : w.nx - 1;
			box[v * 4 + 3] = y1 + 1 < w.ny ? y1 + 1 : w.ny - 1;
		}
		w.blockStart = start;
		w.blockCell = cell;
		w.blockBox = box;
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
			// Every SUBDIV*SUBDIV sample of every cell: 0 metal, 1 an opening too
			// tight to hold water, 2 water. The display asks this grid a 2 px
			// question instead of re-sampling the geometry per frame.
			fine: new Uint8Array(count * SUBDIV * SUBDIV),
			sub: c / SUBDIV,
			fnx: nx * SUBDIV,
			fny: ny * SUBDIV,
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
			// Published waterlines per cell (NaN = dry), read by buoyancy and the
			// display fill; kept out of the solver so both read one snapshot.
			levels: new Float64Array(count),
			levelUp: new Float64Array(count),
			// True while the two arrays hold a published waterline, so clearing
			// them once on the way out is enough.
			levelsLive: false,
			surfScratch: new Float64Array(count),
			comp: new Int32Array(count),
			openS: new Uint8Array(count),
			openE: new Uint8Array(count),
			sillE: new Float64Array(count),
			cellOwner: new Int32Array(count),
			// Per-valve resample cache: rotor angle and layout revision. A replaced
			// valve keeps its angle, so the revision is what catches it.
			stamp: new Float64Array(valves),
			layoutSeen: new Int32Array(valves),
			dirty: new Uint8Array(valves),
			queue: new Int32Array(count),
			seen: new Int32Array(count),
			seenStamp: 0,
			// Cells whose displacement is nonzero, so clearing it costs O(wet)
			// instead of a 125 KB fill that evicts the grain solver's hot data.
			dispList: new Int32Array(count),
			dispCount: 0,
			cellStamp: new Int32Array(count),
			eStamp: new Int32Array(count),
			sStamp: new Int32Array(count),
			serial: 0,
			blockStart: null,
			blockCell: null,
			blockBox: null,
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
		w.layoutSeen.fill(-1);
		w.levels.fill(NaN);
		w.levelUp.fill(NaN);
		for (let i = 0; i < count; i++) {
			const gx = i % nx;
			const gy = (i / nx) | 0;
			w.cellOwner[i] = G.cellAt((gx + 0.5) * c, (gy + 0.5) * c - G.POUR);
		}
		buildBlocks(w, valves);
		return w;
	}

	// ---- geometry sampling -------------------------------------------------

	// A cell's SUBDIV*SUBDIV samples are kept, not just summed. The display reads
	// them instead of asking the geometry again per texel: a 3 px fill scan is
	// ~62k clearance evaluations a frame (4.9 ms measured), which is the same
	// sampling the mask already paid for at 15 Hz.
	function sampleCell(sim, w, i) {
		const c = w.cell;
		const gx = i % w.nx;
		const gy = (i / w.nx) | 0;
		const x0 = gx * c;
		const y0 = gy * c - G.POUR;
		const sub = c / SUBDIV;
		const subArea = sub * sub;
		const fine = w.fine;
		const fnx = w.fnx;
		// The sample grid is row-major over the whole field, so a lookup by world
		// point is one index; packing the nine samples per cell instead would make
		// the display's per-texel address arithmetic wrong in a way that is easy to
		// miss (the first version did exactly that).
		const col = gx * SUBDIV;
		let area = 0;
		let floor = -Infinity;
		let ceil = Infinity;
		for (let b = 0; b < SUBDIV; b++) {
			const y = y0 + (b + 0.5) * sub;
			let f = (gy * SUBDIV + b) * fnx + col;
			for (let a = 0; a < SUBDIV; a++, f++) {
				const x = x0 + (a + 0.5) * sub;
				const clear = G.airClearance(sim.layout, x, y);
				// 0 = metal, 1 = an opening too thin to hold water, 2 = water. The
				// fill paints 1 and 2 (a drawn passage is a passage), the solver only
				// ever charges water to 2.
				if (clear <= 0) {
					fine[f] = 0;
					continue;
				}
				if (clear < WATER_MIN) {
					fine[f] = 1;
					continue;
				}
				fine[f] = 2;
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
		for (let k = 0; k < FACE_SAMPLES; k++) {
			const x = x0 + ((k + 0.5) / FACE_SAMPLES) * c;
			if (G.airClearance(sim.layout, x, y) >= WATER_MIN) { w.openS[i] = 1; return; }
		}
		w.openS[i] = 0;
	}

	// Sample a cell and the four faces that touch it: the two it owns and the two
	// its west/north neighbours own, because a seam is a property of a pair, and
	// a turned rotor changes the faces on both of its sides. Per-cell stamps keep
	// a face that two resampled valves share from being sampled twice.
	function sampleAround(sim, w, i, serial) {
		if (w.cellStamp[i] !== serial) {
			w.cellStamp[i] = serial;
			sampleCell(sim, w, i);
		}
		const gx = i % w.nx;
		const gy = (i / w.nx) | 0;
		if (gx + 1 < w.nx && w.eStamp[i] !== serial) { w.eStamp[i] = serial; sampleEastFace(sim, w, i); }
		if (gy + 1 < w.ny && w.sStamp[i] !== serial) { w.sStamp[i] = serial; sampleSouthFace(sim, w, i); }
		const west = i - 1;
		if (gx > 0 && w.eStamp[west] !== serial) { w.eStamp[west] = serial; sampleEastFace(sim, w, west); }
		const north = i - w.nx;
		if (gy > 0 && w.sStamp[north] !== serial) { w.sStamp[north] = serial; sampleSouthFace(sim, w, north); }
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

	// Re-sample only the valves whose rotor turned or whose layout revision moved
	// (a replaced valve keeps its angle), then relabel components.
	function rebuild(sim) {
		const w = sim.water;
		const valves = sim.layout.valves;
		const revision = sim.layoutVersion | 0;
		let any = false;
		for (let v = 0; v < valves.length; v++) {
			const angle = valves[v].angle;
			const moved = w.stamp[v] !== angle || w.layoutSeen[v] !== revision;
			w.dirty[v] = moved ? 1 : 0;
			if (!moved) continue;
			w.stamp[v] = angle;
			w.layoutSeen[v] = revision;
			any = true;
		}
		if (!any && w.built) return false;
		const first = !w.built;
		if (first) {
			for (let i = 0; i < w.count; i++) sampleCell(sim, w, i);
			for (let i = 0; i < w.count; i++) {
				if (i % w.nx + 1 < w.nx) sampleEastFace(sim, w, i);
				if ((i / w.nx | 0) + 1 < w.ny) sampleSouthFace(sim, w, i);
			}
		} else {
			const serial = ++w.serial;
			for (let v = 0; v < valves.length; v++) {
				if (!w.dirty[v]) continue;
				const end = w.blockStart[v + 1];
				for (let k = w.blockStart[v]; k < end; k++) sampleAround(sim, w, w.blockCell[k], serial);
			}
		}
		// A passage that reopens returns the water its rotor carried.
		for (let i = 0; i < w.count; i++) {
			if (w.air[i] && w.trapped[i] > 0) { w.vol[i] += w.trapped[i]; w.trapped[i] = 0; }
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
		if (newD === w.vol[d]) return;
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
		const capDst = effCap(w, dst) - w.vol[dst];
		if (capDst <= EPS) return;
		const avail = w.vol[src] - waterBelow(w, src, sill);
		if (avail <= EPS) return;
		const wsum = w.width[l] + w.width[r];
		if (wsum <= EPS) return;
		const t = (w.width[l] * w.floor[l] + w.width[r] * w.floor[r] - total - w.gdisp[l] - w.gdisp[r]) / wsum;
		let amt = w.vol[src] - waterBelow(w, src, t);
		if (amt < 0) amt = 0;
		if (amt > avail) amt = avail;
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
		if (!w.built) return 0;
		const list = w.airList;
		const surf = w.surfScratch;
		for (let k = 0; k < w.airCount; k++) surf[list[k]] = surface(w, list[k]);
		for (let p = 0; p < maxPasses; p++) {
			relaxPass(w, (p & 1) === 1);
			let maxD = 0;
			let maxOver = 0;
			for (let k = 0; k < w.airCount; k++) {
				const i = list[k];
				const s = surface(w, i);
				const d = s - surf[i];
				const abs = d < 0 ? -d : d;
				if (abs > maxD) maxD = abs;
				surf[i] = s;
				const over = w.vol[i] - effCap(w, i);
				if (over > maxOver) maxOver = over;
			}
			if (maxD < 1e-4 && maxOver < 1e-4) return p + 1;
		}
		return maxPasses;
	}

	// ---- waterline (buoyancy, displacement, display) -----------------------

	// Publish two waterlines once per step, BEFORE the step moves any water, so a
	// grain's buoyancy and the fill both read the level the grains already saw (a
	// force that read the surface its own step created would chase the solver):
	//   levels[i] - the free surface of the cell itself (NaN = dry), for the fill;
	//   levelUp[i] - the waterline at the cell, for buoyancy.
	//
	// The waterline is a property of the whole vertical run, not of one cell. A
	// cell holds at most a few grains, so a grain's own displacement can empty the
	// cell it sits in while its neighbours stay wet; reading the cell's own surface
	// then flips a floating grain between fully dry and fully submerged every time
	// it crosses a cell edge. Filling the run from its floor instead gives one
	// smooth level for the pool, with the displacement included where it happens.
	function publishLevels(w) {
		const levels = w.levels;
		const up = w.levelUp;
		const air = w.air;
		const vol = w.vol;
		const gdisp = w.gdisp;
		const area = w.area;
		const width = w.width;
		const ceil = w.ceil;
		const floor = w.floor;
		const openS = w.openS;
		const nx = w.nx;
		const ny = w.ny;
		for (let gx = 0; gx < nx; gx++) {
			let row = 0;
			while (row < ny) {
				let i = row * nx + gx;
				if (!air[i]) {
					levels[i] = NaN;
					up[i] = NaN;
					row++;
					continue;
				}
				// A run is a column of open cells joined by open vertical faces.
				let end = row;
				while (end + 1 < ny && openS[end * nx + gx] && air[(end + 1) * nx + gx]) end++;
				// Fill the run from its floor: each cell takes its capacity first,
				// then the cell that runs out of water carries the free surface.
				let liquid = 0;
				for (let r = end; r >= row; r--) {
					const v = vol[r * nx + gx];
					if (v > 0) liquid += v;
				}
				let level = NaN;
				let fillTop = end + 1;
				for (let r = end; r >= row && liquid > EPS; r--) {
					const j = r * nx + gx;
					const displaced = gdisp[j];
					const cap = area[j] - displaced;
					if (liquid >= cap) {
						liquid -= cap > 0 ? cap : 0;
						level = ceil[j];
						fillTop = r;
						continue;
					}
					const s = floor[j] - (liquid + displaced) / width[j];
					level = s < ceil[j] ? ceil[j] : s;
					liquid = 0;
					fillTop = r;
				}
				for (let r = row; r <= end; r++) {
					const j = r * nx + gx;
					if (r >= fillTop) {
						levels[j] = level;
						up[j] = level;
					} else {
						// Dry air above this run's waterline. The relaxation may still
						// owe it water (and the cell a grain sits in may be one of
						// them), so a short gap still sees the pool; a long dry shaft
						// must not borrow a level from below.
						levels[j] = NaN;
						up[j] = fillTop - r <= DRY_SKIP ? level : NaN;
					}
				}
				row = end + 1;
			}
		}
		w.levelsLive = true;
	}

	// The waterline at a world point (Infinity where there is no water): the level
	// published by the last step. A full cell reports its own top edge, which is
	// why the pool surface above it is carried in levelUp instead.
	function surfaceAt(w, x, y) {
		const up = w.levelUp;
		if (!up) return Infinity;
		const gx = Math.floor(x / w.cell);
		const gy = Math.floor((y + G.POUR) / w.cell);
		if (gx < 0 || gx >= w.nx || gy < 0 || gy >= w.ny) return Infinity;
		const level = up[gy * w.nx + gx];
		return level === level ? level : Infinity;
	}

	// Fraction of a grain disc below the waterline at its own position.
	function submerged(w, x, y, r) {
		const level = surfaceAt(w, x, y);
		return Number.isFinite(level) ? segFraction(r, y - level) : 0;
	}

	// Scratch for the cells one immersed disc touches: a disc of the maximum
	// radius spans at most three cells in each direction, so nine slots. The
	// weight sum is kept beside them because the sampled cell bands do not tile
	// the plane, so the overlaps have to be normalised to keep the displaced
	// area exactly the disc's.
	const spotIdx = new Int32Array(9);
	const spotW = new Float64Array(9);
	const spotSum = { count: 0, total: 0 };

	// Cells under the submerged part of one disc, weighted by the overlap of the
	// disc's box with each cell's sampled band. Fills the scratch arrays and
	// reports the count and the weight sum through spotSum.
	function footprint(w, x, y, r, top, bottom) {
		const cell = w.cell;
		const nx = w.nx;
		const gx0 = Math.max(0, Math.floor((x - r) / cell));
		const gx1 = Math.min(nx - 1, Math.floor((x + r) / cell));
		const gy0 = Math.max(0, Math.floor((top + G.POUR) / cell));
		const gy1 = Math.min(w.ny - 1, Math.floor((bottom + G.POUR) / cell));
		let count = 0;
		let total = 0;
		for (let gy = gy0; gy <= gy1; gy++) {
			const row = gy * nx;
			for (let gx = gx0; gx <= gx1; gx++) {
				const j = row + gx;
				if (!w.air[j]) continue;
				// Sampled vertical band of the cell: a 2 px floor sliver counts as
				// the sliver it is, not as a whole cell.
				const lo = top > w.ceil[j] ? top : w.ceil[j];
				const hi = bottom < w.floor[j] ? bottom : w.floor[j];
				if (hi <= lo) continue;
				const lx = x - r > gx * cell ? x - r : gx * cell;
				const hx = x + r < (gx + 1) * cell ? x + r : (gx + 1) * cell;
				if (hx <= lx) continue;
				const weight = (hi - lo) * (hx - lx);
				spotIdx[count] = j;
				spotW[count] = weight;
				total += weight;
				count++;
			}
		}
		spotSum.count = count;
		spotSum.total = total;
	}

	// Grains displace water by their submerged disc area against the waterline,
	// one-way in this slice, and the area is spread over the cells the disc
	// covers rather than loaded on the cell of its centre. One cell is 6 px and a
	// grain is up to 6.2 px across, so a centre-cell load makes the capacity, and
	// with it the waterline a float reads, step whenever the grain crosses an
	// edge; in a shallow pool the centre cell can be a 2 px floor sliver whose
	// capacity is smaller than the disc, so it flips between full and not and
	// pumps the water at ~0.5 Hz. Publishing first means displacement and
	// buoyancy of one step both read the snapshot taken before this step moves
	// any water: a force that read the surface its own step just moved would make
	// grains chase the relaxation.
	function displace(sim) {
		const w = sim.water;
		publishLevels(w);
		const gdisp = w.gdisp;
		const dispList = w.dispList;
		const nx = w.nx;
		for (let k = 0, n = w.dispCount; k < n; k++) gdisp[dispList[k]] = 0;
		let used = 0;
		for (let k = 0; k < sim.count; k++) {
			const x = sim.x[k];
			const y = sim.y[k];
			const r = sim.r[k];
			const level = surfaceAt(w, x, y);
			if (!Number.isFinite(level)) continue;
			const f = segFraction(r, y - level);
			if (f <= 0) continue;
			// Only the disc below the waterline displaces: from the waterline (or
			// the top of the disc, when it is deeper) to the bottom of the disc.
			const top = level > y - r ? level : y - r;
			const bottom = y + r;
			footprint(w, x, y, r, top, bottom);
			const area = PI * r * r * f;
			if (spotSum.total <= 0) {
				// The samples leave a gap under the disc; charge the cell of the
				// centre, which is air whenever the waterline reached the grain.
				const i = Math.floor((y + G.POUR) / w.cell) * nx + Math.floor(x / w.cell);
				if (!w.air[i]) continue;
				gdisp[i] += area;
				dispList[used++] = i;
				continue;
			}
			const share = area / spotSum.total;
			for (let s = 0; s < spotSum.count; s++) {
				const j = spotIdx[s];
				gdisp[j] += spotW[s] * share;
				dispList[used++] = j;
			}
		}
		w.dispCount = used;
		const cap = w.area;
		for (let k = 0; k < used; k++) {
			const i = dispList[k];
			if (gdisp[i] > cap[i]) gdisp[i] = cap[i];
		}
	}

	// Water off (never enabled, or disabled mid-run): nobody is wet. A disabled
	// grid keeps its volume, but the page must not draw it and grains must not
	// feel it, so the published waterline is cleared rather than left stale. The
	// step calls this every tick while water is off, so it writes only when there
	// is a published waterline to clear, not two grid-sized fills per tick.
	function clearLevels(sim) {
		const w = sim.water;
		if (!w || !w.levelsLive) return;
		w.levels.fill(NaN);
		w.levelUp.fill(NaN);
		w.levelsLive = false;
	}

	// ---- display -----------------------------------------------------------

	// The fill is drawn on the mask's own 2 px sample grid, so a texel's centre is
	// one of the samples the solver already admitted or rejected: the picture
	// cannot claim water the solver refused, and cannot paint a wall. Asking the
	// geometry per texel instead cost 4.9 ms a frame (measured) and repeated the
	// mask's own work; the row/column tables below keep the per-texel loop free of
	// division as well, because at 140k texels even that shows.
	function makeDisplay(w) {
		const cell = w.sub;
		const nx = Math.ceil(G.SIZE / cell);
		const ny = Math.ceil((G.SIZE + 2 * G.POUR) / cell);
		const n = nx * ny;
		const field = {
			cell, nx, ny,
			// air: the texel's water cell is open; solid: the texel itself is metal.
			// level: the waterline the texel sees; a Float32 is a picture, not physics.
			// surf: the top of each column's water, NaN where the column is dry.
			air: new Uint8Array(n),
			solid: new Uint8Array(n),
			level: new Float32Array(n),
			surf: new Float32Array(nx),
			// Water cell row/column of each display row/column, and the fine sample
			// row, so sampleDisplay indexes arrays instead of dividing.
			wrow: new Int32Array(ny),
			wcol: new Int32Array(nx),
			frow: new Int32Array(ny),
		};
		for (let gx = 0; gx < nx; gx++) {
			field.wcol[gx] = Math.min(w.nx - 1, Math.floor(((gx + 0.5) * cell) / w.cell));
		}
		for (let gy = 0; gy < ny; gy++) {
			const y = (gy + 0.5) * cell - G.POUR;
			field.wrow[gy] = Math.min(w.ny - 1, Math.max(0, Math.floor((y + G.POUR) / w.cell)));
			// The display grid is the sample grid, so the fine row is the display row
			// itself as long as it stays inside the mask.
			field.frow[gy] = gy < w.fny ? gy : w.fny - 1;
		}
		return field;
	}

	// Per column, walk up from the bottom: the waterline a pixel belongs to is the
	// highest surface of the wet column below it, reset by metal. That fills a pool
	// upward through the air that touches it without needing the display to solve
	// connectivity: the solver already decided where water is, this only decides
	// how far up its level reaches inside one vertical run.
	function sampleDisplay(sim, field) {
		const w = sim.water;
		const nx = field.nx;
		const ny = field.ny;
		const air = field.air;
		const solid = field.solid;
		const level = field.level;
		const surf = field.surf;
		const wair = w.air;
		const levels = w.levels;
		const fine = w.fine;
		const wnx = w.nx;
		const fnx = w.fnx;
		for (let gx = 0; gx < nx; gx++) {
			const wi0 = field.wcol[gx];
			const fx = gx < fnx ? gx : fnx - 1;
			let top = Infinity;
			let wet = Infinity;
			for (let gy = ny - 1, i = (ny - 1) * nx + gx; gy >= 0; gy--, i -= nx) {
				const wi = field.wrow[gy] * wnx + wi0;
				if (!wair[wi]) {
					// Metal ends the vertical run: a pool above it is another pool.
					air[i] = 0;
					solid[i] = 1;
					level[i] = Infinity;
					top = Infinity;
					continue;
				}
				const s = levels[wi];
				if (s < top) top = s;
				air[i] = 1;
				// The water cell is open, but this texel can still be a wall band the
				// cell's single sample never saw; the mask's fine grid knows.
				solid[i] = fine[field.frow[gy] * fnx + fx] === 0 ? 1 : 0;
				level[i] = top;
				const y = (gy + 0.5) * field.cell - G.POUR;
				if (y > top) wet = top;
			}
			surf[gx] = wet;
		}
	}

	// ---- supply, drain, overflow -------------------------------------------

	function mouthIndex(w) {
		const x = (w.ventColumn + 0.5) * G.S;
		return MOUTH_ROW * w.nx + Math.min(w.nx - 1, Math.floor(x / w.cell));
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
			const v = w.vol[i];
			if (v <= 0) continue;
			const gy = (i / w.nx) | 0;
			if (gy <= OVERFLOW_ROW) { w.overflowed += v; w.vol[i] = 0; }
			else if (gy * c - G.POUR >= G.SIZE) { w.drained += v; w.vol[i] = 0; }
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

	// Live count for panels and fixtures; w.wetCount is last step's snapshot.
	function wetCount(w) {
		const list = w.airList;
		let n = 0;
		for (let k = 0; k < w.airCount; k++) if (w.vol[list[k]] > EPS) n++;
		return n;
	}

	// ---- public API --------------------------------------------------------

	function step(sim, h) {
		const w = sim.water;
		if (!w || !w.enabled) { clearLevels(sim); return; }
		if (!w.built || sim.clock - w.maskClock >= MASK_DT) {
			rebuild(sim);
			w.maskClock = sim.clock;
		}
		// displace() publishes the waterline snapshot; the relaxation below only
		// then moves water, so grains never read a level this step created.
		displace(sim);
		supply(sim, h);
		relax(w, RELAX_ITERS);
		boundaries(sim);
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
		return q / M3_PER_PX2;
	}

	// Slice area -> m^3 through the shared depth and length scales.
	function volumeSI(px2) {
		return px2 * M3_PER_PX2;
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
		w.layoutSeen.fill(-1);
		w.levels.fill(NaN);
		w.levelUp.fill(NaN);
		w.levelsLive = false;
	}

	// True where a display texel is inside the metal: the fill must never paint
	// there, and its own passability is borrowed from a whole 6 px cell, so it can
	// sit a pixel into a wall band at a passage edge.
	function solidAt(layout, x, y) {
		return G.airClearance(layout, x, y) <= 0;
	}

	return {
		CELL, SUBDIV, WATER_MIN, DEPTH_PX, M_PER_PX, M3_PER_PX2, DEFAULT_RATE, RELAX_ITERS, MASK_DT, DRY_SKIP,
		create, step, rebuild, relax, settle, displace, clearLevels, publishLevels,
		makeDisplay, sampleDisplay, solidAt, segFraction, submerged,
		setVent, setSupply, supplyFromSI, volumeSI, drainAll, reset,
		totalVol, storedVol, wetCount, surface, surfaceAt, mouthIndex,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveWater;
