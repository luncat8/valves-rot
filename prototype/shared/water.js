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
	// Red, green, blue channels per cell: the conserved liquid state.
	const CH = 3;
	// Effective densities of the liquid families, from the grain palette, so a
	// melt or a freeze moves between materials of one density family: dense red,
	// neutral (the *teal* grain's value, not the 800 green one) and buoyant blue.
	// The colours are named by hue, the densities by family.
	const LIQUID_DENSITY = [2000, 1000, 500];
	// Every mixable channel is one homogeneous phase at this density, so the
	// all-mixable case is exactly the single-liquid solver of the baseline.
	const MIXED_DENSITY = 1000;
	// Share of the smaller cell's capacity a vertical pair may exchange per pass.
	// Bounded so a swap is a quasi-static settle step, not a teleport.
	const SWAP_FRAC = 0.5;
	// Ids of the two books a whole cell can be emptied into.
	const OVERFLOW = 0;
	const DRAINED = 1;

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
			// The only conserved liquid state: R, G, B slice area per cell, three
			// adjacent values so one move walks a cell without a second index.
			ch: new Float64Array(count * CH),
			// vol is a cache of the channel sum. The level solver, displacement and
			// every reader of a cell total keep using it; the channels rule, and the
			// fixtures publish the residual instead of trusting this to be exact.
			vol: new Float64Array(count),
			// Water a closing wall could not route: the rotor carries it until the
			// passage reopens. Kept so split/merge conserves volume exactly.
			trapped: new Float64Array(count),
			trappedCh: new Float64Array(count * CH),
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
			// Equal shares over the selected pour channels. Kept normalized by
			// setPour; deposit normalizes again so a hand-written mask cannot
			// change the delivered volume.
			pour: new Float64Array(CH),
			pourMask: new Uint8Array(CH),
			// Mixability flags partition the channels into phases. They are state,
			// but the phases themselves are derived, so a toggle can neither move
			// nor lose liquid: only the table below is rewritten.
			mixable: new Uint8Array(CH),
			// Derived partition, rebuilt by setMixable: the phase of each channel,
			// that phase's density, the phase ids in density order (densest first)
			// and how many phases there are. One phase => the mixed baseline.
			phaseOf: new Int32Array(CH),
			phaseRho: new Float64Array(CH),
			order: new Int32Array(CH),
			phaseCount: 0,
			// Published per cell, one slot per rank in density order: the top y of
			// that phase's band (NaN = the rank is absent) and its density. The
			// bands are what buoyancy and the layered fill read, so a cell's layers
			// are a snapshot of the last step like the waterline.
			band: new Float64Array(count * CH),
			bandRho: new Float64Array(count * CH),
			// Scratch phase volumes of one cell, and of a pair, so a pass allocates
			// nothing.
			pvA: new Float64Array(CH),
			pvB: new Float64Array(CH),
			attempted: 0,
			admitted: 0,
			unadmitted: 0,
			overflowed: 0,
			drained: 0,
			// Per-channel books: initial + admitted = stored + overflowed + drained.
			// `initial` is what a fixture or scenario imposes by hand, so a direct
			// injection is a boundary term rather than a hidden source.
			chInitial: new Float64Array(CH),
			chAttempted: new Float64Array(CH),
			chAdmitted: new Float64Array(CH),
			chUnadmitted: new Float64Array(CH),
			chOverflowed: new Float64Array(CH),
			chDrained: new Float64Array(CH),
		};
		w.pour.fill(1 / CH);
		w.pourMask.fill(1);
		w.mixable.fill(1);
		w.band.fill(NaN);
		derivePhases(w);
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

	// ---- channels ----------------------------------------------------------
	//
	// Liquid moves only through move() or deposit(). Anything else would be a way
	// to carry (or lose) a channel on one path and not on the mirrored one, and
	// proportional shares are exactly what is easy to forget: the closed-cell
	// push, the trapped return, a drain and a sill spill all move the same liquid.

	// Add `area` to a three-slot channel triple at `o`, split by `shares`. The last
	// channel takes the remainder, so the triple gains exactly the area whatever
	// the rounding of the first two shares. False when `shares` is empty.
	function addSplit(dst, o, area, shares) {
		const sum = shares[0] + shares[1] + shares[2];
		if (!(sum > 0)) return false;
		const a0 = area * shares[0] / sum;
		const a1 = area * shares[1] / sum;
		dst[o] += a0;
		dst[o + 1] += a1;
		dst[o + 2] += area - a0 - a1;
		return true;
	}

	// Add `area` to a cell, split across its channels by `shares` (default: the
	// pour mix).
	function deposit(w, i, area, shares) {
		if (!(area > 0)) return;
		if (!addSplit(w.ch, i * CH, area, shares || w.pour)) return;
		w.vol[i] += area;
	}

	// Move `area` from one cell to another, splitting it across the donor's
	// channels in proportion. The LARGEST channel takes the rounding remainder,
	// not the last one: every other share is a product with a factor below one,
	// so it cannot exceed its own channel, while a remainder charged to an empty
	// channel is exactly how a couple of ulps of rounding become a negative
	// inventory. The largest channel is at least a third of the move, so the
	// remainder is far from both bounds; the clamps are the last-ulp guard for a
	// move within an ulp of the cell's whole contents. The cache then advances by
	// what actually moved, so a clamp can never make it under-report either.
	function move(w, from, to, area) {
		if (!(area > 0)) return;
		const ch = w.ch;
		const total = w.vol[from];
		if (!(total > 0)) return;
		if (area > total) area = total;
		const f = from * CH;
		const t = to * CH;
		let m0;
		let m1;
		let m2;
		if (area >= total) {
			// Emptying the cell moves every channel exactly, so a drained cell
			// keeps no rounding residue.
			m0 = ch[f];
			m1 = ch[f + 1];
			m2 = ch[f + 2];
		} else {
			const r = area / total;
			let big = 0;
			if (ch[f + 1] > ch[f]) big = 1;
			if (ch[f + 2] > ch[f + big]) big = 2;
			m0 = big === 0 ? 0 : ch[f] * r;
			m1 = big === 1 ? 0 : ch[f + 1] * r;
			m2 = big === 2 ? 0 : ch[f + 2] * r;
			if (big === 0) m0 = area - m1 - m2;
			else if (big === 1) m1 = area - m0 - m2;
			else m2 = area - m0 - m1;
		}
		if (!(m0 >= 0)) m0 = 0;
		else if (m0 > ch[f]) m0 = ch[f];
		if (!(m1 >= 0)) m1 = 0;
		else if (m1 > ch[f + 1]) m1 = ch[f + 1];
		if (!(m2 >= 0)) m2 = 0;
		else if (m2 > ch[f + 2]) m2 = ch[f + 2];
		ch[f] -= m0; ch[t] += m0;
		ch[f + 1] -= m1; ch[t + 1] += m1;
		ch[f + 2] -= m2; ch[t + 2] += m2;
		const moved = m0 + m1 + m2;
		w.vol[from] = total - moved;
		w.vol[to] += moved;
	}

	// ---- phases ------------------------------------------------------------
	//
	// A phase is a group of channels, not a stored fluid: the mixability flags
	// partition R/G/B into at most three groups, so toggling a checkbox rewrites
	// this table and nothing else. A phase's volume in a cell is the sum of its
	// channels, which means split and merge are bit-neutral by construction.

	function derivePhases(w) {
		const mixable = w.mixable;
		const of = w.phaseOf;
		const rho = w.phaseRho;
		let mixId = -1;
		let n = 0;
		for (let k = 0; k < CH; k++) {
			if (mixable[k]) {
				if (mixId < 0) {
					mixId = n++;
					rho[mixId] = MIXED_DENSITY;
				}
				of[k] = mixId;
				continue;
			}
			of[k] = n;
			rho[n++] = LIQUID_DENSITY[k];
		}
		// Density order, densest first (insertion sort; at most three entries).
		const order = w.order;
		for (let i = 0; i < n; i++) order[i] = i;
		for (let i = 1; i < n; i++) {
			const p = order[i];
			let j = i - 1;
			while (j >= 0 && rho[order[j]] < rho[p]) { order[j + 1] = order[j]; j--; }
			order[j + 1] = p;
		}
		w.phaseCount = n;
	}

	// Phase volumes of one cell into `out` (indexed by phase id).
	function phaseVols(w, i, out) {
		const of = w.phaseOf;
		const ch = w.ch;
		const o = i * CH;
		const n = w.phaseCount;
		for (let p = 0; p < n; p++) out[p] = 0;
		for (let k = 0; k < CH; k++) out[of[k]] += ch[o + k];
	}

	function phaseVol(w, i, p) {
		const of = w.phaseOf;
		const ch = w.ch;
		const o = i * CH;
		let v = 0;
		for (let k = 0; k < CH; k++) if (of[k] === p) v += ch[o + k];
		return v;
	}

	// Move `area` of ONE phase, split across that phase's channels in proportion.
	// Same rounding rule as move(): the phase's LARGEST channel takes the
	// remainder, so no share can exceed its channel and a phase can never gain a
	// negative channel. A phase that leaves completely moves its channels
	// exactly, so no rounding residue stays in an emptied cell.
	function movePhase(w, from, to, p, area) {
		if (!(area > 0)) return;
		const of = w.phaseOf;
		const ch = w.ch;
		const f = from * CH;
		const t = to * CH;
		let pv = 0;
		let big = -1;
		for (let k = 0; k < CH; k++) {
			if (of[k] !== p) continue;
			pv += ch[f + k];
			if (big < 0 || ch[f + k] > ch[f + big]) big = k;
		}
		if (!(pv > 0) || big < 0) return;
		if (area > pv) area = pv;
		if (area >= pv) {
			let moved = 0;
			for (let k = 0; k < CH; k++) {
				if (of[k] !== p) continue;
				const v = ch[f + k];
				ch[f + k] = 0;
				ch[t + k] += v;
				moved += v;
			}
			w.vol[from] -= moved;
			w.vol[to] += moved;
			return;
		}
		const r = area / pv;
		let moved = 0;
		for (let k = 0; k < CH; k++) {
			if (of[k] !== p) continue;
			if (k === big) continue;
			const m = ch[f + k] * r;
			ch[f + k] -= m;
			ch[t + k] += m;
			moved += m;
		}
		let rest = area - moved;
		if (!(rest >= 0)) rest = 0;
		else if (rest > ch[f + big]) rest = ch[f + big];
		ch[f + big] -= rest;
		ch[t + big] += rest;
		moved += rest;
		w.vol[from] -= moved;
		w.vol[to] += moved;
	}

	// A closing wall's unreachable remainder: the rotor carries exactly the
	// composition it could not route.
	function trap(w, i) {
		if (!(w.vol[i] > 0)) return;
		const o = i * CH;
		for (let k = 0; k < CH; k++) {
			w.trappedCh[o + k] += w.ch[o + k];
			w.ch[o + k] = 0;
		}
		w.trapped[i] += w.vol[i];
		w.vol[i] = 0;
	}

	function releaseTrapped(w, i) {
		if (!(w.trapped[i] > 0)) return;
		const o = i * CH;
		for (let k = 0; k < CH; k++) {
			w.ch[o + k] += w.trappedCh[o + k];
			w.trappedCh[o + k] = 0;
		}
		w.vol[i] += w.trapped[i];
		w.trapped[i] = 0;
	}

	// Empty one cell into an overflow or drain book and report the area taken.
	function takeAll(w, i, book) {
		const o = i * CH;
		const into = book === OVERFLOW ? w.chOverflowed : w.chDrained;
		let sum = 0;
		for (let k = 0; k < CH; k++) {
			into[k] += w.ch[o + k];
			sum += w.ch[o + k];
			w.ch[o + k] = 0;
		}
		w.vol[i] = 0;
		return sum;
	}

	// Book an area whose channel split is given by `shares`; the same split as a
	// deposit, so the books close against the cell totals.
	function bookArea(book, area, shares) {
		if (area === 0 || !Number.isFinite(area)) return;
		addSplit(book, 0, area, shares);
	}

	// Impose a cell's liquid from outside (a fixture, a scenario, a future melt),
	// split by `shares`. Replaces whatever was there and books the actual channel
	// change as an opening inventory term, so replacing one mixture with another
	// still closes the ledger per channel.
	function setLiquid(w, i, area, shares) {
		const o = i * CH;
		const before = w.pvB;
		for (let k = 0; k < CH; k++) {
			before[k] = w.ch[o + k];
			w.ch[o + k] = 0;
		}
		w.vol[i] = 0;
		deposit(w, i, area, shares);
		for (let k = 0; k < CH; k++) w.chInitial[k] += w.ch[o + k] - before[k];
	}

	// Add liquid from outside and book it as an opening inventory term.
	function inject(w, i, area, shares) {
		if (!(area > 0)) return;
		deposit(w, i, area, shares);
		bookArea(w.chInitial, area, shares || w.pour);
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
			const stamp = ++w.seenStamp;
			let head = 0;
			let tail = 0;
			const gx = i % nx;
			const gy = (i / nx) | 0;
			if (gy > 0 && w.air[i - nx]) { seen[i - nx] = stamp; queue[tail++] = i - nx; }
			if (gy + 1 < ny && w.air[i + nx]) { seen[i + nx] = stamp; queue[tail++] = i + nx; }
			if (gx > 0 && w.air[i - 1]) { seen[i - 1] = stamp; queue[tail++] = i - 1; }
			if (gx + 1 < nx && w.air[i + 1]) { seen[i + 1] = stamp; queue[tail++] = i + 1; }
			// The donor keeps its composition while it empties, so every hop is a
			// proportional move and whatever is left is what the rotor carries.
			while (head < tail && w.vol[i] > EPS) {
				const j = queue[head++];
				const room = w.area[j] - w.vol[j];
				if (room > EPS) move(w, i, j, w.vol[i] < room ? w.vol[i] : room);
				if (w.vol[i] <= EPS) break;
				const jx = j % nx;
				const jy = (j / nx) | 0;
				if (jy > 0 && w.openS[j - nx] && w.air[j - nx] && seen[j - nx] !== stamp) { seen[j - nx] = stamp; queue[tail++] = j - nx; }
				if (jy + 1 < ny && w.openS[j] && w.air[j + nx] && seen[j + nx] !== stamp) { seen[j + nx] = stamp; queue[tail++] = j + nx; }
				if (jx > 0 && w.openE[j - 1] && w.air[j - 1] && seen[j - 1] !== stamp) { seen[j - 1] = stamp; queue[tail++] = j - 1; }
				if (jx + 1 < nx && w.openE[j] && w.air[j + 1] && seen[j + 1] !== stamp) { seen[j + 1] = stamp; queue[tail++] = j + 1; }
			}
			if (w.vol[i] > EPS) trap(w, i);
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
		for (let i = 0; i < w.count; i++) if (w.air[i]) releaseTrapped(w, i);
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
	// The liquid that leaves a cell is its bottom-most layer first going down,
	// so a donor keeps its lightest phase and the heavy one pools below; an
	// overfull lower cell sheds the top of its column going up.
	function verticalTransfer(w, u, d) {
		const total = w.vol[u] + w.vol[d];
		if (total <= EPS) return;
		const capD = effCap(w, d);
		const newD = total < capD ? total : capD;
		const delta = newD - w.vol[d];
		if (delta > 0) drain(w, u, d, delta, true);
		else if (delta < 0) drain(w, d, u, -delta, false);
	}

	// Move `area` out of a cell in density order: heaviest first downward, from
	// the donor's bottom, lightest first upward, off the top of the column. One
	// phase is the mixed baseline, which stays on move() so the reference
	// solver is untouched.
	function drain(w, from, to, area, down) {
		if (w.phaseCount < 2) {
			move(w, from, to, area);
			return;
		}
		const order = w.order;
		const n = w.phaseCount;
		for (let k = 0; k < n && area > EPS; k++) {
			const p = down ? order[k] : order[n - 1 - k];
			const v = phaseVol(w, from, p);
			if (!(v > 0)) continue;
			const take = v < area ? v : area;
			movePhase(w, from, to, p, take);
			area -= take;
		}
	}

	// A heavier phase sitting above a lighter one is unstable. Swap equal slice
	// areas across an open vertical face, heavy down and light up: both cells
	// keep their total, so the published surface does not move with a swap.
	function verticalOrder(w, u, d) {
		const n = w.phaseCount;
		if (n < 2) return;
		const order = w.order;
		const uv = w.pvA;
		const dv = w.pvB;
		phaseVols(w, u, uv);
		phaseVols(w, d, dv);
		let ph = -1;
		let pl = -1;
		for (let r = 0; r < n; r++) {
			if (uv[order[r]] > EPS) { ph = order[r]; break; }
		}
		for (let r = n - 1; r >= 0; r--) {
			if (dv[order[r]] > EPS) { pl = order[r]; break; }
		}
		if (ph < 0 || pl < 0 || ph === pl) return;
		if (!(w.phaseRho[ph] > w.phaseRho[pl])) return;
		let amount = uv[ph] < dv[pl] ? uv[ph] : dv[pl];
		const capU = effCap(w, u);
		const capD = effCap(w, d);
		const cap = SWAP_FRAC * (capU < capD ? capU : capD);
		if (amount > cap) amount = cap;
		if (amount <= EPS) return;
		movePhase(w, u, d, ph, amount);
		movePhase(w, d, u, pl, amount);
	}

	// Heavy beside light at one surface is the lock-exchange setup: the surface
	// solver reads it as settled and freezes, with the light phase trapped
	// beside the heavy one instead of above it. Trade heavy for light down the
	// lateral mean-density gradient: the heavier cell gives its heaviest phase
	// and the lighter cell its lightest, in equal areas so both totals keep.
	// The bound below lands the means at worst equal, never crossed — the
	// totals keep, so the means move linearly and the cap is exact — which is
	// what keeps the trade from oscillating around equality. Each firing
	// strictly narrows the contrast, and the vertical swaps then cash the
	// traded phases into sorted columns. Equal-density phases never trade, so
	// a mixed pool stays still.
	function horizontalOrder(w, l, r) {
		const n = w.phaseCount;
		if (n < 2) return;
		const vl = w.vol[l];
		const vr = w.vol[r];
		if (!(vl > EPS) || !(vr > EPS)) return;
		const lv = w.pvA;
		const rv = w.pvB;
		phaseVols(w, l, lv);
		phaseVols(w, r, rv);
		let ml = 0;
		let mr = 0;
		for (let p = 0; p < n; p++) {
			ml += lv[p] * w.phaseRho[p];
			mr += rv[p] * w.phaseRho[p];
		}
		ml /= vl;
		mr /= vr;
		if (ml === mr) return;
		const heavyLeft = ml > mr;
		const av = heavyLeft ? lv : rv;
		const bv = heavyLeft ? rv : lv;
		const ai = heavyLeft ? l : r;
		const bi = heavyLeft ? r : l;
		const order = w.order;
		let ph = -1;
		let pl = -1;
		for (let k = 0; k < n; k++) {
			if (av[order[k]] > EPS) { ph = order[k]; break; }
		}
		for (let k = n - 1; k >= 0; k--) {
			if (bv[order[k]] > EPS) { pl = order[k]; break; }
		}
		if (ph < 0 || pl < 0) return;
		const drho = w.phaseRho[ph] - w.phaseRho[pl];
		if (!(drho > 0)) return;
		const diff = heavyLeft ? ml - mr : mr - ml;
		const va = heavyLeft ? vl : vr;
		const vb = heavyLeft ? vr : vl;
		let amount = diff / (drho * (1 / va + 1 / vb));
		const avail = av[ph] < bv[pl] ? av[ph] : bv[pl];
		if (amount > avail) amount = avail;
		const capA = effCap(w, ai);
		const capB = effCap(w, bi);
		const cap = SWAP_FRAC * (capA < capB ? capA : capB);
		if (amount > cap) amount = cap;
		if (amount <= EPS) return;
		movePhase(w, ai, bi, ph, amount);
		movePhase(w, bi, ai, pl, amount);
	}

	// Horizontal face: equalize surfaces, but the source cannot drain below the
	// face sill and the destination cannot exceed its capacity. Only the phases
	// that reach above the sill spill, lightest first: the top of a stratified
	// column is what crosses a lip.
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
		if (w.phaseCount < 2) {
			move(w, src, dst, amt);
			return;
		}
		// The spill walks the source's phases top-down against one budget: amt is
		// already capped by the receiver's room, so each phase is capped by its
		// own volume and what the budget still allows.
		const order = w.order;
		const sv = w.pvA;
		phaseVols(w, src, sv);
		let budget = amt;
		for (let k = w.phaseCount - 1; k >= 0 && budget > EPS; k--) {
			const p = order[k];
			let take = sv[p];
			if (take > budget) take = budget;
			if (take <= EPS) continue;
			movePhase(w, src, dst, p, take);
			budget -= take;
		}
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
				if (vol[i] > EPS || vol[d] > EPS) {
					verticalTransfer(w, i, d);
					// A swap needs liquid on both sides of the face to exchange.
					if (vol[i] > EPS && vol[d] > EPS) verticalOrder(w, i, d);
				}
			}
			if (w.openE[i]) {
				const r = i + 1;
				if (vol[i] > EPS || vol[r] > EPS) {
					horizontalTransfer(w, i, r, w.sillE[i]);
					if (vol[i] > EPS && vol[r] > EPS) horizontalOrder(w, i, r);
				}
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
	// Per-cell phase bands, densest first, as the top y of each rank's layer and
	// that layer's density. A cell's liquid is stratified here, not stored: the
	// bands are a monotone partition of the occupied height by phase volume, so
	// an absent phase has no slot and the ranks stay contiguous. The top rank's
	// boundary is the published waterline, so a brim-full cell's disc reads the
	// liquid covering it instead of a ceiling.
	function publishBands(w, i, level) {
		const base = i * CH;
		const pv = w.pvA;
		phaseVols(w, i, pv);
		let v = 0;
		for (let p = 0; p < w.phaseCount; p++) v += pv[p];
		if (!(v > EPS)) {
			for (let r = 0; r < CH; r++) w.band[base + r] = NaN;
			return 0;
		}
		const order = w.order;
		const floor = w.floor[i];
		// The splits partition the cell's own occupied height, so a full cell
		// deep in the pool keeps its layers inside itself; only the top rank
		// reaches the run waterline, so a grain there still reads the liquid
		// covering it. A split above the waterline is a transient overfull cell
		// and clamps to the waterline, keeping the bands monotone.
		let occ = v / w.width[i];
		const tall = floor - w.ceil[i];
		if (occ > tall) occ = tall;
		let cum = 0;
		let rank = 0;
		let light = 0;
		for (let r = 0; r < w.phaseCount; r++) {
			const p = order[r];
			const vp = pv[p];
			if (!(vp > EPS)) continue;
			cum += vp;
			let top = cum >= v ? level : floor - occ * cum / v;
			if (top < level) top = level;
			w.band[base + rank] = top;
			w.bandRho[base + rank] = w.phaseRho[p];
			light = w.phaseRho[p];
			rank++;
		}
		for (let r = rank; r < CH; r++) w.band[base + r] = NaN;
		return light;
	}

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
					for (let r = 0; r < CH; r++) w.band[i * CH + r] = NaN;
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
				let light = 0;
				let below = -1;
				for (let r = end; r >= fillTop; r--) {
					const j = r * nx + gx;
					levels[j] = level;
					up[j] = level;
					const rho = publishBands(w, j, level);
					if (rho > 0) {
						if (light <= 0 || rho < light) light = rho;
						below = j;
						continue;
					}
					// A hole inside the pool: at or below the surface but holding
					// no liquid of its own, transiently or emptied by the grain in
					// it. Its waterline reads wet, so its bands must too: it borrows
					// the water below it, which is what a grain there stands in.
					const dst = j * CH;
					if (below < 0) {
						w.band[dst] = level;
						w.bandRho[dst] = MIXED_DENSITY;
						for (let s = 1; s < CH; s++) w.band[dst + s] = NaN;
						continue;
					}
					const src = below * CH;
					for (let s = 0; s < CH; s++) {
						w.band[dst + s] = w.band[src + s];
						w.bandRho[dst + s] = w.bandRho[src + s];
					}
				}
				for (let r = row; r < fillTop; r++) {
					const j = r * nx + gx;
					// Dry air above this run's waterline. The relaxation may still
					// owe it water (and the cell a grain sits in may be one of
					// them), so a short gap still sees the pool; a long dry shaft
					// must not borrow a level from below.
					levels[j] = NaN;
					const reach = fillTop - r <= DRY_SKIP;
					up[j] = reach ? level : NaN;
					// A cell that is dry but inside the pool's reach is one layer:
					// the liquid's lightest phase sits on top of the run.
					const base = j * CH;
					w.band[base] = reach ? level : NaN;
					w.bandRho[base] = light > 0 ? light : MIXED_DENSITY;
					for (let s = 1; s < CH; s++) w.band[base + s] = NaN;
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
			// Normalized channel triple of each phase layer, one slot per density
			// rank (rank * 3 + channel), computed once a frame so a texel copies
			// bytes instead of dividing channels. A rank is a phase's own channels,
			// so a separated layer reads its hue and a mixture keeps its ratio.
			color: new Uint8Array(w.count * CH * CH),
			// Bands are the solver's snapshot, not a copy: the texel loop only reads
			// the top y of each layer and the rank count.
			band: w.band,
			rank: new Uint8Array(w.count),
			// Triple offset of each display row and column, so the texel loop
			// addresses the colour table with two adds and no multiply.
			crow: new Int32Array(ny),
			ccol: new Int32Array(nx),
			// Water cell row/column of each display row/column, and the fine sample
			// row, so sampleDisplay indexes arrays instead of dividing.
			wrow: new Int32Array(ny),
			wcol: new Int32Array(nx),
			frow: new Int32Array(ny),
			// Water-cell, colour-slot and band-slot offsets, so the texel loop adds
			// instead of multiplying.
			crowCell: new Int32Array(ny),
			brow: new Int32Array(ny),
			bcol: new Int32Array(nx),
		};
		for (let gx = 0; gx < nx; gx++) {
			field.wcol[gx] = Math.min(w.nx - 1, Math.floor(((gx + 0.5) * cell) / w.cell));
			field.ccol[gx] = field.wcol[gx] * CH * CH;
			field.bcol[gx] = field.wcol[gx] * CH;
		}
		for (let gy = 0; gy < ny; gy++) {
			const y = (gy + 0.5) * cell - G.POUR;
			field.wrow[gy] = Math.min(w.ny - 1, Math.max(0, Math.floor((y + G.POUR) / w.cell)));
			field.crow[gy] = field.wrow[gy] * w.nx * CH * CH;
			field.crowCell[gy] = field.wrow[gy] * w.nx;
			field.brow[gy] = field.wrow[gy] * w.nx * CH;
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
		// One normalized triple per phase layer of each water cell: I[k] = 255 *
		// ch[k] / max(ch over that phase). Equal shares read white, a dilute colour
		// keeps its hue at any dilution, and a separated layer reads its own channel
		// because a phase is a group of channels and nothing else. A picture, not an
		// intensity: the solver's channels decide, this only maps them to bytes.
		const color = field.color;
		const rank = field.rank;
		const ch = w.ch;
		const of = w.phaseOf;
		const pv = w.pvA;
		const n = w.phaseCount;
		for (let k = 0, count = w.airCount; k < count; k++) {
			const i = w.airList[k];
			const base = i * CH * CH;
			phaseVols(w, i, pv);
			let slot = 0;
			for (let r = 0; r < n; r++) {
				const p = w.order[r];
				if (!(pv[p] > EPS)) continue;
				const o = i * CH;
				let m = 0;
				for (let c = 0; c < CH; c++) {
					if (of[c] === p && ch[o + c] > m) m = ch[o + c];
				}
				const out = base + slot * CH;
				for (let c = 0; c < CH; c++) {
					color[out + c] = of[c] === p ? Math.round(255 * ch[o + c] / m) : 0;
				}
				slot++;
			}
			for (let s = slot; s < CH; s++) {
				const out = base + s * CH;
				color[out] = 0;
				color[out + 1] = 0;
				color[out + 2] = 0;
			}
			rank[i] = slot;
		}
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
		bookArea(w.chAttempted, want, w.pour);
		const i = mouthIndex(w);
		// A metal mouth is blocked: the supply never enters. An open mouth admits
		// everything; if the system below is full the relaxation backs the excess
		// out of the top boundary as overflow, never behind a wall.
		if (!w.air[i]) {
			w.unadmitted += want;
			bookArea(w.chUnadmitted, want, w.pour);
			return;
		}
		deposit(w, i, want, w.pour);
		w.admitted += want;
		bookArea(w.chAdmitted, want, w.pour);
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
			if (gy <= OVERFLOW_ROW) w.overflowed += takeAll(w, i, OVERFLOW);
			else if (gy * c - G.POUR >= G.SIZE) w.drained += takeAll(w, i, DRAINED);
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

	// Equal pour shares over the selected channels. An empty selection is refused
	// so the inlet can never fall back to a default mix behind the player's back.
	function setPour(w, mask) {
		let n = 0;
		for (let k = 0; k < CH; k++) n += mask && mask[k] ? 1 : 0;
		if (n === 0) return false;
		for (let k = 0; k < CH; k++) {
			w.pourMask[k] = mask && mask[k] ? 1 : 0;
			w.pour[k] = w.pourMask[k] ? 1 / n : 0;
		}
		return true;
	}

	// Mixability is state, but the phases are derived from it, so this only
	// records the flags and rebuilds the partition table: no channel moves and no
	// volume can change, so split and merge cannot lose a drop.
	function setMixable(w, mask) {
		for (let k = 0; k < CH; k++) w.mixable[k] = mask && mask[k] ? 1 : 0;
		derivePhases(w);
	}

	// Per-channel stored area, including what rotors are carrying, into `out`.
	function channelTotals(w, out) {
		const ch = w.ch;
		const tc = w.trappedCh;
		let a = 0;
		let b = 0;
		let c = 0;
		for (let i = 0; i < w.count; i++) {
			const o = i * CH;
			a += ch[o] + tc[o];
			b += ch[o + 1] + tc[o + 1];
			c += ch[o + 2] + tc[o + 2];
		}
		out[0] = a;
		out[1] = b;
		out[2] = c;
		return out;
	}

	// Largest |vol - sum(channels)| over all cells: the cache invariant the
	// fixtures publish instead of assuming, NaN if any value went bad.
	function residual(w) {
		const ch = w.ch;
		let max = 0;
		for (let i = 0; i < w.count; i++) {
			const o = i * CH;
			const d = Math.abs(w.vol[i] - (ch[o] + ch[o + 1] + ch[o + 2]));
			if (d !== d) return NaN;
			if (d > max) max = d;
		}
		return max;
	}

	// Supply rate from SI: Q m^3/s spread over the slice depth becomes px^2/s.
	function supplyFromSI(q) {
		return q / M3_PER_PX2;
	}

	// Slice area -> m^3 through the shared depth and length scales.
	function volumeSI(px2) {
		return px2 * M3_PER_PX2;
	}

	// Empty every pool and every rotor-carried remainder, book per channel, and
	// report the area that left.
	function drainAll(w) {
		let v = 0;
		for (let i = 0; i < w.count; i++) {
			if (w.trapped[i] > 0) {
				const o = i * CH;
				for (let k = 0; k < CH; k++) {
					w.chDrained[k] += w.trappedCh[o + k];
					w.trappedCh[o + k] = 0;
				}
				v += w.trapped[i];
				w.trapped[i] = 0;
			}
			if (w.vol[i] > 0) v += takeAll(w, i, DRAINED);
		}
		w.drained += v;
		return v;
	}

	function reset(w) {
		w.ch.fill(0);
		w.vol.fill(0);
		w.trapped.fill(0);
		w.trappedCh.fill(0);
		w.gdisp.fill(0);
		w.attempted = 0;
		w.admitted = 0;
		w.unadmitted = 0;
		w.overflowed = 0;
		w.drained = 0;
		w.chInitial.fill(0);
		w.chAttempted.fill(0);
		w.chAdmitted.fill(0);
		w.chUnadmitted.fill(0);
		w.chOverflowed.fill(0);
		w.chDrained.fill(0);
		w.ventOpen = false;
		w.built = false;
		w.maskClock = 0;
		w.stamp.fill(NaN);
		w.layoutSeen.fill(-1);
		w.levels.fill(NaN);
		w.levelUp.fill(NaN);
		w.band.fill(NaN);
		w.levelsLive = false;
		derivePhases(w);
	}

	// True where a display texel is inside the metal: the fill must never paint
	// there, and its own passability is borrowed from a whole 6 px cell, so it can
	// sit a pixel into a wall band at a passage edge.
	function solidAt(layout, x, y) {
		return G.airClearance(layout, x, y) <= 0;
	}

	return {
		CELL, SUBDIV, WATER_MIN, DEPTH_PX, M_PER_PX, M3_PER_PX2, DEFAULT_RATE, RELAX_ITERS, MASK_DT, DRY_SKIP,
		LIQUID_DENSITY, MIXED_DENSITY, SWAP_FRAC,
		create, step, rebuild, relax, settle, displace, clearLevels, publishLevels, publishBands,
		makeDisplay, sampleDisplay, solidAt, segFraction, submerged,
		setVent, setSupply, setPour, setMixable, supplyFromSI, volumeSI, drainAll, reset,
		totalVol, storedVol, wetCount, surface, surfaceAt, mouthIndex,
		deposit, move, movePhase, setLiquid, inject, channelTotals, residual, CH,
		derivePhases, phaseVol, phaseVols,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveWater;
