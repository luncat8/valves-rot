// Grid gas: constant-pressure mouth cells, conservative face diffusion, valve
// connectivity, the fill front and grain coupling.
// Run: node experiments/gas-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const GAS = require("../prototype/shared/gas.js");
const I = require("../prototype/shared/inlets.js");
const S = require("../prototype/shared/simulation.js");

function crossLayout() {
	const valves = [];
	for (let j = 0; j < G.N; j++) for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "solid", [0, 1, 2, 3], 0, 0));
	return { seed: 42, valves };
}

function columnLayout() {
	const valves = [];
	for (let j = 0; j < G.N; j++) for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "solid", [], 0, 0));
	for (let j = 0; j < G.N; j++) valves[j * G.N + 4] = G.makeValve(4, j, "solid", [1, 3], 0, 0);
	return { seed: 5, valves };
}

function run(sim, seconds) {
	const steps = Math.round(seconds / S.STEP);
	for (let k = 0; k < steps; k++) S.step(sim);
}

function setOpen(sim, side, open) {
	for (let k = 0; k < G.N; k++) {
		const idx = side * G.N + k;
		if (!!sim.inlets.open[idx] !== open) S.toggleInlet(sim, idx, false);
	}
}

function rowMeans(gas) {
	const out = new Float64Array(gas.ny);
	const n = new Int32Array(gas.ny);
	for (let i = 0; i < gas.count; i++) {
		const k = gas.list[i];
		const row = (k / gas.nx) | 0;
		out[row] += gas.p[k];
		n[row]++;
	}
	for (let r = 0; r < gas.ny; r++) out[r] = n[r] ? out[r] / n[r] : NaN;
	return out;
}

