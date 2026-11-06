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
	assert.equal(H.setParams(h, { conductMetal: 0, conductLiquid: 0, ambientRate: 0 }), true,
		"a fully insulated parameter set is valid");
	assert.equal(H.neededSubsteps(h.p, H.DRY_CAP, H.STEP, h.cell), 1, "zero conductance needs one pass");
	const accepted = { ...h.p };
	assert.equal(H.setParams(h, { liquidHeat: 0 }), false, "zero heat capacity is refused");
	assert.equal(H.setParams(h, { ambientRate: -1 }), false, "negative ambient conductance is refused");
	assert.equal(H.setParams(h, { substepCap: 1.5 }), false, "a fractional substep budget is refused");
	assert.deepEqual(h.p, accepted, "invalid values leave every parameter unchanged");
	assert.equal(H.setParams(h, H.PARAMS), true, "the default stable set is restored");
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
	const after = H.stored(h);
	assert.ok(Math.abs(after - before) <= 1e-12 * Math.max(1, Math.abs(before)),
		`a turn moves capacity, not enthalpy (roundoff ${Math.abs(after - before).toExponential(2)})`);
	let changed = 0;
	for (let i = 0; i < h.count; i++) if (h.C[i] !== capBefore[i]) changed++;
	assert.ok(changed > 0, "the rebuilt capacity differs somewhere");
	books(h, "turn");
	H.reset(h);
	assert.equal(H.stored(h), 0, "reset empties the field");
	assert.equal(H.residual(h), 0, "and its books");
	console.log(`ok  turn keeps ${before.toFixed(1)} units through a mask rebuild; reset clears`);
}

// 7. Timestep refinement: for this first-order explicit scheme, halving dt
//    should roughly halve the remaining error. Compare three resolutions rather
//    than expecting two finite steps to be bit-identical.
{
	const spec = {};
	for (let j = 4; j <= 7; j++) spec["4," + j] = ["hollow", [0, 1], RV * 0.7];
	const coarse = makeSim(spec);
	const medium = makeSim(spec);
	const fine = makeSim(spec);
	for (const c of [coarse, medium, fine]) {
		H.fill(c.h, 20);
		const centre = ((c.h.ny / 2) | 0) * c.h.nx + ((c.h.nx / 2) | 0);
		H.setTemperature(c.h, centre, 200);
	}
	for (let k = 0; k < 120; k++) S.step(coarse.sim, S.STEP);
	for (let k = 0; k < 240; k++) S.step(medium.sim, S.STEP / 2);
	for (let k = 0; k < 480; k++) S.step(fine.sim, S.STEP / 4);
	let coarseError = 0;
	let fineError = 0;
	for (let i = 0; i < coarse.h.count; i++) {
		coarseError = Math.max(coarseError, Math.abs(coarse.h.T[i] - medium.h.T[i]));
		fineError = Math.max(fineError, Math.abs(medium.h.T[i] - fine.h.T[i]));
	}
	assert.ok(fineError < coarseError * 0.6,
		`halving dt reduces the error (${coarseError.toExponential(2)} to ${fineError.toExponential(2)} °C)`);
	books(coarse.h, "refinement 1/120");
	books(medium.h, "refinement 1/240");
	books(fine.h, "refinement 1/480");
	console.log(`ok  refinement halves error: ${coarseError.toExponential(1)} to ${fineError.toExponential(1)} °C`);
}

console.log("OK  heat slice 1a: capacity, conduction, sources, ambient, ledger, substep gate");

// ---- slice 1b: material coupling and temperature view ---------------------

const R = require("../prototype/shared/render.js");

// A two-chamber pool connected by an open east face, insulated from the room.
function poolSim(spec) {
	const { sim, h } = makeSim(spec);
	H.setAmbient(h, 20, 0);
	return { sim, h, w: sim.water };
}

// A top chamber over a bottom chamber, joined by a straight vertical pipe:
// water falls freely between them, so the exchange has no sill to perch on.
const twoChambers = {
	"4,4": ["hollow", [1], RV * 0.7],
	"4,5": ["hollow", [3], RV * 0.7],
};

// The centre cell of a valve's chamber (imposition point for setCell).
function chamberCell(sim, valveIndex) {
	const v = sim.layout.valves[valveIndex];
	const w = sim.water;
	return Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
}

