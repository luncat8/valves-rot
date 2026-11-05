// Slice 4 of 0.3-water-plan: does water actually separate a mixed bed, and by
// how much? A fixed layout — a vent shaft over a three-wide, five-row basin —
// is filled to a measured volume, then a mixed bed of all six materials is
// dropped into its two bottom pockets. Buoyancy is given time to act and the
// outcome is counted per material: recovered fraction (light material in the
// upper half of the pool, dense material in the lower half), cross
// contamination, and the upper half's purity. The same bed also runs with water
// off, so the numbers cannot be explained by gravity alone.
//
// Run: node experiments/water-separation.cjs [--png]
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { writePng } = require("./png-writer.cjs");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

const N = G.N;
const RV = G.RV;
const AXIS = 4;
const FILL = 12000; // px² of slice area: a pool ~110 px deep, two chamber rows
const RATE = 4000; // px²/s: fast enough that the fill itself is not the demo
const SETTLE = 12; // seconds of buoyancy after the bed is placed
const ROWS = [7, 8]; // the two bottom chamber rows of the basin
const COLS = [3, 4, 5];
const OUT = path.join(__dirname, "logs", "water-separation-0.4.png");

// A vent shaft down to a three-wide, five-row basin. Row 9 stays solid: the
// bottom of the field is the floor of the basin, so the pool has one bottom and
// nothing leaks into the drain band.
function layout() {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const open = i === AXIS ? j <= 8 : i >= COLS[0] && i <= COLS[2] && j >= 4 && j <= 8;
			valves.push(G.makeValve(i, j, open ? "hollow" : "solid", open ? [0, 1, 2, 3] : [], 0, open ? RV * 0.9 : 0));
		}
	}
	const sim = S.create({ seed: 5, valves }, { turning: false });
	S.setPressure(sim, "off");
	return sim;
}

// Fill by delivered volume, not by time: the vent rate and the layout are fixed,
// so the volume is the reproducible control and the level follows from it.
function fill(sim, target) {
	const w = S.setWater(sim, true);
	W.setVent(w, AXIS, true);
	W.setSupply(w, RATE);
	for (let k = 0; k < 120 * 30 && W.storedVol(w) < target; k++) S.step(sim, S.STEP);
	W.setVent(w, AXIS, false);
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
	return w;
}

// Twelve positions inside a chamber: two rings, far enough apart that no grain
// starts inside another and well inside the chamber wall.
const SLOTS = [];
for (let k = 0; k < 12; k++) {
	const ring = k < 6 ? 8 : 15;
	const a = (k % 6) * (Math.PI / 3) + (k < 6 ? 0 : Math.PI / 6);
	SLOTS.push([Math.cos(a) * ring, Math.sin(a) * ring]);
}

// Two grains of every material in each bottom pocket, rotated per pocket so no
// material consistently starts higher than another.
function bed(sim) {
	const start = [];
	let pocket = 0;
	for (const j of ROWS) {
		for (const i of COLS) {
			const v = sim.layout.valves[j * N + i];
			for (let n = 0; n < SLOTS.length; n++) {
				const color = (n + pocket) % S.MATERIAL_DENSITY.length;
				const k = S.addGrain(sim, v.cx + SLOTS[n][0], v.cy + SLOTS[n][1], S.R_GRAIN, color);
				assert.ok(k >= 0, `the bed fits in pocket ${i},${j}`);
				start.push(sim.y[k]);
			}
			pocket++;
		}
	}
	return start;
}

// The pool's own geometry: the waterline over the bed and the floor under it.
// Both come from the solver's published levels, so no display change can move
// the bands the counts use. Recomputed per sample because the bed's own
// displacement lifts the level a little.
function poolBounds(w) {
	let line = Infinity;
	let floor = -Infinity;
	for (let k = 0; k < w.count; k++) {
		if (w.vol[k] <= 1e-3) continue;
		const y = ((k / w.nx) | 0) * w.cell - G.POUR;
		if (y + w.cell > floor) floor = y + w.cell;
		const lvl = w.levelUp[k];
		if (Number.isFinite(lvl) && lvl < line) line = lvl;
	}
	return { line, floor, depth: floor - line };
}

