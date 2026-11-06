"use strict";
// 0.4 slice 1a: the heat field itself — capacity, conduction, per-valve sources,
// ambient exchange, the substep bound and the energy ledger. No phase change, no
// liquid advection, no grain sensible energy and no view: those are slice 1b and
// slice 4, and this file says so instead of pretending to cover them.
// Run: node experiments/heat-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const H = require("../prototype/shared/heat.js");

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
	S.setWater(sim, true);
	W.rebuild(sim);
	const h = S.setHeat(sim, true);
	H.setAmbient(h, 20, 0);
	return { sim, h, w: sim.water };
}

// The ledger as an equation: what the field holds equals what it started with
// plus what a source and the room put in. Conduction is internal and cancels.
function books(h, tag) {
	const scale = Math.max(1, Math.abs(h.initial), Math.abs(h.source), Math.abs(h.ambient));
	const r = H.residual(h);
	assert.ok(Number.isFinite(r) && Math.abs(r) <= 1e-9 * scale,
		`${tag}: ledger ${r.toExponential(2)} against ${scale.toExponential(2)}`);
	for (let i = 0; i < h.count; i++) {
		assert.ok(Number.isFinite(h.H[i]) && Number.isFinite(h.T[i]), `${tag}: cell ${i} is finite`);
	}
}

const dry = { "4,5": ["hollow", [0], RV * 0.7] };

// 1. An insulated uniform field is exactly constant: every face sees a zero
//    difference, so not one joule moves and the ledger is a true zero.
{
	const { sim, h } = makeSim(dry);
	H.fill(h, 50);
	const before = H.stored(h);
	for (let k = 0; k < 600; k++) S.step(sim, S.STEP);
	assert.equal(H.stored(h), before, "an insulated uniform field keeps every joule");
	let dev = 0;
	for (let i = 0; i < h.count; i++) dev = Math.max(dev, Math.abs(h.T[i] - 50));
	assert.equal(dev, 0, "and every cell still reads its temperature");
	assert.equal(H.residual(h), 0, "nothing to book");
	console.log(`ok  insulated uniform field: ${before.toFixed(1)} units held, exact after 5 s`);
}

// 2. Conduction: one hot cell loses exactly the analytic face sum for one step,
//    the field total is unchanged, and the price is the sampled conductances.
{
	const spec = { "4,5": ["hollow", [0, 2], RV * 0.7], "5,5": ["hollow", [2, 0], RV * 0.7] };
	const { sim, h, w } = makeSim(spec);
	H.fill(h, 20);
	// An east face between two open cells, so the liquid conductance sets it.
	let hot = -1;
	for (let i = 0; i + 1 < h.count && hot < 0; i++) {
		if (w.area[i] > 0 && w.area[i + 1] > 0) hot = i;
	}
	assert.ok(hot >= 0, "the scene has two open neighbours");
	H.setTemperature(h, hot, 60);
	const before = H.stored(h);
	const h0 = h.H[hot];
	const dt = S.STEP;
	assert.equal(H.neededSubsteps(h.p, h.cMin, dt, h.cell), 1, "the default set runs one substep");
	S.step(sim, dt);
	const got = h.H[hot] - h0;
	// Analytic: every face of the cell, from the temperature snapshot.
	const p = h.p;
	const nx = h.nx;
	const gx = hot % nx;
	const gy = (hot / nx) | 0;
	const faces = [];
	if (gx > 0) faces.push([hot - 1, "w"]);
	if (gx + 1 < nx) faces.push([hot + 1, "e"]);
	if (gy > 0) faces.push([hot - nx, "n"]);
	if (gy + 1 < h.ny) faces.push([hot + nx, "s"]);
	let predicted = 0;
	for (const [j] of faces) {
		const o = Math.min(h.open[hot], h.open[j]);
		const k = h.cell * (o * p.conductLiquid + (1 - o) * p.conductMetal);
		predicted += k * (20 - 60) * dt;
	}
	assert.ok(Math.abs(got - predicted) <= 1e-9 * Math.abs(predicted),
		`one step matches the face sum (${got.toFixed(6)} vs ${predicted.toFixed(6)})`);
	assert.ok(Math.abs(H.stored(h) - before) <= 1e-12 * Math.abs(before), "conduction is internal");
	const open = Math.min(h.open[hot], h.open[hot + 1]);
	assert.ok(open > 0.5, "the probed face is a liquid face");
	books(h, "conduction");
	console.log(`ok  one hot cell loses the analytic face sum to ${Math.abs(got / predicted - 1).toExponential(0)} relative`);
}

// 3. A source adds exactly power x time, wherever the field puts the heat.
{
	const { sim, h } = makeSim(dry);
	H.fill(h, 20);
	const before = H.stored(h);
	const valve = 5 * N + 4;
	assert.equal(H.setPower(h, valve, 30), true);
	const steps = 600;
	for (let k = 0; k < steps; k++) S.step(sim, S.STEP);
	const wanted = 30 * steps * S.STEP;
	const got = H.stored(h) - before;
	assert.ok(Math.abs(got - wanted) <= 1e-9 * Math.abs(wanted), `source booked ${got.toFixed(6)} vs ${wanted.toFixed(6)}`);
	assert.ok(h.source > 0, "the source book is signed and non-zero");
	books(h, "source");
	console.log(`ok  a 30 unit/s source adds ${got.toFixed(3)} units in 5 s (wanted ${wanted.toFixed(3)})`);
}

