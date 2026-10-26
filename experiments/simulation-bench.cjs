// Load and allocation measurements for the grain solver.
// Run: node experiments/simulation-bench.cjs > experiments/logs/simulation-0.1.1.txt
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const STEP = S.STEP;
const LOADS = [120, 500, 1000];
const SEED = 11;

// Grains on a jittered lattice over the whole field. This is a load test, not a
// physical state: overlaps are allowed so a thousand grains fit.
function fill(sim, want) {
	const seed = sim.layout.seed | 0;
	let placed = 0;
	for (let y = -20; y < G.SIZE && placed < want; y += 5.2) {
		for (let x = 3; x < G.SIZE && placed < want; x += 5.2) {
			const jx = (G.hashUnit(seed, x | 0, y | 0) - 0.5) * 1.6;
			const jy = (G.hashUnit(seed, y | 0, x | 0) - 0.5) * 1.6;
			const rad = 1.85 + G.hashUnit(seed, x | 0, y | 0 + 77) * 0.3;
			if (S.addGrain(sim, x + jx, y + jy, rad) >= 0) placed++;
		}
	}
	return placed;
}

function measure(n, turning) {
	const sim = S.create(G.createLayout(SEED), { turning });
	fill(sim, n);
	const before = process.memoryUsage().heapUsed;
	const t0 = process.hrtime.bigint();
	const steps = 120 * 5;
	for (let k = 0; k < steps; k++) S.step(sim, STEP);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const heap = (process.memoryUsage().heapUsed - before) / 1024;
	return { n: sim.count, turning, ms, per: ms / steps, heap, overlap: sim.maxOverlap, pen: sim.maxPen, rec: sim.recovered };
}

// Retained heap across a long run, with a collection on both ends when the
// caller runs node with --expose-gc, so the number is growth rather than noise.
function retained() {
	if (!global.gc) return NaN;
	const sim = S.create(G.createLayout(SEED));
	S.seed(sim);
	for (let k = 0; k < 120 * 5; k++) S.step(sim, STEP);
	global.gc();
	const a = process.memoryUsage().heapUsed;
	for (let k = 0; k < 120 * 10; k++) S.step(sim, STEP);
	global.gc();
	return (process.memoryUsage().heapUsed - a) / 1024;
}

function longRun() {
	const sim = S.create(G.createLayout(SEED));
	S.seed(sim);
	const steps = 120 * 60;
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < steps; k++) S.step(sim, STEP);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return {
		ms,
		per: ms / steps,
		active: sim.count,
		drained: sim.drained,
		recovered: sim.recovered,
		pushed: sim.pushed,
		stalls: sim.stalls,
		overlap: sim.maxOverlap,
		pen: sim.maxPen,
		push: sim.maxPush,
	};
}

const lines = [];
lines.push(`# Conservative simulation, Node ${process.version}, ${process.platform} ${process.arch}`);
lines.push(`# grain solver: ${S.ITERATIONS} iterations, bin ${S.BIN}, step ${STEP.toFixed(5)} s, capacity ${S.CAPACITY}`);
lines.push("");
lines.push("load  turning  grains   ms/frame(5s)    us/step   overlap  wallPen  recovered");
for (const n of LOADS) {
	for (const turning of [false, true]) {
		const r = measure(n, turning);
		lines.push(
			`${String(n).padStart(4)}  ${String(turning).padStart(7)}  ${String(r.n).padStart(6)}  ${r.ms.toFixed(1).padStart(12)}  ${(r.per * 1000).toFixed(1).padStart(9)}  ${r.overlap.toFixed(2).padStart(7)}  ${r.pen.toFixed(3).padStart(7)}  ${String(r.rec).padStart(9)}`,
		);
	}
}
lines.push("");
const long = longRun();
lines.push("60 s seeded run, seed 11:");
lines.push(`  ${long.per.toFixed(2)} ms/step, ${long.active} active, ${long.drained} drained, ${long.recovered} recovered, ${long.pushed} wall pushes, ${long.stalls} stalls`);
lines.push(`  worst overlap ${long.overlap.toFixed(2)} px, worst wall penetration ${long.pen.toFixed(3)} px, longest recovery ${long.push.toFixed(2)} px`);
lines.push("");
lines.push("30 s seeded machine, per layout seed (pour slots come from the drain-reachable set):");
lines.push("  seed  seeded  active  drained  recovered  pushes  overlap  wallPen");
for (const seed of [7, 11, 1234, 3, 42]) {
	const m = S.create(G.createLayout(seed));
	const seeded = S.seed(m);
	for (let k = 0; k < 120 * 30; k++) S.step(m, STEP);
	lines.push(
		`  ${String(seed).padStart(4)}  ${String(seeded).padStart(6)}  ${String(m.count).padStart(6)}  ${String(m.drained).padStart(7)}  ${String(m.recovered).padStart(9)}  ${String(m.pushed).padStart(6)}  ${m.maxOverlap.toFixed(2).padStart(7)}  ${m.maxPen.toFixed(3).padStart(7)}`,
	);
}
lines.push("");
const growth = retained();
lines.push(`allocation: ${Number.isNaN(growth) ? "run with --expose-gc for the retained-heap figure" : growth.toFixed(1) + " KB retained over 1200 steps after a warm-up and two collections"}`);
lines.push("");
console.log(lines.join("\n"));
