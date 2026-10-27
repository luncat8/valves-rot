const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const GAS = require("../prototype/shared/gas.js");
const I = require("../prototype/shared/inlets.js");
const S = require("../prototype/shared/simulation.js");

// Mean pressure of the air cells in the top and bottom fifths of the field.
function ends(gas) {
	let top = 0;
	let topN = 0;
	let bottom = 0;
	let bottomN = 0;
	const cut = gas.ny * 0.2;
	for (let n = 0; n < gas.count; n++) {
		const k = gas.list[n];
		const row = (k / gas.nx) | 0;
		if (row < cut) {
			top += gas.p[k];
			topN++;
		} else if (row > gas.ny - cut) {
			bottom += gas.p[k];
			bottomN++;
		}
	}
	return { top: top / topN, bottom: bottom / bottomN };
}

function run(sim, seconds) {
	const steps = Math.round(seconds / S.STEP);
	for (let k = 0; k < steps; k++) S.step(sim);
}

function pinnedBands(gas) {
	let top = 0;
	let bottom = 0;
	for (let n = 0; n < gas.bandCount; n++) {
		if (!gas.pin[gas.band[n]]) continue;
		if (gas.bandSide[n] === 0) top++;
		else bottom++;
	}
	return { top, bottom };
}

// Mean pressure of the mouth cells of one column in the source band.
function mouthPressure(gas, column) {
	let sum = 0;
	let n = 0;
	for (let i = 0; i < gas.bandCount; i++) {
		if (gas.bandSide[i] !== 1 || gas.bandColumn[i] !== column) continue;
		sum += gas.p[gas.band[i]];
		n++;
	}
	return n ? sum / n : NaN;
}

function setOpen(sim, side, open) {
	for (let k = 0; k < G.N; k++) {
		const idx = side * G.N + k;
		if (!!sim.inlets.open[idx] !== open) S.toggleInlet(sim, idx, false);
	}
}

const sim = S.create(G.createLayout(7));
S.seed(sim);
const grains = sim.count;
const targets = Array.from(sim.target);
assert.equal(S.setPressure(sim, "grid"), true);
const gas = () => sim.pressure;
assert.equal(gas().kind, "grid");
assert.ok(gas().count > 1000, "the passages must carry a field");
assert.deepEqual([sim.count, Array.from(sim.target)], [grains, targets], "switching preserves grains and valve targets");

// A standing gradient: sources pin the bottom band, vents the top band.
const standing = ends(gas());
assert.ok(standing.bottom > 0.8, `bottom band holds high pressure (${standing.bottom.toFixed(2)})`);
assert.ok(standing.top < 0.2, `top band holds low pressure (${standing.top.toFixed(2)})`);

// Sealing every vent leaves only sources: the whole field rises.
setOpen(sim, I.TOP, false);
run(sim, 0.2);
assert.ok(ends(gas()).top > 0.85, `sealed vents hold source pressure (${ends(gas()).top.toFixed(2)})`);
assert.equal(pinnedBands(gas()).top, 0, "sealed vents pin nothing");
assert.ok(pinnedBands(gas()).bottom > 0, "sources stay pinned");

// Sealing every source too leaves nothing to hold the field.
setOpen(sim, I.BOTTOM, false);
run(sim, 0.2);
assert.equal(gas().pins, 0, "no open mouth pins the field");
assert.ok(Number.isFinite(gas().mean) && Number.isFinite(gas().flow), "a sealed field stays finite");

// Flipping every mouth inverts the gradient.
S.reset(sim);
for (let k = 0; k < G.N; k++) S.toggleInlet(sim, I.TOP * G.N + k, true);
for (let k = 0; k < G.N; k++) S.toggleInlet(sim, I.BOTTOM * G.N + k, true);
run(sim, 0.2);
const flipped = ends(gas());
assert.ok(flipped.top > 0.8 && flipped.bottom < 0.2, `flipped inlets invert the gradient (${flipped.top.toFixed(2)} / ${flipped.bottom.toFixed(2)})`);

// A sealed mouth stops holding its own column while its neighbours still do.
S.reset(sim);
run(sim, 0.2);
assert.ok(ends(gas()).bottom > 0.8);
const openMouth = mouthPressure(gas(), 1);
for (let k = 0; k < G.N; k += 2) S.toggleInlet(sim, I.BOTTOM * G.N + k, false);
run(sim, 0.2);
const sealedMouth = mouthPressure(gas(), 2);
assert.ok(sealedMouth < openMouth, `a sealed source drops its own mouth (${sealedMouth.toFixed(2)} < ${openMouth.toFixed(2)})`);
assert.ok(sealedMouth < 0.99, "a sealed mouth is not pinned");

// Field bounds, and the mask following the rotors.
S.reset(sim);
run(sim, 0.2);
let maxSpeed = 0;
for (let n = 0; n < gas().count; n++) {
	const k = gas().list[n];
	const p = gas().p[k];
	assert.ok(p >= 0 && p <= 1, "pressure stays normalized");
	maxSpeed = Math.max(maxSpeed, Math.hypot(gas().gx[k], gas().gy[k]));
}
assert.ok(maxSpeed <= 221, "gas speed is bounded");
const rebuilds = gas().rebuilds;
run(sim, 1);
assert.ok(gas().rebuilds > rebuilds, "turning rotors rebuild the mask");

// Drag: gas rising through a chamber slows a grain's fall.
function chamberSim(opts) {
	const s = S.create(G.createLayout(7), { turning: false });
	s.layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, 15);
	const v = s.layout.valves[44];
	S.addGrain(s, v.cx, v.cy, 2.7, 0);
	if (opts.pressure) S.setPressure(s, "grid");
	return s;
}
const wet = chamberSim({ pressure: true });
const dry = chamberSim({ pressure: false });
const idx = GAS.index(wet.x[0], wet.y[0]);
const gasVy = wet.pressure.gy[idx];
S.step(wet);
S.step(dry);
assert.equal(wet.count, 1);
assert.equal(dry.count, 1);
const drag = wet.vy[0] - dry.vy[0];
assert.ok(gasVy * drag > 0, `drag follows the gas velocity (${gasVy.toFixed(1)} px/s, dv ${drag.toFixed(2)})`);
assert.ok(wet.pressure.drags > 0, "grains feel the field");

// Cost of the field on top of the grain solver.
function bench(mode, steps) {
	const s = S.create(G.createLayout(7));
	S.seed(s);
	if (mode) S.setPressure(s, mode);
	const t0 = performance.now();
	for (let k = 0; k < steps; k++) S.step(s);
	return (performance.now() - t0) / steps;
}
const offMs = bench(null, 400);
const gridMs = bench("grid", 400);
assert.ok(gridMs < offMs * 3, `grid gas stays within budget (${gridMs.toFixed(3)} vs ${offMs.toFixed(3)} ms)`);
console.log(
	`OK gas: standing ${standing.bottom.toFixed(2)}/${standing.top.toFixed(2)} gradient, sealed and flipped inlets, bounded field, rotor mask, grain drag; off ${offMs.toFixed(3)} ms vs grid ${gridMs.toFixed(3)} ms per 120 Hz step (${process.version})`,
);