// The open cells of a chamber's disc, and their H/vol/capacity sums in `out`.
function chamberCells(sim, valveIndex, out) {
	const v = sim.layout.valves[valveIndex];
	const w = sim.water;
	const r = v.chamberR;
	const c = w.cell;
	const gx0 = Math.max(0, Math.floor((v.cx - r) / c));
	const gx1 = Math.min(w.nx - 1, Math.floor((v.cx + r) / c));
	const gy0 = Math.max(0, Math.floor((v.cy - r + G.POUR) / c));
	const gy1 = Math.min(w.ny - 1, Math.floor((v.cy + r + G.POUR) / c));
	out.h = 0;
	out.vol = 0;
	out.cap = 0;
	for (let gy = gy0; gy <= gy1; gy++) {
		for (let gx = gx0; gx <= gx1; gx++) {
			const i = gy * w.nx + gx;
			if (!w.air[i]) continue;
			out.h += sim.heat.H[i] - H.latentOf(sim.heat, i);
			out.vol += w.vol[i];
			out.cap += sim.heat.C[i];
		}
	}
	return out;
}

const sums = { h: 0, vol: 0, cap: 0 };

// 8. Liquid movement: a hot pool relaxes into its neighbour and both
//    chambers keep every joule of the books. Pure B shares at and above 80 °C
//    so no plateau engages during the mix.
{
	const { sim, h, w } = poolSim(twoChambers);
	// The whole field sits at 100 °C so the B channel never dips to its 80 °C
	// plateau: this slice measures transport, not phase change.
	H.fill(h, 100);
	H.setCell(h, sim, chamberCell(sim, 4 * N + 4), 400, [0, 0, 1], 100);
	H.setCell(h, sim, chamberCell(sim, 5 * N + 4), 60, [0, 0, 1], 85);
	chamberCells(sim, 4 * N + 4, sums);
	const top0 = sums.vol;
	chamberCells(sim, 5 * N + 4, sums);
	const bot0h = sums.h;
	const bot0v = sums.vol;
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	books(h, "liquid movement");
	chamberCells(sim, 4 * N + 4, sums);
	const topVol = sums.vol;
	chamberCells(sim, 5 * N + 4, sums);
	const botVol = sums.vol;
	const botT = sums.h / sums.cap;
	assert.ok(topVol < top0 - 100, `the top pool drained (${top0.toFixed(0)} -> ${topVol.toFixed(0)} px²)`);
	assert.ok(botVol > bot0v + 100, `the lower chamber gained liquid (${bot0v.toFixed(0)} -> ${botVol.toFixed(0)} px²)`);
	assert.ok(sums.h > bot0h, "the lower chamber gained energy");
	assert.ok(botT > 85 && botT < 100, `the mixed pool reads between its ends (${botT.toFixed(1)} °C)`);
	console.log(`ok  liquid movement: top ${top0.toFixed(0)} -> ${topVol.toFixed(0)} px², lower ${bot0v.toFixed(0)} -> ${botVol.toFixed(0)} px² at ${botT.toFixed(1)} °C`);
}

// 9. Supply, overflow and drain: the vent's pour enters the material book at
//    ambient with its latent, the overflow band carries donor enthalpy out,
//    and Drain water empties the books with it.
{
	const { sim, h, w } = poolSim({ "4,5": ["hollow", [3], RV * 0.7] });
	// Everything at 130 °C so no channel reaches its plateau.
	H.fill(h, 130);
	H.setAmbient(h, 130, 0);
	W.setVent(w, 4, true);
	W.setSupply(w, 6000);
	for (let k = 0; k < 1440; k++) S.step(sim, S.STEP);
	books(h, "supply and overflow");
	assert.ok(w.admitted > 1000, `the vent admitted ${w.admitted.toFixed(0)} px²`);
	assert.ok(w.overflowed > 100, `the band overflowed ${w.overflowed.toFixed(0)} px²`);
	// Net material ≈ what is still stored. Pass-through pricing is exact per
	// parcel but the exported parcel leaves at the donor's live temperature,
	// which drifts a few hundredths of a degree off the ambient import price
	// as liquid mixes with the cell's metal; the bound is that wiggle over
	// the whole throughput, not an exact price match.
	const throughput = (h.p.liquidHeat * 130 + (h.p.latent[0] + h.p.latent[1] + h.p.latent[2]) / 3) * w.admitted;
	const held = W.storedVol(w);
	const latent = (h.p.latent[0] + h.p.latent[1] + h.p.latent[2]) / 3 * held;
	const sensible = h.p.liquidHeat * held * 130;
	assert.ok(Math.abs(h.material - (sensible + latent)) <= 2e-3 * throughput,
		`material book ${h.material.toFixed(1)} vs stored ${sensible.toFixed(1)} + latent ${latent.toFixed(1)}`);
	W.drainAll(w);
	books(h, "drain water");
	assert.ok(Math.abs(h.material) <= 2e-3 * throughput,
		`drain emptied the material book (${h.material.toExponential(2)} left)`);
	console.log(`ok  supply/overflow/drain: admitted ${w.admitted.toFixed(0)}, overflowed ${w.overflowed.toFixed(0)}, books closed`);
}

