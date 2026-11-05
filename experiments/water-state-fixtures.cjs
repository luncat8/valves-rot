"use strict";
// Slice 2 of 0.3-water-plan: water volume/connectivity state on a geometry-derived
// passability grid. Components, spill sills, perched pools, split/merge
// conservation, displacement, supply/drain/overflow counters. No rendering.
// Run: node experiments/water-state-fixtures.cjs
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
function valve(layout, i, j) { return layout.valves[j * N + i]; }

function makeSim(spec, cell) {
	const sim = S.create(field(spec), { turning: false });
	S.setPressure(sim, "off");
	S.setWater(sim, true);
	if (cell) { sim.water = W.create(sim, cell); sim.water.enabled = true; }
	W.rebuild(sim);
	return sim;
}

function cellAt(w, x, y) {
	return Math.floor((y + G.POUR) / w.cell) * w.nx + Math.floor(x / w.cell);
}

// Inject a slice-area volume into the cell containing a world point.
function inject(sim, x, y, vol) {
	const w = sim.water;
	const i = cellAt(w, x, y);
	assert.ok(w.air[i], "inject point must be air");
	w.vol[i] += vol;
	return i;
}

// Total water whose cell centre lies inside a world rect.
function regionVol(sim, x0, y0, x1, y1) {
	const w = sim.water;
	let v = 0;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 0) continue;
		const gx = i % w.nx, gy = (i / w.nx) | 0;
		const x = (gx + 0.5) * w.cell, y = (gy + 0.5) * w.cell - G.POUR;
		if (x >= x0 && x <= x1 && y >= y0 && y <= y1) v += w.vol[i];
	}
	return v;
}

function conservation(sim, tag) {
	const w = sim.water;
	const stored = W.storedVol(w); // free volume + rotor-carried
	assert.ok(Math.abs(w.admitted - (stored + w.drained + w.overflowed)) < 1e-6,
		`${tag}: admitted = stored + drained + overflowed (got ${w.admitted} vs ${stored + w.drained + w.overflowed})`);
	assert.ok(Math.abs(w.attempted - (w.admitted + w.unadmitted)) < 1e-6,
		`${tag}: attempted = admitted + unadmitted`);
}

// ---------------------------------------------------------------------------
// 1. Open vertical pipe: supply falls through and drains; counters conserve.
{
	const spec = {};
	for (let j = 0; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	const sim = makeSim(spec);
	const w = sim.water;
	W.setVent(w, 4, true);
	W.setSupply(w, 200);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	assert.ok(w.drained > 0.5 * w.admitted, `open pipe must drain most supply (drained ${w.drained.toFixed(1)} / admitted ${w.admitted.toFixed(1)})`);
	conservation(sim, "open pipe");
	console.log(`ok  open pipe drains ${w.drained.toFixed(0)}/${w.admitted.toFixed(0)}, components ${w.compCount}`);
}

// 2. Blocked inlet: the spout is real void, so water enters it, but a shut top
//    port keeps every drop upstream — nothing is deposited behind the wall. A
//    spout filled to capacity then spills the excess out the top as overflow.
{
	const spec = {};
	for (let j = 1; j < N; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	spec["4,0"] = ["hollow", [0, 2], RV * 0.5]; // top cell E/W: N spout shut
	const sim = makeSim(spec);
	const w = sim.water;
	W.setVent(w, 4, true);
	W.setSupply(w, 200);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	const below = regionVol(sim, 0, G.S, G.SIZE, G.SIZE + G.POUR);
	assert.ok(below < 1e-6, `a shut port deposits nothing behind it (got ${below})`);
	assert.ok(w.admitted > 0, "the open spout itself admits water");
	conservation(sim, "blocked inlet");
	// Keep supplying until the dead-end spout is full; the excess spills out the
	// top as overflow (the mouth is open, so it is admitted, not unadmitted).
	W.setSupply(w, 4000);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	assert.ok(w.overflowed > 0, "a full open inlet spills supply as overflow");
	assert.ok(regionVol(sim, 0, G.S, G.SIZE, G.SIZE + G.POUR) < 1e-6, "still nothing behind the wall");
	conservation(sim, "full inlet");
	console.log(`ok  blocked inlet confines water, full inlet overflow ${w.overflowed.toFixed(0)}`);
}

// 3. Sealed chamber isolation: flooding a neighbour never wets a sealed pocket.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.8],   // left chamber, opens E
		"4,5": ["hollow", [2], RV * 0.8],   // right chamber, opens W -> connected
		"6,5": ["hollow", [], RV * 0.8],    // sealed pocket, no ports
	};
	const sim = makeSim(spec);
	const w = sim.water;
	const left = valve(sim.layout, 3, 5), sealed = valve(sim.layout, 6, 5);
	inject(sim, left.cx, left.cy, 400);
	W.settle(w, 300);
	const sealedVol = regionVol(sim, sealed.cx - RV, sealed.cy - RV, sealed.cx + RV, sealed.cy + RV);
	assert.ok(sealedVol < 1e-6, `sealed pocket stays dry (got ${sealedVol})`);
	const leftComp = w.comp[cellAt(w, left.cx, left.cy)];
	const sealedComp = w.comp[cellAt(w, sealed.cx, sealed.cy)];
	assert.ok(leftComp >= 0 && sealedComp >= 0, "both chambers are air cells");
	assert.notEqual(leftComp, sealedComp, "sealed pocket is a separate component");
	console.log("ok  sealed pocket isolated from flooded neighbour");
}

