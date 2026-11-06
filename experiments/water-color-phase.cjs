"use strict";
// Slice 2 of 0.3-water-color-plan: separated phases. Unchecked mixability boxes
// part the channels into phases (R 2000, G 1000, B 500 kg/m³) that settle into
// layers, buoy grains by layer, and paint as bands; the all-mixable regression
// gate lives in water-mixed-baseline.cjs, not here.
// Run: node experiments/water-color-phase.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const R = require("../prototype/shared/render.js");

const N = G.N;
const RV = G.RV;

// A field of blank plugs with only the listed cells opened. Specs keyed "i,j"
// hold [kind, ports, chamberR].
function field(spec) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const e = spec[i + "," + j];
			valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
		}
	}
	return { seed: 3, valves };
}
function valve(layout, i, j) { return layout.valves[j * N + i]; }

function makeSim(spec) {
	const sim = S.create(field(spec), { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	return { sim, w };
}

function cellAt(w, x, y) {
	return Math.floor((y + G.POUR) / w.cell) * w.nx + Math.floor(x / w.cell);
}

function slug(w, sim, i, j, area, shares) {
	const v = valve(sim.layout, i, j);
	W.setLiquid(w, cellAt(w, v.cx, v.cy), area, shares);
}

function tube() {
	const spec = {};
	for (let j = 3; j <= 8; j++) spec["4," + j] = ["hollow", [0, 1, 2, 3], RV * 0.9];
	return makeSim(spec);
}

function basin() {
	const spec = {};
	for (let j = 4; j <= 8; j++) for (let i = 3; i <= 5; i++) spec[i + "," + j] = ["hollow", [0, 1, 2, 3], RV * 0.9];
	return makeSim(spec);
}

// Depth centroid per channel (NaN where the channel is absent).
function coms(w) {
	const m = [0, 0, 0];
	const t = [0, 0, 0];
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 0) continue;
		const y = (((i / w.nx) | 0) + 0.5) * w.cell - G.POUR;
		for (let k = 0; k < 3; k++) { m[k] += w.ch[i * 3 + k] * y; t[k] += w.ch[i * 3 + k]; }
	}
	return m.map((v, k) => (t[k] > 0 ? v / t[k] : NaN));
}

const pvU = new Float64Array(3);
const pvD = new Float64Array(3);

// Heavy-over-light area across open vertical faces: for every phase pair with
// rho_p > rho_q, the upper cell's p over the lower cell's q. A settled column
// reads zero; perched pools and sharp interfaces do too, because the metric is
// local and a one-cell interface never stacks heavy over light.
function inversion(w) {
	let inv = 0;
	for (let k = 0; k < w.airCount; k++) {
		const u = w.airList[k];
		if (!w.openS[u]) continue;
		const d = u + w.nx;
		if (w.vol[u] <= 1e-12 || w.vol[d] <= 1e-12) continue;
		W.phaseVols(w, u, pvU);
		W.phaseVols(w, d, pvD);
		for (let a = 0; a < w.phaseCount; a++) {
			if (pvU[a] <= 1e-12) continue;
			for (let b = 0; b < w.phaseCount; b++) {
				if (w.phaseRho[a] > w.phaseRho[b] && pvD[b] > 1e-12) inv += Math.min(pvU[a], pvD[b]);
			}
		}
	}
	return inv;
}

const stored = new Float64Array(3);

// Per-channel ledger: initial + admitted equals stored + overflowed + drained,
// and the cached cell totals still sum their channels.
function books(w, tag) {
	W.channelTotals(w, stored);
	const held = stored[0] + stored[1] + stored[2];
	for (let k = 0; k < 3; k++) {
		const lhs = w.chInitial[k] + w.chAdmitted[k];
		const rhs = stored[k] + w.chOverflowed[k] + w.chDrained[k];
		const tol = 1e-9 * Math.max(1, Math.abs(lhs), Math.abs(rhs));
		assert.ok(Math.abs(lhs - rhs) <= tol,
			`${tag}: channel ${"RGB"[k]} closes (${lhs.toFixed(6)} vs ${rhs.toFixed(6)})`);
		assert.ok(Number.isFinite(stored[k]) && stored[k] >= 0, `${tag}: channel ${k} is finite and nonnegative`);
	}
	const r = W.residual(w);
	assert.ok(Number.isFinite(r) && r <= 1e-9 * Math.max(1, held),
		`${tag}: vol cache matches the channels (residual ${r.toExponential(2)} for ${held.toFixed(1)} px²)`);
	return held;
}

