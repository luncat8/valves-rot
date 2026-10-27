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
assert.ok(maxSpeed <= GAS.GAS_MAX + 0.01, "gas speed is bounded");
const rebuilds = gas().rebuilds;
run(sim, 1);
assert.ok(gas().rebuilds > rebuilds, "turning rotors rebuild the mask");

// Coupling: a grain dropped through an open chamber falls slower in air and is
// pushed sideways by the flow, and the air-force control scales both.
function dropTest(mode, force) {
	const s = S.create(G.createLayout(7), { turning: false });
	s.layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, G.RV * 0.8);
	const v = s.layout.valves[44];
	S.addGrain(s, v.cx, v.cy - 12, 2.7, 0);
	if (mode) {
		S.setPressure(s, mode);
		S.setAirForce(s, force);
	}
	const y0 = s.y[0];
	const x0 = s.x[0];
	let time = -1;
	for (let k = 0; k < 360; k++) {
		S.step(s);
		if (time < 0 && s.y[0] - y0 > 30) time = k * S.STEP;
	}
	return { time: time < 0 ? Infinity : time, drift: Math.abs(s.x[0] - x0), sim: s };
}
const dry = dropTest(null, 0);
const still = dropTest("grid", 0);
assert.ok(Math.abs(still.time - dry.time) < 1e-9, "air force 0 matches pressure off");
const wet = dropTest("grid", 1);
const hard = dropTest("grid", 2);
assert.ok(wet.time > dry.time * 1.5, `air clearly holds a fall back (${wet.time.toFixed(2)} s vs ${dry.time.toFixed(2)} s)`);
assert.ok(wet.drift > 4, `the flow pushes a falling grain sideways (${wet.drift.toFixed(1)} px)`);
assert.ok(!Number.isFinite(hard.time) || hard.time > wet.time * 1.2, "more air force means more lift");
assert.ok(wet.sim.pressure.drags > 0, "grains feel the field");
const particle = dropTest("particles", 1);
assert.ok(particle.time > dry.time * 1.5, `air particles also hold a fall back (${particle.time.toFixed(2)} s)`);
assert.ok(particle.sim.pressure.collisions > 0, "air particles hit grains");
const show = r => (Number.isFinite(r.time) ? r.time.toFixed(2) + " s" : "hovering");

// Reciprocity: occupancy warps the potential, and a sitting pile drains the gas
// that lifts it. Positions stay frozen so the measurement is the field, not the
// grains sliding out of the chamber.
function slice(field, x, y, r) {
	let p = 0;
	let spd = 0;
	let n = 0;
	for (let i = 0; i < field.count; i++) {
		const k = field.list[i];
		const gx = (k % field.nx) * field.cell + field.cell / 2;
		const gy = ((k / field.nx) | 0) * field.cell + field.cell / 2 - G.POUR;
		if ((gx - x) * (gx - x) + (gy - y) * (gy - y) > r * r) continue;
		p += field.p[k];
		spd += Math.hypot(field.gx[k], field.gy[k]);
		n++;
	}
	return { n, p: p / n, spd: spd / n };
}

function chamber(pack) {
	const s = S.create(G.createLayout(7), { turning: false });
	s.layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, G.RV * 0.8);
	const v = s.layout.valves[44];
	if (pack) {
		const rad = 2.7;
		const reach = (v.chamberR - rad) * (v.chamberR - rad);
		for (let y = v.cy - 20; y <= v.cy + 20; y += 5.5) {
			for (let x = v.cx - 20; x <= v.cx + 20; x += 5.5) {
				if ((x - v.cx) * (x - v.cx) + (y - v.cy) * (y - v.cy) < reach) S.addGrain(s, x, y, rad, 0);
			}
		}
	}
	S.setPressure(s, "grid");
	return { s, v };
}

const vacant = chamber(false);
const piled = chamber(true);
assert.ok(piled.s.count > 20, "the chamber holds a pile");
const vacantDrop =
	slice(vacant.s.pressure, vacant.v.cx, vacant.v.cy + 16, 8).p - slice(vacant.s.pressure, vacant.v.cx, vacant.v.cy - 16, 8).p;
const piledDrop =
	slice(piled.s.pressure, piled.v.cx, piled.v.cy + 16, 8).p - slice(piled.s.pressure, piled.v.cx, piled.v.cy - 16, 8).p;
assert.ok(
	piledDrop > vacantDrop * 2,
	`a pile drops pressure across its thickness (${piledDrop.toFixed(3)} vs ${vacantDrop.toFixed(3)})`,
);
const vacantMid = slice(vacant.s.pressure, vacant.v.cx, vacant.v.cy, 14).spd;
const piledMid0 = slice(piled.s.pressure, piled.v.cx, piled.v.cy, 14).spd;
for (let k = 0; k < 48; k++) {
	GAS.step(vacant.s, S.STEP);
	GAS.step(piled.s, S.STEP);
}
const piledMid = slice(piled.s.pressure, piled.v.cx, piled.v.cy, 14).spd;
assert.ok(piledMid < vacantMid * 0.85, `a sitting pile damps the flow (${piledMid.toFixed(0)} vs ${vacantMid.toFixed(0)})`);
assert.ok(piledMid < piledMid0 * 0.95, "grains take momentum from the cells they sit in");
assert.ok(piled.s.pressure.gain > 0, "reciprocal impulse is counted");
assert.equal(vacant.s.pressure.gain, 0);

const late = chamber(false);
const cell = GAS.index(late.v.cx, late.v.cy);
assert.equal(late.s.pressure.fill[cell], 0);
S.addGrain(late.s, late.v.cx, late.v.cy, 2.7, 0);
const updates = late.s.pressure.updates;
for (let k = 0; k < 8; k++) GAS.step(late.s, S.STEP);
assert.ok(late.s.pressure.updates > updates, "a still machine still re-solves for fill");
assert.ok(late.s.pressure.fill[cell] > 0.4, "a grain occupies its cell");

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
	`OK gas: standing ${standing.bottom.toFixed(2)}/${standing.top.toFixed(2)} gradient, sealed and flipped inlets, bounded field, rotor mask; pile Δp ${piledDrop.toFixed(3)} vs empty ${vacantDrop.toFixed(3)}, flow ${piledMid.toFixed(0)} vs ${vacantMid.toFixed(0)}; 30 px fall ${show(dry)} dry, ${show(wet)} at force 1, ${show(hard)} at force 2, ${show(particle)} with particles, drift ${wet.drift.toFixed(1)} px; off ${offMs.toFixed(3)} ms vs grid ${gridMs.toFixed(3)} ms per 120 Hz step (${process.version})`,
);
