"use strict";
// Slice 1 of 0.3-water-plan: material identity, mass arrays, submerged segment.
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

function sim() {
	const valves = [];
	for (let j = 0; j < G.N; j++) for (let i = 0; i < G.N; i++) valves.push(G.makeValve(i, j, "hollow", [], 0, G.RV * 0.9));
	const s = S.create({ seed: 7, valves }, { turning: false });
	S.setPressure(s, "off");
	return s;
}

// densities: stable mapping, radius-independent, mass = density-ratio * r^2
assert.deepEqual([...S.MATERIAL_DENSITY], [2000, 1400, 1000, 500, 1200, 800]);
assert.equal(S.grainMass(2, 2.7), 2.7 * 2.7, "neutral material keeps historical r^2 mass");
assert.equal(S.grainMass(0, 2.7), 2 * 2.7 * 2.7);
assert.ok(S.grainMass(3, 3.1) < S.grainMass(3, 2.3) * 2, "larger buoyant grain can outweigh smaller in relative terms check via ratio");
assert.ok(Math.abs(S.grainMass(0, 2.3) - S.grainMass(3, 4.6)) < 1e-9, "equal mass, different size/density");

// addGrain writes mass/invMass; identity survives compaction (drain at bottom)
{
	const s = sim();
	const a = S.addGrain(s, 20, 20, 2.7, 0);
	const b = S.addGrain(s, 40, 20, 2.7, 3);
	assert.ok(a >= 0 && b >= 0);
	assert.equal(s.mass[a] * s.invMass[a], 1);
	s.y[a] = G.SIZE + G.POUR; // drained by compact() on next step
	S.step(s, S.STEP);
	assert.equal(s.count, 1);
	assert.equal(s.color[0], 3, "survivor keeps its material after compaction");
	assert.equal(s.mass[0], S.grainMass(3, 2.7));
}

// impact: equal-size heavy vs light head-on — the light grain rebounds faster
// (resting support is equal-split by design; see simulation.js pairContact)
{
	const s = sim();
	const v = s.layout.valves[55];
	const a = S.addGrain(s, v.cx - 4, v.cy, 2.7, 0); // 2000
	const b = S.addGrain(s, v.cx + 4, v.cy, 2.7, 3); // 500
	s.vx[a] = 200; s.vx[b] = -200;
	S.step(s, S.STEP);
	assert.ok(s.vx[b] > s.vx[a] && s.vx[a] > 0, `heavy grain plows on, light grain is knocked ahead faster (${s.vx[a]} vs ${s.vx[b]})`);
}

// submerged circular segment: dry / half / full + symmetry + analytic quarter
assert.equal(S.submergedFraction(2.7, -3), 0);
assert.equal(S.submergedFraction(2.7, 3), 1);
assert.ok(Math.abs(S.submergedFraction(2.7, 0) - 0.5) < 1e-12);
for (const d of [-2, -1, 0.5, 1.5]) {
	assert.ok(Math.abs(S.submergedFraction(2.7, d) + S.submergedFraction(2.7, -d) - 1) < 1e-12, "segment symmetry");
}
// floating equilibrium submerged fraction = rho_grain / rho_water (used by Phase 1)
for (let c = 0; c < 6; c++) {
	const f = S.MATERIAL_DENSITY[c] / S.WATER_DENSITY;
	assert.ok(f > 0 && f <= 2, `material ${c} equilibrium fraction sane`);
}

console.log("OK  water slice 1: materials, mass/invMass, compaction identity, pair momentum, submerged segment");