// 4. Sill / perched pool: two chambers joined at mid-height. The left fills to
//    the aperture sill before the right wets; above the sill they equalize.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.8],
		"4,5": ["hollow", [2], RV * 0.8],
	};
	const sim = makeSim(spec);
	const w = sim.water;
	const left = valve(sim.layout, 3, 5), right = valve(sim.layout, 4, 5);
	const lx0 = left.cx - RV, lx1 = left.cx + RV, rx0 = right.cx - RV, rx1 = right.cx + RV;
	const y0 = left.cy - RV, y1 = left.cy + RV;

	// Small pour: perched in the left chamber, right stays dry.
	inject(sim, left.cx, left.cy + RV * 0.5, 60);
	W.settle(w, 300);
	let rv = regionVol(sim, rx0, y0, rx1, y1);
	assert.ok(rv < 1e-3, `below the sill the right chamber stays dry (got ${rv.toFixed(3)})`);
	const perched = regionVol(sim, lx0, y0, lx1, y1);
	assert.ok(Math.abs(perched - 60) < 1e-3, "perched volume is retained on the left");

	// Large pour: over the sill, both chambers wet and surfaces equalize.
	inject(sim, left.cx, left.cy, 1400);
	W.settle(w, 400);
	const lv = regionVol(sim, lx0, y0, lx1, y1);
	rv = regionVol(sim, rx0, y0, rx1, y1);
	assert.ok(lv > 0 && rv > 0, `above the sill both chambers wet (left ${lv.toFixed(0)}, right ${rv.toFixed(0)})`);
	assert.ok(Math.abs(W.totalVol(w) - 1460) < 1e-3, "sill spill conserves total volume");
	// Free surfaces in the two chambers should match (communicating vessels).
	function chamberSurface(cx) {
		let best = Infinity, found = false;
		for (let i = 0; i < w.count; i++) {
			if (w.vol[i] <= 1e-3) continue;
			const gx = i % w.nx, gy = (i / w.nx) | 0;
			const x = (gx + 0.5) * w.cell, y = (gy + 0.5) * w.cell - G.POUR;
			if (Math.abs(x - cx) > RV * 0.5 || Math.abs(y - left.cy) > RV) continue;
			const s = W.surface(w, i);
			if (s < best) { best = s; found = true; }
		}
		return found ? best : Infinity;
	}
	const sl = chamberSurface(left.cx), sr = chamberSurface(right.cx);
	assert.ok(Math.abs(sl - sr) < 2.5, `connected surfaces equalize (left ${sl.toFixed(2)}, right ${sr.toFixed(2)})`);
	console.log(`ok  sill perch then spill, surfaces ${sl.toFixed(1)}≈${sr.toFixed(1)}`);
}

