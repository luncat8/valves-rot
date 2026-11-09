// Vertical vent calibration: three independent pipes carry light, standard and
// heavy grains. Run: node experiments/air-scale-fixtures.cjs
// Density is part of the grain mass now (material palette), so the lanes use
// real materials: buoyant blue 500, neutral teal 1000, dense red 2000 kg/m3.
// The neutral r = 2.7 grain is exactly REFERENCE_GRAIN_MASS, the mass the 1x
// air-force setting was calibrated to balance.
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const Y0 = 540;
const LANES = [
	{ column: 3, radius: 1.7, color: 3, name: "light" },
	{ column: 4, radius: 2.7, color: 2, name: "standard" },
	{ column: 5, radius: 3.4, color: 0, name: "heavy" },
];

function build(force) {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) {
			const open = LANES.some(lane => lane.column === i);
			valves.push(G.makeValve(i, j, "solid", open ? [1, 3] : [], 0, 0));
		}
	}
	const sim = S.create({ seed: 73, valves }, { turning: false });
	sim.inlets.present.fill(0);
	sim.inlets.open.fill(0);
	for (const lane of LANES) {
		const c = lane.column;
		sim.inlets.present[c] = 1;
		sim.inlets.present[G.N + c] = 1;
		sim.inlets.open[c] = 1;
		sim.inlets.open[G.N + c] = 1;
	}
	S.setPressure(sim, "grid");
	S.setAirForce(sim, force);
	for (const lane of LANES) {
		assert.ok(S.addGrain(sim, (lane.column + 0.5) * G.S, Y0, lane.radius, lane.color) >= 0);
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
assert.ok(Math.abs(standard - Y0) < 20, `1x should balance gravity for the standard grain, y=${standard.toFixed(1)}`);
assert.ok(balanced.y[0] < Y0 - 120, `the light grain rises at 1x, y=${balanced.y[0].toFixed(1)}`);
assert.ok(balanced.y[2] > Y0 + 15, `the heavy grain falls at 1x, y=${balanced.y[2].toFixed(1)}`);

const lift = build(2);
run(lift, 1);
assert.equal(lift.count, 3);
assert.ok(lift.y[0] < Y0 - 200, `2x must blow the light grain upward, y=${lift.y[0].toFixed(1)}`);
assert.ok(lift.y[1] < Y0 - 120, `2x must lift the standard grain, y=${lift.y[1].toFixed(1)}`);

console.log(
	`OK air scale: 0x drains ${off.drained}; 1x standard y=${standard.toFixed(1)}, ` +
		`light rises ${(Y0 - balanced.y[0]).toFixed(1)} px, heavy falls ${(balanced.y[2] - Y0).toFixed(1)} px; ` +
		`2x light rises ${(Y0 - lift.y[0]).toFixed(1)} px`,
);
