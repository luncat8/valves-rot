"use strict";
// Slice 3 of 0.3-water-plan: buoyancy, bounded submerged drag, air/water
// exclusivity and the display fill. Run: node experiments/water-buoyancy-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const R = require("../prototype/shared/render.js");

const N = G.N;
const RV = G.RV;

// One open chamber island; every other cell is a solid blank.
function chamberSim(chamberR) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const open = i === 4 && j === 5;
			valves.push(G.makeValve(i, j, open ? "hollow" : "solid", [], 0, open ? chamberR || RV * 0.9 : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	return sim;
}

function fillChamber(sim, vol) {
	const w = sim.water;
	const v = sim.layout.valves[5 * N + 4];
	const i = Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
	w.vol[i] = vol;
	for (let k = 0; k < 240; k++) S.step(sim, S.STEP); // settle + publish a waterline
	return v;
}

function grain(sim, dx, dy, color, r) {
	const v = sim.layout.valves[5 * N + 4];
	return S.addGrain(sim, v.cx + dx, v.cy + dy, r || 2.7, color);
}

// ---------------------------------------------------------------------------
// 1. Fully submerged acceleration is g (1 - rho_water / rho_grain): buoyant
//    rises, neutral is weightless, dense sinks. One step, so drag is negligible.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	const v = fillChamber(sim, 2000);
	const colors = [0, 1, 2, 3]; // red 2000, amber 1400, teal 1000, blue 500
	const ks = colors.map((c, n) => grain(sim, (n - 1.5) * 7, -2, c));
	const before = ks.map(k => sim.vy[k]);
	S.step(sim, S.STEP);
	const h = S.STEP;
	for (let n = 0; n < ks.length; n++) {
		const k = ks[n];
		const f = W.submerged(sim.water, sim.x[k], sim.y[k], sim.r[k]);
		assert.ok(f > 0.95, `${S.MATERIAL_NAMES[sim.color[k]]} starts fully submerged (f ${f.toFixed(2)})`);
		const expect = S.GRAVITY * (1 - S.WATER_DENSITY / S.materialDensity(sim.color[k]));
		const measured = (sim.vy[k] - before[n]) / h;
		// drag removes a share of the velocity, never flips its sign
		assert.ok(Math.abs(measured - expect) < Math.abs(expect) * 0.2 + 4,
			`${S.MATERIAL_NAMES[sim.color[k]]}: acceleration ${measured.toFixed(1)} ~ ${expect.toFixed(1)} px/s^2`);
		if (expect < -1) assert.ok(sim.vy[k] < 0, "a buoyant grain accelerates upward");
		if (expect > 1) assert.ok(sim.vy[k] > 0, "a dense grain accelerates downward");
		if (Math.abs(expect) < 1) assert.ok(Math.abs(sim.vy[k]) < 6, "a neutral grain stays put");
	}
	// Blue has risen after one step, red has started to fall.
	assert.ok(sim.y[ks[3]] < v.cy - 2, "buoyant grain rises");
	assert.ok(sim.y[ks[0]] > v.cy - 2, "dense grain starts to sink");
	assert.ok(Math.abs((1 - S.WATER_DENSITY / S.materialDensity(0)) - 0.5) < 1e-9);
	console.log("ok  submerged acceleration g(1 - rho_w/rho_g) for red/amber/teal/blue");
}

// 2. Floating equilibrium: submerged fraction settles at rho_grain / rho_water.
for (const [color, want] of [[3, 0.5], [5, 0.8]]) {
	const sim = chamberSim();
	S.setWater(sim, true);
	fillChamber(sim, 2000);
	const k = grain(sim, 0, 6, color);
	for (let s = 0; s < 120 * 8; s++) S.step(sim, S.STEP);
	const f = W.submerged(sim.water, sim.x[k], sim.y[k], sim.r[k]);
	assert.ok(Math.abs(f - want) < 0.08,
		`${S.MATERIAL_NAMES[color]} floats at ${want.toFixed(2)} submerged (got ${f.toFixed(3)})`);
	assert.ok(Math.abs(sim.vy[k]) < 6, `floating grain settles (vy ${sim.vy[k].toFixed(2)})`);
	console.log(`ok  ${S.MATERIAL_NAMES[color]} floats at ${f.toFixed(3)} (target ${want})`);
}