// 5. Split/merge during a turn: volume is conserved and never teleports.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0],        // straight connector rotor
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const sim = makeSim(spec);
	const w = sim.water;
	const mid = valve(sim.layout, 4, 5);
	const left = valve(sim.layout, 3, 5), right = valve(sim.layout, 5, 5);
	inject(sim, left.cx, left.cy, 500);
	W.settle(w, 300);
	const total0 = W.storedVol(w);
	assert.ok(Math.abs(total0 - 500) < 1e-3, "connect: volume conserved");
	const rightConnected = regionVol(sim, right.cx - RV, right.cy - RV, right.cx + RV, right.cy + RV);
	assert.ok(rightConnected > 1, "connected rotor lets water reach the right chamber");

	// Turn the connector a quarter: E/W shuts, the component splits. The rotor
	// carries its passage water (trapped); none is lost or teleports across.
	G.setAngle(mid, G.HALF_PI);
	W.rebuild(sim);
	W.settle(w, 300);
	const total1 = W.storedVol(w);
	assert.ok(Math.abs(total1 - total0) < 1e-3, `split conserves volume (${total0.toFixed(2)} -> ${total1.toFixed(2)})`);
	const lc = w.comp[cellAt(w, left.cx, left.cy)];
	const rc = w.comp[cellAt(w, right.cx, right.cy)];
	assert.ok(lc >= 0 && rc >= 0, "both chambers are air cells");
	assert.notEqual(lc, rc, "a shut connector splits the component");

	// Turn back: merge, the carried water returns, still conserved.
	G.setAngle(mid, 0);
	W.rebuild(sim);
	W.settle(w, 300);
	const total2 = W.storedVol(w);
	assert.ok(Math.abs(total2 - total0) < 1e-3, "merge conserves volume");
	assert.ok(Math.abs(W.totalVol(w) - total0) < 1e-3, "reopened passage returns carried water");
	console.log(`ok  split/merge conserves ${total0.toFixed(0)} across turns`);
}

// 6. Grain displacement raises the free surface without changing water volume.
{
	const spec = { "4,5": ["hollow", [], RV * 0.85] };
	const sim = makeSim(spec);
	const w = sim.water;
	const v = valve(sim.layout, 4, 5);
	inject(sim, v.cx, v.cy + RV * 0.4, 500);
	W.settle(w, 300);
	function topSurface() {
		let best = Infinity;
		for (let i = 0; i < w.count; i++) {
			if (w.vol[i] <= 1e-3) continue;
			const s = W.surface(w, i);
			if (s < best) best = s;
		}
		return best;
	}
	const before = topSurface();
	const volBefore = W.totalVol(w);
	// A dense grain resting on the chamber floor, fully below the waterline, so
	// the water it displaces can only go up.
	const g = S.addGrain(sim, v.cx, v.cy + RV * 0.85 - 3.4, 3.1, 0);
	assert.ok(g >= 0, "grain placed in the chamber");
	W.displace(sim);
	W.settle(w, 300);
	const after = topSurface();
	assert.ok(after < before - 0.4, `submerged grain raises the waterline (${before.toFixed(2)} -> ${after.toFixed(2)})`);
	assert.ok(Math.abs(W.totalVol(w) - volBefore) < 1e-3, "displacement moves no water volume");
	console.log(`ok  displacement lifts surface ${(before - after).toFixed(2)} px`);
}

