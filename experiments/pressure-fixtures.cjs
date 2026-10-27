const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const P = require("../prototype/shared/pressure.js");

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
assert.equal(S.setPressure(sim, "grid"), false);
S.setPressure(sim, "off");
assert.equal(sim.pressure, null);
const a = S.create(G.createLayout(11));
const b = S.create(G.createLayout(11));
S.seed(a); S.seed(b);
S.setPressure(b, "particles"); S.setPressure(b, "off");
for (let k = 0; k < 100; k++) { S.step(a); S.step(b); }
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
console.log(`OK pressure: reciprocal impulse, elastic static walls, sealed containment, switching, off equivalence; ${full.pressure.count} air, ${full.pressure.collisions} contacts; ${((performance.now() - start) / 180).toFixed(2)} ms/60Hz including assertions (${process.version})`);
