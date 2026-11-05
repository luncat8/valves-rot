// Slice 5 of 0.3-water-plan: can the float layer be captured, so a quest has a
// countable water state? Water has no velocity, so a float only ever moves
// vertically. It cannot be pushed into a side pocket opened at the same level —
// that is measured here as the negative control, because "open a side pocket and
// skim the layer" is the intuitive design and it is false for this physics.
//
// What a float does do is stay at the surface. So the capture is: a one-chamber-
// wide shaft, mix poured in at the top, dense grains sink to the pool at the
// bottom, floats stay on the surface above a gate valve, the gate is turned shut
// under them, and the water is drained. The floats are then in the trap and the
// dense bed on the pool floor: dry, separated, countable.
//
// Also measured: the same mixture dropped into the empty chamber *before* the
// fill, which is the harder case — floats under the pile are jammed in a
// two-grain-wide tube, and one can be pinned under a flat arm ceiling.
//
// Run: node experiments/water-gate.cjs
"use strict";
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

const N = G.N;
const AXIS = 4;
const GATE = 6; // the gate valve's row: everything above it is the trap
const CR = G.RV * 0.88;
const FAST = 3000; // px²/s: get the water up to the gate
const SLOW = 250; // px²/s: slow enough that the loosest float keeps up
const GATE_TOP = GATE * G.S;
const GATE_BOTTOM = GATE_TOP + G.S;
const POUR_GAP = 0.15; // s between grains, so a pour does not arrive as a plug
const POUR_STEPS = Math.round(POUR_GAP * 120);

// One chamber wide above and below the gate, or nothing can rise through it.
function layout() {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			let kind = "solid";
			let ports = [];
			let base = 0;
			let cr = 0;
			const shaft = i === AXIS && (j < GATE || (j > GATE && j <= 8));
			if (shaft) {
				kind = "hollow";
				ports = [0, 1, 2, 3];
				cr = CR;
			} else if (i === AXIS && j === GATE) {
				// N-S straight: the gate. A quarter turn shuts the column.
				kind = "hollow";
				ports = [0, 2];
				base = Math.PI / 2;
				cr = CR;
			}
			valves.push(G.makeValve(i, j, kind, ports, base, cr));
		}
	}
	const sim = S.create({ seed: 5, valves }, { turning: false });
	S.setPressure(sim, "off");
	return sim;
}

function levelAt(w) {
	return W.surfaceAt(w, AXIS * G.S + G.S / 2, GATE_TOP + 40);
}

// Pour until the published level is this many px above the gate's top edge.
function pourTo(sim, rate, above) {
	const w = sim.water;
	W.setSupply(w, rate);
	W.setVent(w, AXIS, true);
	const stop = GATE_TOP - above;
	for (let k = 0; k < 120 * 90; k++) {
		S.step(sim, S.STEP);
		const lvl = levelAt(w);
		if (Number.isFinite(lvl) && lvl < stop) return k / 120;
	}
	return Infinity;
}

// Two grains of every material, from the top of the shaft (a pour) or dropped
// into the bottom chamber before the fill (a floor bed).
function load(sim, pour) {
	const colors = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5];
	const bottom = sim.layout.valves[8 * N + AXIS];
	let placed = 0;
	for (let k = 0; k < colors.length; k++) {
		const g = pour
			? S.addGrain(sim, bottom.cx + (k % 2 ? 2.6 : -2.6), 10, S.R_GRAIN, colors[k])
			: S.addGrain(sim, bottom.cx + Math.cos(k * Math.PI / 3) * (k < 6 ? 8 : 15), bottom.cy + Math.sin(k * Math.PI / 3) * (k < 6 ? 8 : 15), S.R_GRAIN, colors[k]);
		if (g >= 0) placed++;
		if (pour) for (let t = 0; t < POUR_STEPS; t++) S.step(sim, S.STEP);
	}
	return placed;
}

// Three regions: above the gate cell, inside its bore, and the pool below.
function census(sim) {
	const rows = S.MATERIAL_DENSITY.map(() => ({ above: 0, gate: 0, pool: 0 }));
	for (let k = 0; k < sim.count; k++) {
		const row = rows[S.materialIndex(sim.color[k])];
		const y = sim.y[k];
		if (y < GATE_TOP) row.above++;
		else if (y < GATE_BOTTOM) row.gate++;
		else row.pool++;
	}
	return rows;
}

function tally(sim) {
	const rows = census(sim);
	let floats = 0;
	let floatsUp = 0;
	let dense = 0;
	let denseDown = 0;
	let stray = 0;
	for (let m = 0; m < rows.length; m++) {
		const row = rows[m];
		const n = row.above + row.gate + row.pool;
		const rho = S.MATERIAL_DENSITY[m];
		if (rho < S.WATER_DENSITY) {
			floats += n;
			floatsUp += row.above + row.gate;
		} else if (rho > S.WATER_DENSITY) {
			dense += n;
			denseDown += row.pool;
			stray += row.above + row.gate;
		}
	}
	return { floats, floatsUp, dense, denseDown, stray, capture: floats ? floatsUp / floats : 1 };
}

function report(tag, sim) {
	const rows = census(sim);
	const t = tally(sim);
	const cells = [];
	for (let m = 0; m < rows.length; m++) {
		const row = rows[m];
		cells.push(`${S.MATERIAL_NAMES[m]} ${row.above}/${row.gate}/${row.pool}`);
	}
	console.log(`  ${tag}: ${cells.join(" · ")}`);
	console.log(
		`    float layer above the gate ${t.floatsUp}/${t.floats} · dense below ${t.denseDown}/${t.dense}` +
			` · dense strayed up ${t.stray}`,
	);
	return t;
}

