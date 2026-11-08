// Heat-on water render regression. The previous dry-crossing fix kept the
// heat ledger closed, but the report that "heat on breaks water render
// permanently — water exists but is not drawn" needs an executable gate
// against it: walk the same path the page does (sampleDisplay + renderWater)
// at every checkpoint and assert non-zero visible texels whenever the
// solver holds water. Runs the four scenarios that previously blew up:
// a heat-first enable with no pre-fill, a heat enable over an already-wet
// field, a heat enable followed by Game/Lab mode parking and back, and a
// long melt/freeze run with two opposed heaters.
// Run: node experiments/heat-water-render.cjs
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const G = require(path.join(__dirname, "..", "prototype", "shared", "geometry.js"));
const S = require(path.join(__dirname, "..", "prototype", "shared", "simulation.js"));
const W = require(path.join(__dirname, "..", "prototype", "shared", "water.js"));
const H = require(path.join(__dirname, "..", "prototype", "shared", "heat.js"));
const R = require(path.join(__dirname, "..", "prototype", "shared", "render.js"));

// Render the water sheet the way the page does, and count texels the page
// would actually see (alpha > 0). The render uses real ImageData, so a stall
// in sampleDisplay or a zeroed channel cache reads as zero visible texels.
function visibleWater(sim) {
        const w = sim.water;
        assert.ok(w && w.enabled, "water is enabled");
        const field = W.makeDisplay(w);
        W.sampleDisplay(sim, field);
        const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
        R.renderWater(map, field, 0, 1);
        let vis = 0;
        const d = map.img.data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) vis++;
        let held = 0;
        for (let i = 0; i < w.count; i++) held += w.vol[i] + w.trapped[i];
        return { vis, held, nx: field.nx, ny: field.ny };
}

// Wet + heat with no pre-fill: the page's heat-first flow.
function scenarioHeatFirst(seed) {
        const sim = S.create(G.createLayout(seed), { turning: false });
        S.setPressure(sim, "off");
        S.setHeat(sim, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 600; k++) S.step(sim, S.STEP);
        const p = visibleWater(sim);
        assert.ok(p.held > 1 && p.vis > 0, `seed ${seed} heat-first: vis=${p.vis} held=${p.held.toFixed(1)} (water exists, must render)`);
        return p;
}