// ---------------------------------------------------------------------------
// 1. A fully inverted stack settles red below green below blue in the tube.
{
	const { sim, w } = tube();
	W.setMixable(w, [0, 0, 0]);
	slug(w, sim, 4, 3, 1500, [1, 0, 0]);
	slug(w, sim, 4, 5, 1500, [0, 1, 0]);
	slug(w, sim, 4, 7, 1500, [0, 0, 1]);
	for (let k = 0; k < 120 * 5; k++) S.step(sim, S.STEP);
	const [r, g, b] = coms(w);
	const inv = inversion(w);
	assert.ok(r > g && g > b, `red settles deepest (${r.toFixed(1)} > ${g.toFixed(1)} > ${b.toFixed(1)})`);
	assert.ok(inv < 1e-3, `no heavy-over-light face survives (inversion ${inv.toExponential(2)} px²)`);
	books(w, "tube settling");
	console.log(`ok  inverted stack settles R/G/B to ${r.toFixed(0)}/${g.toFixed(0)}/${b.toFixed(0)} px depth in 5 s, inversion ${inv.toExponential(1)}`);
}

// 2. The wide basin settles too, and stays settled: lateral ordering trades
//    heavy for light without oscillating around equality.
{
	const { sim, w } = basin();
	W.setMixable(w, [0, 0, 0]);
	slug(w, sim, 3, 4, 1500, [1, 0, 0]); slug(w, sim, 5, 4, 1500, [1, 0, 0]);
	slug(w, sim, 3, 6, 1500, [0, 1, 0]); slug(w, sim, 5, 6, 1500, [0, 1, 0]);
	slug(w, sim, 3, 8, 1500, [0, 0, 1]); slug(w, sim, 5, 8, 1500, [0, 0, 1]);
	for (let k = 0; k < 120 * 10; k++) S.step(sim, S.STEP);
	const at = coms(w);
	const inv = inversion(w);
	assert.ok(at[0] > at[1] && at[1] > at[2],
		`the basin orders red below green below blue (${at.map(v => v.toFixed(1)).join(" > ")})`);
	assert.ok(inv < 1e-3, `no heavy-over-light face survives (inversion ${inv.toExponential(2)} px²)`);
	for (let k = 0; k < 120 * 5; k++) S.step(sim, S.STEP);
	const late = coms(w);
	for (let k = 0; k < 3; k++) {
		assert.ok(Math.abs(late[k] - at[k]) < 1e-3, `layer ${k} holds its depth (drift ${(late[k] - at[k]).toExponential(1)})`);
	}
	assert.ok(inversion(w) < 1e-3, "another 5 s adds no inversion");
	books(w, "basin settling");
	for (let i = 0; i < w.ch.length; i++) {
		assert.ok(Number.isFinite(w.ch[i]) && w.ch[i] >= 0, `cell channel ${i} is finite and nonnegative`);
	}
	console.log(`ok  wide basin settles in 10 s and holds (drift < 1e-3 px over 5 s more)`);
}

// 3. A light layer poured under a heavy one reaches the top.
{
	const { sim, w } = tube();
	W.setMixable(w, [0, 0, 0]);
	slug(w, sim, 4, 7, 1500, [0, 0, 1]);
	slug(w, sim, 4, 4, 1500, [1, 0, 0]);
	for (let k = 0; k < 120 * 5; k++) S.step(sim, S.STEP);
	const [r, , b] = coms(w);
	let ymin = Infinity;
	let ymax = -Infinity;
	for (let i = 0; i < w.count; i++) {
		if (w.vol[i] <= 0.01) continue;
		const y = (((i / w.nx) | 0) + 0.5) * w.cell - G.POUR;
		if (y < ymin) ymin = y;
		if (y > ymax) ymax = y;
	}
	const mid = (ymin + ymax) / 2;
	assert.ok(b < mid && mid < r, `blue ends in the top half, red in the bottom half (${b.toFixed(1)} < ${mid.toFixed(1)} < ${r.toFixed(1)})`);
	assert.ok(inversion(w) < 1e-3, "no heavy-over-light face survives");
	books(w, "light under heavy");
	console.log(`ok  blue poured under red reaches the top half in 5 s`);
}

