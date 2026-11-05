// The fixed water field both balance measurements share: a vent shaft over a
// three-wide basin, filled by delivered volume, and a mixed bed of every
// material in its two bottom pockets. `water-separation.cjs` judges whether the
// bed separates at all; `water-balance.cjs` sweeps WATER_DRAG on the same field.
// One copy, so a tuning run and the acceptance run can never drift apart.
"use strict";
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

const N = G.N;
const RV = G.RV;
const AXIS = 4;
const FILL = 12000; // px² of slice area: a pool ~110 px deep, two chamber rows
const RATE = 4000; // px²/s: fast enough that the fill itself is not the demo
const SETTLE = 12; // seconds of buoyancy after the bed is placed
const ROWS = [7, 8]; // the two bottom chamber rows of the basin
const COLS = [3, 4, 5];

// A vent shaft down to a three-wide, five-row basin. Row 9 stays solid: the
// bottom of the field is the floor of the basin, so the pool has one bottom and
// nothing leaks into the drain band.
function layout() {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const open = i === AXIS ? j <= 8 : i >= COLS[0] && i <= COLS[2] && j >= 4 && j <= 8;
			valves.push(G.makeValve(i, j, open ? "hollow" : "solid", open ? [0, 1, 2, 3] : [], 0, open ? RV * 0.9 : 0));
		}
	}
	const sim = S.create({ seed: 5, valves }, { turning: false });
	S.setPressure(sim, "off");
	return sim;
}

// Fill by delivered volume, not by time: the vent rate and the layout are fixed,
// so the volume is the reproducible control and the level follows from it.
function fill(sim, target) {
	const w = S.setWater(sim, true);
	W.setVent(w, AXIS, true);
	W.setSupply(w, RATE);
	for (let k = 0; k < 120 * 30 && W.storedVol(w) < target; k++) S.step(sim, S.STEP);
	W.setVent(w, AXIS, false);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	return w;
}

// Twelve positions inside a chamber: two rings, far enough apart that no grain
// starts inside another and well inside the chamber wall.
const SLOTS = [];
for (let k = 0; k < 12; k++) {
	const ring = k < 6 ? 8 : 15;
	const a = (k % 6) * (Math.PI / 3) + (k < 6 ? 0 : Math.PI / 6);
	SLOTS.push([Math.cos(a) * ring, Math.sin(a) * ring]);
}

// Two grains of every material in each bottom pocket, rotated per pocket so no
// material consistently starts higher than another.
function bed(sim) {
	const start = [];
	let pocket = 0;
	for (const j of ROWS) {
		for (const i of COLS) {
			const v = sim.layout.valves[j * N + i];
			for (let n = 0; n < SLOTS.length; n++) {
				const color = (n + pocket) % S.MATERIAL_DENSITY.length;
				const k = S.addGrain(sim, v.cx + SLOTS[n][0], v.cy + SLOTS[n][1], S.R_GRAIN, color);
				if (k < 0) throw new Error(`the bed does not fit in pocket ${i},${j}`);
				start.push(sim.y[k]);
			}
			pocket++;
		}
	}
	return start;
}

// The pool's own geometry: the waterline over the bed and the floor under it.
// Both come from the solver's published levels, so no display change can move
// the bands the counts use. Recomputed per sample because the bed's own
// displacement lifts the level a little.
function poolBounds(w) {
	let line = Infinity;
	let floor = -Infinity;
	for (let k = 0; k < w.count; k++) {
		if (w.vol[k] <= 1e-3) continue;
		const y = ((k / w.nx) | 0) * w.cell - G.POUR;
		if (y + w.cell > floor) floor = y + w.cell;
		const lvl = w.levelUp[k];
		if (Number.isFinite(lvl) && lvl < line) line = lvl;
	}
	return { line, floor, depth: floor - line };
}

function blankRow() {
	return { count: 0, upper: 0, high: 0, mid: 0, low: 0, float: 0, rise: 0, f: 0 };
}

// Count each material into the upper and lower halves of the pool, and into the
// high/middle/low thirds for diagnosis. Halves are the metric: a pile of dense
// grains stands two or three deep on the floor, and the top of that pile is
// taller than a third of a shallow pool, which would score a correct sink as a
// miss. A grain is the material its palette index names, never its pixels.
function census(sim, bounds, start) {
	const { line, depth } = bounds;
	const mid = line + depth * 0.5;
	const top = line + depth * 0.35;
	const bottom = line + depth * 0.65;
	const rows = S.MATERIAL_DENSITY.map(blankRow);
	for (let k = 0; k < sim.count; k++) {
		const row = rows[S.materialIndex(sim.color[k])];
		const y = sim.y[k];
		row.count++;
		row.rise += start[k] - y; // positive = ended above where it started
		if (y < mid) row.upper++;
		if (y < top) row.high++;
		else if (y > bottom) row.low++;
		else row.mid++;
		if (!sim.water.enabled) continue;
		const f = W.submerged(sim.water, sim.x[k], y, sim.r[k]);
		if (f > 0 && f < 0.98) row.float++;
		row.f += f;
	}
	return rows;
}