// 4. Ambient exchange: the sign follows the room, the size follows the sampled
//    exterior faces, and a zero rate isolates the field again.
{
	const { sim, h } = makeSim(dry);
	H.fill(h, 20);
	let area = 0;
	for (let i = 0; i < h.count; i++) area += h.exterior[i];
	assert.ok(area > 0, "the ring has faces");
	const rate = 0.05;
	const dt = S.STEP;
	H.setAmbient(h, 80, rate);
	let before = H.stored(h);
	S.step(sim, dt);
	const warm = H.stored(h) - before;
	const predictedWarm = rate * area * (80 - 20) * dt;
	assert.ok(warm > 0, "a warmer room heats the field");
	assert.ok(Math.abs(warm - predictedWarm) <= 1e-9 * predictedWarm,
		`ambient ${warm.toFixed(6)} vs ${predictedWarm.toFixed(6)}`);
	books(h, "ambient warm");
	H.fill(h, 20);
	H.setAmbient(h, 0, rate);
	before = H.stored(h);
	S.step(sim, dt);
	const cold = H.stored(h) - before;
	const predictedCold = rate * area * (0 - 20) * dt;
	assert.ok(cold < 0, "a colder room cools the field");
	assert.ok(Math.abs(cold - predictedCold) <= 1e-9 * -predictedCold,
		`cold ambient ${cold.toFixed(6)} vs ${predictedCold.toFixed(6)}`);
	books(h, "ambient cold");
	console.log(`ok  ambient: ${area.toFixed(0)} px of exterior face, ${predictedWarm.toFixed(3)} units/s at 60 °C over`);
}

// 5. The substep budget is a gate on parameters, not a silent clamp: a set that
//    would need more substeps is refused and the old set stays live.
{
	const { sim, h } = makeSim(dry);
	H.fill(h, 20);
	assert.equal(H.setParams(h, { conductLiquid: 40 }), false, "an unstable set is refused");
	assert.equal(h.p.conductLiquid, H.PARAMS.conductLiquid, "the refused set changes nothing");
	assert.equal(H.setParams(h, { conductLiquid: 1 }), true, "a stable set is accepted");
	S.step(sim, S.STEP);
	assert.ok(h.substeps >= 1 && h.substeps <= h.p.substepCap, `substeps ${h.substeps} inside the budget`);
	assert.ok(H.neededSubsteps(h.p, H.DRY_CAP, H.STEP, h.cell) <= h.p.substepCap, "the dry floor fits");
	books(h, "parameters");
	console.log(`ok  substep gate: ${h.substeps} substep(s) at the default set, unstable sets refused`);
}

// 6. A rotor turn resamples the mask and keeps enthalpy: capacity moves, heat
//    does not, so a turn cannot create or destroy energy. Reset clears the field.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0],
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const { sim, h } = makeSim(spec);
	const mid = 5 * N + 4;
	const v = sim.layout.valves[mid];
	const cell = Math.floor((v.cy + G.POUR) / h.w.cell) * h.w.nx + Math.floor(v.cx / h.w.cell);
	W.setLiquid(sim.water, cell, 400, [1, 1, 1]);
	H.updateCapacity(h);
	H.fill(h, 40);
	const before = H.stored(h);
	const capBefore = h.C.slice();
	G.setAngle(sim.layout.valves[mid], G.HALF_PI);
	S.setTarget(sim, mid, G.HALF_PI);
	W.rebuild(sim);
	assert.notEqual(sim.water.serial, h.maskSerial, "the water mask moved on");
	S.step(sim, S.STEP);
	assert.equal(h.maskSerial, sim.water.serial, "heat followed the mask");
	assert.equal(H.stored(h), before, "a turn moves capacity, not enthalpy");
	let changed = 0;
	for (let i = 0; i < h.count; i++) if (h.C[i] !== capBefore[i]) changed++;
	assert.ok(changed > 0, "the rebuilt capacity differs somewhere");
	books(h, "turn");
	H.reset(h);
	assert.equal(H.stored(h), 0, "reset empties the field");
	assert.equal(H.residual(h), 0, "and its books");
	console.log(`ok  turn keeps ${before.toFixed(1)} units through a mask rebuild; reset clears`);
}

// 7. Timestep refinement: the same scene integrated at 1/120 and 1/480 over one
//    second lands on the same field, so the explicit scheme is converging and not
//    riding its stability bound.
{
	const spec = {};
	for (let j = 4; j <= 7; j++) spec["4," + j] = ["hollow", [0, 1], RV * 0.7];
	const a = makeSim(spec);
	const b = makeSim(spec);
	for (const c of [a, b]) {
		H.fill(c.h, 20);
		const centre = ((c.h.ny / 2) | 0) * c.h.nx + ((c.h.nx / 2) | 0);
		H.setTemperature(c.h, centre, 200);
	}
	for (let k = 0; k < 120; k++) S.step(a.sim, S.STEP);
	for (let k = 0; k < 480; k++) S.step(b.sim, S.STEP / 4);
	let worst = 0;
	for (let i = 0; i < a.h.count; i++) worst = Math.max(worst, Math.abs(a.h.T[i] - b.h.T[i]));
	assert.ok(worst < 1e-3, `refinement agrees (worst ${worst.toExponential(1)} °C)`);
	books(a.h, "refinement 1/120");
	books(b.h, "refinement 1/480");
	console.log(`ok  1/120 and 1/480 agree to ${worst.toExponential(1)} °C after one second`);
}

console.log("OK  heat slice 1a: capacity, conduction, sources, ambient, ledger, substep gate");
