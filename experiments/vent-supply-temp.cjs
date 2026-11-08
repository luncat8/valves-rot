// Vent supply and grain spawn temperature regression. The report: "water and
// grain should be sourced (spawned at vent) with ambient temperature —
// currently it looks like 0 and causes water to immediately freeze at the vent
// even if ambient is high." The supply path already books every parcel at the
// room temperature; the freeze was the rule, not the import: a channel froze
// below its melt plateau (R 120, G 100, B 80 °C), which sits above any
// ordinary room, so a 20 °C pour froze on arrival and even a 100 °C room still
// froze the R share. The freeze point is now the lower of the plateau and the
// room, and reset re-opens the field at the room instead of at 0 °C (the
// zero field needed the outer ring's ~36-minute warm-up, which is where the
// "spawned at 0" reading came from). This gate walks the page's flows:
// pour at every interesting ambient, pour grains, Reset then pour again, and
// a cooler driving a pool below the room — freezing must still exist there.
// Run: node experiments/vent-supply-temp.cjs
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const G = require(path.join(__dirname, "..", "prototype", "shared", "geometry.js"));
const S = require(path.join(__dirname, "..", "prototype", "shared", "simulation.js"));
const W = require(path.join(__dirname, "..", "prototype", "shared", "water.js"));
const H = require(path.join(__dirname, "..", "prototype", "shared", "heat.js"));

function makeSim(seed) {
        const sim = S.create(G.createLayout(seed), { turning: false });
        S.setPressure(sim, "off");
        S.setHeat(sim, true);
        return sim;
}

// The page's flow: the room is typed into the Ambient box, which rebases the
// field at once, then the vent is opened. The mouth cell is where supply lands.
function mouthCell(w, column) {
        return 2 * w.nx + Math.min(w.nx - 1, Math.floor(((column + 0.5) * G.S) / w.cell));
}

function storedWater(w) {
        let v = 0;
        for (let i = 0; i < w.count; i++) v += w.vol[i] + w.trapped[i];
        return v;
}

// 1. Supply at ambient never freezes on arrival, at any room. 20 °C is the
//    reported default; 100 °C still froze the R share (plateau 120) before the
//    fix; 150 °C is above every plateau and must keep working.
function supplyAtAmbient(ambient, seed) {
        const sim = makeSim(seed);
        const h = sim.heat;
        H.setAmbient(h, ambient, undefined, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 600; k++) S.step(sim, S.STEP);
        const w = sim.water;
        const t = h.T[mouthCell(w, 0)];
        const held = storedWater(w);
        assert.equal(h.frozen, 0, `room ${ambient} °C (seed ${seed}): nothing froze — frozen=${h.frozen}`);
        assert.ok(Math.abs(t - ambient) <= 0.5,
                `room ${ambient} °C (seed ${seed}): the mouth reads ${t.toFixed(2)} °C, not pinned at a plateau`);
        assert.ok(held > 50, `room ${ambient} °C (seed ${seed}): the pour accumulated (${held.toFixed(1)} px²)`);
        const r = H.residual(h);
        assert.ok(Math.abs(r) <= 1e-6 * Math.max(1, Math.abs(h.material)),
                `room ${ambient} °C (seed ${seed}): books close (residual ${r.toExponential(2)})`);
        return held;
}

// 2. Poured grains enter at the room temperature: their cells read ambient
//    while it is below every melt point (no pin), and the books close at a hot
//    room where the melt-point pin hides the reading.
function grainsAtAmbient(ambient, seed) {
        const sim = makeSim(seed);
        const h = sim.heat;
        H.setAmbient(h, ambient, undefined, true);
        S.pour(sim, 24);
        for (let k = 0; k < 300; k++) S.step(sim, S.STEP);
        assert.ok(sim.count > 0, `grains at room ${ambient} °C (seed ${seed}): grains were poured`);
        assert.equal(h.frozen, 0, `grains at room ${ambient} °C (seed ${seed}): no freeze without liquid`);
        if (ambient <= 80) {
                let worst = 0;
                for (let k = 0; k < sim.count; k++) {
                        const i = sim.gcell[k];
                        if (i < 0) continue;
                        const d = Math.abs(h.T[i] - ambient);
                        if (d > worst) worst = d;
                }
                assert.ok(worst <= 0.5,
                        `grains at room ${ambient} °C (seed ${seed}): grain cells read ambient (worst ${worst.toFixed(2)} °C off)`);
        }
        // A falling grain must carry only its own sensible share: priced over a
        // capacity of its own CG it would sweep each fully-open transit cell's
        // whole book along, leaving a trail of collapsed ~0 °C donors behind it.
        // The design's own floor is the lowest freeze point, min(plateau, room):
        // at or below the plateaus that is the room itself, while in a hot room
        // the melt pins drag their neighbourhood down to the plateaus (a 150 °C
        // room melts grains and cools to 80/100/120, never under the lowest) —
        // the collapsed donors of the bug read ~0 °C, far under either floor.
        const floor = Math.min(ambient, h.p.melt[0], h.p.melt[1], h.p.melt[2]);
        let coldest = Infinity;
        for (let i = 0; i < h.count; i++) if (h.T[i] < coldest) coldest = h.T[i];
        assert.ok(coldest >= floor - 0.5,
                `grains at room ${ambient} °C (seed ${seed}): no cell collapsed below the design floor ${floor} °C (coldest ${coldest.toFixed(2)} °C)`);
        const r = H.residual(h);
        assert.ok(Math.abs(r) <= 1e-6 * Math.max(1, Math.abs(h.material)),
                `grains at room ${ambient} °C (seed ${seed}): books close (residual ${r.toExponential(2)})`);
}

