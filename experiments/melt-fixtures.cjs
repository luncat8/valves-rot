"use strict";
// 0.4 slices 3 and 4: melting and freezing through the enthalpy ledger. Every
// conversion is internal — the field's energy, each channel's mass and the
// material book are checked as equations, not sampled. The melt is a
// whole-grain threshold with a pinned plateau; the freeze is per channel,
// highest plateau first, at the LOWER of the plateau and the room temperature
// (supply at ambient must not refreeze on arrival), with clamped radii, a
// fractional inventory and deterministic deferral when no valid grain can be
// placed. The freeze gates park the room at or above the plateau they drive,
// so the plateau — not the room — is the governing freeze point there.
// Run: node experiments/melt-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const H = require("../prototype/shared/heat.js");

const N = G.N;
const RV = G.RV;
const CH = 3;

// One open chamber in a solid field; `extra` adds more spec entries.
function field(extra) {
	const spec = Object.assign({ "4,5": ["hollow", [0], RV * 0.75] }, extra || {});
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const e = spec[i + "," + j];
			valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
		}
	}
	return { seed: 3, valves };
}

function makeSim(extra) {
	const sim = S.create(field(extra), { turning: false });
	S.setPressure(sim, "off");
	S.setWater(sim, true);
	W.rebuild(sim);
	const h = S.setHeat(sim, true);
	H.setAmbient(h, 20, 0);
	return { sim, h, w: sim.water };
}

function centreCell(sim) {
	const v = sim.layout.valves[5 * N + 4];
	const w = sim.water;
	return Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
}

// The ledger closes: stored = initial + source + ambient + material.
function books(h, tag) {
	const scale = Math.max(1, Math.abs(h.initial), Math.abs(h.source), Math.abs(h.ambient), Math.abs(h.material));
	const r = H.residual(h);
	assert.ok(Number.isFinite(r) && Math.abs(r) <= 1e-9 * scale,
		`${tag}: ledger ${r.toExponential(2)} against ${scale.toExponential(2)}`);
}

// Conserved mass state: grain mass plus every channel. The freeze inventory
// (`frac`) is intent, not material — the plan's "defer without consuming
// mass" keeps the earmarked liquid in its channel until a grain is placed —
// so it is reported but never counted as mass.
function massState(sim, w, h) {
	const ch = new Float64Array(CH);
	W.channelTotals(w, ch);
	let grains = 0;
	for (let k = 0; k < sim.count; k++) grains += sim.mass[k];
	let frac = 0;
	for (let i = 0; i < h.frac.length; i++) frac += h.frac[i];
	return { grains, ch: ch[0] + ch[1] + ch[2], frac, red: ch[0], green: ch[1], blue: ch[2] };
}

const grainMassOf = (mat, r) => (S.MATERIAL_DENSITY[mat] / 1000) * r * r;

// Step until every grain has been in the same booked cell for a while, so a
// threshold test can heat the cell the grain actually sits in.
function settleGrain(sim, h) {
	let stable = 0;
	for (let k = 0; k < 240 && stable < 15; k++) {
		S.step(sim, S.STEP);
		let still = true;
		for (let g = 0; g < sim.count; g++) if (sim.gcell[g] !== sim.gcell[0]) still = false;
		stable = still ? stable + 1 : 0;
	}
	return sim.count > 0 ? sim.gcell[0] : -1;
}

// 1. Each material's channel mapping and reference mass: the whole grain
//    becomes exactly its mass in px², split by the melt table.
{
	for (let mat = 0; mat < S.MATERIAL_DENSITY.length; mat++) {
		const { sim, h, w } = makeSim();
		const cell = centreCell(sim);
		const v = sim.layout.valves[5 * N + 4];
		const k = S.addGrain(sim, v.cx, v.cy, 2.7, mat);
		assert.ok(k >= 0, "the grain was placed");
		settleGrain(sim, h);
		const m = grainMassOf(mat, 2.7);
		const tm = H.materialMelt(h.p, mat);
		H.fill(h, tm + 300);
		for (let k = 0; k < 120 && sim.count > 0; k++) S.step(sim, S.STEP);
		assert.equal(sim.count, 0, `${S.MATERIAL_NAMES[mat]} melted`);
		const ch = new Float64Array(CH);
		W.channelTotals(w, ch);
		const shares = H.MELT_SHARES[mat];
		for (let c = 0; c < CH; c++) {
			assert.ok(Math.abs(ch[c] - m * shares[c]) <= 1e-9 * m,
				`${S.MATERIAL_NAMES[mat]} channel ${c}: ${ch[c].toFixed(4)} vs ${m * shares[c].toFixed(4)}`);
		}
		books(h, "melt " + S.MATERIAL_NAMES[mat]);
	}
	console.log("ok  melt mapping: all six materials split by the table at reference mass");
}