// Recovered fraction per group, and how much of each region is the wrong group.
// Neutral material is in neither group: it is weightless in water, so it cannot
// be expected to reach a region and scoring it as a failure would be a
// threshold invented against physics.
function score(rows) {
	let lightN = 0;
	let lightUp = 0;
	let denseN = 0;
	let denseDown = 0;
	let upN = 0;
	let upLight = 0;
	for (let m = 0; m < rows.length; m++) {
		const row = rows[m];
		const rho = S.MATERIAL_DENSITY[m];
		if (rho === S.WATER_DENSITY) continue;
		upN += row.upper;
		if (rho < S.WATER_DENSITY) {
			lightN += row.count;
			lightUp += row.upper;
			upLight += row.upper;
		} else {
			denseN += row.count;
			denseDown += row.count - row.upper;
		}
	}
	const wanted = lightN + denseN;
	const recovered = lightUp + denseDown;
	return {
		floatRecovery: lightN ? lightUp / lightN : 1,
		sinkRecovery: denseN ? denseDown / denseN : 1,
		recovered: wanted ? recovered / wanted : 1,
		contamination: wanted ? 1 - recovered / wanted : 0,
		purity: upN ? upLight / upN : NaN,
	};
}

function measure(sim, start, fixed) {
	const bounds = fixed || poolBounds(sim.water);
	const rows = census(sim, bounds, start);
	return { bounds, rows, score: score(rows) };
}

// The dry baseline fills the same pool, takes its geometry, and then switches
// water off, so the two runs differ only in the force: same layout, same bed,
// same bands. `fixed` keeps the bands of a run whose water is gone.
function run(withWater, fixed, drag) {
	const sim = layout();
	if (drag !== undefined) S.setWaterDrag(sim, drag);
	fill(sim, FILL);
	const bounds = fixed || poolBounds(sim.water);
	if (!withWater) S.setWater(sim, false);
	const start = bed(sim);
	const curve = [];
	for (let t = 0; t < SETTLE; t++) {
		for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
		curve.push(measure(sim, start, fixed));
	}
	const final = measure(sim, start, fixed);
	return { sim, start, curve, final, bounds, placed: start.length };
}

// ---- the tight pool ------------------------------------------------------
// One float in a chamber barely larger than its own displacement: the level
// feedback case the plan documents as a limit. ~56 px across, so 260 px² of
// water is a pool shallower than the grain is tall.
const TIGHT_R = RV * 0.9;
const TIGHT_VOL = 260;

function tightSim() {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const open = i === 4 && j === 5;
			valves.push(G.makeValve(i, j, open ? "hollow" : "solid", [], 0, open ? TIGHT_R : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	return sim;
}

// Peak-to-peak height of one float over `seconds`, after it has settled. The
// chamber is filled by injecting volume into its own cell, because the vent
// pours only into the top band of the field.
function floatWander(radius, color, seconds, drag) {
	const sim = tightSim();
	if (drag !== undefined) S.setWaterDrag(sim, drag);
	const w = S.setWater(sim, true);
	const v = sim.layout.valves[5 * N + 4];
	const i = Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
	W.setLiquid(w, i, TIGHT_VOL);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	const g = S.addGrain(sim, v.cx, v.cy + 4, radius, color);
	for (let k = 0; k < 120 * 2; k++) S.step(sim, S.STEP);
	let lo = Infinity;
	let hi = -Infinity;
	for (let k = 0; k < 120 * seconds; k++) {
		S.step(sim, S.STEP);
		const y = sim.y[g];
		if (y < lo) lo = y;
		if (y > hi) hi = y;
	}
	const f = W.submerged(w, sim.x[g], sim.y[g], sim.r[g]);
	return { wander: hi - lo, submerged: f, settled: sim.y[g] };
}

module.exports = {
	N, AXIS, FILL, RATE, SETTLE, ROWS, COLS, SLOTS, TIGHT_R, TIGHT_VOL,
	layout, fill, bed, poolBounds, census, score, measure, run, blankRow,
	tightSim, floatWander,
};