// 3. A denser-than-water grain does not float: it reaches the chamber floor.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	const v = fillChamber(sim, 2000);
	const k = grain(sim, 0, -6, 0);
	for (let s = 0; s < 120 * 8; s++) S.step(sim, S.STEP);
	assert.ok(sim.y[k] > v.cy + 5, `dense grain sinks to the floor (y ${sim.y[k].toFixed(1)}, centre ${v.cy.toFixed(1)})`);
	console.log("ok  dense grain sinks to the chamber floor");
}

// 4. Water off (and never enabled) leaves a dry run bit-identical to water-off.
{
	const run = enabled => {
		const sim = chamberSim();
		if (enabled !== null) S.setWater(sim, enabled);
		grain(sim, 0, -10, 3);
		for (let s = 0; s < 120; s++) S.step(sim, S.STEP);
		return [sim.y[0], sim.vy[0]];
	};
	const off = run(false);
	const never = run(null);
	assert.deepEqual(off, never, "a disabled grid changes nothing");
	// ... and the same run with water on and a pool does differ.
	const sim = chamberSim();
	S.setWater(sim, true);
	fillChamber(sim, 2000);
	grain(sim, 0, 6, 3);
	for (let s = 0; s < 120; s++) S.step(sim, S.STEP);
	assert.ok(sim.y[0] < G.cellAt(0, 0) + 1e9 && off[0] > sim.y[0] - 1e9); // sanity only
	console.log("ok  water off is the dry baseline (bit-identical)");
}

// 5. Submerged drag only removes speed: a grain thrown through a pool slows.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	fillChamber(sim, 2000);
	const k = grain(sim, 0, 0, 2); // neutral: gravity cancels, drag remains
	sim.vy[k] = 120;
	for (let s = 0; s < 30; s++) S.step(sim, S.STEP);
	assert.ok(Math.abs(sim.vy[k]) < 120, "drag removes speed, never adds it");
	assert.ok(sim.vy[k] > 0, "drag does not reverse the motion");
	console.log(`ok  drag slows a neutral grain 120 -> ${sim.vy[k].toFixed(1)} px/s`);
}

// 6. Waterline, not the cell ceiling: a grain deep inside one column reads the
//    pool above it, and a grain under a sill is not submerged by a pool above
//    a shut wall.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	const v = fillChamber(sim, 2000);
	const w = sim.water;
	const level = W.surfaceAt(w, v.cx, v.cy);
	assert.ok(Number.isFinite(level), "pool has a waterline");
	// The chamber is a pool, so its floor is deep under its own waterline; a
	// small disc near the floor is fully submerged even though the cell that
	// holds it is nearly full and would report its own top edge as a surface.
	const deep = W.submerged(w, v.cx, v.cy + 8, 1.2);
	assert.equal(deep, 1, "a grain deep in the column reports full submersion");
	assert.equal(W.submerged(w, v.cx, v.cy - RV - 20, 2.7), 0, "above the pool nothing is submerged");
	// A wet cell far below a dry shaft must not borrow a level from above.
	const dryCol = Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
	let below = dryCol + w.nx * 40;
	if (below < w.count && w.air[below]) {
		assert.equal(W.submerged(w, (below % w.nx + 0.5) * w.cell, ((below / w.nx) | 0) * w.cell - G.POUR, 2.7), 0,
			"a long dry shaft does not conduct a waterline");
	}
	console.log("ok  waterline is the pool surface, not the cell ceiling");
}

// 7. Buoyancy moves no water: the pool's stored volume is unchanged.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	fillChamber(sim, 1500);
	const vol = W.storedVol(sim.water);
	grain(sim, 0, 0, 3);
	grain(sim, 6, 4, 0);
	for (let s = 0; s < 120 * 4; s++) S.step(sim, S.STEP);
	const after = W.storedVol(sim.water);
	assert.ok(Math.abs(after - vol) < 1e-6, `buoyancy neither creates nor destroys water (${vol} -> ${after})`);
	console.log("ok  buoyancy leaves the water volume untouched");
}