const EMPTY = () => ({ count: 0, upper: 0, high: 0, mid: 0, low: 0, float: 0, rise: 0, f: 0 });

// Count each material into the upper and lower halves of the pool, and into the
// high/middle/low thirds for diagnosis. Halves are the metric: a pile of dense
// grains stands two or three deep on the floor, and the top of that pile is
// taller than a third of a shallow pool, which would score a correct sink as a
// miss. A grain is the material its palette index names, never its pixels.
function census(sim, bounds, start) {
	const { line, depth } = bounds;
	const mid = line + depth * 0.5;
	const top = line + depth * 0.35;
	const bottom = line + depth * 0.65;
	const rows = S.MATERIAL_DENSITY.map(EMPTY);
	for (let k = 0; k < sim.count; k++) {
		const row = rows[S.materialIndex(sim.color[k])];
		const y = sim.y[k];
		row.count++;
		row.rise += start[k] - y; // positive = ended above where it started
		if (y < mid) row.upper++;
		if (y < top) row.high++;
		else if (y > bottom) row.low++;
		else row.mid++;
		if (!sim.water.enabled) continue;
		const f = W.submerged(sim.water, sim.x[k], y, sim.r[k]);
		if (f > 0 && f < 0.98) row.float++;
		row.f += f;
	}
	return rows;
}

// Recovered fraction per group, and how much of each region is the wrong group.
// Neutral material is in neither group: it is weightless in water, so it cannot
// be expected to reach a region and scoring it as a failure would be a
// threshold invented against physics.
function score(rows) {
	let lightN = 0;
	let lightUp = 0;
	let denseN = 0;
	let denseDown = 0;
	let upN = 0;
	let upLight = 0;
	for (let m = 0; m < rows.length; m++) {
		const r = rows[m];
		const rho = S.MATERIAL_DENSITY[m];
		if (rho === S.WATER_DENSITY) continue;
		upN += r.upper;
		if (rho < S.WATER_DENSITY) {
			lightN += r.count;
			lightUp += r.upper;
			upLight += r.upper;
		} else {
			denseN += r.count;
			denseDown += r.count - r.upper;
		}
	}
	const wanted = lightN + denseN;
	const recovered = lightUp + denseDown;
	return {
		floatRecovery: lightN ? lightUp / lightN : 1,
		sinkRecovery: denseN ? denseDown / denseN : 1,
		recovered: wanted ? recovered / wanted : 1,
		contamination: wanted ? 1 - recovered / wanted : 0,
		purity: upN ? upLight / upN : NaN,
	};
}

function measure(sim, start, fixed) {
	const bounds = fixed || poolBounds(sim.water);
	const rows = census(sim, bounds, start);
	return { bounds, rows, score: score(rows) };
}

// The dry baseline fills the same pool, takes its geometry, and then switches
// water off, so the two runs differ only in the force: same layout, same bed,
// same bands. `fixed` keeps the bands of a run whose water is gone.
function run(withWater, fixed) {
	const sim = layout();
	fill(sim, FILL);
	const bounds = fixed || poolBounds(sim.water);
	if (!withWater) S.setWater(sim, false);
	const start = bed(sim);
	const curve = [];
	for (let t = 0; t < SETTLE; t++) {
		for (let k = 0; k < 120; k++) S.step(sim, S.STEP);
		curve.push(measure(sim, start, fixed));
	}
	const final = measure(sim, start, fixed);
	return { sim, start, curve, final, bounds, placed: start.length };
}

