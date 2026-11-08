// 0.4 thermodynamics: an enthalpy field on the water grid. One total-enthalpy
// number per cell covers the fixed metal, the liquid it holds and the grains
// that sit in it, including the latent book of the liquid; temperature is
// derived from that number and the cell's composition, never stored beside
// it, so a plateau can be pinned while a whole-grain threshold is still short
// of the energy it needs. Heat moves by conduction through metal and liquid
// faces under an explicit substep bound, by per-valve signed sources, by
// Newton loss to the room on the grid's outer ring, and with the material:
// every liquid parcel carries its sensible enthalpy at the donor's last
// published temperature plus its latent book, and every grain crossing moves
// its sensible energy exactly once. Phase change converts whole grains into
// channel liquid and channel liquid back into primary grains through the same
// enthalpy ledger with no external term: conversions are internal and cancel.
//
// Illustrative units, shared with the water grid: 1 mm/px, 10 mm slice depth,
// 1 mg per mass unit, so a px² of reference-density liquid is one mass unit
// and its latent book is `latent[k]` per px². A grain of solver mass m (mg)
// melts into m px² of liquid apportioned by MELT_SHARES; freezing m px² of
// channel k grows a grain of mass m of FREEZE_MAT[k] at radius
// sqrt(m*1000/rho). The reference liquid density is a thermal-mass
// approximation only: buoyancy still uses the colour plan's effective
// densities, so a melt changes a dense grain's slice area, visibly and
// without creating or losing mass.
const ValveHeat = (() => {
	"use strict";
	const G = typeof ValveGeometry !== "undefined" ? ValveGeometry : require("./geometry.js");
	const WATER = typeof ValveWater !== "undefined" ? ValveWater : require("./water.js");

	// The simulation module is grabbed lazily: simulation.js requires this
	// file at load, so a top-level require would be circular and half-built.
	let SIM = null;
	function simApi() {
		if (!SIM) SIM = typeof ValveSimulation !== "undefined" ? ValveSimulation : require("./simulation.js");
		return SIM;
	}

	const CH = 3;
	// Palette index is the material; each melts into channel shares by mass:
	// red (1,0,0), amber (½,½,0), teal (0,½,½), blue (0,0,1), pink (½,0,½),
	// green (0,1,0) — the actual indices, not the palette order.
	const MELT_SHARES = [
		[1, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0.5],
		[0, 0, 1], [0.5, 0, 0.5], [0, 1, 0],
	];
	// Freezing is per primary channel: R→red, G→light green, B→blue. Secondary
	// materials never re-form as alloys; an amber melt freezes into red and
	// green grains.
	const FREEZE_MAT = [0, 5, 3];
	// Deterministic placement probes per cell, channel and step.
	const PROBES = 6;

	// Every entry is a tuning choice with an explicit unit, not a calibration.
	// `conduct*` is per px of face per second, `ambientRate` per px of exterior
	// face per second, `*Heat` per mass unit per °C, `metalMass` per px² of
	// metal, `latent` per px² (mg) of channel liquid, `melt` the channel
	// plateau in °C.
	const PARAMS = {
		ambient: 20,
		metalHeat: 0.5,
		liquidHeat: 4.2,
		grainHeat: 1.2,
		metalMass: 2.7,
		conductMetal: 0.9,
		conductLiquid: 0.8,
		ambientRate: 0.05,
		substepCap: 4,
		latent: [60, 55, 50],
		melt: [120, 100, 80],
	};
	// Explicit diffusion margin, the nominal capacity of an empty passage, the
	// fixed step the parameter gate is validated against, and the channel
	// volume below which liquid is not a freezing reservoir.
	const STABILITY = 0.45;
	const DRY_CAP = 0.6;
	const STEP = 1 / 120;
	const CH_EPS = 1e-6;

	function copyParams() {
		const p = {};
		for (const k in PARAMS) {
			const v = PARAMS[k];
			p[k] = Array.isArray(v) ? v.slice() : v;
		}
		return p;
	}

	// A material melts at the highest plateau among its channels, so the
	// liquid it becomes is stable at that temperature instead of refreezing
	// one of its own halves on the spot.
	function materialMelt(p, mat) {
		const shares = MELT_SHARES[mat];
		let t = 0;
		for (let k = 0; k < CH; k++) if (shares[k] > 0 && p.melt[k] > t) t = p.melt[k];
		return t;
	}

	// Per-material melt points and the channels in freezing order (highest
	// plateau first, ties by index), both derived from the parameter table.
	function buildTables(h) {
		const p = h.p;
		for (let m = 0; m < MELT_SHARES.length; m++) h.matMelt[m] = materialMelt(p, m);
		const order = h.freezeOrder;
		for (let k = 0; k < CH; k++) order[k] = k;
		for (let k = 1; k < CH; k++) {
			const c = order[k];
			let j = k - 1;
			while (j >= 0 && p.melt[order[j]] < p.melt[c]) { order[j + 1] = order[j]; j--; }
			order[j + 1] = c;
		}
	}

	function create(sim) {
		const w = sim.water;
		if (!w) return null;
		const count = w.count;
		const valves = sim.layout.valves.length;
		const h = {
			kind: "heat",
			enabled: false,
			w,
			p: copyParams(),
			count,
			nx: w.nx,
			ny: w.ny,
			cell: w.cell,
			c2: w.cell * w.cell,
			// State: enthalpy rules; temperature and capacity are derived. H
			// covers metal, liquid and grain sensible energy plus the cell's
			// liquid latent book.
			H: new Float64Array(count),
			C: new Float64Array(count),
			T: new Float64Array(count),
			// Per-cell grain heat capacity and lowest melt point present,
			// rebuilt from the grain field every step through cgList.
			CG: new Float64Array(count),
			minMelt: new Float64Array(count),
			cgList: new Int32Array(count),
			cgCount: 0,
			// Per-channel freeze inventory (px²) of one cell: sub-grain
			// remainders wait here until a whole valid grain can be placed.
			frac: new Float64Array(count * CH),
			matMelt: new Float64Array(MELT_SHARES.length),
			freezeOrder: new Int32Array(CH),
			dead: new Uint8Array(sim.capacity),
			// Sampled open fraction, per-cell source weight (1 / owned cells)
			// and the exterior face length, all rebuilt from the water mask.
			open: new Float64Array(count),
			weight: new Float64Array(count),
			exterior: new Float64Array(count),
			ownerCount: new Int32Array(valves),
			power: new Float64Array(valves),
			cMin: DRY_CAP,
			maskSerial: -1,
			substeps: 0,
			// Ledger: stored = initial + source + ambient + material. Phase
			// conversion is internal and cancels; melted/frozen are masses (mg).
			initial: 0,
			source: 0,
			ambient: 0,
			material: 0,
			melted: 0,
			frozen: 0,
		};
		h.minMelt.fill(Infinity);
		buildTables(h);
		rebuild(h);
		// The machine sits in the room: the field opens at ambient and the
		// opening stock is the whole book, so the ledger starts closed.
		fill(h, h.p.ambient);
		// Water hooks, attached once. They no-op while disabled, so a parked
		// field keeps its books frozen while the water keeps moving.
		h.onFlow = (from, to, area, m0, m1, m2) => { if (h.enabled) flow(h, from, to, area, m0, m1, m2); };
		h.onEnter = (i, area, shares) => { if (h.enabled) enter(h, i, area, shares); };
		h.onLeave = (i, m0, m1, m2) => { if (h.enabled) leave(h, i, m0, m1, m2); };
		return h;
	}

	// Follow the water mask: a rotor turn changes which cells hold water, so
	// the open fraction, the owner weights and the exterior faces are
	// resampled. Enthalpy is kept, never discarded, so a turn cannot create
	// or lose heat.
	function rebuild(h) {
		const w = h.w;
		const n = h.count;
		const cell = h.cell;
		const counts = h.ownerCount;
		const owner = w.cellOwner;
		const nx = h.nx;
		const ny = h.ny;
		counts.fill(0);
		for (let i = 0; i < n; i++) {
			const o = w.area[i] / h.c2;
			h.open[i] = o > 1 ? 1 : o;
			const v = owner[i];
			if (v >= 0) counts[v]++;
		}
		for (let i = 0; i < n; i++) {
			const v = owner[i];
			h.weight[i] = v >= 0 && counts[v] > 0 ? 1 / counts[v] : 0;
			// The outer ring of the grid is the only face the room touches: the
			// mouth bands sit outside it, so an exterior cell loses heat on the
			// sides it has no neighbour on.
			const gx = i % nx;
			const gy = (i / nx) | 0;
			let sides = 0;
			if (gx === 0) sides++;
			if (gx === nx - 1) sides++;
			if (gy === 0) sides++;
			if (gy === ny - 1) sides++;
			h.exterior[i] = sides * cell;
		}
		h.maskSerial = w.serial;
		updateCapacity(h);
	}

	// Capacity: metal where the cell is not open, the liquid it holds (free
	// and rotor-carried), its grains, and a nominal floor so an empty passage
	// still has a finite temperature.
	function capacityAt(h, i) {
		const w = h.w;
		const p = h.p;
		let c = p.metalMass * p.metalHeat * (1 - h.open[i]) + p.liquidHeat * (w.vol[i] + w.trapped[i]) + h.CG[i];
		return c < DRY_CAP ? DRY_CAP : c;
	}

	function updateCapacity(h) {
		const C = h.C;
		let min = Infinity;
		for (let i = 0; i < h.count; i++) {
			const c = capacityAt(h, i);
			C[i] = c;
			if (c < min) min = c;
		}
		h.cMin = min;
	}

	// The latent book is derived from the channels, so it can never drift
	// from the liquid that is actually there.
	function latentOf(h, i) {
		const p = h.p;
		const ch = h.w.ch;
		const tc = h.w.trappedCh;
		const o = i * CH;
		return p.latent[0] * (ch[o] + tc[o]) + p.latent[1] * (ch[o + 1] + tc[o + 1]) + p.latent[2] * (ch[o + 2] + tc[o + 2]);
	}

	// Worst-case conductance and capacity give the explicit-diffusion bound; a
	// parameter set that needs more substeps than the budget is refused instead
	// of running unstable.
	function neededSubsteps(p, cMin, dt, cell) {
		const perPx = p.conductLiquid > p.conductMetal ? p.conductLiquid : p.conductMetal;
		const gMax = 4 * (cell * perPx + cell * p.ambientRate);
		if (!(gMax > 0)) return 1;
		const c = cMin < DRY_CAP ? cMin : DRY_CAP;
		return Math.ceil(dt / ((STABILITY * c) / gMax));
	}

	function substepsFor(h, dt) {
		const p = h.p;
		let n = neededSubsteps(p, h.cMin, dt, h.cell);
		if (n < 1) n = 1;
		if (n > p.substepCap) n = p.substepCap;
		h.substeps = n;
		return n;
	}

	function conduct(h, dt) {
		const H = h.H;
		const T = h.T;
		const open = h.open;
		const p = h.p;
		const nx = h.nx;
		const ny = h.ny;
		const kMetal = h.cell * p.conductMetal;
		const kRange = h.cell * (p.conductLiquid - p.conductMetal);
		let i = 0;
		for (let gy = 0; gy < ny; gy++) {
			for (let gx = 0; gx < nx; gx++, i++) {
				const oa = open[i];
				const ta = T[i];
				if (gx + 1 < nx) {
					const j = i + 1;
					const ob = open[j];
					// A face is only as open as its narrower side; metal conducts
					// too, so an all-metal boundary still carries heat.
					const o = oa < ob ? oa : ob;
					const dE = (kMetal + kRange * o) * (ta - T[j]) * dt;
					H[i] -= dE;
					H[j] += dE;
				}
				if (gy + 1 < ny) {
					const j = i + nx;
					const ob = open[j];
					const o = oa < ob ? oa : ob;
					const dE = (kMetal + kRange * o) * (ta - T[j]) * dt;
					H[i] -= dE;
					H[j] += dE;
				}
			}
		}
	}

	function ambient(h, dt) {
		const p = h.p;
		if (!(p.ambientRate > 0)) return;
		const H = h.H;
		const T = h.T;
		const ext = h.exterior;
		const n = h.count;
		const rate = p.ambientRate;
		const room = p.ambient;
		let into = 0;
		for (let i = 0; i < n; i++) {
			const f = ext[i];
			if (!(f > 0)) continue;
			const dE = rate * f * (room - T[i]) * dt;
			H[i] += dE;
			into += dE;
		}
		h.ambient += into;
	}

	function sources(h, dt) {
		const H = h.H;
		const power = h.power;
		const owner = h.w.cellOwner;
		const weight = h.weight;
		const n = h.count;
		let into = 0;
		for (let i = 0; i < n; i++) {
			const v = owner[i];
			if (v < 0) continue;
			const pw = power[v];
			if (pw === 0) continue;
			const dE = pw * weight[i] * dt;
			H[i] += dE;
			into += dE;
		}
		h.source += into;
	}

	// Derived temperature with both plateau pins: a cell cannot read above the
	// melt point of a grain it still holds (the excess is pending latent
	// energy), nor below the plateau of a channel it can still freeze (the
	// deficit is a freeze in progress). Conduction, sources and the room trade
	// at the pinned temperature, which is what makes a plateau a buffer
	// instead of a display trick.
	function publish(h) {
		const H = h.H;
		const C = h.C;
		const T = h.T;
		const ch = h.w.ch;
		const tc = h.w.trappedCh;
		const p = h.p;
		const minMelt = h.minMelt;
		for (let i = 0; i < h.count; i++) {
			const o = i * CH;
			let lat = 0;
			let pin = -Infinity;
			const a0 = ch[o] + tc[o];
			const a1 = ch[o + 1] + tc[o + 1];
			const a2 = ch[o + 2] + tc[o + 2];
			if (a0 > CH_EPS) { lat += p.latent[0] * a0; if (p.melt[0] > pin) pin = p.melt[0]; }
			if (a1 > CH_EPS) { lat += p.latent[1] * a1; if (p.melt[1] > pin) pin = p.melt[1]; }
			if (a2 > CH_EPS) { lat += p.latent[2] * a2; if (p.melt[2] > pin) pin = p.melt[2]; }
			let t = (H[i] - lat) / C[i];
			if (pin > t) t = pin;
			if (minMelt[i] < t) t = minMelt[i];
			T[i] = t;
		}
	}

	// ---- material coupling --------------------------------------------------

	// The live derived temperature of a cell: the same formula as publish,
	// but from the CURRENT composition instead of the last published
	// snapshot. The water relaxation moves liquid many times between heat
	// steps and even sloshes a parcel up and back within one step, so a
	// parcel priced at the published snapshot could claim more (or less)
	// energy than its donor's liquid actually holds; pricing it at the live
	// temperature keeps every move consistent with the state it leaves.
	function liveT(h, i) {
		const p = h.p;
		const vol = h.w.vol[i] + h.w.trapped[i];
		let c = p.metalMass * p.metalHeat * (1 - h.open[i]) + p.liquidHeat * vol + h.CG[i];
		if (c < DRY_CAP) c = DRY_CAP;
		return (h.H[i] - latentOf(h, i)) / c;
	}

	// A liquid parcel moves between cells: sensible enthalpy at the donor's
	// live temperature plus the latent of the channels it actually carries.
	// The guard is the last-ulp net for a degenerate donor.
	function flow(h, from, to, area, m0, m1, m2) {
		const p = h.p;
		let dE = p.liquidHeat * area * liveT(h, from) + p.latent[0] * m0 + p.latent[1] * m1 + p.latent[2] * m2;
		if (dE > 0 && dE > h.H[from]) dE = h.H[from] > 0 ? h.H[from] : 0;
		h.H[from] -= dE;
		h.H[to] += dE;
	}

	// Supply enters at ambient with its sensible and latent enthalpy.
	function enter(h, i, area, shares) {
		const p = h.p;
		let dE = p.liquidHeat * area * p.ambient;
		for (let k = 0; k < CH; k++) dE += p.latent[k] * area * shares[k];
		h.H[i] += dE;
		h.material += dE;
	}

	// Overflow and drain carry the donor's enthalpy.
	function leave(h, i, m0, m1, m2) {
		const p = h.p;
		let dE = p.liquidHeat * (m0 + m1 + m2) * liveT(h, i) + p.latent[0] * m0 + p.latent[1] * m1 + p.latent[2] * m2;
		if (dE > 0 && dE > h.H[i]) dE = h.H[i] > 0 ? h.H[i] : 0;
		h.H[i] -= dE;
		h.material -= dE;
	}

	// A grain leaves the field (bottom drain, valve purge, Drain button): its
	// sensible energy leaves with it. A grain never booked (-1) exports
	// nothing because it never imported anything.
	function grainGone(sim, k) {
		const h = sim.heat;
		if (!h || !h.enabled) return;
		const from = sim.gcell[k];
		if (from < 0) return;
		let dE = h.p.grainHeat * sim.mass[k] * liveT(h, from);
		if (dE > 0 && dE > h.H[from]) dE = h.H[from] > 0 ? h.H[from] : 0;
		h.H[from] -= dE;
		h.material -= dE;
		sim.gcell[k] = -1;
	}

	// Reconcile the grain field with the cells: a grain never seen before
	// enters the books at ambient, a crossing moves its sensible energy once
	// at the cell's last published temperature, and the per-cell grain
	// capacity and lowest melt point are rebuilt for capacity and pins.
	//
	// Two passes: a crossing is priced at the donor's live temperature, which
	// has to include the grain's own capacity in the donor's `c`. Resetting
	// `cg` before the crossings would floor a dry donor at DRY_CAP, and the
	// flow guard would then clamp the parcel to the whole cell: one grain
	// carried the entire cell's enthalpy across, the receiver pinned at its
	// melt plateau and the donor collapsed, the seed of the water-vent
	// runaway. The crossings run first against last step's `cg`; the rebuild
	// then rewrites `cg` and `minMelt` for the new positions.
	function grainsScan(sim, h) {
		const cg = h.CG;
		const list = h.cgList;
		const minMelt = h.minMelt;
		const p = h.p;
		const cell = h.cell;
		const nx = h.nx;
		const ny = h.ny;
		const H = h.H;
		// Pass 1: imports and crossings against last step's grain map.
		for (let k = 0; k < sim.count; k++) {
			let gx = (sim.x[k] / cell) | 0;
			let gy = ((sim.y[k] + G.POUR) / cell) | 0;
			if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
			if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
			const i = gy * nx + gx;
			const cap = p.grainHeat * sim.mass[k];
			const from = sim.gcell[k];
			if (from < 0) {
				const dE = cap * p.ambient;
				H[i] += dE;
				h.material += dE;
				sim.gcell[k] = i;
			} else if (from !== i) {
				let dE = cap * liveT(h, from);
				if (dE > 0 && dE > H[from]) dE = H[from] > 0 ? H[from] : 0;
				H[from] -= dE;
				H[i] += dE;
				sim.gcell[k] = i;
			}
		}
		// Pass 2: rewrite the per-cell grain capacity and lowest melt
		// point for the cells grains actually sit in this step.
		for (let k = 0; k < h.cgCount; k++) {
			cg[list[k]] = 0;
			minMelt[list[k]] = Infinity;
		}
		let used = 0;
		for (let k = 0; k < sim.count; k++) {
			let gx = (sim.x[k] / cell) | 0;
			let gy = ((sim.y[k] + G.POUR) / cell) | 0;
			if (gx < 0) gx = 0; else if (gx >= nx) gx = nx - 1;
			if (gy < 0) gy = 0; else if (gy >= ny) gy = ny - 1;
			const i = gy * nx + gx;
			const cap = p.grainHeat * sim.mass[k];
			cg[i] += cap;
			const mm = h.matMelt[sim.color[k]];
			if (mm < minMelt[i]) minMelt[i] = mm;
			list[used++] = i;
		}
		h.cgCount = used;
	}

	// ---- phase change -------------------------------------------------------
	//
	// Both directions convert through the enthalpy ledger with no external
	// term. A melt needs the cell to hold, beyond its melt point's enthalpy,
	// the latent of the grain's mass plus the capacity swap; until then the
	// published temperature pins at the plateau and the excess waits. A freeze
	// converts the mass the cell's deficit below the plateau supports, and a
	// sub-grain remainder accumulates per cell and channel until a whole valid
	// grain can be placed; a blocked placement defers without consuming mass
	// or energy.

	function meltPass(sim, h) {
		const w = h.w;
		const p = h.p;
		const dead = h.dead;
		dead.fill(0, 0, sim.count);
		let melted = 0;
		for (let k = 0; k < sim.count; k++) {
			const mat = sim.color[k];
			const shares = MELT_SHARES[mat];
			const tm = h.matMelt[mat];
			const i = sim.gcell[k];
			const m = sim.mass[k];
			const lat = latentOf(h, i);
			const t = (h.H[i] - lat) / h.C[i];
			if (t <= tm) continue;
			const excess = h.H[i] - (h.C[i] * tm + lat);
			let ls = 0;
			for (let c = 0; c < CH; c++) ls += shares[c] * p.latent[c];
			// The whole-grain threshold: latent plus the liquid-for-grain
			// capacity swap, both at the melt point.
			if (excess < m * (ls + (p.liquidHeat - p.grainHeat) * tm)) continue;
			// The melt lands in the grain's own cell when it can hold it, else in
			// the first eligible neighbour (E, S, W, N); a grain with nowhere to
			// put its liquid waits, pinned, and nothing is consumed. The grain's
			// own displacement never counts against the room: it frees that
			// displacement as it melts, and counting it would block a grain from
			// ever melting in a wet cell.
			const roomOf = j => w.air[j] ? w.area[j] - w.vol[j] - w.trapped[j] : -1;
			let dst = roomOf(i) >= m ? i : -1;
			if (dst < 0) {
				const gx = i % h.nx;
				const gy = (i / h.nx) | 0;
				if (gx + 1 < h.nx && roomOf(i + 1) >= m) dst = i + 1;
				else if (gy + 1 < h.ny && roomOf(i + h.nx) >= m) dst = i + h.nx;
				else if (gx > 0 && roomOf(i - 1) >= m) dst = i - 1;
				else if (gy > 0 && roomOf(i - h.nx) >= m) dst = i - h.nx;
			}
			if (dst < 0) continue;
			WATER.deposit(w, dst, m, shares);
			h.CG[i] -= p.grainHeat * m;
			h.C[i] = capacityAt(h, i);
			h.C[dst] = capacityAt(h, dst);
			if (dst !== i) {
				// The liquid leaves at the plateau with its latent; that is exactly
				// the grain's own sensible share plus the excess the threshold
				// consumed, so both cells stay consistent.
				let ls = 0;
				for (let c = 0; c < CH; c++) ls += shares[c] * p.latent[c];
				const dE = p.liquidHeat * m * tm + ls * m;
				h.H[i] -= dE;
				h.H[dst] += dE;
			}
			dead[k] = 1;
			melted += m;
		}
		if (melted > 0) {
			simApi().removeGrains(sim, dead);
			h.melted += melted;
		}
	}

	// Deterministic probe points of one cell, hashed from cell, channel,
	// attempt and the step: a deferral retries fresh points next step instead
	// of re-failing the same six forever.
	function probe(sim, h, i, k, rad) {
		const api = simApi();
		const gx = i % h.nx;
		const gy = (i / h.nx) | 0;
		const seed = sim.layout.seed | 0;
		const base = i * 8 + k * 2;
		for (let a = 0; a < PROBES; a++) {
			const j = a + sim.steps * PROBES;
			const u = G.hashUnit(seed, base, j);
			const v = G.hashUnit(seed, base + 1, j);
			const x = (gx + u) * h.cell;
			const y = (gy + v) * h.cell - G.POUR;
			if (!api.slotFree(sim, x, y, rad)) continue;
			const idx = api.addGrain(sim, x, y, rad, FREEZE_MAT[k]);
			if (idx >= 0) return idx;
			break;
		}
		return -1;
	}

	// Try to place frozen grains of one cell and channel from the accumulated
	// inventory. Each grain is clamped to the supported radii; the placement
	// checks clearance, grain overlap and capacity, and a blocked placement
	// defers without consuming mass or energy. The full intent is tried first
	// and the smallest valid grain second: a shallow puddle cannot swallow a
	// full-radius grain, but the minimum one often fits.
	function formGrains(sim, h, i, k) {
		const api = simApi();
		const w = h.w;
		const p = h.p;
		const mat = FREEZE_MAT[k];
		const rho = api.MATERIAL_DENSITY[mat];
		const mMin = (rho / 1000) * api.R_MIN * api.R_MIN;
		const mMax = (rho / 1000) * api.R_MAX * api.R_MAX;
		const fo = i * CH + k;
		let frozen = 0;
		while (h.frac[fo] >= mMin && w.ch[fo] >= mMin) {
			let mass = h.frac[fo] < mMax ? h.frac[fo] : mMax;
			if (mass > w.ch[fo]) mass = w.ch[fo];
			if (mass < mMin) break;
			let rad = Math.sqrt((mass * 1000) / rho);
			let idx = probe(sim, h, i, k, rad);
			if (idx < 0 && mass > mMin) {
				mass = mMin;
				rad = api.R_MIN;
				idx = probe(sim, h, i, k, rad);
			}
			if (idx < 0) break;
			// The grain was born of this cell's liquid, so it is already in
			// the enthalpy books, not an import at ambient.
			sim.gcell[idx] = i;
			WATER.takeChannel(w, i, k, mass);
			h.frac[fo] -= mass;
			h.CG[i] += p.grainHeat * mass;
			h.C[i] = capacityAt(h, i);
			frozen += mass;
		}
		return frozen;
	}

	// Freeze per cell, highest plateau first: the mass the deficit below the
	// plateau supports, capped by the channel's liquid, accumulates into the
	// cell's inventory and becomes grains when a valid one fits.
	function freezePass(sim, h) {
		const w = h.w;
		const p = h.p;
		const ch = w.ch;
		const order = h.freezeOrder;
		let frozen = 0;
		for (let i = 0; i < h.count; i++) {
			if (!(w.vol[i] > CH_EPS)) continue;
			const o = i * CH;
			for (let r = 0; r < CH; r++) {
				const k = order[r];
				if (!(ch[o + k] > CH_EPS)) continue;
				const plateau = p.melt[k];
				const lat = latentOf(h, i);
				const t = (h.H[i] - lat) / h.C[i];
				if (t >= plateau) continue;
				const denom = p.latent[k] + (p.liquidHeat - p.grainHeat) * plateau;
				if (!(denom > 0)) continue;
				let m = (h.C[i] * (plateau - t)) / denom;
				if (m > ch[o + k]) m = ch[o + k];
				if (!(m > 0)) continue;
				const fo = o + k;
				h.frac[fo] += m;
				if (h.frac[fo] > ch[o + k]) h.frac[fo] = ch[o + k];
				frozen += formGrains(sim, h, i, k);
			}
		}
		h.frozen += frozen;
	}

	function step(sim, dt) {
		const h = sim.heat;
		if (!h || !h.enabled) return false;
		const w = h.w;
		// The mask check includes the first build: a field created before the
		// water grid sampled its cells must resample once it has.
		if (!w.built || w.serial !== h.maskSerial) rebuild(h);
		grainsScan(sim, h);
		updateCapacity(h);
		const n = substepsFor(h, dt);
		const sub = dt / n;
		for (let s = 0; s < n; s++) {
			publish(h);
			conduct(h, sub);
			ambient(h, sub);
			sources(h, sub);
		}
		meltPass(sim, h);
		freezePass(sim, h);
		publish(h);
		return true;
	}

	// ---- controls and books -------------------------------------------------

	// Signed power for one valve, spread over the cells it owns by fixed weights.
	function setPower(h, valve, power) {
		if (!(valve >= 0) || valve >= h.power.length) return false;
		h.power[valve] = Number.isFinite(power) ? power : 0;
		return true;
	}

	function setAmbient(h, temperature, rate) {
		if (Number.isFinite(temperature)) h.p.ambient = temperature;
		if (Number.isFinite(rate) && rate >= 0) h.p.ambientRate = rate;
	}

	// Parameters are refused, not clamped, when they would need more substeps
	// than the budget at the smallest capacity the field can have.
	function validParams(p) {
		if (!Number.isFinite(p.ambient)) return false;
		if (!(Number.isFinite(p.metalHeat) && p.metalHeat > 0)) return false;
		if (!(Number.isFinite(p.liquidHeat) && p.liquidHeat > 0)) return false;
		if (!(Number.isFinite(p.grainHeat) && p.grainHeat > 0)) return false;
		if (!(Number.isFinite(p.metalMass) && p.metalMass > 0)) return false;
		if (!(Number.isFinite(p.conductMetal) && p.conductMetal >= 0)) return false;
		if (!(Number.isFinite(p.conductLiquid) && p.conductLiquid >= 0)) return false;
		if (!(Number.isFinite(p.ambientRate) && p.ambientRate >= 0)) return false;
		if (!(Number.isInteger(p.substepCap) && p.substepCap >= 1)) return false;
		for (let k = 0; k < CH; k++) {
			if (!(Number.isFinite(p.latent[k]) && p.latent[k] > 0)) return false;
			if (!Number.isFinite(p.melt[k])) return false;
		}
		return true;
	}

	function setParams(h, next) {
		const p = copyParams();
		for (const key in next) {
			if (!(key in p)) continue;
			const v = next[key];
			if (Array.isArray(p[key])) {
				if (!Array.isArray(v) || v.length !== p[key].length) return false;
				for (let k = 0; k < v.length; k++) p[key][k] = v[k];
			} else p[key] = v;
		}
		if (!validParams(p)) return false;
		if (neededSubsteps(p, DRY_CAP, STEP, h.cell) > p.substepCap) return false;
		for (const key in p) h.p[key] = Array.isArray(p[key]) ? p[key].slice() : p[key];
		buildTables(h);
		return true;
	}

	// Boundary term for a fixture: impose a temperature directly and book it as
	// opening inventory, so the ledger stays an equation instead of a trust.
	function setTemperature(h, i, temperature) {
		if (i < 0 || i >= h.count || !Number.isFinite(temperature)) return false;
		const before = h.H[i];
		h.H[i] = h.C[i] * temperature + latentOf(h, i);
		h.T[i] = temperature;
		h.initial += h.H[i] - before;
		return true;
	}

	// Fixture and scenario primitive: replace a cell's liquid and temperature
	// together, booking the actual change as opening inventory. The water-side
	// setLiquid stays raw so the two books are always written as one act.
	function setCell(h, sim, i, area, shares, temperature) {
		if (i < 0 || i >= h.count) return false;
		const before = h.H[i];
		WATER.setLiquid(h.w, i, area, shares);
		const o = i * CH;
		for (let k = 0; k < CH; k++) h.frac[o + k] = 0;
		h.C[i] = capacityAt(h, i);
		h.H[i] = h.C[i] * temperature + latentOf(h, i);
		h.T[i] = temperature;
		h.initial += h.H[i] - before;
		return true;
	}

	// Impose a uniform temperature over the whole field and reset the books to
	// exactly the stored energy. Fixture and scenario use; the page's field
	// opens at ambient this way once, at creation.
	function fill(h, temperature) {
		const H = h.H;
		const C = h.C;
		const T = h.T;
		let total = 0;
		for (let i = 0; i < h.count; i++) {
			H[i] = C[i] * temperature + latentOf(h, i);
			T[i] = temperature;
			total += H[i];
		}
		h.initial = total;
		h.source = 0;
		h.ambient = 0;
		h.material = 0;
		h.substeps = 0;
		h.melted = 0;
		h.frozen = 0;
		h.frac.fill(0);
	}

	function stored(h) {
		const H = h.H;
		let total = 0;
		for (let i = 0; i < h.count; i++) total += H[i];
		return total;
	}

	function residual(h) {
		return stored(h) - h.initial - h.source - h.ambient - h.material;
	}

	// Reset empties the field and its books but keeps the per-valve powers and
	// every parameter, like the water reset keeps rates and colours. An empty
	// field reads 0 °C; the room warms it back through the exterior ring.
	function reset(h) {
		h.H.fill(0);
		h.T.fill(0);
		h.CG.fill(0);
		h.minMelt.fill(Infinity);
		h.cgCount = 0;
		h.frac.fill(0);
		h.initial = 0;
		h.source = 0;
		h.ambient = 0;
		h.material = 0;
		h.melted = 0;
		h.frozen = 0;
		h.substeps = 0;
		h.maskSerial = -1;
	}

	return {
		PARAMS, DRY_CAP, STEP, STABILITY, CH, MELT_SHARES, FREEZE_MAT, PROBES, CH_EPS,
		create, rebuild, updateCapacity, step, publish, setPower, setAmbient, setParams,
		setTemperature, setCell, fill, stored, residual, reset, neededSubsteps,
		grainGone, latentOf, materialMelt,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveHeat;
