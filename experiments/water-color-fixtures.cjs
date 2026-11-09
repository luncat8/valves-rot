"use strict";
// Slice 1 of 0.3-water-color-plan: conserved R/G/B liquid channels, proportional
// transfer, per-channel books, pour shares, and both display views. All colours
// are mixable here; separated phases are slice 2.
// Run: node experiments/water-color-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const R = require("../prototype/shared/render.js");

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
function valve(layout, i, j) { return layout.valves[j * N + i]; }

function makeSim(spec) {
	const sim = S.create(field(spec), { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	return { sim, w };
}

function cellAt(w, x, y) {
	return Math.floor((y + G.POUR) / w.cell) * w.nx + Math.floor(x / w.cell);
}

// The wettest cell: a pool spreads over its chamber, so a display test reads the
// cell that actually holds the liquid rather than the one it was poured into.
function fullest(w) {
	let best = -1;
	let vol = 0;
	for (let i = 0; i < w.count; i++) if (w.vol[i] > vol) { vol = w.vol[i]; best = i; }
	return best;
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

const stored = new Float64Array(3);

// The channel ledger, stated as an equation rather than trusted: what entered
// (initial + admitted) equals what is held plus what left (overflowed + drained),
// per channel, and the cached cell totals still sum their channels.
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

// The display table holds one triple per phase layer, rank * 3 + channel; with
// every colour mixable there is one layer and it sits at rank 0.
function triple(field, cell, rank) {
	const o = (cell * 3 + (rank || 0)) * 3;
	return [...field.color.slice(o, o + 3)];
}

function snapshot(w) {
	return { ch: w.ch.slice(), vol: w.vol.slice(), trappedCh: w.trappedCh.slice() };
}
function assertUnchanged(w, snap, tag) {
	assert.deepEqual([...w.ch], [...snap.ch], `${tag}: channels untouched`);
	assert.deepEqual([...w.vol], [...snap.vol], `${tag}: totals untouched`);
	assert.deepEqual([...w.trappedCh], [...snap.trappedCh], `${tag}: carried channels untouched`);
}

// ---------------------------------------------------------------------------
// 1. Supply splits the inlet rate by the pour mask and books each channel.
{
	const spec = {};
	for (let j = 0; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	const { sim, w } = makeSim(spec);
	W.setVent(w, 4, true);
	W.setSupply(w, 300);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	const held = books(w, "three-colour pour");
	const third = w.admitted / 3;
	for (let k = 0; k < 3; k++) {
		assert.ok(Math.abs(w.chAdmitted[k] - third) < 1e-6 * Math.max(1, third),
			`equal pour shares book a third each (${w.chAdmitted[k].toFixed(3)} vs ${third.toFixed(3)})`);
	}
	assert.ok(held > 0 && w.admitted > 0);
	console.log(`ok  three-colour pour: admitted ${w.admitted.toFixed(0)} px², each channel a third, drained ${w.drained.toFixed(0)}`);
}

// 2. The selection changes the mix, not the volume: one colour and two colours
//    deliver the same total rate into the same field.
{
	function pour(mask) {
		const spec = {};
		for (let j = 0; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
		const { sim, w } = makeSim(spec);
		W.setVent(w, 4, true);
		W.setSupply(w, 300);
		assert.equal(W.setPour(w, mask), true, "a non-empty pour mask is accepted");
		for (let k = 0; k < 60; k++) S.step(sim, S.STEP);
		books(w, "pour " + mask);
		return w;
	}
	const onlyR = pour([1, 0, 0]);
	assert.ok(onlyR.chAdmitted[0] > 0 && onlyR.chAdmitted[1] === 0 && onlyR.chAdmitted[2] === 0,
		"a single-colour pour books one channel only");
	assert.ok(onlyR.pour[0] === 1 && onlyR.pour[1] === 0, "shares normalize to the single channel");
	const rg = pour([1, 1, 0]);
	assert.ok(Math.abs(rg.chAdmitted[0] - rg.chAdmitted[1]) < 1e-9, "two selected channels take equal shares");
	assert.ok(rg.chAdmitted[2] === 0, "an unselected channel gets nothing");
	assert.ok(Math.abs(rg.admitted - onlyR.admitted) < 1e-6,
		`the same rate delivers the same volume (${onlyR.admitted.toFixed(3)} vs ${rg.admitted.toFixed(3)})`);
	// An empty mask is refused, so the inlet cannot fall back to a default mix.
	const { w } = makeSim({ "4,5": ["hollow", [], RV * 0.8] });
	const before = [...w.pour];
	assert.equal(W.setPour(w, [0, 0, 0]), false, "the last pour colour cannot be deselected");
	assert.deepEqual([...w.pour], before, "a refused mask leaves the shares alone");
	console.log(`ok  pour selection splits one rate (R ${onlyR.chAdmitted[0].toFixed(0)}, R+G ${rg.chAdmitted[0].toFixed(0)}+${rg.chAdmitted[1].toFixed(0)}, totals equal)`);
}

// 3. A move is proportional and exact: the donor keeps its ratio and the pair
//    conserves every channel.
{
	const { sim, w } = makeSim({ "4,5": ["hollow", [], RV * 0.8], "5,5": ["hollow", [], RV * 0.8] });
	const a = valve(sim.layout, 4, 5);
	const b = valve(sim.layout, 5, 5);
	const i = cellAt(w, a.cx, a.cy);
	const j = cellAt(w, b.cx, b.cy);
	W.setLiquid(w, i, 120, [1, 2, 3]);
	W.move(w, i, j, 50);
	assert.equal(w.vol[i], 70);
	assert.equal(w.vol[j], 50);
	const share = [1 / 6, 2 / 6, 3 / 6];
	for (let k = 0; k < 3; k++) {
		assert.ok(Math.abs(w.ch[i * 3 + k] + w.ch[j * 3 + k] - 120 * share[k]) < 1e-9, `channel ${k} is conserved by the move`);
		assert.ok(Math.abs(w.ch[j * 3 + k] - 50 * share[k]) < 1e-9, `channel ${k} moved in proportion`);
	}
	// Moving everything empties the donor without a remainder.
	W.move(w, i, j, w.vol[i]);
	assert.equal(w.vol[i], 0);
	assert.deepEqual([...w.ch.slice(i * 3, i * 3 + 3)], [0, 0, 0], "an emptied donor keeps nothing");
	// Rounding rule: every share is a product with a factor below one, so it
	// cannot overdraw its own channel — but the remainder can. A cell with an
	// empty blue channel and a dust-sized move used to charge the rounding
	// remainder to that empty channel and leave it at -1.4e-20 px²; the closed
	// box measurement found the same dust at -6.8e-21 after 60 s of toggling. The
	// remainder now goes to the largest channel, which holds a third of the move.
	W.setLiquid(w, i, 36, [3, 1, 0]); // channels 27 / 9 / 0, no blue to overdraw
	const jBefore = w.vol[j];
	const jRed = w.ch[j * 3];
	const jGreen = w.ch[j * 3 + 1];
	const jBlue = w.ch[j * 3 + 2];
	W.move(w, i, j, 0.00036);
	for (let k = 0; k < 3; k++) {
		assert.ok(w.ch[i * 3 + k] >= 0 && w.ch[j * 3 + k] >= 0, `channel ${k} stays nonnegative on a dust move`);
	}
	assert.ok(Math.abs(w.ch[j * 3] - jRed - 0.00027) < 1e-12, "red takes its 3/4 share");
	assert.ok(Math.abs(w.ch[j * 3 + 1] - jGreen - 0.00009) < 1e-12, "green takes its 1/4 share");
	assert.equal(w.ch[j * 3 + 2], jBlue, "an empty channel receives and gives nothing");
	assert.ok(Math.abs(w.vol[i] - (36 - 0.00036)) < 1e-9, "the donor loses exactly what moved");
	assert.ok(Math.abs(w.vol[j] - jBefore - 0.00036) < 1e-9, "the receiver gains exactly what moved");
	assert.ok(Math.abs(w.ch[i * 3] / w.ch[i * 3 + 1] - 3) < 1e-9, "the donor keeps its 3:1 ratio");
	books(w, "moves");
	console.log("ok  move(area) is proportional, exact and leaves no remainder");
}

// 4. Sill spill and settling move the mix, not a colour: a mixed pour that spreads
//    through two connected chambers keeps every cell's ratio.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.8],
		"4,5": ["hollow", [2], RV * 0.8],
	};
	const { sim, w } = makeSim(spec);
	const left = valve(sim.layout, 3, 5);
	const right = valve(sim.layout, 4, 5);
	W.setLiquid(w, cellAt(w, left.cx, left.cy), 1400, [1, 1, 2]);
	W.settle(w, 400);
	const rv = w.vol[cellAt(w, right.cx, right.cy)];
	assert.ok(rv > 1, "the mix crosses the sill");
	books(w, "sill spill");
	let cells = 0;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 1e-3) continue;
		cells++;
		const r = w.ch[i * 3] / w.ch[i * 3 + 2];
		assert.ok(Math.abs(r - 0.5) < 1e-6, `a spilled mix keeps its ratio (R/B ${r.toFixed(6)})`);
	}
	assert.ok(cells > 1, "more than one cell holds liquid");
	console.log(`ok  sill spill carries the ratio into ${cells} cells, R/B 0.5 preserved`);
}

// 5. A turning rotor carries, splits and returns the composition it trapped.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0], // straight connector rotor
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const { sim, w } = makeSim(spec);
	const mid = valve(sim.layout, 4, 5);
	const left = valve(sim.layout, 3, 5);
	const right = valve(sim.layout, 5, 5);
	W.setLiquid(w, cellAt(w, left.cx, left.cy), 500, [1, 2, 3]);
	W.settle(w, 300);
	const before = W.channelTotals(w, new Float64Array(3)).slice();
	assert.ok(regionVol(w, right.cx - RV, right.cy - RV, right.cx + RV, right.cy + RV) > 1,
		"the mix reaches the right chamber");
	G.setAngle(mid, G.HALF_PI);
	W.rebuild(sim);
	W.settle(w, 300);
	let carried = 0;
	let trappedCh = 0;
	for (let i = 0; i < w.count; i++) {
		carried += w.trapped[i];
		for (let k = 0; k < 3; k++) trappedCh += w.trappedCh[i * 3 + k];
	}
	assert.ok(carried > 0, "the shut connector carries water");
	assert.ok(Math.abs(trappedCh - carried) < 1e-9, "and it carries the colours, not a blank");
	books(w, "split");
	G.setAngle(mid, 0);
	W.rebuild(sim);
	W.settle(w, 300);
	let leftOver = 0;
	for (let i = 0; i < w.count; i++) leftOver += w.trapped[i];
	assert.ok(leftOver < 1e-9, "a reopened passage returns the carried water");
	const after = W.channelTotals(w, new Float64Array(3));
	for (let k = 0; k < 3; k++) {
		assert.ok(Math.abs(after[k] - before[k]) < 1e-6, `channel ${k} survives split and merge`);
	}
	books(w, "merge");
	// Draining covers the carried shares too, and books them as drained.
	const drained = W.drainAll(w);
	assert.ok(Math.abs(drained - (after[0] + after[1] + after[2])) < 1e-6, "drain takes the whole inventory");
	books(w, "drain");
	console.log(`ok  split/merge carries ${carried.toFixed(0)} px² of mix, drain books ${drained.toFixed(0)} px²`);
}