function report(tag, result) {
	const { bounds, rows, score: s } = result.final;
	const sim = result.sim;
	console.log(
		`\n${tag}: pool ${bounds.depth.toFixed(0)} px deep (waterline ${bounds.line.toFixed(0)}, floor ${bounds.floor.toFixed(0)}), ` +
			`${W.storedVol(sim.water).toFixed(0)} px² in ${W.wetCount(sim.water)} cells, ${sim.count} grains after ${SETTLE} s`,
	);
	console.log("  material        rho   n  high  mid  low  upper  rising  mean-f  mean-rise");
	for (let m = 0; m < rows.length; m++) {
		const r = rows[m];
		console.log(
			"  " +
				S.MATERIAL_NAMES[m].padEnd(14) +
				String(S.MATERIAL_DENSITY[m]).padStart(5) +
				String(r.count).padStart(4) +
				String(r.high).padStart(6) +
				String(r.mid).padStart(5) +
				String(r.low).padStart(5) +
				String(r.upper).padStart(7) +
				String(r.float).padStart(8) +
				(sim.water.enabled ? (r.f / r.count).toFixed(2) : "   -").padStart(8) +
				(r.rise / r.count).toFixed(0).padStart(11),
		);
	}
	console.log(
		`  float recovery ${(s.floatRecovery * 100).toFixed(0)}% · sink recovery ${(s.sinkRecovery * 100).toFixed(0)}%` +
			` · recovered ${(s.recovered * 100).toFixed(0)}% · contamination ${(s.contamination * 100).toFixed(0)}%` +
			(Number.isFinite(s.purity) ? ` · upper-half purity ${(s.purity * 100).toFixed(0)}%` : ""),
	);
	const curve = result.curve.map((c, t) => `${t + 1}s ${(c.score.recovered * 100).toFixed(0)}%`).join(" ");
	console.log(`  recovered over time: ${curve}`);
}

// ---- picture -------------------------------------------------------------
// Two panels of the basin, before the bed and after it settles: the mixed bed
// and the stratified one, drawn with the page's water alpha ramp.
const GRAIN_RGB = S.GRAIN_COLORS.map(hex => [1, 3, 5].map(o => parseInt(hex.slice(o, o + 2), 16)));
const WATER_RGB = [30, 112, 210];

function mix(px, o, rgb, a) {
	px[o] += (rgb[0] - px[o]) * a;
	px[o + 1] += (rgb[1] - px[o + 1]) * a;
	px[o + 2] += (rgb[2] - px[o + 2]) * a;
}

function panel(sim, view, scale) {
	const wdt = Math.round(view.w * scale);
	const hgt = Math.round(view.h * scale);
	const px = Buffer.alloc(wdt * hgt * 3);
	for (let i = 0; i < px.length; i += 3) {
		px[i] = 18;
		px[i + 1] = 22;
		px[i + 2] = 29;
	}
	for (let y = 0; y < hgt; y++) {
		const wy = view.y0 + (y + 0.5) / scale;
		for (let x = 0; x < wdt; x++) {
			const wx = view.x0 + (x + 0.5) / scale;
			const clear = G.airClearance(sim.layout, wx, wy);
			const o = (y * wdt + x) * 3;
			if (clear >= S.R_GRAIN) {
				px[o] = 236;
				px[o + 1] = 240;
				px[o + 2] = 244;
			} else if (clear > 0) {
				px[o] = 118;
				px[o + 1] = 128;
				px[o + 2] = 140;
			}
			const level = sim.water.enabled ? W.surfaceAt(sim.water, wx, wy) : Infinity;
			const depth = wy - level;
			if (!(depth > 0)) continue;
			let t = depth / 6;
			if (t > 1) t = 1;
			mix(px, o, WATER_RGB, 0.58 + 0.42 * t);
		}
	}
	for (let k = 0; k < sim.count; k++) {
		const cx = (sim.x[k] - view.x0) * scale;
		const cy = (sim.y[k] - view.y0) * scale;
		const rad = sim.r[k] * scale;
		const col = GRAIN_RGB[sim.color[k]];
		for (let dy = -Math.ceil(rad); dy <= rad; dy++) {
			for (let dx = -Math.ceil(rad); dx <= rad; dx++) {
				const d2 = dx * dx + dy * dy;
				if (d2 > rad * rad) continue;
				const x = Math.round(cx + dx);
				const y = Math.round(cy + dy);
				if (x < 0 || x >= wdt || y < 0 || y >= hgt) continue;
				const o = (y * wdt + x) * 3;
				if (d2 > (rad - 1) * (rad - 1)) mix(px, o, [21, 25, 31], 0.65);
				else mix(px, o, col, 1);
			}
		}
	}
	return { rgb: px, w: wdt, h: hgt };
}