// 10. Grain sensible energy: a cold grain imports at ambient, its crossings
//     move its energy cell to cell while it falls, and Drain exports it at the
//     cell's published temperature. No liquid, so no plateau can engage.
{
	const spec = { "4,5": ["hollow", [0], RV * 0.75] };
	const { sim, h } = poolSim(spec);
	H.fill(h, 100);
	const v = sim.layout.valves[5 * N + 4];
	const k0 = S.addGrain(sim, v.cx, v.cy - RV * 0.5, 2.7, 0);
	assert.ok(k0 >= 0, "the grain was placed");
	for (let step = 0; step < 360; step++) {
		S.step(sim, S.STEP);
		books(h, "grain fall step " + step);
	}
	assert.ok(sim.count === 1, "the grain is still in the field");
	const landed = sim.gcell[0];
	assert.ok(landed >= 0, "the grain is booked in a cell");
	const dE = h.p.grainHeat * sim.mass[0] * h.T[landed];
	assert.ok(h.material > 0 && h.material <= dE * 1.001,
		`import ${h.material.toFixed(2)} vs sensible at landing ${dE.toFixed(2)}`);
	const imported = h.material;
	S.drain(sim);
	books(h, "grain drain");
	// The grain arrived cold and leaves carrying the heat it absorbed from its
	// cell, so the net book is a deficit bounded by the field's warmth.
	const absorbed = h.p.grainHeat * sim.mass[0] === 0 ? 0 : imported - h.material;
	assert.ok(h.material < 0, `the drain exported the grain warmer than it came (${h.material.toFixed(1)} net)`);
	// Bound: the field was filled at 100 °C and the grain arrived at 20 °C,
	// with composition wobble on top.
	assert.ok(absorbed <= h.p.grainHeat * (2000 / 1000) * 2.7 * 2.7 * 105,
		`the absorbed heat is bounded (${absorbed.toFixed(1)} E)`);
	console.log(`ok  grain crossings: imported ${imported.toFixed(1)} E at 20 °C, exported at ${h.T[landed].toFixed(0)} °C, net ${h.material.toFixed(1)} E`);
}

// 11. A rotor turn with liquid and a grain present: the mask rebuild moves
//     capacity and cells, never enthalpy.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0],
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const { sim, h } = poolSim(spec);
	const mid = 5 * N + 4;
	const leftCell = chamberCell(sim, 5 * N + 3);
	H.setCell(h, sim, leftCell, 200, [0, 0, 1], 130);
	const right = sim.layout.valves[5 * N + 5];
	assert.ok(S.addGrain(sim, right.cx, right.cy, 2.7, 3) >= 0, "the blue grain was placed");
	H.setTemperature(h, chamberCell(sim, 5 * N + 5), 60);
	for (let k = 0; k < 60; k++) S.step(sim, S.STEP);
	books(h, "settled before turn");
	const before = H.stored(h);
	S.turn(sim, mid, 1);
	W.rebuild(sim);
	for (let k = 0; k < 60; k++) S.step(sim, S.STEP);
	const after = H.stored(h);
	assert.ok(Math.abs(after - before) <= 1e-9 * Math.max(1, Math.abs(before)),
		`the turn kept the field's energy (${Math.abs(after - before).toExponential(2)})`);
	books(h, "turn with material");
	console.log(`ok  turn with liquid and a grain: ${before.toFixed(0)} E held, ledger closed`);
}

