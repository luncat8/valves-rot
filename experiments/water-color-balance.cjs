"use strict";
// Closed basin, 60 s at 120 Hz, with every mixability partition exercised.
const assert = require("node:assert/strict");
const os = require("node:os");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const C = require("./water-color-scenario.cjs");
const sim = C.create();
const w = sim.water;
const masks = [[0, 0, 0], [1, 1, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
let maxAbs = 0;
let maxRel = 0;
let maxCache = 0;
let minChannel = 0;
const totals = new Float64Array(3);
for (let second = 0; second < 60; second++) {
	const ch = w.ch.slice();
	const trapped = w.trappedCh.slice();
	const vol = w.vol.slice();
	W.setMixable(w, masks[second % masks.length]);
	assert.deepEqual(w.ch, ch, "toggle must not rewrite channels");
	assert.deepEqual(w.trappedCh, trapped, "toggle must not rewrite trapped channels");
	assert.deepEqual(w.vol, vol, "toggle must not rewrite totals");
	C.steps(sim, 1);
	W.channelTotals(w, totals);
	for (let k = 0; k < 3; k++) {
		const input = w.chInitial[k] + w.chAdmitted[k];
		const output = totals[k] + w.chOverflowed[k] + w.chDrained[k];
		const error = Math.abs(input - output);
		maxAbs = Math.max(maxAbs, error);
		maxRel = Math.max(maxRel, error / Math.max(1, Math.abs(input)));
	}
	maxCache = Math.max(maxCache, W.residual(w));
	for (const value of w.ch) {
		assert.ok(Number.isFinite(value), "finite channels");
		minChannel = Math.min(minChannel, value);
	}
}
assert.ok(minChannel >= -1e-9, "negative channel dust exceeds tolerance");
assert.ok(maxRel < 1e-9 && maxAbs < 1e-5, "closed-box ledger");
assert.ok(maxCache < 1e-9, "cell cache residual");
assert.equal(w.overflowed + w.drained + w.admitted, 0, "closed box has no flows across its boundary");
console.log(`node ${process.version}; ${os.cpus()[0].model}; seed 3; dt ${S.STEP}; 60 s; 60 toggles`);
console.log(`max ledger absolute ${maxAbs.toExponential(6)} px²; relative ${maxRel.toExponential(6)}; cache ${maxCache.toExponential(6)} px²`);
console.log(`minimum channel ${minChannel.toExponential(6)} px² (roundoff dust)`);
console.log("limits: absolute 1e-5 px²; relative 1e-9; cache 1e-9 px²; negative dust -1e-9 px²");
console.log("OK  closed-box channel balance and bit-exact toggles");