// 6. Overflow books the excess per channel instead of a blank total.
{
	const spec = {};
	for (let j = 1; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	spec["4,0"] = ["hollow", [0, 2], RV * 0.5]; // dead-end spout: fills, then spills
	const { sim, w } = makeSim(spec);
	W.setVent(w, 4, true);
	W.setSupply(w, 4000);
	W.setPour(w, [1, 0, 1]);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	assert.ok(w.overflowed > 0, "a full open inlet spills");
	books(w, "overflow");
	assert.ok(Math.abs(w.chOverflowed[0] - w.chOverflowed[2]) < 1e-6 * Math.max(1, w.chOverflowed[0]),
		"overflow keeps the R+B split it took in");
	assert.equal(w.chOverflowed[1], 0, "a channel that was never poured never overflows");
	console.log(`ok  overflow ${w.overflowed.toFixed(0)} px² booked as R ${w.chOverflowed[0].toFixed(0)} / B ${w.chOverflowed[2].toFixed(0)}, no G`);
}

// 7. Reset clears channels, carried shares and books; nothing stale survives.
{
	const spec = { "4,5": ["hollow", [], RV * 0.85] };
	const { sim, w } = makeSim(spec);
	const v = valve(sim.layout, 4, 5);
	W.setLiquid(w, cellAt(w, v.cx, v.cy), 400, [2, 1, 0]);
	W.drainAll(w);
	books(w, "after drain");
	W.reset(w);
	for (const book of ["chInitial", "chAttempted", "chAdmitted", "chUnadmitted", "chOverflowed", "chDrained"]) {
		assert.deepEqual([...w[book]], [0, 0, 0], `reset clears ${book}`);
	}
	let any = 0;
	for (let i = 0; i < w.ch.length; i++) any += w.ch[i] + w.trappedCh[i];
	assert.equal(any, 0, "reset clears every channel and carried share");
	console.log("ok  reset clears channels, carried shares and per-channel books");
}

// 8. Display mapping: the normalized triple (dominant = 255) and the two views.
{
	const { sim, w } = makeSim({ "4,5": ["hollow", [], RV * 0.85] });
	const v = valve(sim.layout, 4, 5);
	W.setLiquid(w, cellAt(w, v.cx, v.cy), 400, [1, 1, 1]);
	for (let k = 0; k < 30; k++) S.step(sim, S.STEP);
	const field = W.makeDisplay(w);
	W.sampleDisplay(sim, field);
	const i = fullest(w);
	assert.ok(w.vol[i] > 0);
	const tri = triple(field, i);
	assert.deepEqual(tri, [255, 255, 255], "equal shares display white");
	// Every wet cell keeps that triple: a proportional mix moves without splitting.
	for (let c = 0; c < w.count; c++) {
		if (w.vol[c] <= 1e-9) continue;
		assert.deepEqual(triple(field, c), [255, 255, 255], `cell ${c} keeps the mix`);
	}
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	const color = new Uint8ClampedArray(field.nx * field.ny * 4);
	const pigment = new Uint8ClampedArray(field.nx * field.ny * 4);
	R.renderWater({ nx: map.nx, ny: map.ny, img: { data: color }, ctx: { putImageData() {} } }, field, 0);
	R.renderWater({ nx: map.nx, ny: map.ny, img: { data: pigment }, ctx: { putImageData() {} } }, field, 1);
	let painted = 0;
	// The colour view shades the normalized triple a fixed step so an equal mix
	// still reads darker than pale porcelain; the field keeps the unshaded
	// mapping the pigment view uses.
	const shade = Math.round(255 * R.WATER_SHADE);
	for (let t = 0; t < field.nx * field.ny; t++) {
		const o = t * 4;
		assert.equal(color[o + 3], pigment[o + 3], "both views share the depth alpha");
		if (color[o + 3] === 0) continue;
		painted++;
		assert.equal(color[o], shade, "the colour view paints the shaded triple");
		assert.equal(color[o + 1], shade);
		assert.equal(color[o + 2], shade);
		assert.equal(pigment[o], 0, "white RGB reads black in pigment view");
		assert.equal(pigment[o + 1], pigment[o]);
		assert.equal(pigment[o + 2], pigment[o]);
	}
	assert.ok(painted > 50, `the pool paints texels (${painted})`);
	// Anchors of the pigment mapping, as a pure function.
	assert.equal(R.pigmentLevel(80, 80, 80), 255, "(80,80,80) clamps to full light");
	assert.equal((R.pigmentLevel(255, 255, 0) + 0.5) | 0, 128, "(255,255,0) maps to about 128");
	assert.equal(R.pigmentLevel(255, 255, 255), 0, "(255,255,255) maps to black");
	assert.equal(R.pigmentLevel(0, 0, 0), 255, "black RGB is full light");
	assert.equal(R.pigmentLevel(255, 255, 64), 95.5, "(255,255,64) is 95.5");
	console.log(`ok  views: ${painted} texels, equal shares white / pigment 0, anchors 255/128/0`);
}

// 9. Ratios and the pure primaries in both views; a view change is state-free.
{
	const { sim, w } = makeSim({ "4,5": ["hollow", [], RV * 0.85] });
	const v = valve(sim.layout, 4, 5);
	W.setLiquid(w, cellAt(w, v.cx, v.cy), 300, [2, 1, 0]);
	for (let k = 0; k < 30; k++) S.step(sim, S.STEP);
	const i = fullest(w);
	const snap = snapshot(w);
	const field = W.makeDisplay(w);
	W.sampleDisplay(sim, field);
	assert.deepEqual(triple(field, i), [255, 128, 0], "2:1:0 displays orange");
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	R.renderWater(map, field, 0);
	R.renderWater(map, field, 1);
	R.renderWater(map, field, 0);
	assertUnchanged(w, snap, "rendering both views");
	// A pure primary reads full in the colour view and light in pigment.
	W.setLiquid(w, i, 200, [1, 0, 0]);
	W.sampleDisplay(sim, field);
	assert.deepEqual(triple(field, i), [255, 0, 0], "a pure channel is its own hue");
	assert.equal((R.pigmentLevel(255, 0, 0) + 0.5) | 0, 255, "a pure primary is light in pigment view");
	console.log("ok  ratios survive normalization; pigment anchors and view toggling leave state alone");
}

// 10. Mixability is a derived partition: toggling it cannot move a channel.
{
	const { sim, w } = makeSim({ "4,5": ["hollow", [], RV * 0.85] });
	const v = valve(sim.layout, 4, 5);
	W.setLiquid(w, cellAt(w, v.cx, v.cy), 500, [1, 2, 3]);
	W.settle(w, 300);
	const before = snapshot(w);
	for (const mask of [[1, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 0], [1, 1, 1]]) {
		W.setMixable(w, mask);
		W.rebuild(sim);
		assertUnchanged(w, before, "mixable " + mask.join(""));
	}
	console.log("ok  mixability toggles touch no channel and no total");
}

// 11. Long closed-box run: no drift, no negative channel, no NaN.
{
	const spec = {};
	for (let j = 1; j < N - 1; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	const { sim, w } = makeSim(spec);
	W.setLiquid(w, cellAt(w, valve(sim.layout, 4, 5).cx, valve(sim.layout, 4, 5).cy), 3000, [1, 1, 1]);
	// Pour shares are per vent, so the vent column is selected before its mix.
	W.setVent(w, 4, true);
	W.setPour(w, [1, 0, 1]);
	W.setSupply(w, 800);
	for (let k = 0; k < 120 * 20; k++) S.step(sim, S.STEP);
	const held = books(w, "20 s closed box");
	for (let i = 0; i < w.ch.length; i++) {
		assert.ok(Number.isFinite(w.ch[i]) && w.ch[i] >= 0, `cell channel ${i} is finite and nonnegative`);
	}
	const totals = W.channelTotals(w, new Float64Array(3));
	assert.ok(Math.abs(totals[0] + totals[1] + totals[2] - held) < 1e-9 * Math.max(1, held));
	console.log(`ok  20 s closed box: ${held.toFixed(0)} px² held, R ${totals[0].toFixed(0)} / G ${totals[1].toFixed(0)} / B ${totals[2].toFixed(0)}, overflow ${w.overflowed.toFixed(0)}`);
}

// 12. Dual 2+2 non-mixing valves (`solid-bends` and `solid-overpass`): pure Red
// and pure Blue streams cross the same valve cell without mixing, and rotating
// `solid-overpass` through 90° (`switched` branch-flip evacuation) conserves every drop.
{
	// (a) solid-bends at (4,1) with ports [1,0,2,3] (S-E and W-N):
	//     Vent 4 (Red) -> (4,0) -> (4,1) W-N -> (3,1) S-E -> cup (3,2).
	//     Vent 5 (Blue) -> (5,0) -> (5,1) W-N -> (4,1) S-E -> cup (4,2).
	{
		const { sim, w } = makeSim({
			"4,0": ["solid", [1, 3]],
			"5,0": ["solid", [1, 3]],
			"4,1": ["solid", [1, 0, 2, 3]],
			"3,1": ["solid", [0, 1]],
			"5,1": ["solid", [2, 3]],
			"3,2": ["hollow", [3], RV * 0.8],
			"4,2": ["hollow", [3], RV * 0.8],
		});
		W.setVent(w, 4, true); W.setSupply(w, 250, 4); W.setPour(w, [1, 0, 0], 4);
		W.setVent(w, 5, true); W.setSupply(w, 250, 5); W.setPour(w, [0, 0, 1], 5);
		for (let k = 0; k < 360; k++) S.step(sim, S.STEP);
		books(w, "dual-bends water");
		let cup3R = 0, cup3B = 0, cup4R = 0, cup4B = 0;
		for (let c = 0; c < w.count; c++) {
			const x = (c % w.nx + 0.5) * W.CELL;
			const y = (((c / w.nx) | 0) + 0.5) * W.CELL - G.POUR;
			if (y < 2 * G.S || y >= 3 * G.S) continue;
			const col = (x / G.S) | 0;
			if (col === 3) { cup3R += w.ch[c * 3]; cup3B += w.ch[c * 3 + 2]; }
			if (col === 4) { cup4R += w.ch[c * 3]; cup4B += w.ch[c * 3 + 2]; }
		}
		assert.ok(cup3R > 150 && cup4B > 150, `both streams reached their cups through solid-bends (R=${cup3R.toFixed(1)}, B=${cup4B.toFixed(1)})`);
		assert.equal(cup3B, 0, "zero Blue leaked into Red cup across solid-bends");
		assert.equal(cup4R, 0, "zero Red leaked into Blue cup across solid-bends");
	}

	// (b) solid-overpass at (4,1) in both orientations ([0,2,1,3] and [1,3,2,0]),
	//     followed by continuous rotation through a full 90° quarter turn.
	for (const ports of [[0, 2, 1, 3], [1, 3, 2, 0]]) {
		const { sim, w } = makeSim({
			"4,0": ["solid", [1, 3]],
			"3,0": ["solid", [1, 3]],
			"3,1": ["solid", [0, 3]],
			"4,1": ["solid", ports],
			"5,1": ["solid", [1, 2]],
			"5,2": ["hollow", [3], RV * 0.8],
			"4,2": ["hollow", [3], RV * 0.8],
		});
		W.setVent(w, 4, true); W.setSupply(w, 250, 4); W.setPour(w, [1, 0, 0], 4);
		W.setVent(w, 3, true); W.setSupply(w, 250, 3); W.setPour(w, [0, 0, 1], 3);
		for (let k = 0; k < 360; k++) S.step(sim, S.STEP);
		books(w, "dual-overpass stationary");
		let cup4R = 0, cup4B = 0, cup5R = 0, cup5B = 0;
		for (let c = 0; c < w.count; c++) {
			const x = (c % w.nx + 0.5) * W.CELL;
			const y = (((c / w.nx) | 0) + 0.5) * W.CELL - G.POUR;
			if (y < 2 * G.S || y >= 3 * G.S) continue;
			const col = (x / G.S) | 0;
			if (col === 4) { cup4R += w.ch[c * 3]; cup4B += w.ch[c * 3 + 2]; }
			if (col === 5) { cup5R += w.ch[c * 3]; cup5B += w.ch[c * 3 + 2]; }
		}
		assert.ok(cup4R > 150 && cup5B > 150, `both streams crossed solid-overpass [${ports}] (R=${cup4R.toFixed(1)}, B=${cup5B.toFixed(1)})`);
		assert.equal(cup4B, 0, `zero Blue leaked into N-S Red stream on solid-overpass [${ports}]`);
		assert.equal(cup5R, 0, `zero Red leaked into W-E Blue stream on solid-overpass [${ports}]`);

		// Shut vents and rotate the overpass smoothly through +90° (`w.switched` branch flips):
		// channel and total books must remain conserved to machine precision.
		W.setVent(w, 4, false);
		W.setVent(w, 3, false);
		const over = valve(sim.layout, 4, 1);
		for (let step = 1; step <= 30; step++) {
			G.setAngle(over, (G.HALF_PI * step) / 30);
			W.rebuild(sim);
			S.step(sim, S.STEP);
		}
		books(w, `rotating solid-overpass [${ports}]`);
	}
	console.log("ok  dual 2+2 non-mixing water crossing (solid-bends & solid-overpass + 90° rotation)");
}

console.log("OK  water colour slice 1: channels, proportional transport, books, pour shares, two views");