// 4. A mixed phase keeps its ratios while it separates from the free channel.
{
	const { sim, w } = basin();
	W.setMixable(w, [1, 1, 0]);
	slug(w, sim, 4, 4, 2400, [2, 1, 0]);
	slug(w, sim, 4, 8, 1200, [0, 0, 1]);
	for (let k = 0; k < 120 * 10; k++) S.step(sim, S.STEP);
	let worst = 0;
	let cells = 0;
	for (let i = 0; i < w.count; i++) {
		const o = i * 3;
		if (w.ch[o] + w.ch[o + 1] < 1) continue;
		cells++;
		const d = Math.abs(w.ch[o] / (w.ch[o] + w.ch[o + 1]) - 2 / 3);
		if (d > worst) worst = d;
	}
	assert.ok(cells > 0 && worst < 1e-9, `the mixed R/G ratio survives in ${cells} cells (worst dev ${worst.toExponential(1)})`);
	const [r, g, b] = coms(w);
	assert.ok(Math.abs(r - g) < 1e-6, "the mixed channels share one centroid");
	assert.ok(b < r - 1 && b < g - 1, `free blue floats above the mix (${b.toFixed(1)} vs ${r.toFixed(1)})`);
	books(w, "mixed phase");
	console.log(`ok  R+G at 2:1 keeps its ratio to ${worst.toExponential(0)} while blue layers above`);
}

// 5. Nothing crosses a closed sill: pure pools on both sides of a shut gate keep
//    exactly their composition while the pools themselves equilibrate.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0], // straight connector rotor
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const { sim, w } = makeSim(spec);
	W.setMixable(w, [0, 0, 0]);
	// setAngle snaps the rotor; setTarget holds it there, or the per-step rotor
	// update would swing the gate back toward its old target.
	G.setAngle(valve(sim.layout, 4, 5), G.HALF_PI);
	S.setTarget(sim, 5 * N + 4, G.HALF_PI);
	W.rebuild(sim);
	const left = valve(sim.layout, 3, 5);
	const right = valve(sim.layout, 5, 5);
	const gateX = valve(sim.layout, 4, 5).cx;
	W.setLiquid(w, cellAt(w, left.cx, left.cy), 500, [1, 0, 0]);
	W.setLiquid(w, cellAt(w, right.cx, right.cy), 500, [0, 0, 1]);
	for (let k = 0; k < 120 * 5; k++) S.step(sim, S.STEP);
	const snapCh = w.ch.slice();
	const snapVol = w.vol.slice();
	for (let k = 0; k < 120 * 5; k++) S.step(sim, S.STEP);
	let drift = 0;
	for (let i = 0; i < w.ch.length; i++) {
		const d = Math.abs(w.ch[i] - snapCh[i]);
		if (d > drift) drift = d;
	}
	for (let i = 0; i < w.count; i++) {
		const d = Math.abs(w.vol[i] - snapVol[i]);
		if (d > drift) drift = d;
	}
	assert.ok(drift < 1e-9, `settled pools behind a shut gate stop moving (drift ${drift.toExponential(1)})`);
	let crossR = 0;
	let crossB = 0;
	for (let i = 0; i < w.count; i++) {
		const x = ((i % w.nx) + 0.5) * w.cell;
		if (x > gateX) crossR += w.ch[i * 3];
		else crossB += w.ch[i * 3 + 2];
	}
	assert.equal(crossR, 0, "no red reaches the right pool");
	assert.equal(crossB, 0, "no blue reaches the left pool");
	books(w, "closed sill");
	console.log(`ok  shut gate: zero cross-contamination, drift ${drift.toExponential(0)} over 5 s`);
}

// 6. Split and merge conserve every channel with phases: a closing rotor carries
//    the composition it trapped and a reopening returns it.
{
	const spec = {
		"3,5": ["hollow", [0], RV * 0.7],
		"4,5": ["solid", [0, 2], 0], // straight connector rotor
		"5,5": ["hollow", [2], RV * 0.7],
	};
	const { sim, w } = makeSim(spec);
	W.setMixable(w, [0, 0, 0]);
	const mid = valve(sim.layout, 4, 5);
	const left = valve(sim.layout, 3, 5);
	W.setLiquid(w, cellAt(w, left.cx, left.cy), 500, [1, 0, 1]);
	W.settle(w, 300);
	const before = W.channelTotals(w, new Float64Array(3)).slice();
	G.setAngle(mid, G.HALF_PI);
	W.rebuild(sim);
	W.settle(w, 300);
	let carried = 0;
	let trappedCh = 0;
	for (let i = 0; i < w.count; i++) {
		carried += w.trapped[i];
		for (let k = 0; k < 3; k++) trappedCh += w.trappedCh[i * 3 + k];
	}
	assert.ok(carried > 0, "the shut connector carries water");
	assert.ok(Math.abs(trappedCh - carried) < 1e-9, "and it carries the colours, not a blank");
	books(w, "phase split");
	G.setAngle(mid, 0);
	W.rebuild(sim);
	W.settle(w, 300);
	let leftOver = 0;
	for (let i = 0; i < w.count; i++) leftOver += w.trapped[i];
	assert.ok(leftOver < 1e-9, "a reopened passage returns the carried water");
	const after = W.channelTotals(w, new Float64Array(3));
	for (let k = 0; k < 3; k++) {
		assert.ok(Math.abs(after[k] - before[k]) < 1e-6, `channel ${k} survives split and merge`);
	}
	books(w, "phase merge");
	console.log(`ok  split/merge with phases carries ${carried.toFixed(0)} px² and returns every channel`);
}

