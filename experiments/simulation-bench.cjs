// Load, render-batch and allocation measurements for the grain solver.
// Run: node --expose-gc experiments/simulation-bench.cjs > experiments/logs/simulation-0.1.1.txt
const os = require("node:os");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const STEP = S.STEP;
const LOADS = [120, 500, 1000];
const SEED = 11;

function fill(sim, want) {
	const seed = sim.layout.seed | 0;
	let placed = 0;
	for (let y = -20; y < G.SIZE && placed < want; y += 5.2) {
		for (let x = 3; x < G.SIZE && placed < want; x += 5.2) {
			const jx = (G.hashUnit(seed, x | 0, y | 0) - 0.5) * 1.6;
			const jy = (G.hashUnit(seed, y | 0, x | 0) - 0.5) * 1.6;
			const rad = 1.85 + G.hashUnit(seed, x | 0, (y | 0) + 77) * 0.3;
			if (S.addGrain(sim, x + jx, y + jy, rad) >= 0) placed++;
		}
	}
	return placed;
}

function measure(n, turning) {
	const sim = S.create(G.createLayout(SEED), { turning });
	fill(sim, n);
	const t0 = process.hrtime.bigint();
	const steps = 120 * 5;
	for (let k = 0; k < steps; k++) S.step(sim, STEP);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const usStep = (ms / steps) * 1000;
	return {
		n: sim.count,
		turning,
		ms60Hz: (ms / steps) * 2,
		usStep,
		overlap: sim.maxOverlap,
		pen: sim.maxPen,
		rec: sim.recovered,
	};
}

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
	const seeded = S.seed(sim);
	const steps = 120 * 60;
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < steps; k++) S.step(sim, STEP);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	return {
		seeded,
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

const cpu = (os.cpus()[0] && os.cpus()[0].model) || "unknown cpu";
const lines = [];
lines.push(`simulation layer 0.1.1`);
lines.push(`node ${process.version} ${process.platform}/${process.arch} ${cpu} (${os.cpus().length} cpus)`);
lines.push(`solver: ${S.ITERATIONS} iter, bin ${S.BIN}, step ${STEP.toFixed(5)} s, cap ${S.CAPACITY}`);
lines.push("");
lines.push("load  turning  active  ms/60Hz  us/step  maxOverlap  maxWallPen  recovered");
for (const n of LOADS) {
	for (const turning of [false, true]) {
		const r = measure(n, turning);
		lines.push(
			`${String(n).padStart(4)}  ${String(turning).padStart(7)}  ${String(r.n).padStart(6)}  ${r.ms60Hz.toFixed(2).padStart(7)}  ${r.usStep.toFixed(1).padStart(7)}  ${r.overlap.toFixed(2).padStart(10)}  ${r.pen.toFixed(3).padStart(10)}  ${String(r.rec).padStart(9)}`,
		);
	}
}
lines.push("");
const long = longRun();
lines.push(`60s seeded run (seed 11): ${long.per.toFixed(2)} ms/step, seeded ${long.seeded}, active ${long.active}, drained ${long.drained}, rec ${long.recovered}, pushes ${long.pushed}, stalls ${long.stalls}, maxOv ${long.overlap.toFixed(2)}, maxPen ${long.pen.toFixed(3)}, maxPush ${long.push.toFixed(2)}`);
lines.push("");
lines.push("30s seeded runs:");
lines.push("seed  seeded  active  drained  rec  pushes  maxOverlap  maxWallPen");
for (const seed of [7, 11, 1234, 3, 12, 42]) {
	const m = S.create(G.createLayout(seed));
	const seeded = S.seed(m);
	for (let k = 0; k < 120 * 30; k++) S.step(m, STEP);
	lines.push(
		`${String(seed).padStart(4)}  ${String(seeded).padStart(6)}  ${String(m.count).padStart(6)}  ${String(m.drained).padStart(7)}  ${String(m.recovered).padStart(3)}  ${String(m.pushed).padStart(6)}  ${m.maxOverlap.toFixed(2).padStart(10)}  ${m.maxPen.toFixed(3).padStart(10)}`,
	);
}
lines.push("");
const growth = retained();
lines.push(`retainedHeap(1200 steps): ${Number.isNaN(growth) ? "n/a" : growth.toFixed(1) + " KB"}`);
console.log(lines.join("\n"));
