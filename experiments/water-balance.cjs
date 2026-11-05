// The drag balance for the water mode, as a script instead of a one-off probe.
// `WATER_DRAG` sets how fast still water brakes a submerged grain, and it is the
// single knob that decides whether a mixed bed separates: too little and the
// bed churns, too much and the dense grains never reach the floor.
//
// Measured on the same field as `water-separation.cjs` (see water-scenario.cjs):
//   * time to 90% recovered and final recovered fraction, per drag;
//   * the worst float wander in the tight pool, where a float in a vessel barely
//     larger than its own displacement is the documented limit case.
//
// Run: node experiments/water-balance.cjs
"use strict";
const assert = require("node:assert/strict");
const S = require("../prototype/shared/simulation.js");
const C = require("./water-scenario.cjs");

const DRAGS = [3, 4, 6, 12];
const RADII = [2.3, 2.7, 3.0];

function recoveredAt(result, share) {
	const at = result.curve.findIndex(c => c.score.recovered >= share);
	return at < 0 ? Infinity : at + 1;
}

function worstWander(drag) {
	let worst = 0;
	for (const r of RADII) {
		const m = C.floatWander(r, 3, 10, drag);
		if (m.wander > worst) worst = m.wander;
	}
	return worst;
}

console.log("drag  90% at  final  float  sink  worst float wander");
const rows = [];
for (const drag of DRAGS) {
	const result = C.run(true, null, drag);
	const fast = recoveredAt(result, 0.9);
	const wander = worstWander(drag);
	rows.push({ drag, fast, score: result.final.score, wander });
	console.log(
		String(drag).padStart(4) +
			String(Number.isFinite(fast) ? fast + " s" : "never").padStart(7) +
			`${(result.final.score.recovered * 100).toFixed(0)}%`.padStart(7) +
			`${(result.final.score.floatRecovery * 100).toFixed(0)}%`.padStart(7) +
			`${(result.final.score.sinkRecovery * 100).toFixed(0)}%`.padStart(6) +
			`${wander.toFixed(2)} px`.padStart(20),
	);
}

const shipped = rows.find(row => row.drag === S.WATER_DRAG);
const low = rows.reduce((a, b) => (a.drag < b.drag ? a : b));
const high = rows.reduce((a, b) => (a.drag > b.drag ? a : b));
assert.ok(shipped, `the shipped drag (${S.WATER_DRAG}) is in the sweep`);
assert.equal(S.WATER_DRAG, 6, "the plan documents 6 /s; change both together");

// 1. The shipped value recovers the whole bed at 100% light and 100% dense.
assert.ok(shipped.score.recovered >= 0.95, `the shipped drag separates the bed (${(shipped.score.recovered * 100).toFixed(0)}%)`);
assert.ok(shipped.score.floatRecovery >= 0.95 && shipped.score.sinkRecovery >= 0.95, "both groups recover at the shipped drag");

// 2. Too little drag churns the bed: grains are still moving well after the
//    drained case would have settled, and the float in the tight pool wanders.
assert.ok(low.drag < S.WATER_DRAG, "the sweep has a lighter drag to compare");
assert.ok(low.wander > shipped.wander * 2, `less drag churns the float (${low.wander.toFixed(2)} vs ${shipped.wander.toFixed(2)} px)`);
assert.ok(low.score.sinkRecovery < shipped.score.sinkRecovery, `less drag leaves dense grains up (${(low.score.sinkRecovery * 100).toFixed(0)}%)`);

// 3. Too much drag strands the dense grains: they are braked before they sink.
assert.ok(high.drag > S.WATER_DRAG, "the sweep has a heavier drag to compare");
assert.ok(high.score.sinkRecovery < 0.9, `more drag strands dense grains (${(high.score.sinkRecovery * 100).toFixed(0)}%)`);
assert.ok(high.wander < shipped.wander, "but it does damp the float, which is why it looks tempting");

// 4. The float in the tight pool is the documented limit, not a drift: it stays
//    a few pixels and holds its density ratio.
const lone = C.floatWander(2.7, 3, 10, S.WATER_DRAG);
assert.ok(lone.wander < 4, `the tight-pool float wanders ${lone.wander.toFixed(2)} px, not more`);
assert.ok(Math.abs(lone.submerged - 0.5) < 0.15, `its submerged fraction stays near 0.50 (${lone.submerged.toFixed(2)})`);

console.log(`\nwander source: one float, radii ${RADII.join("/")} px, 10 s each, in a ${(C.TIGHT_R * 2).toFixed(0)} px chamber with ${C.TIGHT_VOL} px² of water`);
console.log(`OK  water balance: ${S.WATER_DRAG} /s separates both groups with the tightest float`);