function spread(gas) {
	let lo = 1;
	let hi = 0;
	for (let i = 0; i < gas.count; i++) {
		const v = gas.p[gas.list[i]];
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	return hi - lo;
}

function oneD(nx, cell, pinEnd) {
	const f = GAS.blankField(nx, 1, cell);
	f.air.fill(1);
	f.face.fill(15);
	f.open.fill(1);
	for (let k = 0; k < nx; k++) f.list[k] = k;
	f.pin[0] = 2;
	if (pinEnd) f.pin[nx - 1] = 1;
	GAS.link(f);
	GAS.components(f);
	GAS.conductance(f);
	GAS.markActive(f);
	return f;
}

function chamber(pack) {
	const s = S.create(crossLayout(), { turning: false });
	s.layout.valves[44] = G.makeValve(4, 4, "hollow", [0, 1, 2, 3], 0, G.RV * 0.8);
	const v = s.layout.valves[44];
	if (pack) {
		const rad = 2.7;
		const reach = (v.chamberR - rad) * (v.chamberR - rad);
		for (let y = v.cy - 20; y <= v.cy + 20; y += 5.5) {
			for (let x = v.cx - 20; x <= v.cx + 20; x += 5.5) {
				if ((x - v.cx) ** 2 + (y - v.cy) ** 2 < reach) S.addGrain(s, x, y, rad, 0);
			}
		}
	}
	S.setPressure(s, "grid");
	return { s, v };
}

function slice(gas, x, y, r) {
	let p = 0;
	let speed = 0;
	let n = 0;
	for (let i = 0; i < gas.count; i++) {
		const k = gas.list[i];
		const gx = (k % gas.nx) * gas.cell + gas.cell / 2;
		const gy = ((k / gas.nx) | 0) * gas.cell + gas.cell / 2 - G.POUR;
		if ((gx - x) ** 2 + (gy - y) ** 2 > r * r) continue;
		p += gas.p[k];
		speed += Math.hypot(gas.gx[k], gas.gy[k]);
		n++;
	}
	return { n, p: p / n, speed: speed / n };
}

function dropTest(mode, force, isolated) {
	const s = S.create(crossLayout(), { turning: false });
	s.layout.valves[44] = G.makeValve(4, 4, "hollow", isolated ? [] : [0, 1, 2, 3], 0, G.RV * 0.8);
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
	return {
		time: time < 0 ? Infinity : time,
		drift: Math.abs(s.x[0] - x0),
		sim: s,
		drags: s.pressure && s.pressure.kind === "grid" ? s.pressure.drags : 0,
	};
}

// ---- constant-pressure boundaries ---------------------------------------
const sim = S.create(G.createLayout(7), { turning: false });
S.seed(sim);
const grains = sim.count;
const targets = Array.from(sim.target);
assert.equal(S.setPressure(sim, "grid"), true);
const gas = () => sim.pressure;
assert.equal(gas().kind, "grid");
assert.ok(gas().count > 1000, "the passages must carry a field");
assert.deepEqual([sim.count, Array.from(sim.target)], [grains, targets], "switching preserves grains and valve targets");
assert.equal(gas().pins, 200);
assert.equal(gas().sources, 100);
assert.equal(gas().vents, 100);
assert.ok(gas().pins > 0, "open mouths are constant-pressure boundaries");

// Mouths are cells outside the 10x10 field and hold exactly their level.
function checkPins(field) {
	let checked = 0;
	for (let n = 0; n < field.bandCount; n++) {
		const k = field.band[n];
		const y = ((k / field.nx) | 0) * field.cell + field.cell / 2 - G.POUR;
		assert.ok(y < 0 || y > G.SIZE, "a mouth cell is outside the play field");
		if (!field.pin[k]) continue;
		assert.equal(field.p[k], field.pin[k] === 2 ? 1 : 0, "an open mouth is a constant-pressure boundary");
		checked++;
	}
	return checked;
}
assert.equal(checkPins(gas()), 200);
run(sim, 0.5);
assert.equal(checkPins(gas()), 200, "mouths stay pinned while the field moves");

// A sealed mouth is an ordinary air pocket: no pin, no constant pressure.
S.toggleInlet(sim, I.BOTTOM * G.N + 3, false);
let sealedColumn = 0;
for (let n = 0; n < gas().bandCount; n++) {
	if (gas().bandSide[n] !== I.BOTTOM || gas().bandColumn[n] !== 3) continue;
	assert.equal(gas().pin[gas().band[n]], 0, "a sealed mouth pins nothing");
	sealedColumn++;
}
assert.ok(sealedColumn > 0);
assert.equal(gas().sources, 100 - sealedColumn);
// Flipping a mouth swaps which constant pressure its cells hold.
S.toggleInlet(sim, I.TOP * G.N + 3, true);
for (let n = 0; n < gas().bandCount; n++) {
	if (gas().bandSide[n] !== I.TOP || gas().bandColumn[n] !== 3) continue;
	assert.equal(gas().pin[gas().band[n]], 2, "a flipped vent becomes a source");
	assert.equal(gas().p[gas().band[n]], 1);
}
S.reset(sim);

// ---- steady field on a connected machine --------------------------------
const connected = S.create(crossLayout(), { turning: false });
S.setPressure(connected, "grid");
const cg = connected.pressure;
assert.equal(cg.compCount, 1, "open cross valves make one connected air volume");
const rows = rowMeans(cg);
assert.ok(rows[0] < 0.05, `the low band holds low pressure (${rows[0].toFixed(2)})`);
assert.ok(rows[cg.ny - 1] > 0.95, `the high band holds high pressure (${rows[cg.ny - 1].toFixed(2)})`);
assert.ok(Math.abs(rows[(cg.ny / 2) | 0] - 0.5) < 0.08, "the middle sits at half the source-to-vent drop");
for (let r = 1; r < cg.ny; r++) assert.ok(rows[r] > rows[r - 1] - 0.06, "pressure falls monotonically towards the vents");
assert.ok(cg.flow > 10, "a source and a vent in one component carry a through-flow");

// ---- a sealed machine keeps its air -------------------------------------
const frozenBefore = Float32Array.from(cg.p);
const frozenSpread = spread(cg);
setOpen(connected, I.TOP, false);
setOpen(connected, I.BOTTOM, false);
assert.equal(cg.pins, 0);
assert.equal(cg.pins, 0);
run(connected, 1);
let maxChange = 0;
for (let k = 0; k < frozenBefore.length; k++) maxChange = Math.max(maxChange, Math.abs(frozenBefore[k] - cg.p[k]));
assert.equal(maxChange, 0, "with every mouth sealed the pressure does not move");
assert.ok(spread(cg) > 0.8, `a sealed machine keeps its gradient instead of one flat colour (${spread(cg).toFixed(2)})`);
assert.ok(frozenSpread > 0.8);
assert.ok(cg.flow < 1, `a sealed machine has no through-flow (${cg.flow.toFixed(2)} px/s)`);
assert.ok(Number.isFinite(cg.mean) && Number.isFinite(cg.flow), "a sealed field stays finite");
// Reopen one source and one vent: the field answers again, but not instantly.
S.toggleInlet(connected, I.TOP * G.N + 1, false);
S.toggleInlet(connected, I.BOTTOM * G.N + 8, false);
assert.equal(cg.pins, 20);
run(connected, 0.1);
assert.ok(Math.abs(cg.mean - 0.5) >= 0, "the field is still defined");
run(connected, 1);
assert.ok(spread(cg) > 0.8 && cg.flow > 0, "reopening mouths restores the through-flow");

// ---- the front really starts at a mouth ---------------------------------
const chain = oneD(121, 6, false);
chain.p.fill(0);
chain.p[0] = 1;
GAS.diffuse(chain, 40);
assert.ok(chain.p[1] > chain.p[10] && chain.p[10] > chain.p[20], "pressure decays away from the source");
assert.ok(chain.p[60] < 0.02, "the far end is still empty after one step");
const nearAfterOne = chain.p[60];
for (let k = 0; k < 7; k++) GAS.diffuse(chain, 40);
assert.ok(chain.p[60] > nearAfterOne, "the front reaches further cells over later steps");
assert.ok(chain.p[120] < chain.p[1], "the far end still lags behind the mouth");
for (let k = 0; k < 121; k++) assert.ok(chain.p[k] >= 0 && chain.p[k] <= 1, "a transient stays normalized");
const both = oneD(121, 6, true);
GAS.steady(both, both.p);
let steadyError = 0;
for (let k = 0; k < 121; k++) steadyError = Math.max(steadyError, Math.abs(both.p[k] - (1 - k / 120)));
assert.ok(steadyError < 1e-4, `the steady solve gives the linear 1-D profile (${steadyError.toExponential(2)})`);

// ---- long pipes converge instead of starving ------------------------------
// IC(0) is exact along a chain, so even a scrambled 301-cell pipe solves in a
// few sweeps; Jacobi needed one iteration per cell and stalled the front.
const longPipe = oneD(301, 6, true);
for (let k = 0; k < 301; k++) longPipe.p[k] = 0.5 + 0.4 * Math.sin(k * 0.37);
GAS.steady(longPipe, longPipe.p);
assert.ok(longPipe.pcgIters <= 10, `a 301-cell pipe solves in a few sweeps (${longPipe.pcgIters})`);
let pipeError = 0;
for (let k = 0; k < 301; k++) pipeError = Math.max(pipeError, Math.abs(longPipe.p[k] - (1 - k / 300)));
assert.ok(pipeError < 1e-4, `the long pipe reaches the linear profile (${pipeError.toExponential(2)})`);
// A full-strength implicit step carries the transient through the pipe too.
const rush = oneD(121, 6, true);
rush.p.fill(0.5);
for (let k = 0; k < 10; k++) GAS.diffuse(rush, GAS.DIFFUSE_DT);
let rushError = 0;
for (let k = 0; k < 121; k++) rushError = Math.max(rushError, Math.abs(rush.p[k] - (1 - k / 120)));
assert.ok(rushError < 0.1, `ten mask ticks fill a 121-cell pipe (${rushError.toFixed(3)})`);

// On a connected machine the same must hold end to end: after a mouth change
// the front arrives within a handful of mask ticks and no solve hits the
// iteration cap.
const brisk = S.create(crossLayout(), { turning: false });
S.setPressure(brisk, "grid");
setOpen(brisk, I.TOP, false);
setOpen(brisk, I.BOTTOM, false);
run(brisk, 0.3);
S.toggleInlet(brisk, I.TOP * G.N + 0, false);
S.toggleInlet(brisk, I.BOTTOM * G.N + (G.N - 1), false);
GAS.steady(brisk.pressure, brisk.pressure.pTarget);
let briskTicks = 0;
for (; briskTicks < 30; briskTicks++) {
	S.settlePressure(brisk, 1 / 30);
	assert.ok(brisk.pressure.pcgIters < 400, "no solve starves against the iteration cap");
	let near = 0;
	let active = 0;
	for (let n = 0; n < brisk.pressure.count; n++) {
		const k = brisk.pressure.list[n];
		if (!brisk.pressure.active[k] || brisk.pressure.pin[k]) continue;
		active++;
		if (Math.abs(brisk.pressure.p[k] - brisk.pressure.pTarget[k]) <= 0.02) near++;
	}
	if (active && near / active >= 0.95) break;
}
assert.ok(briskTicks <= 15, `the front crosses a connected machine quickly (${briskTicks} mask ticks)`);

// ---- valves decide where the air can go ---------------------------------
const gated = S.create(crossLayout(), { turning: false });
gated.layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, G.RV * 0.8);
const pocket = gated.layout.valves[44];
S.setPressure(gated, "grid");
const gg = () => gated.pressure;
const pocketCell = GAS.index(pocket.cx, pocket.cy);
assert.equal(gg().active[pocketCell], 0, "a chamber with no ports is disconnected from every mouth");
assert.ok(gg().p[pocketCell] < 0.05, "an isolated chamber starts empty");
setOpen(gated, I.TOP, false);
run(gated, 1);
assert.ok(gg().p[pocketCell] < 0.05, "high air cannot leak through metal into a shut chamber");
assert.ok(gg().mean > 0.5, "the connected field does fill from the sources");
const rebuilds = gg().rebuilds;
S.installValve(gated, 44, G.typeById("hollow-cross"), 0, G.RV * 0.8);
assert.ok(gg().rebuilds > rebuilds, "a new valve rebuilds the air graph");
assert.equal(gg().active[pocketCell], 1, "opening the ports connects the chamber to a mouth");
run(gated, 0.5);
assert.ok(gg().p[pocketCell] > 0.5, `air now flows into the opened chamber (${gg().p[pocketCell].toFixed(2)})`);

