"use strict";
// Input source vents: one per column above the pour band, each with its own
// on/off flag, rate and pour shares, plus the hue mapping the canvas slide uses
// and the column sweep the global slider brushes with.
// Run: node experiments/water-sources-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

const N = G.N;
const RV = G.RV;

// A field of blank plugs with only the listed cells opened. Specs keyed "i,j"
// hold [kind, ports, chamberR].
function field(spec) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const e = spec[i + "," + j];
			valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
		}
	}
	return { seed: 3, valves };
}

function makeSim(spec) {
	const sim = S.create(field(spec), { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	return { sim, w };
}

// Liquid whose cell centre lies inside a world rect.
function regionVol(w, x0, y0, x1, y1) {
	let v = 0;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 0) continue;
		const x = ((i % w.nx) + 0.5) * w.cell;
		const y = (((i / w.nx) | 0) + 0.5) * w.cell - G.POUR;
		if (x >= x0 && x <= x1 && y >= y0 && y <= y1) v += w.vol[i];
	}
	return v;
}

function regionChannels(w, x0, y0, x1, y1, out) {
	out[0] = out[1] = out[2] = 0;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 0) continue;
		const x = ((i % w.nx) + 0.5) * w.cell;
		const y = (((i / w.nx) | 0) + 0.5) * w.cell - G.POUR;
		if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
			const o = i * 3;
			out[0] += w.ch[o];
			out[1] += w.ch[o + 1];
			out[2] += w.ch[o + 2];
		}
	}
	return out;
}

const stored = new Float64Array(3);
const region = new Float64Array(3);
const shares = new Float64Array(3);

// The channel ledger, stated as an equation rather than trusted.
function books(w, tag) {
	W.channelTotals(w, stored);
	const held = stored[0] + stored[1] + stored[2];
	for (let k = 0; k < 3; k++) {
		const lhs = w.chInitial[k] + w.chAdmitted[k];
		const rhs = stored[k] + w.chOverflowed[k] + w.chDrained[k];
		const tol = 1e-9 * Math.max(1, Math.abs(lhs), Math.abs(rhs));
		assert.ok(Math.abs(lhs - rhs) <= tol,
			`${tag}: channel ${"RGB"[k]} closes (${lhs.toFixed(6)} vs ${rhs.toFixed(6)})`);
		assert.ok(Number.isFinite(stored[k]) && stored[k] >= 0, `${tag}: channel ${k} is finite and nonnegative`);
	}
	const r = W.residual(w);
	assert.ok(Number.isFinite(r) && r <= 1e-9 * Math.max(1, held),
		`${tag}: vol cache matches the channels (residual ${r.toExponential(2)} for ${held.toFixed(1)} px²)`);
	return held;
}

function near(a, b, tol, tag) {
	assert.ok(Math.abs(a - b) <= tol, `${tag}: ${a} vs ${b} (tol ${tol})`);
}

// A scratch water state for the pure state tests.
let scratch = null;
function w0() {
	if (!scratch) {
		const sim = S.create(field({}), { turning: false });
		scratch = S.setWater(sim, true);
	}
	return scratch;
}

// ---------------------------------------------------------------------------
// 1. Two vents pour different liquids into their own columns; the books close
//    per channel and each column reads its own vent's colour and rate.
{
	const spec = {};
	for (const c of [2, 7]) for (let j = 0; j < N; j++) spec[c + "," + j] = ["hollow", [3, 1], RV * 0.5];
	// Cap the shaft bottoms so both pools accumulate instead of draining: a rate
	// comparison needs stored liquid, not a transient flow-through.
	spec["2,9"] = ["hollow", [3], RV * 0.5];
	spec["7,9"] = ["hollow", [3], RV * 0.5];
	const { sim, w } = makeSim(spec);
	W.setVent(w, 2, true);
	W.setSupply(w, 300);
	W.setPour(w, [1, 0, 0]);
	W.setVent(w, 7, true);
	W.setSupply(w, 600);
	W.setPour(w, [0, 0, 1]);
	assert.equal(w.ventRate[2], 300, "moving the current vent keeps the first vent's rate");
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP); // 2 s at 120 Hz
	const held = books(w, "two vents");
	assert.ok(held > 0, "both vents poured");
	const left = [...regionChannels(w, 2 * G.S, 0, 3 * G.S, G.SIZE, region)];
	const right = [...regionChannels(w, 7 * G.S, 0, 8 * G.S, G.SIZE, region)];
	assert.ok(left[0] > 0 && Math.abs(left[1]) < 1e-9 && Math.abs(left[2]) < 1e-9, "column 2 holds only red");
	assert.ok(right[2] > 0 && Math.abs(right[0]) < 1e-9 && Math.abs(right[1]) < 1e-9, "column 7 holds only blue");
	near(left[0] / right[2], 300 / 600, 0.05, "the two pools keep the 1:2 rate ratio");
	console.log(`ok  two vents pour their own colours (red ${left[0].toFixed(0)} px², blue ${right[2].toFixed(0)} px²)`);
}