// 2. No melt below the threshold: the excess stays pending and the published
//    temperature pins at the plateau. The excess is half the whole-grain
//    threshold, not a degree: the explicit-conduction loss over one step can
//    exceed one degree of capacity (more so as the sensible heats are tuned
//    down), and the pin is only observable while excess remains.
{
	const { sim, h } = makeSim();
	let cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	S.addGrain(sim, v.cx, v.cy, 2.7, 0);
	cell = settleGrain(sim, h);
	const m = grainMassOf(0, 2.7);
	const tm = H.materialMelt(h.p, 0);
	const need = m * (h.p.latent[0] + (h.p.liquidHeat - h.p.grainHeat) * tm);
	H.setTemperature(h, cell, tm + need / (2 * h.C[cell]));
	S.step(sim, S.STEP);
	assert.equal(sim.count, 1, "half the threshold is not enough");
	assert.ok(Math.abs(h.T[cell] - tm) <= 0.05, `the cell pins at ${tm} °C (${h.T[cell].toFixed(2)})`);
	assert.equal(h.w.vol[cell], 0, "no liquid was added");
	books(h, "no melt below threshold");
	console.log(`ok  no melt below threshold: pinned at ${tm.toFixed(0)} °C, grain intact`);
}

// 3. Energy-limited melting: half the needed excess still waits, the rest
//    completes it, and the conversion is internal to the ledger.
{
	const { sim, h } = makeSim();
	let cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	S.addGrain(sim, v.cx, v.cy, 2.7, 0);
	cell = settleGrain(sim, h);
	const m = grainMassOf(0, 2.7);
	const tm = H.materialMelt(h.p, 0);
	// The exact threshold for this cell composition, computed from the model.
	const need = m * (h.p.latent[0] + (h.p.liquidHeat - h.p.grainHeat) * tm);
	const cap = h.C[cell];
	H.setTemperature(h, cell, tm + need / (2 * cap));
	S.step(sim, S.STEP);
	assert.equal(sim.count, 1, "half the latent is not enough");
	assert.ok(Math.abs(h.T[cell] - tm) <= 0.05, `still pinned (${h.T[cell].toFixed(2)} °C)`);
	H.setTemperature(h, cell, tm + (need * 1.02) / cap);
	S.step(sim, S.STEP);
	assert.equal(sim.count, 0, "the full threshold melts the grain");
	assert.ok(Math.abs(h.melted - m) <= 1e-9 * m, `exactly one grain melted (${h.melted.toFixed(3)} mg)`);
	books(h, "energy-limited melt");
	console.log(`ok  energy-limited melt: threshold ${need.toFixed(0)} E, pinned until met, then internal`);
}

// 4. Blocked capacity defers: a cell already full of liquid cannot take the
//    melt, so the grain waits and nothing is consumed.
{
	const { sim, h, w } = makeSim();
	let cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	H.setCell(h, sim, cell, w.area[cell], [0, 0, 1], 130);
	S.addGrain(sim, v.cx, v.cy - 8, 2.7, 0);
	cell = settleGrain(sim, h);
	assert.equal(cell, Math.floor((sim.y[0] + G.POUR) / w.cell) * w.nx + Math.floor(sim.x[0] / w.cell), "the cell tracks the grain");
	H.setTemperature(h, cell, 420);
	const vol0 = w.vol[cell];
	S.step(sim, S.STEP);
	assert.equal(sim.count, 1, "the melt deferred");
	assert.ok(Math.abs(w.vol[cell] - vol0) <= 1e-9, "no liquid was added");
	assert.ok(Math.abs(h.T[cell] - 120) <= 0.5, `pinned at the plateau (${h.T[cell].toFixed(1)} °C)`);
	books(h, "blocked melt defers");
	console.log("ok  blocked melt: a full cell defers the grain, pinned at 120 °C");
}