// Turning a rotor rebuilds the mask without erasing the field; in a machine
// whose only source-to-vent path runs through that valve, the path changes.
const turned = S.create(columnLayout(), { turning: false });
S.setPressure(turned, "grid");
const tv = turned.layout.valves[44];
const beforeTurn = Float32Array.from(turned.pressure.p);
G.setAngle(tv, tv.angle + G.HALF_PI);
const maskRebuilds = turned.pressure.rebuilds;
GAS.refresh(turned);
assert.ok(turned.pressure.rebuilds > maskRebuilds, "a rotor turn rebuilds the mask");
let unchanged = 0;
for (let k = 0; k < beforeTurn.length; k++) if (Math.abs(beforeTurn[k] - turned.pressure.p[k]) < 1e-6) unchanged++;
assert.equal(unchanged, beforeTurn.length, "changing connectivity does not repaint the pressure");
run(turned, 0.4);
let moved = 0;
for (let i = 0; i < turned.pressure.count; i++) {
	const k = turned.pressure.list[i];
	if (Math.abs(beforeTurn[k] - turned.pressure.p[k]) > 0.02) moved++;
}
assert.ok(moved > 20, `a rotor turn moves the field (${moved} cells)`);

// ---- rotation drives the gas with no inertia state ------------------------
// A turning rotor drags the air in its disc the way the particle backend's
// moving walls do, straight from omega: no momentum is stored, so the swirl
// stops a few mask ticks after the rotor does, and no pressure boundary is
// needed for it to exist.
const swirl = S.create(G.createLayout(7), { turning: false });
S.setPressure(swirl, "grid");
S.installValve(swirl, 44, G.typeById("hollow-cross"), 0, G.RV * 0.8);
setOpen(swirl, I.TOP, false);
setOpen(swirl, I.BOTTOM, false);
GAS.refresh(swirl, true); // sealed snapshot with zeroed velocity
const spun = swirl.pressure;
function swirlSettle() {
	for (let k = 0; k < 8; k++) S.settlePressure(swirl, 1 / 30);
}
function discTangential() {
	const v = swirl.layout.valves[44];
	let sum = 0;
	let n = 0;
	for (let i = 0; i < spun.count; i++) {
		const k = spun.list[i];
		const cx = (k % spun.nx) * spun.cell + spun.cell / 2;
		const cy = ((k / spun.nx) | 0) * spun.cell + spun.cell / 2 - G.POUR;
		const dx = cx - v.cx;
		const dy = cy - v.cy;
		const d2 = dx * dx + dy * dy;
		if (d2 > (G.RV * 0.6) * (G.RV * 0.6) || d2 < 4) continue;
		sum += (spun.gx[k] * -dy + spun.gy[k] * dx) / Math.sqrt(d2);
		n++;
	}
	return n ? sum / n : 0;
}
swirlSettle();
const stillSwirl = discTangential();
assert.equal(spun.pins, 0, "rotation needs no pressure boundary");
assert.ok(Math.abs(stillSwirl) < 2, `a sealed still machine carries no swirl (${stillSwirl.toFixed(1)} px/s)`);
swirl.omega[44] = 2.4;
swirlSettle();
const cw = discTangential();
assert.ok(cw > 10, `a turning rotor drags the gas with it (${cw.toFixed(0)} px/s)`);
swirl.omega[44] = -2.4;
swirlSettle();
const ccw = discTangential();
assert.ok(ccw < -10, `the swirl follows the direction of rotation (${ccw.toFixed(0)} px/s)`);
swirl.omega[44] = 0;
swirlSettle();
const stopped = discTangential();
assert.ok(Math.abs(stopped) < Math.abs(cw) * 0.35, `the swirl stops with the rotor: no inertia state (${stopped.toFixed(1)} px/s)`);

