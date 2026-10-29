// What a packed passage does with and without lubrication. A bed of grains in a
// full pipe is held by an arch: positional contacts carry no weight, so the
// shaft above a bend stops instead of creeping through it. These runs measure
// the effect of `sim.lubricant` on a jogged chute, a long horizontal run and the
// quietness of a settled pile.
// Run: node experiments/packed-flow.cjs
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const N = G.N;
const SIDE = G.S;
const STEP = S.STEP;
const LUBES = [0, 0.5, 1, 2];

function blank(seed) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) valves.push(G.makeValve(i, j, "solid", [], 0, 0));
	}
	return { seed, valves };
}

// A vertical shaft, one elbow jog east, then a shaft to the bottom.
function jogLayout() {
	const layout = blank(7);
	const v = layout.valves;
	for (let j = 0; j < 5; j++) v[j * N + 4] = G.makeValve(4, j, "solid", [3, 1], 0, 0);
	v[5 * N + 4] = G.makeValve(4, 5, "solid", [3, 0], 0, 0);
	v[5 * N + 5] = G.makeValve(5, 5, "solid", [2, 1], 0, 0);
	for (let j = 6; j < N; j++) v[j * N + 5] = G.makeValve(5, j, "solid", [3, 1], 0, 0);
	return layout;
}

// The same, but the jog is a six-cell horizontal run: gravity gives a level pipe
// no thrust at all, so this needs the bed to be movable, not just unjammed.
function longLayout() {
	const layout = blank(7);
	const v = layout.valves;
	for (let j = 0; j <= 5; j++) v[j * N + 1] = G.makeValve(1, j, "solid", [3, 1], 0, 0);
	v[6 * N + 1] = G.makeValve(1, 6, "solid", [3, 0], 0, 0);
	for (let i = 2; i <= 7; i++) v[6 * N + i] = G.makeValve(i, 6, "solid", [0, 2], 0, 0);
	v[6 * N + 8] = G.makeValve(8, 6, "solid", [2, 1], 0, 0);
	for (let j = 7; j < N; j++) v[j * N + 8] = G.makeValve(8, j, "solid", [3, 1], 0, 0);
	return layout;
}

function chute(layout, column, seconds, perSecond, lubricant) {
	const sim = S.create(layout, { turning: false, lubricant });
	const every = Math.max(1, Math.round(120 / perSecond));
	const steps = Math.round(seconds / STEP);
	let first = -1;
	let poured = 0;
	for (let k = 0; k < steps; k++) {
		if (k % every === 0 && S.addGrain(sim, (column + 0.5) * SIDE, -20) >= 0) poured++;
		S.step(sim, STEP);
		if (first < 0 && sim.drained > 0) first = k * STEP;
	}
	return { first: first < 0 ? null : first, poured, drained: sim.drained, alive: sim.count };
}

// A settled pile in a goal chamber: the shake must not boil a resting bed or
// spill it out of its bottle.
function settledBottle(lubricant) {
	const sim = S.create(blank(7), { turning: false, lubricant });
	const idx = 5 * N + 5;
	S.installValve(sim, idx, G.typeById("hollow-single"), 3, G.RV * 0.53);
	const v = sim.layout.valves[idx];
	for (let k = 0; k < 120 * 6; k++) {
		if (k % 5 === 0) S.addGrain(sim, v.cx + (((k * 37) % 9) - 4) * 2.0, v.cy - 24);
		S.step(sim, STEP);
	}
	for (let k = 0; k < 120 * 6; k++) S.step(sim, STEP);
	let speed = 0;
	let n = 0;
	for (let k = 0; k < 120 * 4; k++) {
		S.step(sim, STEP);
		if (k % 10) continue;
		for (let g = 0; g < sim.count; g++) {
			speed += Math.hypot(sim.vx[g], sim.vy[g]);
			n++;
		}
	}
	let inside = 0;
	let outside = 0;
	for (let g = 0; g < sim.count; g++) {
		const dx = sim.x[g] - v.cx;
		const dy = sim.y[g] - v.cy;
		if (dx * dx + dy * dy < v.chamberR * v.chamberR) inside++;
		else outside++;
	}
	return { grains: sim.count, inside, outside, speed: speed / Math.max(1, n) };
}

function fmt(r) {
	const first = r.first === null ? "never" : r.first.toFixed(1) + "s";
	return `${first.padStart(6)} first  ${String(r.drained).padStart(4)}/${String(r.poured).padEnd(4)} drained`;
}

console.log("packed passages by lubricant (poured 12 s, simulated 60 s)");
for (const lub of LUBES) {
	const jog = chute(jogLayout(), 4, 12, 10, lub);
	const long = chute(longLayout(), 1, 60, 4, lub);
	console.log(`  lubricant ${String(lub).padEnd(4)} jog ${fmt(jog)}   long ${fmt(long)}`);
}

console.log("\nsettled goal bottle after a 6 s pour and 10 s of rest");
for (const lub of LUBES) {
	const p = settledBottle(lub);
	console.log(
		`  lubricant ${String(lub).padEnd(4)} ${String(p.grains).padStart(3)} grains` +
			`  chamber ${p.inside}  in the neck ${p.outside}  mean speed ${p.speed.toFixed(0)} px/s`,
	);
}