// 5. Compaction, transfer and external drain preserve the mass, channel and
//    energy ledgers through a sequence of melts and drains.
{
	const { sim, h, w } = makeSim();
	const v = sim.layout.valves[5 * N + 4];
	const cell = centreCell(sim);
	S.addGrain(sim, v.cx - 4, v.cy - 4, 2.7, 0);
	S.addGrain(sim, v.cx + 4, v.cy - 4, 2.7, 1);
	settleGrain(sim, h);
	H.fill(h, 420);
	for (let k = 0; k < 120 && sim.count > 0; k++) S.step(sim, S.STEP);
	books(h, "two melts");
	const state = massState(sim, w, h);
	const m0 = grainMassOf(0, 2.7);
	const m1 = grainMassOf(1, 2.7);
	assert.ok(Math.abs(state.red - (m0 + m1 / 2)) <= 1e-9 * m0, `R channel ${state.red.toFixed(3)}`);
	assert.ok(Math.abs(state.green - m1 / 2) <= 1e-9 * m0, `G channel ${state.green.toFixed(3)}`);
	assert.ok(Math.abs(state.blue) <= 1e-9, "no blue was invented");
	assert.equal(sim.count, 0, "both grains melted");
	W.drainAll(w);
	books(h, "drain after melts");
	const after = massState(sim, w, h);
	assert.ok(after.red <= 1e-9 && after.green <= 1e-9, "the drain emptied the channels");
	console.log(`ok  melt ledgers: R ${state.red.toFixed(2)} + G ${state.green.toFixed(2)} px² conserved through drain`);
}

// 6. Sensible + latent equality in an insulated cell: the enthalpy before and
//    after the conversion is the same number.
{
	const { sim, h, w } = makeSim();
	let cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	S.addGrain(sim, v.cx, v.cy, 2.7, 3);
	cell = settleGrain(sim, h);
	H.fill(h, 400);
	// A uniform fill conducts nothing, so the total is exact through the step;
	// the conversion itself may move the liquid's share to a neighbour cell.
	const total0 = H.stored(h);
	const C0 = h.C[cell];
	for (let k = 0; k < 120 && sim.count > 0; k++) S.step(sim, S.STEP);
	assert.equal(sim.count, 0, "the blue grain melted");
	assert.ok(Math.abs(H.stored(h) - total0) <= 1e-9 * Math.abs(total0),
		`total enthalpy held (${(H.stored(h) - total0).toExponential(1)})`);
	const dst = h.w.vol[cell] > 0 ? cell : cell + 1;
	const lat = H.latentOf(h, dst);
	const t = (h.H[dst] - lat) / h.C[dst];
	assert.ok(t > 80 && t < 400, `derived temperature sane (${t.toFixed(1)} °C)`);
	assert.ok(h.C[dst] > C0 || h.w.vol[dst] > 0, "the melt became liquid capacity");
	books(h, "insulated conversion");
	console.log(`ok  insulated conversion: total H held exactly, T reads ${t.toFixed(1)} °C after the melt`);
}

// ---- slice 4: freezing ----------------------------------------------------

// 7. Latent release: below the plateau the freeze converts liquid into grains
//    and the released latent pins the cell back at the plateau while liquid
//    remains.
{
	const { sim, h, w } = makeSim();
	const cell = centreCell(sim);
	H.fill(h, 118);
	// The freeze point is the lower of the plateau and the room, so the room
	// parks at red's plateau: the liquid below it still freezes, pinned there.
	H.setAmbient(h, 120, undefined, false);
	H.setCell(h, sim, cell, 30, [1, 0, 0], 110);
	for (let k = 0; k < 240 && sim.count === 0; k++) S.step(sim, S.STEP);
	assert.ok(sim.count >= 1, "a grain froze");
	assert.equal(sim.color[0], 0, "it is a red grain");
	// The released latent holds the remaining liquid at the plateau: find the
	// cell holding most of it and read its published temperature.
	let wet = -1;
	for (let i = 0; i < w.count; i++) if (wet < 0 || w.vol[i] > w.vol[wet]) wet = i;
	assert.ok(w.vol[wet] > 1, `liquid remains after the first grain (${w.vol[wet].toFixed(1)} px²)`);
	assert.ok(Math.abs(h.T[wet] - 120) <= 0.5, `the wet cell pins at the plateau (${h.T[wet].toFixed(1)} °C)`);
	const state = massState(sim, w, h);
	assert.ok(Math.abs(state.red + state.grains - 30) <= 1e-6, "red mass conserved");
	books(h, "latent release");
	console.log(`ok  latent release: ${sim.count} grain(s), wet cell pinned at ${h.T[wet].toFixed(1)} °C, mass held`);
}

