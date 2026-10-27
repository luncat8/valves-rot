const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const I = require("../prototype/shared/inlets.js");
const S = require("../prototype/shared/simulation.js");
const P = require("../prototype/shared/air.js");

function chamber() {
	const layout = G.createLayout(7);
	layout.valves[44] = G.makeValve(4, 4, "hollow", [], 0, 15);
	return S.create(layout, { turning: false });
}
const sim = chamber();
const v = sim.layout.valves[44];
S.addGrain(sim, v.cx, v.cy, 2.7, 0);
const before = [sim.count, sim.injected, sim.drained, sim.target[44], sim.x[0]];
assert.equal(S.setPressure(sim, "particles"), true);
assert.deepEqual([sim.count, sim.injected, sim.drained, sim.target[44], sim.x[0]], before);
const p = sim.pressure;
p.count = 1;
p.x[0] = v.cx - 3.5;
p.y[0] = v.cy;
p.vx[0] = 180;
p.vy[0] = 0;
const momentum = P.MASS * p.vx[0];
const energy = P.MASS * p.vx[0] ** 2;
P.step(sim, 1 / 120);
assert.ok(sim.vx[0] > 0, "air pushes a colored grain");
assert.ok(Math.abs(P.MASS * p.vx[0] + sim.r[0] ** 2 * sim.vx[0] - momentum) < 1e-10, "reciprocal momentum");
assert.ok(Math.abs(P.MASS * p.vx[0] ** 2 + sim.r[0] ** 2 * sim.vx[0] ** 2 - energy) < 1e-8, "elastic exchange");
S.drain(sim);
p.x[0] = v.cx + 13;
p.y[0] = v.cy;
p.vx[0] = 180;
p.vy[0] = 0;
for (let k = 0; k < 300; k++) {
	P.step(sim, 1 / 120);
	assert.ok(G.airClearance(sim.layout, p.x[0], p.y[0]) >= P.RADIUS - 1e-6);
	assert.ok(Math.abs(Math.hypot(p.vx[0], p.vy[0]) - 180) < 1e-7, "static walls preserve speed");
	assert.ok(Math.hypot(p.x[0] - v.cx, p.y[0] - v.cy) <= 15 - P.RADIUS + 1e-6, "sealed chamber contains air");
}
assert.equal(S.setPressure(sim, "grid"), true);
assert.equal(S.setPressure(sim, "off"), true);
assert.equal(sim.pressure, null);

// Inlets: one mouth per column per band, bottom sources over top vents.
const inlets = I.create();
assert.equal(inlets.count, G.N * 2);
assert.equal(I.count(inlets, I.HIGH), G.N);
assert.equal(I.count(inlets, I.LOW), G.N);
assert.equal(I.hit(inlets, 5 * G.S + 10, -G.POUR + 2), I.TOP * G.N + 5);
assert.equal(I.hit(inlets, 5 * G.S + 10, G.SIZE + G.POUR - 2), I.BOTTOM * G.N + 5);
assert.equal(I.hit(inlets, 5 * G.S + 10, G.SIZE / 2), -1, "the housing is not an inlet");
I.press(inlets, 3, false);
assert.equal(inlets.open[3], 0, "a click seals a mouth");
I.press(inlets, 3, true);
assert.equal(inlets.level[3], I.HIGH, "shift-click flips polarity");
I.reset(inlets);
assert.equal(I.count(inlets, I.HIGH), G.N);
assert.equal(I.count(inlets, I.LOW), G.N);

// Reservoir exchange: air that reaches a vent is recycled into a source, so the
// population circulates from the bottom band to the top band.
const flow = S.create(G.createLayout(11));
S.seed(flow);
S.setPressure(flow, "particles");
const air = flow.pressure;
const fixed = [air.count, flow.count, flow.target[3]];
for (let k = 0; k < 600; k++) S.step(flow);
assert.deepEqual([air.count, flow.count, flow.target[3]], fixed, "exchange conserves air and grains");
assert.ok(air.cycles > 0, "vents recycle air into the sources");
const cycled = air.cycles;
for (let k = 0; k < flow.inlets.count; k++) flow.inlets.open[k] = 0;
flow.inlets.version++;
for (let k = 0; k < 120; k++) S.step(flow);
assert.equal(air.cycles, cycled, "sealed inlets stop the circulation");

// Pressure off keeps the grain trajectory identical.
const a = S.create(G.createLayout(11));
const b = S.create(G.createLayout(11));
S.seed(a);
S.seed(b);
S.setPressure(b, "grid");
S.setPressure(b, "particles");
S.setPressure(b, "off");
for (let k = 0; k < 100; k++) {
	S.step(a);
	S.step(b);
}
assert.deepEqual(a.x, b.x, "off mode retains grain behavior");

const full = S.create(G.createLayout(7));
S.seed(full);
S.setPressure(full, "particles");
const start = performance.now();
for (let k = 0; k < 360; k++) {
	S.step(full);
	for (let j = 0; j < full.pressure.count; j++) {
		assert.ok(Number.isFinite(full.pressure.x[j]) && Number.isFinite(full.pressure.vy[j]));
		assert.ok(Math.hypot(full.pressure.vx[j], full.pressure.vy[j]) <= P.LIMIT + 1e-6);
	}
}
assert.equal(full.injected, full.count + full.drained + full.purged);
console.log(
	`OK air: reciprocal impulse, elastic static walls, sealed containment, inlet toggles, reservoir exchange, switching, off equivalence; ${full.pressure.count} air, ${full.pressure.collisions} contacts, ${full.pressure.cycles} recycles; ${((performance.now() - start) / 180).toFixed(2)} ms/60Hz including assertions (${process.version})`,
);