const wet = run(true, null);
const dry = run(false, wet.bounds);
report("water on", wet);
report("water off (baseline)", dry);

// ---- one float, no crowd ------------------------------------------------
// The density-ratio equilibrium is a property of one grain, not of a raft: with
// 24 floats in one chamber the top of the raft is pushed out of the water, which
// is why the crowded run reports a mean submerged fraction below the ratio.
{
	const sim = layout();
	fill(sim, FILL);
	// One per pocket: side by side they would push each other out of the water.
	const left = sim.layout.valves[7 * N + COLS[0]];
	const right = sim.layout.valves[7 * N + COLS[2]];
	const blue = S.addGrain(sim, left.cx, left.cy + 10, S.R_GRAIN, 3);
	const green = S.addGrain(sim, right.cx, right.cy + 10, S.R_GRAIN, 5);
	for (let k = 0; k < SETTLE * 120; k++) S.step(sim, S.STEP);
	const fb = W.submerged(sim.water, sim.x[blue], sim.y[blue], sim.r[blue]);
	const fg = W.submerged(sim.water, sim.x[green], sim.y[green], sim.r[green]);
	console.log(`\none float each: blue submerged ${fb.toFixed(2)} (density ratio 0.50), green ${fg.toFixed(2)} (0.80)`);
	assert.ok(Math.abs(fb - 0.5) < 0.1, `a lone blue grain floats half submerged (${fb.toFixed(2)})`);
	assert.ok(Math.abs(fg - 0.8) < 0.1, `a lone green grain floats four fifths submerged (${fg.toFixed(2)})`);
	assert.ok(fb < fg, "the lighter material floats higher");
}

// ---- assertions ----------------------------------------------------------
// Conservation first: separation that loses grains or water is not a result.
assert.equal(wet.sim.count, wet.placed, "no grain is lost while separating");
assert.equal(dry.sim.count, dry.placed, "no grain is lost in the dry baseline");
const stored = W.storedVol(wet.sim.water);
assert.ok(Math.abs(stored - FILL) < FILL * 0.02, `the pool holds the fill it was given (${stored.toFixed(0)} / ${FILL})`);
assert.ok(wet.final.bounds.depth > 100, `the pool is deep enough to separate (${wet.final.bounds.depth.toFixed(0)} px)`);

// Buoyancy did the separating, and it separated by density.
assert.ok(wet.final.score.floatRecovery >= 0.95, `light grains reach the upper half (${(wet.final.score.floatRecovery * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.sinkRecovery >= 0.95, `dense grains reach the lower half (${(wet.final.score.sinkRecovery * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.contamination <= 0.05, `cross contamination stays low (${(wet.final.score.contamination * 100).toFixed(0)}%)`);
assert.ok(wet.final.score.purity >= 0.95, `the upper half is light material (${(wet.final.score.purity * 100).toFixed(0)}%)`);
assert.ok(dry.final.score.floatRecovery <= 0.2, `without water the light grains stay down (${(dry.final.score.floatRecovery * 100).toFixed(0)}%)`);
assert.ok(wet.final.rows[3].upper === wet.final.rows[3].count, "every buoyant blue grain ends above the midline");
assert.ok(wet.final.rows[0].upper === 0, "no dense red grain ends above the midline");
// The bed must be mostly separated within a few seconds, or the scenario is a
// demo of patience rather than of buoyancy.
const fast = wet.curve.findIndex(c => c.score.recovered >= 0.9);
assert.ok(fast >= 0 && fast < 10, `the bed separates within ${fast + 1} s`);

const VIEW = { x0: COLS[0] * G.S - 30, y0: 3 * G.S - G.POUR, w: 3 * G.S + 60, h: 7 * G.S };
const before = layout();
fill(before, FILL);
bed(before);
writePng(OUT, [panel(before, VIEW, 1), panel(wet.sim, VIEW, 1)], { background: 12 });
console.log(`\nwrote ${path.relative(path.join(__dirname, ".."), OUT)}`);
console.log("OK  water slice 4: a mixed bed separates by density, measured per material");