// 8. Highest plateau first: with R and G liquid cooling together, the red
//    grain forms before any green one.
{
	const { sim, h, w } = makeSim();
	const cell = centreCell(sim);
	// 60 px² so each pooled cell keeps an R share above red's minimum grain
	// mass; a thinner pool would let green win on its smaller minimum alone.
	H.fill(h, 95);
	// Room at red's plateau, so the 120/100 points govern, not the room.
	H.setAmbient(h, 120, undefined, false);
	H.setCell(h, sim, cell, 60, [0.5, 0.5, 0], 95);
	let first = -1;
	for (let k = 0; k < 600 && first < 0; k++) {
		S.step(sim, S.STEP);
		if (sim.count > 0) first = sim.color[0];
	}
	assert.ok(first >= 0, "a grain froze");
	assert.equal(first, 0, "the first grain is red, the highest plateau");
	let green = false;
	for (let k = 0; k < 1200 && !green; k++) {
		S.step(sim, S.STEP);
		for (let g = 0; g < sim.count; g++) if (sim.color[g] === 5) green = true;
	}
	assert.ok(green, "green froze once red had gone");
	const state = massState(sim, w, h);
	assert.ok(Math.abs(state.red + state.green + state.grains - 60) <= 1e-6, "mass held");
	books(h, "freeze ordering");
	console.log("ok  freeze ordering: red first at 120 °C, green later at 100 °C");
}

// 9. Radius clamps and the fractional remainder: every frozen grain sits in
//    the supported radius range and the sub-grain remainder waits in the
//    inventory instead of being invented or lost.
{
	const { sim, h, w } = makeSim();
	const cell = centreCell(sim);
	H.fill(h, 20);
	// Room at red's plateau: the hot pool freezes as it cools below 120.
	H.setAmbient(h, 120, undefined, false);
	H.setCell(h, sim, cell, 100, [1, 0, 0], 125);
	for (let k = 0; k < 2400; k++) S.step(sim, S.STEP);
	assert.ok(sim.count >= 2, `grains formed (${sim.count})`);
	for (let k = 0; k < sim.count; k++) {
		assert.ok(sim.r[k] >= S.R_MIN - 1e-9 && sim.r[k] <= S.R_MAX + 1e-9,
			`grain ${k} radius ${sim.r[k].toFixed(3)} inside [${S.R_MIN}, ${S.R_MAX}]`);
	}
	const state = massState(sim, w, h);
	assert.ok(Math.abs(state.red + state.grains - 100) <= 1e-6,
		`mass held: liquid ${state.red.toFixed(2)} + grains ${state.grains.toFixed(2)} (frac ${state.frac.toFixed(2)})`);
	assert.ok(state.grains > 40, `most of the pool froze (${state.grains.toFixed(1)} mg)`);
	books(h, "radius clamps");
	console.log(`ok  radius clamps: ${sim.count} grains in range, ${state.red.toFixed(2)} px² liquid left, remainder ${state.frac.toFixed(2)} px²`);
}