// 12. The overlay samples the published field: every texel is the fixed scale
//     color of its cell's temperature, clamped at both ends.
{
	const { sim, h } = poolSim({ "4,5": ["hollow", [0], RV * 0.7] });
	H.fill(h, 20);
	H.setTemperature(h, 100, -15);
	H.setTemperature(h, 101, 65);
	H.setTemperature(h, 102, 300);
	const map = { nx: h.nx, ny: h.ny, img: { data: new Uint8ClampedArray(h.count * 4) }, ctx: { putImageData() {} } };
	R.renderHeat(map, h);
	let worst = 0;
	for (let i = 0; i < h.count; i++) {
		const want = R.heatColor(h.T[i]);
		const o = i * 4;
		for (let c = 0; c < 3; c++) {
			const d = Math.abs(map.img.data[o + c] - want[c]);
			if (d > worst) worst = d;
		}
	}
	assert.equal(worst, 0, "every texel equals the published temperature's color");
	assert.deepEqual(R.heatColor(-15), R.heatColor(R.HEAT_MIN), "below the scale clamps");
	assert.deepEqual(R.heatColor(300), R.heatColor(R.HEAT_MAX), "above the scale clamps");
	console.log(`ok  overlay: ${h.count} texels agree with the published field, 0..${R.HEAT_MAX} °C fixed scale`);
}

// 13. Lifecycle: disabling heat freezes the books while the water keeps
//     running, re-enabling resumes them, and reset empties the field but
//     keeps every valve's power.
{
	const { sim, h } = poolSim({ "4,5": ["hollow", [0], RV * 0.7] });
	H.fill(h, 40);
	assert.equal(H.setPower(h, 5 * N + 4, 50), true);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	const frozen = {
		stored: H.stored(h),
		source: h.source,
		ambient: h.ambient,
		material: h.material,
	};
	S.setHeat(sim, false);
	assert.equal(sim.heat.enabled, false, "heat is disabled");
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	assert.equal(H.stored(h), frozen.stored, "a disabled field stores exactly what it had");
	assert.equal(h.source, frozen.source, "and its books are frozen");
	S.setHeat(sim, true);
	for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
	books(h, "resume after disable");
	assert.ok(h.source > frozen.source, "the source book resumed");
	H.reset(h);
	assert.equal(H.stored(h), 0, "reset empties the field");
	assert.equal(H.residual(h), 0, "and its books");
	assert.equal(h.power[5 * N + 4], 50, "the valve keeps its power");
	console.log(`ok  lifecycle: books frozen while off, resumed on, reset keeps powers`);
}

// 14. Step cost against the heat-disabled baseline on the same wet scene.
{
	const sim = S.create(G.createLayout(7), { turning: true });
	S.setPressure(sim, "off");
	S.setWater(sim, true);
	W.setVent(sim.water, 4, true);
	W.setSupply(sim.water, 600);
	const h = S.setHeat(sim, true);
	H.setAmbient(h, 130, 0.05);
	// Fill the scene with flowing water at 130 °C: no plateau engages, so the
	// comparison measures the coupling, not a phase-change storm.
	H.fill(h, 130);
	for (let k = 0; k < 720; k++) S.step(sim, S.STEP);
	const steps = 2000;
	let t0 = process.hrtime.bigint();
	for (let k = 0; k < steps; k++) S.step(sim, S.STEP);
	const onMs = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
	S.setHeat(sim, false);
	t0 = process.hrtime.bigint();
	for (let k = 0; k < steps; k++) S.step(sim, S.STEP);
	const offMs = Number(process.hrtime.bigint() - t0) / 1e6 / steps;
	assert.ok(onMs < offMs * 4 + 0.01, `heat-on ${onMs.toFixed(3)} ms/step vs off ${offMs.toFixed(3)}`);
	console.log(`ok  timing: ${offMs.toFixed(3)} ms/step off, ${onMs.toFixed(3)} ms/step on (${(onMs / offMs).toFixed(2)}×), substeps ${sim.heat.substeps}`);
}

console.log("OK  heat slice 1b: material coupling, books, overlay, lifecycle, timing");
