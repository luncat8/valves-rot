// Vertical vent calibration: three independent pipes carry light, standard and
// heavy grains. Run: node experiments/air-scale-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const COLUMNS = [3, 4, 5];
const RADII = [1.7, 2.7, 3.4];
const Y0 = 540;

function build(force) {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) {
			valves.push(G.makeValve(i, j, "solid", COLUMNS.indexOf(i) >= 0 ? [1, 3] : [], 0, 0));
		}
	}
	const sim = S.create({ seed: 73, valves }, { turning: false });
	sim.inlets.present.fill(0);
	sim.inlets.open.fill(0);
	for (let n = 0; n < COLUMNS.length; n++) {
		const c = COLUMNS[n];
		sim.inlets.present[c] = 1;
		sim.inlets.present[G.N + c] = 1;
		sim.inlets.open[c] = 1;
		sim.inlets.open[G.N + c] = 1;
	}
	S.setPressure(sim, "grid");
	S.setAirForce(sim, force);
	for (let n = 0; n < COLUMNS.length; n++) {
		assert.ok(S.addGrain(sim, (COLUMNS[n] + 0.5) * G.S, Y0, RADII[n], n) >= 0);
	}
	return sim;
}

function run(sim, seconds) {
	for (let k = 0; k < Math.round(seconds / S.STEP); k++) S.step(sim, S.STEP);
}

const off = build(0);
run(off, 1);
assert.equal(off.drained, 3, "without airflow, all three grains fall out of the pipe");

const balanced = build(1);
run(balanced, 1);
assert.equal(balanced.count, 3);
const standard = balanced.y[1];
assert.ok(Math.abs(standard - Y0) < 20, `1× should balance gravity for the standard grain, y=${standard.toFixed(1)}`);
assert.ok(balanced.y[0] < Y0 - 120, `the light grain rises at 1×, y=${balanced.y[0].toFixed(1)}`);
assert.ok(balanced.y[2] > Y0 + 15, `the heavy grain falls at 1×, y=${balanced.y[2].toFixed(1)}`);

const lift = build(2);
run(lift, 1);
assert.equal(lift.count, 3);
assert.ok(lift.y[0] < Y0 - 200, `2× must blow the light grain upward, y=${lift.y[0].toFixed(1)}`);
assert.ok(lift.y[1] < Y0 - 120, `2× must lift the standard grain, y=${lift.y[1].toFixed(1)}`);

console.log(
	`OK air scale: 0× drains ${off.drained}; 1× standard y=${standard.toFixed(1)}, light rises ${(Y0 - balanced.y[0]).toFixed(1)} px, heavy falls ${(balanced.y[2] - Y0).toFixed(1)} px; 2× light rises ${(Y0 - lift.y[0]).toFixed(1)} px`,
);