// ---------------------------------------------------------------------------
// 2. Single-vent compatibility: the old setVent/setSupply/setPour calls still
//    pour exactly one column, and the shut default pours nothing.
{
	const spec = {};
	for (let j = 0; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	const { sim, w } = makeSim(spec);
	for (let k = 0; k < 60; k++) S.step(sim, S.STEP);
	assert.equal(w.admitted, 0, "a shut vent admits nothing");
	W.setVent(w, 4, true);
	W.setSupply(w, 200);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	const held = books(w, "single vent");
	assert.ok(held > 0, "the vent poured");
	for (let c = 0; c < N; c++) {
		if (c === 4) continue;
		assert.equal(regionVol(w, c * G.S, 0, (c + 1) * G.S, G.SIZE), 0, `column ${c} stays dry`);
	}
	assert.equal(W.ventOpenCount(w), 1, "exactly one vent is open");
	console.log(`ok  single-vent API still pours one column (${held.toFixed(0)} px²)`);
}

// ---------------------------------------------------------------------------
// 3. A blocked top port is per vent: the column under a shut spout keeps every
//    drop out of the field while its neighbour pours normally.
{
	const spec = {};
	for (const c of [4, 6]) for (let j = 0; j < N; j++) spec[c + "," + j] = ["hollow", [3, 1], RV * 0.5];
	spec["4,0"] = ["hollow", [0, 2], RV * 0.5]; // top cell E/W: the N spout is shut
	const { sim, w } = makeSim(spec);
	W.setVent(w, 4, true);
	W.setSupply(w, 200);
	W.setVent(w, 6, true);
	W.setSupply(w, 200);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	books(w, "blocked vent");
	assert.ok(w.admitted > 0, "supply is booked through the shared ledger");
	// The shut spout's own void reaches into the top of its cell, so the wall is
	// judged below the first valve row, as the water-state fixtures do.
	assert.equal(regionVol(w, 4 * G.S, G.S, 5 * G.S, G.SIZE), 0, "nothing passes the shut spout");
	assert.ok(regionVol(w, 6 * G.S, G.S, 7 * G.S, G.SIZE) > 0, "the neighbour's column carries water");
	console.log(`ok  shut spout confines its own vent, neighbour poured ${regionVol(w, 6 * G.S, G.S, 7 * G.S, G.SIZE).toFixed(0)} px²`);
}

// ---------------------------------------------------------------------------
// 4. Hue mapping: the six corners are the primary and secondary colours, every
//    hue in between ramps its two neighbours, and the inverse reads it back.
{
	const corners = [[0, [1, 0, 0]], [60, [1, 1, 0]], [120, [0, 1, 0]], [180, [0, 1, 1]], [240, [0, 0, 1]], [300, [1, 0, 1]]];
	for (const [hue, want] of corners) {
		W.hueShares(hue, shares);
		assert.deepEqual([...shares], want, `hue ${hue} is ${want.join(",")}`);
		assert.equal(W.sharesHue(shares), hue, `shares ${want.join(",")} read back as ${hue}`);
	}
	W.hueShares(30, shares);
	assert.deepEqual([...shares], [1, 0.5, 0], "hue 30 ramps G halfway");
	near(W.sharesHue(shares), 30, 1e-9, "hue 30 reads back");
	W.hueShares(720 + 120, shares);
	assert.deepEqual([...shares], [0, 1, 0], "the hue wheel wraps");
	W.hueShares(-60, shares);
	assert.deepEqual([...shares], [1, 0, 1], "negative hues wrap onto the wheel");
	assert.equal(W.sharesHue([1 / 3, 1 / 3, 1 / 3]), 0, "grey shares have no hue");
	assert.equal(W.sharesHue([0, 0, 0]), 0, "empty shares have no hue");
	// A hue picked colour survives the vent state's sum normalization.
	const w = w0();
	W.setVentShares(w, 0, W.hueShares(90, shares));
	assert.deepEqual([...w.ventShares.slice(0, 3)], [1 / 3, 2 / 3, 0], "hue 90 normalizes to a 1:2:0 mix");
	near(W.sharesHue(w.ventShares.slice(0, 3)), 90, 1e-9, "the normalized mix keeps its hue");
	console.log("ok  hue wheel: corners exact, ramps linear, wraps both ways");
}

// ---------------------------------------------------------------------------
// 5. Per-vent edits and the mirror: direct setters touch one vent, the mirror
//    follows the current vent, and refusals change nothing.
{
	const w = w0();
	W.setVent(w, 3, true);
	W.setSupply(w, 500);
	W.setPour(w, [0, 1, 0]);
	assert.equal(w.ventOpen, true, "mirror follows the current vent's flag");
	assert.equal(w.rate, 500, "mirror follows the current vent's rate");
	assert.deepEqual([...w.pour], [0, 1, 0], "mirror follows the current vent's shares");
	W.setVentRate(w, 5, 1234);
	assert.equal(w.ventRate[5], 1234, "a direct rate edit lands");
	assert.equal(w.rate, 500, "the mirror ignores another vent");
	W.setVentRate(w, 5, 99999);
	assert.equal(w.ventRate[5], W.RATE_MAX, "a vent rate is capped at the global ceiling");
	W.setVentRate(w, 5, -5);
	assert.equal(w.ventRate[5], 0, "a negative rate clamps to zero");
	W.setVentShares(w, 6, [2, 1, 0]);
	assert.deepEqual([...w.ventShares.slice(18, 21)], [2 / 3, 1 / 3, 0], "shares normalize by their sum");
	assert.equal(W.setVentShares(w, 6, [0, 0, 0]), false, "black shares are refused");
	assert.deepEqual([...w.ventShares.slice(18, 21)], [2 / 3, 1 / 3, 0], "a refused edit changes nothing");
	assert.equal(W.setPour(w, [0, 0, 0]), false, "an empty pour mask is still refused");
	assert.equal(W.toggleVent(w, 6), true, "toggle opens a shut vent");
	assert.equal(W.toggleVent(w, 6), false, "toggle shuts it again");
	assert.equal(w.ventOn[6], 0, "the vent ends shut");
	W.setVentRate(w, 5, 1234);
	W.selectVent(w, 5);
	assert.equal(w.rate, 1234, "selecting a vent mirrors its rate");
	assert.equal(w.ventOpen, false, "selecting mirrors its flag");
	assert.deepEqual([...w.pour], [1 / 3, 1 / 3, 1 / 3], "an untouched vent keeps the default mix");
	W.selectVent(w, 6);
	assert.deepEqual([...w.pour], [2 / 3, 1 / 3, 0], "selecting mirrors its shares");
	assert.deepEqual([...w.pourMask], [1, 1, 0], "the pour mask mirrors the channels in use");
	console.log("ok  per-vent edits land, the mirror follows the current vent, refusals hold");
}

// ---------------------------------------------------------------------------
// 6. The column sweep: moving the global column stamps the settings of the vent
//    it left onto every vent it passes, without touching the vents it skipped.
{
	const { w } = makeSim({});
	W.setVent(w, 1, true);
	W.setSupply(w, 250);
	W.setPour(w, [1, 0, 0]);
	W.setVentRate(w, 8, 6000);
	W.setVentShares(w, 8, [0, 1, 0]);
	W.sweepVents(w, 1, 4);
	assert.equal(w.ventColumn, 4, "the sweep ends on the destination vent");
	for (const c of [2, 3, 4]) {
		assert.equal(w.ventOn[c], 1, `swept vent ${c} is open`);
		assert.equal(w.ventRate[c], 250, `swept vent ${c} carries the rate`);
		assert.deepEqual([...w.ventShares.slice(c * 3, c * 3 + 3)], [1, 0, 0], `swept vent ${c} is red`);
	}
	assert.equal(w.ventOn[8], 0, "a vent outside the sweep keeps its flag");
	assert.equal(w.ventRate[8], 6000, "a vent outside the sweep keeps its rate");
	assert.deepEqual([...w.ventShares.slice(24, 27)], [0, 1, 0], "a vent outside the sweep keeps its colour");
	// A jump over the whole row is one brush stroke: everything the slider passed
	// becomes the source. The source vent itself is already the stamp, and the
	// vents beyond it are untouched.
	W.sweepVents(w, 1, 9);
	for (let c = 1; c < N; c++) {
		assert.equal(w.ventOn[c], 1, `vent ${c} is open after the full sweep`);
		assert.equal(w.ventRate[c], 250, `vent ${c} carries the rate after the full sweep`);
		assert.deepEqual([...w.ventShares.slice(c * 3, c * 3 + 3)], [1, 0, 0], `vent ${c} is red after the full sweep`);
	}
	assert.equal(w.ventOn[0], 0, "the vent beyond the sweep keeps its own flag");
	// A no-move sweep only selects, and wild columns clamp to the field.
	W.sweepVents(w, 7, 7);
	assert.equal(w.ventColumn, 7, "a no-move sweep only selects");
	W.sweepVents(w, 9, 99);
	assert.equal(w.ventColumn, N - 1, "an over-range destination clamps to the field");
	W.sweepVents(w, 99, 2);
	assert.equal(w.ventColumn, 2, "an over-range source clamps too");
	console.log("ok  column sweep stamps every vent it passes, skips the rest, clamps");
}

// ---------------------------------------------------------------------------
// 7. Reset shuts every vent and keeps each one's rate and colour.
{
	const { w } = makeSim({});
	W.setVent(w, 2, true);
	W.setVentRate(w, 2, 900);
	W.setVentShares(w, 2, [0, 0, 1]);
	W.setVent(w, 5, true);
	W.reset(w);
	assert.equal(W.ventOpenCount(w), 0, "reset shuts every vent");
	assert.equal(w.ventRate[2], 900, "reset keeps the rates");
	assert.deepEqual([...w.ventShares.slice(6, 9)], [0, 0, 1], "reset keeps the colours");
	assert.equal(w.ventOpen, false, "the mirror reads the shut current vent");
	console.log("ok  reset shuts every vent and keeps their parameters");
}

console.log("OK  water sources: per-vent supply, hue wheel, mirror, sweep, reset");