const sim = layout();
const w = S.setWater(sim, true);
const LOAD_ARGS = process.argv.includes("--floor");
const placed = load(sim, !LOAD_ARGS);
console.log(
	`trap: one chamber wide, gate at row ${GATE}, ${placed} grains of six materials ` +
		(LOAD_ARGS ? "dropped into the empty bottom chamber" : "poured down the shaft into the water"),
);
if (!LOAD_ARGS) {
	const t1 = pourTo(sim, FAST, 10);
	W.setVent(w, AXIS, false);
	console.log(`fill: ${t1.toFixed(1)} s at ${FAST} px²/s, ${W.storedVol(w).toFixed(0)} px² stored, level ${levelAt(w).toFixed(0)} (gate top ${GATE_TOP})`);
}
for (let k = 0; k < 120 * 8; k++) S.step(sim, S.STEP);
report("after the pour settles", sim);

// Raise the last stretch slowly: the surface must not outrun the lightest
// float, or it leaves the layer behind in the pool.
const t3 = pourTo(sim, SLOW, 45);
W.setVent(w, AXIS, false);
for (let k = 0; k < 120 * 3; k++) S.step(sim, S.STEP);
console.log(`raise: ${t3.toFixed(1)} s at ${SLOW} px²/s, level ${levelAt(w).toFixed(0)}`);
const filled = report("layer lifted into the trap", sim);

// Shut the gate under the floats and drain: the gate is a wall, so the layer
// stays where the water left it.
S.turn(sim, GATE * N + AXIS, 1);
for (let k = 0; k < 120 * 2; k++) S.step(sim, S.STEP);
W.drainAll(w);
for (let k = 0; k < 120 * 6; k++) S.step(sim, S.STEP);
const dry = report("gate shut, water drained", sim);
console.log(`  grains ${sim.count} of ${placed}, ${W.storedVol(w).toFixed(0)} px² left of ${w.admitted.toFixed(0)} admitted`);

assert.equal(sim.count, placed, "no grain is lost to the gate or the drain");
assert.equal(dry.stray, 0, "no dense grain crosses the gate");
if (LOAD_ARGS) {
	// The floor bed is the diagnostic, not the acceptance case: a float poured
	// into a two-grain-wide shaft under the pile is jammed, and one can be pinned
	// under a flat arm ceiling. Run without --floor for the shipped mechanic.
	assert.ok(dry.capture >= 0.5, `diagnostic: most floats still escape (${(dry.capture * 100).toFixed(0)}%)`);
	console.log("  (--floor is the harder case: floats loaded under the pile, not the acceptance run)");
} else {
	assert.ok(filled.capture >= 0.95, `the float layer is above the gate (${(filled.capture * 100).toFixed(0)}%)`);
	assert.equal(filled.stray, 0, `no dense grain rides up with the layer (${filled.stray} strayed)`);
	assert.ok(dry.capture >= 0.95, `the layer is still above the gate once dry (${(dry.capture * 100).toFixed(0)}%)`);
}

// ---- negative control: a side pocket at the same level -------------------
// Floats ride a level; they are not carried by it. An open pocket at the surface
// takes in none of them, however long it is left open.
{
	const COLS = [3, 4, 5];
	const pocket = [6, 5];
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const open = (i >= COLS[0] && i <= COLS[2] && j >= 4 && j <= 8) || (i === pocket[0] && j === pocket[1]);
			valves.push(G.makeValve(i, j, open ? "hollow" : "solid", open ? [0, 1, 2, 3] : [], 0, open ? CR : 0));
		}
	}
	const side = S.create({ seed: 9, valves }, { turning: false });
	S.setPressure(side, "off");
	const sw = S.setWater(side, true);
	W.setVent(sw, COLS[1], true);
	W.setSupply(sw, 3000);
	for (let k = 0; k < 120 * 60 && W.storedVol(sw) < 12000; k++) S.step(side, S.STEP);
	W.setVent(sw, COLS[1], false);
	let floats = 0;
	for (const j of [7, 8]) {
		for (const i of COLS) {
			const v = side.layout.valves[j * N + i];
			for (let k = 0; k < 4; k++) {
				const a = (k % 4) * Math.PI / 2 + Math.PI / 4;
				if (S.addGrain(side, v.cx + Math.cos(a) * 9, v.cy + Math.sin(a) * 9, S.R_GRAIN, k % 2 ? 3 : 5) >= 0) floats++;
			}
		}
	}
	for (let k = 0; k < 120 * 14; k++) S.step(side, S.STEP);
	const cell = side.layout.valves[pocket[1] * N + pocket[0]];
	let inPocket = 0;
	for (let k = 0; k < side.count; k++) {
		if (Math.abs(side.x[k] - cell.cx) < G.S / 2 && Math.abs(side.y[k] - cell.cy) < G.S / 2) inPocket++;
	}
	console.log(`\ncontrol: ${floats} floats, an open pocket at the surface level for 14 s, ${inPocket} crossed into it`);
	assert.equal(inPocket, 0, "an open side pocket at the same level takes no floats");
}

console.log("\nOK  water slice 5: the float layer is captured by a gate above a one-wide shaft, not by a side pocket");
