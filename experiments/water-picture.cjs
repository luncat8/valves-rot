// Water picture: two panels written to logs/water-state-0.3.png so a colour or
// alpha change can be judged without a browser. Left is the seeded field mid-fill
// from the vent; right is a sealed pool with one grain of every material, so the
// float/sink result of slice 3 is visible in the same picture.
// The water sheet is painted by the page's own renderer through the shared
// water painter, so it is a colour preview of the real layer, not a copy of it
// (the render wiring itself is asserted in render-smoke.cjs).
// Run: node experiments/water-picture.cjs [seed] [seconds]
const path = require("node:path");
const { writePng } = require("./png-writer.cjs");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "prototype", "shared");
const G = require(path.join(SHARED, "geometry.js"));
const S = require(path.join(SHARED, "simulation.js"));
const W = require(path.join(SHARED, "water.js"));
const P = require("./water-paint.cjs");

const SEED = Number(process.argv[2]) || 7;
const SECONDS = Number(process.argv[3]) || 6;
const OUT = path.join(__dirname, "logs", "water-state-0.3.png");

function fieldSim() {
	const sim = S.create(G.createLayout(SEED));
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	S.seed(sim);
	W.setVent(w, 4, true);
	W.setSupply(w, 600);
	for (let k = 0; k < SECONDS * 120; k++) S.step(sim, S.STEP);
	return sim;
}

// A sealed two-cell pool: water stays in it, so it is the honest "does colour
// read as water" case and the only place a floating grain can come to rest.
function poolSim() {
	const N = G.N;
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const pool = j === 5 && (i === 4 || i === 5);
			valves.push(G.makeValve(i, j, pool ? "hollow" : "solid", pool ? [i === 4 ? 0 : 2] : [], 0, pool ? G.RV * 0.85 : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	const v = sim.layout.valves[5 * N + 4];
	w.vol[Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell)] = 1400;
	for (let c = 0; c < 6; c++) S.addGrain(sim, v.cx + (c - 2.5) * 8.4, v.cy - 12, 2.7, c);
	for (let c = 0; c < 6; c++) S.addGrain(sim, v.cx + (c - 2.5) * 8.4 + 4, v.cy - 3, 2.7, c);
	for (let k = 0; k < 12 * 120; k++) S.step(sim, S.STEP);
	return sim;
}

const field = fieldSim();
const pool = poolSim();
const chamber = pool.layout.valves[5 * G.N + 4];
writePng(
	OUT,
	[P.panel(field, { x0: 0, y0: -G.POUR, w: G.SIZE, h: G.SIZE + 2 * G.POUR }, 1), P.panel(pool, { x0: chamber.cx - 62, y0: chamber.cy - 42, w: 124, h: 84 }, 3)],
	{ background: 12 },
);
if (process.env.WATER_DEBUG) {
	for (let k = 0; k < pool.count; k++) {
		const f = W.submerged(pool.water, pool.x[k], pool.y[k], pool.r[k]);
		console.log(S.MATERIAL_NAMES[pool.color[k]].padEnd(14), "y", pool.y[k].toFixed(1), "vy", pool.vy[k].toFixed(1), "f", f.toFixed(2), "line", W.surfaceAt(pool.water, pool.x[k], pool.y[k]).toFixed(1));
	}
}
const fw = field.water;
const pw = pool.water;
console.log(
	`left  seed ${SEED} after ${SECONDS}s: stored ${W.storedVol(fw).toFixed(0)} px² in ${W.wetCount(fw)} cells, ` +
		`overflow ${fw.overflowed.toFixed(0)}, grains ${field.count}\n` +
		`right sealed pool at 3x: stored ${W.storedVol(pw).toFixed(0)} px², grains ${pool.count}, ` +
		`waterline ${W.surfaceAt(pw, chamber.cx, chamber.cy).toFixed(1)}\n` +
		`wrote ${path.relative(ROOT, OUT)}`,
);