// 7. Grain acceleration in known bands matches g (1 - sum(rho/rho_g f)): teal in
//    red rises at one g, in blue sinks at half g, blue hangs neutral in blue,
//    and a grain on the interface reads the band split.
{
	function settled() {
		const built = tube();
		W.setMixable(built.w, [0, 0, 0]);
		S.setWaterDrag(built.sim, 0);
		slug(built.w, built.sim, 4, 4, 1500, [1, 0, 0]);
		slug(built.w, built.sim, 4, 7, 1500, [0, 0, 1]);
		for (let k = 0; k < 120 * 3; k++) S.step(built.sim, S.STEP);
		return built;
	}
	// One grain per pool: a grain's own displacement shifts the bands it reads,
	// so sharing a pool would measure a different publish than it steps.
	function acceleration(x, y, r, color) {
		const { sim, w } = settled();
		const k = S.addGrain(sim, x, y, r, color);
		sim.vx[k] = 0;
		sim.vy[k] = 0;
		const h = S.STEP;
		S.step(sim, h);
		const damp = 1 - S.DAMPING * h;
		const got = (sim.vy[k] / damp) / h;
		const idx = Math.floor((y + G.POUR) / w.cell) * w.nx + Math.floor(x / w.cell);
		const rho = S.materialDensity(color);
		let rel = 0;
		let prev = 0;
		for (let b = 0; b < 3; b++) {
			const top = w.band[idx * 3 + b];
			if (!Number.isFinite(top)) break;
			const f = W.segFraction(r, y - top);
			if (f > prev) {
				rel += (w.bandRho[idx * 3 + b] / rho) * (f - prev);
				prev = f;
			}
		}
		return { got, want: S.GRAVITY * (1 - rel) };
	}
	function centreCell(w, wantR) {
		const cx = 4 * G.S + G.S / 2;
		const gx = Math.floor(cx / w.cell);
		for (let gy = 0; gy < w.ny; gy++) {
			const i = gy * w.nx + gx;
			if (w.vol[i] < 30) continue;
			// Absolute dust, not a share: the interface cell reads 99% red and
			// would pass a ratio test while straddling the split.
			if (wantR ? w.ch[i * 3 + 2] < 1e-6 : w.ch[i * 3] < 1e-6) return i;
		}
		throw new Error("no pure cell");
	}
	function centre(i, w) {
		return [((i % w.nx) + 0.5) * w.cell, (((i / w.nx) | 0) + 0.5) * w.cell - G.POUR];
	}
	const tol = 1e-9 * S.GRAVITY;
	const probe = settled();
	const [rx, ry] = centre(centreCell(probe.w, true), probe.w);
	const [bx, by] = centre(centreCell(probe.w, false), probe.w);
	const cases = [
		["teal in red", acceleration(rx, ry, 2.5, 2), -S.GRAVITY],
		["teal in blue", acceleration(bx, by, 2.5, 2), S.GRAVITY / 2],
		["blue in blue", acceleration(bx, by, 2.5, 3), 0],
	];
	// The interface cell holds both bands; a grain centred on the split is cut
	// exactly in half by it.
	const cx = 4 * G.S + G.S / 2;
	const gx = Math.floor(cx / probe.w.cell);
	let split = -1;
	for (let gy = 0; gy < probe.w.ny; gy++) {
		const i = gy * probe.w.nx + gx;
		if (Number.isFinite(probe.w.band[i * 3 + 1])) { split = probe.w.band[i * 3]; break; }
	}
	assert.ok(split > 0, "the settled pool has a two-band cell");
	cases.push(["teal on the split", acceleration(cx, split, 2, 2), S.GRAVITY * (1 - (2000 + 500) / 2 / 1000)]);
	for (const [tag, a, anchor] of cases) {
		assert.ok(Math.abs(a.got - a.want) <= tol, `${tag}: ${a.got.toFixed(6)} vs band sum ${a.want.toFixed(6)}`);
		assert.ok(Math.abs(a.got - anchor) <= tol, `${tag} reads its anchor (${anchor})`);
	}
	console.log(`ok  band-summed buoyancy matches to ${tol.toExponential(0)}: -g, +g/2, 0 and the split value`);
}