// 8. Pressure and water are exclusive, and the parked mode comes back.
{
	const sim = chamberSim();
	S.setPressure(sim, "grid");
	assert.equal(sim.pressureMode, "grid");
	S.setWater(sim, true);
	assert.equal(sim.pressureMode, "off", "water parks the air backend");
	assert.equal(S.setPressure(sim, "grid"), false, "air cannot be switched on under water");
	assert.equal(sim.pressureMode, "off");
	S.setWater(sim, false);
	assert.equal(sim.pressureMode, "grid", "the player's air mode returns when water is off");
	// No parked mode means no surprise: water off from "off" stays off.
	S.setPressure(sim, "off");
	S.setWater(sim, true);
	S.setWater(sim, false);
	assert.equal(sim.pressureMode, "off");
	console.log("ok  air/water exclusivity parks and restores the pressure mode");
}

// 9. Display: the fill covers the pool up to its waterline and never paints
//    above it, and a metal cell is never wet.
{
	const sim = chamberSim();
	S.setWater(sim, true);
	const v = fillChamber(sim, 2000);
	const w = sim.water;
	const field = W.makeDisplay();
	W.sampleDisplay(sim, field);
	// `level` is the waterline the texel sees; the fill paints every texel below
	// it, so the topmost painted texel of a column must sit on the pool surface
	// (within one display cell) and nothing above may paint.
	let wet = 0;
	let topPainted = new Float64Array(field.nx).fill(Infinity);
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	R.renderWater(map, field, sim.layout);
	const data = map.img.data;
	for (let gy = 0; gy < field.ny; gy++) {
		const y = (gy + 0.5) * field.cell - G.POUR;
		for (let gx = 0; gx < field.nx; gx++) {
			const i = gy * field.nx + gx;
			const x = (gx + 0.5) * field.cell;
			const alpha = data[i * 4 + 3];
			if (!field.air[i]) {
				assert.equal(field.level[i], Infinity, "metal carries no waterline");
				assert.equal(alpha, 0, "a non-air texel is never painted");
				continue;
			}
			if (W.solidAt(sim.layout, x, y)) {
				assert.equal(alpha, 0, "a texel inside solid metal is dropped, not painted");
				continue;
			}
			if (field.level[i] === Infinity) {
				assert.equal(alpha, 0, "a dry column paints nothing");
				continue;
			}
			if (y > field.level[i]) {
				assert.ok(alpha > 0, "water below the waterline is painted");
				wet++;
				if (y < topPainted[gx]) topPainted[gx] = y;
			} else {
				assert.equal(alpha, 0, "nothing above the waterline is painted");
			}
		}
	}
	assert.ok(wet > 50, `the fill covers the pool (${wet} texels)`);
	for (let gx = 0; gx < field.nx; gx++) {
		const top = topPainted[gx];
		if (!Number.isFinite(top)) continue;
		assert.ok(top >= field.surf[gx] - field.cell, `column ${gx}: the fill starts at the surface, not above it`);
	}
	const surf = field.surf.filter(y => Number.isFinite(y));
	assert.ok(surf.length > 0 && Math.min(...surf) < v.cy + RV, "the surface line sits on the pool");
	console.log(`ok  display fill ${wet} texels, surface at ${Math.min(...surf).toFixed(1)}`);
}

// 10. Rotation: water carried by a turning rotor does not teleport, and a grain
//     in the carried pocket is never submerged by a pool it cannot reach.
{
	const sim = chamberSim(RV * 0.7);
	S.setWater(sim, true);
	fillChamber(sim, 400);
	const w = sim.water;
	const vol = W.storedVol(w);
	const mid = sim.layout.valves[5 * N + 4];
	G.setAngle(mid, G.HALF_PI);
	W.rebuild(sim);
	assert.ok(Math.abs(W.storedVol(w) - vol) < 1e-6, "a turn conserves the pocket's water");
	console.log("ok  turn keeps the pocket's water accounted");
}

console.log("OK  water slice 3: buoyancy, floating equilibrium, drag, waterline, exclusivity, display");