// Heat over a pre-wet field, then a long run with active melt/freeze.
function scenarioHeatOverWet(seed) {
        const sim = S.create(G.createLayout(seed), { turning: false });
        S.setPressure(sim, "off");
        S.setWater(sim, true);
        W.rebuild(sim);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
        S.setHeat(sim, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        let brokenAt = -1;
        for (let k = 0; k < 6000; k++) {
                S.step(sim, S.STEP);
                if (k % 600 === 599) {
                        const p = visibleWater(sim);
                        if (p.held > 1 && p.vis === 0) { brokenAt = k + 1; break; }
                }
        }
        assert.equal(brokenAt, -1, `seed ${seed} heat-over-wet: water render broke at step ${brokenAt}`);
        const p = visibleWater(sim);
        assert.ok(p.vis > 0, `seed ${seed} heat-over-wet: final vis=${p.vis} must be > 0`);
        return p;
}

// Mode park and back: setHeat(true) under Lab, then game.setMode("game")
// parks water+heat, then back to Lab re-enables water (the user clicks the
// checkbox) and heat (the user clicks Heat on), and water must render.
function scenarioModePark(seed) {
        const sim = S.create(G.createLayout(seed), { turning: false });
        S.setPressure(sim, "off");
        S.setWater(sim, true);
        W.rebuild(sim);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
        S.setHeat(sim, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
        // Park water (and heat) the way setMode("game") does, then resume.
        S.setWater(sim, false);
        assert.equal(sim.water.enabled, false, "parked water is disabled");
        assert.equal(sim.heat.enabled, false, "parked heat is disabled with water");
        S.setWater(sim, true);
        S.setHeat(sim, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
        const p = visibleWater(sim);
        assert.ok(p.vis > 0, `seed ${seed} mode-park: vis=${p.vis} after park and resume`);
        return p;
}

// Long melt/freeze run with two opposed heaters; water must keep rendering.
function scenarioLongMeltFreeze(seed) {
        const sim = S.create(G.createLayout(seed), { turning: false });
        S.setPressure(sim, "off");
        S.setHeat(sim, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        H.setPower(sim.heat, 5 * G.N + 3, 150);
        H.setPower(sim.heat, 5 * G.N + 6, -150);
        let brokenAt = -1;
        for (let k = 0; k < 12000; k++) {
                S.step(sim, S.STEP);
                if (k % 1000 === 999) {
                        const p = visibleWater(sim);
                        if (p.held > 1 && p.vis === 0) { brokenAt = k + 1; break; }
                }
        }
        assert.equal(brokenAt, -1, `seed ${seed} long melt/freeze: water render broke at step ${brokenAt}`);
        const p = visibleWater(sim);
        assert.ok(p.vis > 0, `seed ${seed} long melt/freeze: final vis=${p.vis} must be > 0`);
        return { p, melted: sim.heat.melted, frozen: sim.heat.frozen };
}

// Ambient one-shot shift: setAmbient with shift=true rebases the field by ΔT
// and closes the ledger through the ambient term, so a user typing a new
// room temperature sees the field respond at once.
function scenarioAmbientShift() {
        const sim = S.create(G.createLayout(7), { turning: false });
        S.setPressure(sim, "off");
        S.setHeat(sim, true);
        const h = sim.heat;
        H.fill(h, 20);
        const stored0 = H.stored(h);
        // Shift the room from 20 to 100 °C. Each cell's T moves by +80, and the
        // ambient ledger absorbs the difference.
        H.setAmbient(h, 100, undefined, true);
        const stored1 = H.stored(h);
        const dE = stored1 - stored0;
        assert.ok(Math.abs(dE - h.ambient) < 1e-6 * Math.max(1, Math.abs(dE)),
                `ambient shift books: dE=${dE.toFixed(1)} ambient=${h.ambient.toFixed(1)}`);
        // The mean T should now be ~100 °C (uniform shift over a uniform field).
        let sumT = 0;
        for (let i = 0; i < h.count; i++) sumT += h.T[i];
        const meanT = sumT / h.count;
        assert.ok(Math.abs(meanT - 100) < 1e-6, `ambient shift raised mean T to ${meanT.toFixed(3)} (wanted 100)`);
        // The residual must still be ~0.
        const r = H.residual(h);
        assert.ok(Math.abs(r) < 1e-6 * Math.max(1, Math.abs(h.ambient)), `ambient shift residual ${r.toExponential(2)}`);
        // Setting the same ambient again is a no-op (dT = 0).
        const stored2 = H.stored(h);
        H.setAmbient(h, 100, undefined, true);
        assert.equal(H.stored(h), stored2, "re-setting the same ambient is a no-op");
        // Setting a new ambient with shift=false only updates the room
        // temperature; the field does not move.
        H.setAmbient(h, 50, undefined, false);
        assert.equal(H.stored(h), stored2, "shift=false does not move the field");
        assert.equal(h.p.ambient, 50, "shift=false still updates the room setting");
}

const t0 = process.hrtime.bigint();
for (const seed of [1, 2, 3, 7, 11, 42, 100]) scenarioHeatFirst(seed);
console.log("ok  heat-first enable: water renders on seeds 1, 2, 3, 7, 11, 42, 100");
for (const seed of [1, 2, 3, 7, 11, 42, 100]) {
        const p = scenarioHeatOverWet(seed);
        if (seed === 7) console.log(`ok  heat over wet field (seed 7): vis=${p.vis} held=${p.held.toFixed(1)} after 6000 steps`);
}
console.log("ok  heat over wet field: water renders across a 6000-step run on all seven seeds");
for (const seed of [1, 7, 42]) {
        const p = scenarioModePark(seed);
        if (seed === 7) console.log(`ok  mode park and resume (seed 7): vis=${p.vis} held=${p.held.toFixed(1)}`);
}
console.log("ok  mode park and resume: water renders after parking water+heat and resuming");
{
        const r = scenarioLongMeltFreeze(7);
        console.log(`ok  long melt/freeze with opposed heaters (seed 7): vis=${r.p.vis} held=${r.p.held.toFixed(1)} melted=${r.melted.toFixed(0)} mg frozen=${r.frozen.toFixed(0)} mg`);
}
scenarioAmbientShift();
console.log("ok  ambient one-shot shift: ledger closes, mean T follows the new room, no-op on repeat, shift=false is a pure setting change");
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`OK  heat-on water render and ambient shift regression (${ms.toFixed(0)} ms)`);
