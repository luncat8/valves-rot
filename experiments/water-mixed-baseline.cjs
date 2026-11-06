"use strict";
// Golden digest of the ALL-MIXABLE solver, recorded on the commit before
// separated phases existed. Separated phases must not change the case where
// every colour is mixable: that case is the single-liquid solver, and its
// numbers are the reference every later change is measured against.
//
// Run: node experiments/water-mixed-baseline.cjs          compare with GOLDEN
//      node experiments/water-mixed-baseline.cjs --record  print a new GOLDEN
//
// The digest is geometry-free: total held area, per-channel totals, wet cell
// count, a distribution checksum, the published surface at one column and the
// end state of three submerged grains of different density.
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

const N = G.N;
const RV = G.RV;
const STEPS = 240;

// Recorded on 0.3 slice 1 (all mixable, single phase).
const GOLDEN = {
	held: 800,
	ch: [266.666666667, 266.666666667, 266.666666667],
	wet: 119,
	checksum: 10128203.860030483,
	surface: 613.900106893,
	grains: [322.940836027, 633.061384467, 327.172345017, 630.783666312, 330.469145725, 613.537610522],
};

function field() {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			let kind = "solid";
			let ports = [];
			let r = 0;
			if (i === 4 && j <= 7) { kind = "hollow"; ports = [3, 1]; r = RV * 0.5; }
			if (i === 4 && j === 8) { kind = "hollow"; ports = [3]; r = RV * 0.75; }
			if (i === 5 && j === 8) { kind = "hollow"; ports = [2]; r = RV * 0.55; }
			valves.push(G.makeValve(i, j, kind, ports, 0, r));
		}
	}
	return { seed: 3, valves };
}

const vals = new Float64Array(3);

function digest() {
	const sim = S.create(field(), { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	W.setVent(w, 4, true);
	W.setSupply(w, 400);
	W.setPour(w, [1, 1, 1]);
	// Three grains of different density, all denser than the pool floor level.
	const cx = sim.layout.valves[5 * N + 4].cx;
	const cy = sim.layout.valves[8 * N + 4].cy;
	for (let n = 0; n < 3; n++) S.addGrain(sim, cx - 2 + n * 2, cy + 4, 2.4, n === 0 ? 0 : n === 1 ? 2 : 3);
	for (let k = 0; k < STEPS; k++) S.step(sim, S.STEP);
	W.channelTotals(w, vals);
	let wet = 0;
	let checksum = 0;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] > 1e-6) wet++;
		checksum += w.vol[i] * (i + 1);
	}
	const out = {
		held: W.storedVol(w),
		ch: [vals[0], vals[1], vals[2]],
		wet,
		checksum,
		surface: W.surfaceAt(w, cx, cy),
		grains: [],
	};
	for (let k = 0; k < 3; k++) out.grains.push(sim.x[k], sim.y[k]);
	return out;
}

const got = digest();
const fmt = v => (Number.isFinite(v) ? v.toFixed(9) : String(v));
if (process.argv.includes("--record")) {
	console.log("const GOLDEN = {");
	console.log(`\theld: ${fmt(got.held)},`);
	console.log(`\tch: [${got.ch.map(fmt).join(", ")}],`);
	console.log(`\twet: ${got.wet},`);
	console.log(`\tchecksum: ${fmt(got.checksum)},`);
	console.log(`\tsurface: ${fmt(got.surface)},`);
	console.log(`\tgrains: [${got.grains.map(fmt).join(", ")}],`);
	console.log("};");
	process.exit(0);
}

const TOL = 1e-9;
const near = (a, b, what) => {
	const scale = Math.max(1, Math.abs(a), Math.abs(b));
	assert.ok(Math.abs(a - b) <= TOL * scale, `${what}: ${fmt(a)} vs golden ${fmt(b)}`);
};
near(got.held, GOLDEN.held, "held");
for (let k = 0; k < 3; k++) near(got.ch[k], GOLDEN.ch[k], "channel " + "RGB"[k]);
assert.equal(got.wet, GOLDEN.wet, `wet cells: ${got.wet} vs golden ${GOLDEN.wet}`);
near(got.checksum, GOLDEN.checksum, "distribution checksum");
near(got.surface, GOLDEN.surface, "surface");
for (let n = 0; n < 6; n++) near(got.grains[n], GOLDEN.grains[n], "grain " + n);
console.log(`ok  all-mixable baseline: held ${fmt(got.held)} px² in ${got.wet} cells, checksum ${fmt(got.checksum)}, surface ${fmt(got.surface)}`);
console.log(`    grains ${got.grains.map(fmt).join(", ")}`);
console.log("OK  mixed solver matches the pre-phase reference");