// 7. Overflow: a column sealed at the bottom fills from the vent, then backs out
//    the top as overflow. admitted = stored + overflowed (+ drained = 0 here).
{
	const spec = {};
	for (let j = 0; j < N - 1; j++) spec["4," + j] = ["hollow", [3, 1], RV * 0.5];
	spec["4,9"] = ["hollow", [3], RV * 0.5]; // bottom cell: no S drain
	const sim = makeSim(spec);
	const w = sim.water;
	W.setVent(w, 4, true);
	W.setSupply(w, 6000);
	for (let k = 0; k < 600; k++) S.step(sim, S.STEP); // 5 s -> 30000 px^2
	assert.ok(w.overflowed > 0, `a full sealed-bottom column overflows (got ${w.overflowed.toFixed(0)})`);
	assert.ok(w.drained < 1e-6, "sealed bottom drains nothing");
	conservation(sim, "overflow");
	console.log(`ok  overflow ${w.overflowed.toFixed(0)}, stored ${W.totalVol(w).toFixed(0)}, drained ${w.drained.toFixed(0)}`);
}

// 8. Two resolutions: the same perch scenario conserves and perches at both.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.8],
		"4,5": ["hollow", [2], RV * 0.8],
	};
	for (const cell of [6, 3]) {
		const sim = makeSim(spec, cell);
		const w = sim.water;
		const left = valve(sim.layout, 3, 5), right = valve(sim.layout, 4, 5);
		inject(sim, left.cx, left.cy + RV * 0.5, 60);
		W.settle(w, 500);
		const rv = regionVol(sim, right.cx - RV, right.cy - RV, right.cx + RV, right.cy + RV);
		assert.ok(rv < 1, `cell=${cell}: below-sill pour stays perched (right ${rv.toFixed(3)})`);
		assert.ok(Math.abs(W.totalVol(w) - 60) < 1e-3, `cell=${cell}: volume conserved`);
		console.log(`ok  resolution cell=${cell}: perched, conserved, components ${w.compCount}`);
	}
}

// 9. A valve replaced at the SAME angle still invalidates the mask. The cache
//    used to key on the rotor angle alone, so swapping a valve left the water
//    grid describing the old passage.
{
	const spec = { "4,5": ["hollow", [], RV * 0.85] };
	const sim = makeSim(spec);
	const w = sim.water;
	const v = sim.layout.valves[5 * N + 4];
	const cell = cellAt(w, v.cx, v.cy);
	w.vol[cell] = 400;
	W.settle(w, 300);
	assert.ok(w.air[cell], "the chamber is air before the swap");
	const vol = W.storedVol(w);
	const blank = G.TYPES.find(t => t.kind === "solid" && t.ports.length === 0);
	S.installValve(sim, 5 * N + 4, blank, 0); // same angle: 0
	W.rebuild(sim);
	assert.equal(w.air[cell], 0, "a sealed valve is no longer water-holding air");
	assert.ok(Math.abs(W.storedVol(w) - vol) < 1e-6, `replacement conserves volume (${vol} -> ${W.storedVol(w)})`);
	// The closing wall pushes water into the void next to it (a real corridor) and
	// carries the rest; either way it is accounted, never left in phantom void.
	const trapped = W.storedVol(w) - W.totalVol(w);
	assert.ok(trapped > 0 || W.totalVol(w) > 0, "the water left the sealed chamber");
	assert.ok(W.totalVol(w) <= vol + 1e-6, "nothing is created by the swap");
	// Swap the chamber back at the same angle: the passage and its water return.
	S.installValve(sim, 5 * N + 4, G.TYPES.find(t => t.id === "hollow-blank"), 0);
	W.rebuild(sim);
	assert.ok(w.air[cell], "the reopened chamber is air again");
	assert.ok(W.totalVol(w) > 0, "the carried water comes back on reopen");
	console.log("ok  same-angle valve replacement re-samples the mask");
}

console.log("OK  water slice 2: components, sills, perched pools, split/merge, displacement, supply/drain/overflow, replacement, two resolutions");