// ---- occupancy and reciprocation ----------------------------------------
const vacant = chamber(false);
const piled = chamber(true);
assert.ok(piled.s.count > 20, "the chamber holds a pile");
for (let k = 0; k < 12; k++) {
	GAS.step(vacant.s, S.STEP);
	GAS.step(piled.s, S.STEP);
}
const center = GAS.index(vacant.v.cx, vacant.v.cy);
assert.ok(piled.s.pressure.fill[center] > 0.4, "grains occupy their cell");
assert.ok(piled.s.pressure.cond[center] < vacant.s.pressure.cond[center], "a pile lowers the cell conductance");
const vacantMid = slice(vacant.s.pressure, vacant.v.cx, vacant.v.cy, 14).speed;
const piledMid = slice(piled.s.pressure, piled.v.cx, piled.v.cy, 14).speed;
assert.ok(piledMid < vacantMid * 0.95, `a pile slows the flow through it (${piledMid.toFixed(1)} vs ${vacantMid.toFixed(1)})`);
assert.ok(piled.s.pressure.gain > 0 && piled.s.pressure.drags > 0, "the pile takes momentum from the gas");
assert.equal(vacant.s.pressure.gain, 0);

// ---- grain coupling -----------------------------------------------------
const dry = dropTest(null, 0);
const still = dropTest("grid", 0);
assert.ok(Math.abs(still.time - dry.time) < 1e-9, "air force 0 matches pressure off");
const wet = dropTest("grid", 1);
const hard = dropTest("grid", 2);
assert.ok(wet.time > dry.time * 1.4, `air holds a fall back (${wet.time.toFixed(2)} s vs ${dry.time.toFixed(2)} s)`);
assert.ok(wet.drift > 2, `the flow pushes a falling grain sideways (${wet.drift.toFixed(1)} px)`);
assert.ok(!Number.isFinite(hard.time) || hard.time > wet.time * 1.15, "more air force means more lift");
assert.ok(wet.drags > 0, "grains feel the field");
const isolated = dropTest("grid", 2, true);
assert.equal(isolated.drags, 0, "a chamber cut off from every mouth has no air flow");
const particle = dropTest("particles", 1);
assert.ok(particle.time > dry.time * 1.5, `air particles also hold a fall back (${particle.time.toFixed(2)} s)`);
const show = r => (Number.isFinite(r.time) ? r.time.toFixed(2) + " s" : "hovering");

