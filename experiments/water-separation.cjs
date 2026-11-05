// Slice 4 of 0.3-water-plan: does water actually separate a mixed bed, and by
// how much? The fixed field lives in `water-scenario.cjs` — a vent shaft over a
// three-wide basin, filled to a measured volume, then a mixed bed of all six
// materials dropped into its two bottom pockets. Buoyancy is given time to act
// and the outcome is counted per material: recovered fraction (light material in
// the upper half of the pool, dense material in the lower half), cross
// contamination, and the upper half's purity. The same bed also runs with water
// off, so the numbers cannot be explained by gravity alone.
//
// Run: node experiments/water-separation.cjs
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { writePng } = require("./png-writer.cjs");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const P = require("./water-paint.cjs");
const C = require("./water-scenario.cjs");

const N = G.N;
const OUT = path.join(__dirname, "logs", "water-separation-0.4.webp");

function report(tag, result) {
	const { bounds, rows, score: s } = result.final;
	const sim = result.sim;
	console.log(
		`\n${tag}: pool ${bounds.depth.toFixed(0)} px deep (waterline ${bounds.line.toFixed(0)}, floor ${bounds.floor.toFixed(0)}), ` +
			`${W.storedVol(sim.water).toFixed(0)} px² in ${W.wetCount(sim.water)} cells, ${sim.count} grains after ${C.SETTLE} s`,
	);
	console.log("  material        rho   n  high  mid  low  upper  rising  mean-f  mean-rise");
	for (let m = 0; m < rows.length; m++) {
		const r = rows[m];
		console.log(
			"  " +
				S.MATERIAL_NAMES[m].padEnd(14) +
				String(S.MATERIAL_DENSITY[m]).padStart(5) +
				String(r.count).padStart(4) +
				String(r.high).padStart(6) +
				String(r.mid).padStart(5) +
				String(r.low).padStart(5) +
				String(r.upper).padStart(7) +
				String(r.float).padStart(8) +
				(sim.water.enabled ? (r.f / r.count).toFixed(2) : "   -").padStart(8) +
				(r.rise / r.count).toFixed(0).padStart(11),
		);
	}
	console.log(
		`  float recovery ${(s.floatRecovery * 100).toFixed(0)}% · sink recovery ${(s.sinkRecovery * 100).toFixed(0)}%` +
			` · recovered ${(s.recovered * 100).toFixed(0)}% · contamination ${(s.contamination * 100).toFixed(0)}%` +
			(Number.isFinite(s.purity) ? ` · upper-half purity ${(s.purity * 100).toFixed(0)}%` : ""),
	);
	const curve = result.curve.map((c, t) => `${t + 1}s ${(c.score.recovered * 100).toFixed(0)}%`).join(" ");
	console.log(`  recovered over time: ${curve}`);
}

// ---- picture -------------------------------------------------------------
// Two panels of the basin, before the bed and after it settles: the mixed bed
// and the stratified one, painted by the shared water painter so the sheet in the
// picture is the one the page draws.
const VIEW = { x0: C.COLS[0] * G.S - 30, y0: 3 * G.S - G.POUR, w: 3 * G.S + 60, h: 7 * G.S };

const wet = C.run(true, null);
const dry = C.run(false, wet.bounds);
report("water on", wet);
report("water off (baseline)", dry);

// ---- one float, no crowd ------------------------------------------------
// The density-ratio equilibrium is a property of one grain, not of a raft: with
// 24 floats in one chamber the top of the raft is pushed out of the water, which
// is why the crowded run reports a mean submerged fraction below the ratio.
{
	const sim = C.layout();
	C.fill(sim, C.FILL);
	// One per pocket: side by side they would push each other out of the water.
	const left = sim.layout.valves[7 * N + C.COLS[0]];
	const right = sim.layout.valves[7 * N + C.COLS[2]];
	const blue = S.addGrain(sim, left.cx, left.cy + 10, S.R_GRAIN, 3);
	const green = S.addGrain(sim, right.cx, right.cy + 10, S.R_GRAIN, 5);
	for (let k = 0; k < C.SETTLE * 120; k++) S.step(sim, S.STEP);
	const fb = W.submerged(sim.water, sim.x[blue], sim.y[blue], sim.r[blue]);
	const fg = W.submerged(sim.water, sim.x[green], sim.y[green], sim.r[green]);
	console.log(`\none float each: blue submerged ${fb.toFixed(2)} (density ratio 0.50), green ${fg.toFixed(2)} (0.80)`);
	assert.ok(Math.abs(fb - 0.5) < 0.1, `a lone blue grain floats half submerged (${fb.toFixed(2)})`);
	assert.ok(Math.abs(fg - 0.8) < 0.1, `a lone green grain floats four fifths submerged (${fg.toFixed(2)})`);
	assert.ok(fb < fg, "the lighter material floats higher");
}

// ---- assertions ----------------------------------------------------------
// Conservation first: separation that loses grains or water is not a result.
assert.equal(wet.sim.count, wet.placed, "no grain is lost while separating");
assert.equal(dry.sim.count, dry.placed, "no grain is lost in the dry baseline");
const stored = W.storedVol(wet.sim.water);
assert.ok(Math.abs(stored - C.FILL) < C.FILL * 0.02, `the pool holds the fill it was given (${stored.toFixed(0)} / ${C.FILL})`);
assert.ok(wet.final.bounds.depth > 100, `the pool is deep enough to separate (${wet.final.bounds.depth.toFixed(0)} px)`);

// Buoyancy did the separating, and it separated by density.
assert.ok(wet.final.score.floatRecovery >= 0.95, `light grains reach the upper half (${(wet.final.score.floatRecovery * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.sinkRecovery >= 0.95, `dense grains reach the lower half (${(wet.final.score.sinkRecovery * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.contamination <= 0.05, `cross contamination stays low (${(wet.final.score.contamination * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.purity >= 0.95, `the upper half is light material (${(wet.final.score.purity * 100).toFixed(0)}%)`);
assert.ok(dry.final.score.floatRecovery <= 0.2, `without water the light grains stay down (${(dry.final.score.floatRecovery * 100).toFixed(0)}%)`);
assert.equal(wet.final.rows[3].upper, wet.final.rows[3].count, "every buoyant blue grain ends above the midline");
assert.equal(wet.final.rows[0].upper, 0, "no dense red grain ends above the midline");
// The bed must be mostly separated within a few seconds, or the scenario is a
// demo of patience rather than of buoyancy.
const fast = wet.curve.findIndex(c => c.score.recovered >= 0.9);
assert.ok(fast >= 0 && fast < 10, `the bed separates within ${fast + 1} s`);

const before = C.layout();
C.fill(before, C.FILL);
C.bed(before);
writePng(OUT, [P.panel(before, VIEW, 1), P.panel(wet.sim, VIEW, 1)], { background: 12 });
console.log(`\nwrote ${path.relative(path.join(__dirname, ".."), OUT)}`);
console.log("OK  water slice 4: a mixed bed separates by density, measured per material");