// 8. A stratified column paints as bands: the interface cell carries one triple
//    per rank, and texels take the colour of the layer they fall in.
{
	const { sim, w } = tube();
	W.setMixable(w, [0, 0, 0]);
	slug(w, sim, 4, 4, 1500, [1, 0, 0]);
	slug(w, sim, 4, 7, 1500, [0, 0, 1]);
	for (let k = 0; k < 120 * 3; k++) S.step(sim, S.STEP);
	const field = W.makeDisplay(w);
	W.sampleDisplay(sim, field);
	const cx = 4 * G.S + G.S / 2;
	const gx = Math.floor(cx / w.cell);
	let found = -1;
	for (let gy = 0; gy < w.ny; gy++) {
		const i = gy * w.nx + gx;
		if (field.rank[i] === 2) { found = i; break; }
	}
	assert.ok(found >= 0, "the interface cell has two ranks");
	const o = found * 9;
	assert.deepEqual([...field.color.slice(o, o + 3)], [255, 0, 0], "rank 0 is the dense red layer");
	assert.deepEqual([...field.color.slice(o + 3, o + 6)], [0, 0, 255], "rank 1 is the light blue layer");
	const split = w.band[found * 3];
	assert.ok(Number.isFinite(split) && Number.isFinite(w.band[found * 3 + 1]), "both band tops publish");
	assert.ok(w.band[found * 3] > w.band[found * 3 + 1], "the dense top sits below the light top");
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	R.renderWater(map, field, 0);
	const dgx = Math.floor(cx / field.cell);
	function texel(y) {
		const dgy = Math.floor((y + G.POUR) / field.cell);
		const p = (dgy * field.nx + dgx) * 4;
		return [...map.img.data.slice(p, p + 4)];
	}
	const shade = Math.round(255 * 0.55);
	const up = texel(split - 10);
	const down = texel(split + 10);
	assert.deepEqual(up.slice(0, 3), [0, 0, shade], "a texel in the blue layer paints blue");
	assert.deepEqual(down.slice(0, 3), [shade, 0, 0], "a texel in the red layer paints red");
	assert.ok(up[3] > 0 && down[3] > 0, "both layers are opaque");
	R.renderWater(map, field, 1);
	assert.deepEqual(texel(split - 10).slice(0, 3), [255, 255, 255], "a pure layer is light in pigment view");
	assert.deepEqual(texel(split + 10).slice(0, 3), [255, 255, 255], "both pure layers are light in pigment view");
	console.log(`ok  interface cell ranks red/blue, texels split at y=${split.toFixed(1)}`);
}

// 9. A hole inside the pool borrows the bands below it: its waterline reads wet,
//    so its bands must too, or a grain there would fall through published water.
{
	const { sim, w } = tube();
	W.setMixable(w, [0, 0, 0]);
	slug(w, sim, 4, 4, 1500, [1, 0, 0]);
	slug(w, sim, 4, 7, 1500, [0, 0, 1]);
	for (let k = 0; k < 120 * 3; k++) S.step(sim, S.STEP);
	const cx = 4 * G.S + G.S / 2;
	const gx = Math.floor(cx / w.cell);
	let hole = -1;
	for (let gy = 1; gy < w.ny; gy++) {
		const i = gy * w.nx + gx;
		const below = i + w.nx;
		if (w.vol[i] > 20 && w.vol[below] > 20) { hole = i; break; }
	}
	assert.ok(hole >= 0, "the pool has a wet-over-wet column");
	W.setLiquid(w, hole, 0);
	S.step(sim, S.STEP);
	const up = w.levelUp[hole];
	assert.ok(Number.isFinite(up), "the hole's waterline still reads wet");
	const top = w.band[hole * 3];
	assert.ok(Number.isFinite(top), "so does its band");
	assert.equal(top, w.band[(hole + w.nx) * 3], "the hole inherits the water below it");
	assert.ok(w.bandRho[hole * 3] === 2000 || w.bandRho[hole * 3] === 500, "with that water's density");
	books(w, "hole borrowing");
	console.log(`ok  an emptied below-surface cell keeps finite bands from below`);
}

console.log("OK  water colour slice 2: separated phases settle, buoy and paint in layers");