// 3. The page's Reset re-opens the field at the room temperature — not at
//    0 °C — so a pour right after Reset lands on a room-temperature machine
//    and does not freeze. This is the "it looks like 0" report.
function resetReopensAtRoom() {
        const sim = makeSim(7);
        const h = sim.heat;
        H.setAmbient(h, 60, undefined, true);
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 240; k++) S.step(sim, S.STEP);
        assert.ok(storedWater(sim.water) > 0, "reset gate: water poured before the reset");
        S.reset(sim);
        // Reset emptied the field and shut the vents but kept the room setting.
        let sum = 0;
        for (let i = 0; i < h.count; i++) sum += h.T[i];
        const mean = sum / h.count;
        assert.ok(Math.abs(mean - 60) <= 1e-9, `after Reset the field reads the room (${mean.toFixed(2)} °C, not 0)`);
        assert.equal(H.stored(h), h.initial, "the re-opened stock is the new opening book");
        assert.equal(H.residual(h), 0, "and the ledger closes on it");
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 600; k++) S.step(sim, S.STEP);
        assert.equal(h.frozen, 0, `a pour right after Reset does not freeze (frozen=${h.frozen})`);
        assert.ok(Math.abs(h.T[mouthCell(sim.water, 0)] - 60) <= 0.5, "the mouth sits at the room after Reset");
        assert.ok(storedWater(sim.water) > 50, "the post-Reset pour accumulated");
}

// 4. Freezing still exists — it just needs a cell below the room now. A cooler
//    under every valve drives the pooled supply below the 20 °C room and the
//    freeze converts it back into primary grains with the books held.
function coolerStillFreezes() {
        const sim = makeSim(7);
        const h = sim.heat;
        W.setVent(sim.water, 0, true);
        W.setSupply(sim.water, 100);
        for (let k = 0; k < 600; k++) S.step(sim, S.STEP);
        assert.equal(h.frozen, 0, "cooler gate: the room-temperature pour stays liquid");
        assert.ok(storedWater(sim.water) > 50, "cooler gate: a pool formed");
        for (let v = 0; v < h.power.length; v++) H.setPower(h, v, -150);
        let frozeAt = -1;
        for (let k = 0; k < 6000 && h.frozen === 0; k++) {
                S.step(sim, S.STEP);
                if (h.frozen > 0) { frozeAt = k; break; }
        }
        assert.ok(h.frozen > 0, `a cooler below the room freezes the pool (frozen=${h.frozen.toFixed(1)} mg)`);
        assert.ok(sim.count > 0, "the freeze placed grains");
        const booksOk = Math.abs(H.residual(h)) <= 1e-6 * Math.max(1, Math.abs(h.material));
        assert.ok(booksOk, `the freeze is internal and the books close (residual ${H.residual(h).toExponential(2)})`);
        console.log(`ok  cooler gate: −150 E/s on every valve froze ${h.frozen.toFixed(1)} mg into ${sim.count} grain(s) below the 20 °C room`);
}

const t0 = process.hrtime.bigint();
for (const room of [20, 60, 90, 100, 150]) {
        for (const seed of [7, 42]) supplyAtAmbient(room, seed);
}
console.log("ok  supply at ambient: rooms 20/60/90/100/150 °C on seeds 7 and 42 — no freeze on arrival, mouth at the room, books closed");
for (const room of [20, 150]) {
        for (const seed of [7, 42]) grainsAtAmbient(room, seed);
}
console.log("ok  grains at ambient: poured grains read the room on their cells, books closed");
resetReopensAtRoom();
console.log("ok  reset: the field re-opens at the room temperature and a pour right after it stays liquid");
coolerStillFreezes();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`OK  vent supply and grain spawn temperature regression (${ms.toFixed(0)} ms)`);
