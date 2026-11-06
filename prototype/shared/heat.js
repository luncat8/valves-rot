// 0.4 slice 1a: the heat field. Total enthalpy per water-grid cell, temperature
// derived from it, conduction across open and metal faces under an explicit
// substep bound, per-valve signed sources, ambient exchange on the grid's outer
// ring, and a ledger that names every term.
//
// Illustrative units, matching the water grid: 1 mm/px, 10 mm slice depth, 1 mg
// per mass unit, so a px² of reference-density liquid is one mass unit and a px²
// of metal is `metalMass`. Energy is mass x specific heat x °C. A cell's
// capacity is its metal plus its liquid plus a nominal floor for an empty
// passage, and it changes when water moves; enthalpy does not, so a cell that
// fills with cold liquid cools without inventing or losing energy.
//
// Slice 1a models the field only. Liquid advection, grain sensible energy,
// supply/drain enthalpy and phase change land in slice 1b, which is why every
// book below is about the field and never about material.
const ValveHeat = (() => {
	"use strict";

	// Every entry is a tuning choice with an explicit unit, not a calibration.
	// `conduct*` is per px of face per second, `ambientRate` per px of exterior
	// face per second, `*Heat` per mass unit, `metalMass` per px² of metal.
	const PARAMS = {
		ambient: 20,
		metalHeat: 0.5,
		liquidHeat: 4.2,
		metalMass: 2.7,
		conductMetal: 0.9,
		conductLiquid: 0.8,
		ambientRate: 0.05,
		substepCap: 4,
	};
	// Explicit diffusion margin, the nominal capacity of an empty passage, and
	// the fixed step the parameter gate is validated against.
	const STABILITY = 0.45;
	const DRY_CAP = 0.6;
	const STEP = 1 / 120;

	function copyParams() {
		const p = {};
		for (const k in PARAMS) p[k] = PARAMS[k];
		return p;
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
			// State: enthalpy rules, temperature and capacity are derived.
			H: new Float64Array(count),
			C: new Float64Array(count),
			T: new Float64Array(count),
			// Sampled open fraction, per-cell source weight (1 / owned cells) and
			// the exterior face length, all rebuilt from the water mask.
			open: new Float64Array(count),
			weight: new Float64Array(count),
			exterior: new Float64Array(count),
			ownerCount: new Int32Array(valves),
			power: new Float64Array(valves),
			cMin: DRY_CAP,
			maskSerial: -1,
			substeps: 0,
			initial: 0,
			source: 0,
			ambient: 0,
		};
		rebuild(h);
		return h;
	}

	// Follow the water mask: a rotor turn changes which cells hold water, so the
	// open fraction, the owner weights and the exterior faces are resampled.
	// Enthalpy is kept, never discarded, so a turn cannot create or lose heat.
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

	// Capacity: metal where the cell is not open, liquid in its channel total,
	// and a nominal floor so an empty passage still has a finite temperature.
	function updateCapacity(h) {
		const C = h.C;
		const n = h.count;
		const p = h.p;
		const open = h.open;
		const vol = h.w.vol;
		const metal = p.metalMass * p.metalHeat;
		const liquid = p.liquidHeat;
		let min = Infinity;
		for (let i = 0; i < n; i++) {
			let c = metal * (1 - open[i]) + liquid * vol[i];
			if (c < DRY_CAP) c = DRY_CAP;
			C[i] = c;
			if (c < min) min = c;
		}
		h.cMin = min;
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

	function publish(h) {
		const H = h.H;
		const C = h.C;
		const T = h.T;
		for (let i = 0; i < h.count; i++) T[i] = H[i] / C[i];
	}

	function step(sim, dt) {
		const h = sim.heat;
		if (!h || !h.enabled) return false;
		if (h.w.serial !== h.maskSerial) rebuild(h);
		updateCapacity(h);
		const n = substepsFor(h, dt);
		const sub = dt / n;
		for (let s = 0; s < n; s++) {
			publish(h);
			conduct(h, sub);
			ambient(h, sub);
			sources(h, sub);
		}
		publish(h);
		return true;
	}

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
		if (!(Number.isFinite(p.metalMass) && p.metalMass > 0)) return false;
		if (!(Number.isFinite(p.conductMetal) && p.conductMetal >= 0)) return false;
		if (!(Number.isFinite(p.conductLiquid) && p.conductLiquid >= 0)) return false;
		if (!(Number.isFinite(p.ambientRate) && p.ambientRate >= 0)) return false;
		if (!(Number.isInteger(p.substepCap) && p.substepCap >= 1)) return false;
		return true;
	}

	function setParams(h, next) {
		const p = copyParams();
		for (const k in next) if (k in p) p[k] = next[k];
		if (!validParams(p)) return false;
		if (neededSubsteps(p, DRY_CAP, STEP, h.cell) > p.substepCap) return false;
		for (const k in p) h.p[k] = p[k];
		return true;
	}

	// Boundary terms for a fixture: impose a temperature directly and book it as
	// opening inventory, so the ledger stays an equation instead of a trust.
	function setTemperature(h, i, temperature) {
		if (i < 0 || i >= h.count || !Number.isFinite(temperature)) return false;
		const before = h.H[i];
		h.H[i] = h.C[i] * temperature;
		h.T[i] = temperature;
		h.initial += h.H[i] - before;
		return true;
	}

	function fill(h, temperature) {
		const H = h.H;
		const C = h.C;
		const T = h.T;
		let total = 0;
		for (let i = 0; i < h.count; i++) {
			H[i] = C[i] * temperature;
			T[i] = temperature;
			total += H[i];
		}
		h.initial = total;
		h.source = 0;
		h.ambient = 0;
		h.substeps = 0;
	}

	function stored(h) {
		const H = h.H;
		let total = 0;
		for (let i = 0; i < h.count; i++) total += H[i];
		return total;
	}

	function residual(h) {
		return stored(h) - h.initial - h.source - h.ambient;
	}

	function reset(h) {
		h.H.fill(0);
		h.T.fill(0);
		h.initial = 0;
		h.source = 0;
		h.ambient = 0;
		h.power.fill(0);
		h.substeps = 0;
		h.maskSerial = -1;
	}

	return {
		PARAMS, DRY_CAP, STEP,
		create, rebuild, updateCapacity, step, publish, setPower, setAmbient, setParams,
		setTemperature, fill, stored, residual, reset, neededSubsteps,
	};
})();
if (typeof module !== "undefined" && module.exports) module.exports = ValveHeat;