// 10. Slot failure defers without consuming, and the inventory pays out once
//     the liquid sits where a grain fits. In a chamber barely wider than one
//     grain, a blocker plus the walls leaves no point that fits even the
//     smallest grain, so the freeze defers with its intent accumulated; the
//     same liquid, poured into a wide chamber, freezes on the retry schedule.
{
	const { sim, h, w } = makeSim({ "4,5": ["hollow", [0], RV * 0.2], "6,5": ["hollow", [0], RV * 0.75] });
	const cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	// Room at red's plateau for the whole gate: above it nothing freezes,
	// below it the intent accumulates — the plateau governs, not the room.
	H.setAmbient(h, 120, undefined, false);
	H.fill(h, 125);
	H.setCell(h, sim, cell, 20, [1, 0, 0], 125);
	for (let k = 0; k < 60; k++) S.step(sim, S.STEP);
	assert.equal(h.frozen, 0, "above the plateau nothing froze yet");
	assert.ok(S.addGrain(sim, v.cx, v.cy, 2.7, 2) >= 0, "the blocker was placed");
	H.fill(h, 95);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	assert.equal(h.frozen, 0, "no freeze while the chamber is blocked");
	const ch0 = new Float64Array(CH);
	W.channelTotals(w, ch0);
	assert.ok(Math.abs(ch0[0] - 20) <= 1e-6, `the liquid was not consumed (${ch0[0].toFixed(2)} px²)`);
	let intent = 0;
	for (let i = 0; i < h.frac.length; i += 1) intent += h.frac[i];
	assert.ok(intent > 1, `the freeze intent accumulated (${intent.toFixed(2)} px²)`);
	books(h, "blocked defers");
	// The same liquid where a grain fits: drain, re-pour into the wide
	// chamber, and the per-step retries pay the inventory out.
	W.drainAll(w);
	const wide = sim.layout.valves[5 * N + 6];
	const wideCell = Math.floor((wide.cy + G.POUR) / w.cell) * w.nx + Math.floor(wide.cx / w.cell);
	// 30 px²: enough that one pooled cell clears red's minimum grain mass.
	H.setCell(h, sim, wideCell, 30, [1, 0, 0], 95);
	for (let k = 0; k < 480 && h.frozen === 0; k++) S.step(sim, S.STEP);
	assert.ok(h.frozen > 0, `the retry froze in the wide chamber (${h.frozen.toFixed(1)} mg)`);
	const ch1 = new Float64Array(CH);
	W.channelTotals(w, ch1);
	let redGrains = 0;
	for (let k = 0; k < sim.count; k++) if (sim.color[k] === 0) redGrains += sim.mass[k];
	assert.ok(Math.abs(ch1[0] + redGrains - 30) <= 1e-6, "the payout conserved red mass");
	books(h, "retry pays out");
	console.log(`ok  blocked slot: deferred ${intent.toFixed(1)} px² of intent without consuming, paid out ${h.frozen.toFixed(1)} mg where a grain fits`);
}

// 11. Hot and cold repeated cycles: melt, freeze, melt again — mass, channels
//     and energy ride through every cycle. Blue grains: their melt is a small
//     mass that pools thinly, and blue's small minimum grain mass is the one
//     that can still freeze from a thin pool.
{
	const { sim, h, w } = makeSim();
	const cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	// Room at blue's plateau for the whole gate: the freeze half of every
	// cycle freezes below 80, the melt half at 200 is unaffected by it.
	H.setAmbient(h, 80, undefined, false);
	let placed = 0;
	for (const [dx, dy] of [[-6, -5], [6, -5], [-6, 5], [6, 5]]) {
		if (S.addGrain(sim, v.cx + dx, v.cy + dy, 2.7, 3) >= 0) placed++;
	}
	assert.equal(placed, 4, "four blue grains were placed");
	settleGrain(sim, h);
	const m0 = placed * grainMassOf(3, 2.7);
	for (let cycle = 0; cycle < 3; cycle++) {
		H.fill(h, 200);
		for (let k = 0; k < 240 && sim.count > 0; k++) S.step(sim, S.STEP);
		assert.equal(sim.count, 0, `cycle ${cycle}: melted`);
		const liquid = massState(sim, w, h);
		assert.ok(Math.abs(liquid.blue - m0) <= 1e-6, `cycle ${cycle}: B channel ${liquid.blue.toFixed(3)}`);
		books(h, `cycle ${cycle} melt`);
		H.fill(h, 60);
		for (let k = 0; k < 900 && h.frozen === 0; k++) S.step(sim, S.STEP);
		const solid = massState(sim, w, h);
		assert.ok(Math.abs(solid.blue + solid.grains - m0) <= 1e-6,
			`cycle ${cycle}: mass held (${solid.blue.toFixed(2)} liquid + ${solid.grains.toFixed(2)} frozen)`);
		assert.ok(h.frozen > 0, `cycle ${cycle}: froze ${h.frozen.toFixed(1)} of ${m0.toFixed(1)} mg, the rest is a sub-grain residue`);
		books(h, `cycle ${cycle} freeze`);
	}
	console.log("ok  hot/cold cycles: three melt-freeze rounds, mass and energy held");
}