// ---- bounds, idle cost, mode switching ----------------------------------
S.reset(sim);
run(sim, 0.5);
let maxSpeed = 0;
for (let i = 0; i < gas().count; i++) {
	const k = gas().list[i];
	const p = gas().p[k];
	assert.ok(p >= 0 && p <= 1, "pressure stays normalized");
	assert.ok(Number.isFinite(gas().gx[k]) && Number.isFinite(gas().gy[k]), "velocity stays finite");
	maxSpeed = Math.max(maxSpeed, Math.hypot(gas().gx[k], gas().gy[k]));
}
assert.ok(maxSpeed <= GAS.GAS_MAX + 0.01, "gas speed is bounded");
const spinning = S.create(G.createLayout(7));
S.setPressure(spinning, "grid");
const rebuildCount = spinning.pressure.rebuilds;
run(spinning, 1);
assert.ok(spinning.pressure.rebuilds > rebuildCount, "turning rotors rebuild the mask");
const idle = S.create(G.createLayout(7), { turning: false });
S.setPressure(idle, "grid");
for (let k = 0; k < 60; k++) S.settlePressure(idle, 1 / 120);
const idleSolves = idle.pressure.solves;
const idleUpdates = idle.pressure.updates;
for (let k = 0; k < 24; k++) S.settlePressure(idle, 1 / 120);
assert.equal(idle.pressure.solves, idleSolves, "a settled machine skips the linear solve");
assert.ok(idle.pressure.updates > idleUpdates, "but the mask clock still runs");
assert.equal(S.setPressure(sim, "off"), true);
assert.equal(sim.pressure, null);
assert.equal(S.setPressure(sim, "grid"), true);

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
assert.ok(gridMs < offMs * 6, `grid gas stays within budget (${gridMs.toFixed(3)} vs ${offMs.toFixed(3)} ms)`);
console.log(
	`OK gas: constant-pressure mouths (${gas().pins} cells), 1 connected component with a linear 0–1 gradient, ` +
	`sealed field keeps ${frozenSpread.toFixed(2)} of colour, front 1-D, valve gating; ` +
	`pile flow ${piledMid.toFixed(0)} vs empty ${vacantMid.toFixed(0)}; ` +
	`30 px fall ${show(dry)} dry, ${show(wet)} at force 1, ${show(hard)} at force 2, ${show(particle)} with particles, drift ${wet.drift.toFixed(1)} px; ` +
	`off ${offMs.toFixed(3)} ms vs grid ${gridMs.toFixed(3)} ms per 120 Hz step (${process.version})`,
);