// 12. Mixed secondary to primary round trip: amber melts into half R half G;
//     freezing pays out red and green grains, never an amber one.
{
	const { sim, h, w } = makeSim();
	const cell = centreCell(sim);
	const v = sim.layout.valves[5 * N + 4];
	// Six grains so each pooled cell's R share clears red's minimum grain
	// mass; a thinner melt would leave the R half liquid forever.
	const spots = [[-8, -6], [0, -6], [8, -6], [-8, 4], [0, 4], [8, 4]];
	let added = 0;
	for (const [dx, dy] of spots) if (S.addGrain(sim, v.cx + dx, v.cy + dy, 2.7, 1) >= 0) added++;
	assert.equal(added, 6, "six amber grains were placed");
	settleGrain(sim, h);
	const total = 6 * grainMassOf(1, 2.7);
	// Room at red's plateau: both halves freeze below their own points.
	H.setAmbient(h, 120, undefined, false);
	H.fill(h, 500);
	for (let k = 0; k < 600 && sim.count > 0; k++) S.step(sim, S.STEP);
	assert.equal(sim.count, 0, "the amber grains melted");
	const halves = massState(sim, w, h);
	assert.ok(Math.abs(halves.red - total / 2) <= 1e-6 && Math.abs(halves.green - total / 2) <= 1e-6,
		`halves ${halves.red.toFixed(2)} / ${halves.green.toFixed(2)} of ${total.toFixed(2)}`);
	H.fill(h, 60);
	for (let k = 0; k < 1200; k++) S.step(sim, S.STEP);
	const mats = [0, 0, 0, 0, 0, 0];
	for (let k = 0; k < sim.count; k++) mats[sim.color[k]]++;
	assert.equal(mats[1], 0, "no amber grain re-formed");
	assert.ok(mats[0] >= 1, "red grains formed from the R half");
	assert.ok(mats[5] >= 1, "green grains formed from the G half");
	const state = massState(sim, w, h);
	assert.ok(Math.abs(state.red + state.green + state.grains - total) <= 1e-6,
		`mass held (${state.red.toFixed(2)} + ${state.green.toFixed(2)} + ${state.grains.toFixed(2)})`);
	books(h, "secondary round trip");
	console.log(`ok  amber round trip: ${mats[0]} red + ${mats[5]} green grains, no alloy, mass held`);
}

// 13. Moving and draining latent inventory: melted liquid carries its latent
//     through flows and out through the drain, and the books stay closed.
{
	const { sim, h, w } = makeSim({ "4,4": ["hollow", [1], RV * 0.75], "4,5": ["hollow", [3], RV * 0.75] });
	const top = centreCell(sim);
	const v = sim.layout.valves[4 * N + 4];
	S.addGrain(sim, v.cx, v.cy, 2.7, 0);
	settleGrain(sim, h);
	// 500 °C: the whole-grain threshold is met by the fill alone. (The old
	// 300 °C relied on a pricing bug — a grain crossing a fully-open dry
	// cell was priced over a capacity of its own CG only, so it swept the
	// donor's whole book along and the sweep donated the missing excess.)
	H.fill(h, 500);
	for (let k = 0; k < 120 && sim.count > 0; k++) S.step(sim, S.STEP);
	assert.equal(sim.count, 0, "the grain melted in the top chamber");
	// The field is hot, so the melt stays liquid while it falls to the lower
	// chamber and its latent rides the flows.
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	books(h, "latent moved");
	const ch = new Float64Array(CH);
	W.channelTotals(w, ch);
	const m0 = grainMassOf(0, 2.7);
	assert.ok(Math.abs(ch[0] - m0) <= 1e-3, `the R channel rode the flow (${ch[0].toFixed(3)} px²)`);
	const vLow = sim.layout.valves[5 * N + 4];
	let lowVol = 0;
	const rr = vLow.chamberR;
	for (let gy = Math.floor((vLow.cy - rr + G.POUR) / w.cell); gy <= Math.floor((vLow.cy + rr + G.POUR) / w.cell); gy++) {
		for (let gx = Math.floor((vLow.cx - rr) / w.cell); gx <= Math.floor((vLow.cx + rr) / w.cell); gx++) {
			lowVol += w.vol[gy * w.nx + gx];
		}
	}
	assert.ok(lowVol > 5, `the melt pooled in the lower chamber (${lowVol.toFixed(1)} px²)`);
	W.drainAll(w);
	books(h, "latent drained");
	const after = new Float64Array(CH);
	W.channelTotals(w, after);
	assert.ok(after[0] <= 1e-9, "the latent left with the liquid");
	console.log("ok  latent inventory: moved chamber-to-chamber and drained with closed books");
}

console.log("OK  heat slices 3-4: melting and freezing through the enthalpy ledger");
