// The power balance for the heat mode, as a script instead of a one-off probe.
// The signed valve power is the single knob that decides whether a heater or a
// cooler can drive a chamber pool through the plateaus at an interactive pace:
// too little and the melt never happens at all (the old ±150 E/s slider left
// the heater inert — a 240 mg pour froze 19% in 50 s and nothing melted back
// in 200 s), while the freeze work per px² (latent plus the capacity swap at
// the room) is about a third of the melt work per px² (latent plus the swap at
// the plateau), so the melt leg is the one the default has to be tuned against.
// The sweep found the knee at ±3000 E/s (melt-back in 152 s) and the shipped
// default at ±5000 E/s: first freeze 0.2 s, a 240 mg pool 46% frozen by 20 s,
// and the whole frozen mass melted back inside 110 s. Beyond it the extra
// power buys no more freeze — the plateau there is placement-bound, not
// power-bound — and only drives the cooled block further below the labeled
// 0–240 °C scale.
//
// Measured on a deterministic shaft scene (the heat-picture idiom, seed-free):
// solid-cross rotors at column 3 rows 0–4 leave a wide open shaft from the pour
// band into a hollow elbow chamber at (3,5), so a pour at the page's default
// rate lands in the band, falls the shaft and pools in the chamber. The cooler
// sits on the chamber valve only, the way a player would select it.
//
// Run: node experiments/heat-balance.cjs
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const G = require(path.join(__dirname, "..", "prototype", "shared", "geometry.js"));
const S = require(path.join(__dirname, "..", "prototype", "shared", "simulation.js"));
const W = require(path.join(__dirname, "..", "prototype", "shared", "water.js"));
const H = require(path.join(__dirname, "..", "prototype", "shared", "heat.js"));

// The page's default pour (water.js DEFAULT_RATE) and the slider ceiling this
// table ships with (index.html; render-smoke asserts the two move together).
const POUR = 40;
const SHIPPED = 5000;
const ROOM = 20;
const POUR_S = 6;
const FREEZE_S = 30;
const MELT_CAP_S = 150;
const CHAMBER = 53; // (3,5) in the 10x10 valve field

function scene() {
        const spec = {};
        for (let j = 0; j < 5; j++) spec["3," + j] = ["solid", [0, 1, 2, 3]];
        spec["3,5"] = ["hollow", [0, 3], G.RV * 0.36];
        const valves = [];
        for (let j = 0; j < G.N; j++) {
                for (let i = 0; i < G.N; i++) {
                        const e = spec[i + "," + j];
                        valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
                }
        }
        const sim = S.create({ seed: 3, valves }, { turning: false });
        S.setPressure(sim, "off");
        const h = S.setHeat(sim, true);
        H.setAmbient(h, ROOM, undefined, true);
        return { sim, h };
}

// Liquid and grains by region: the pour band above the field (grid rows < 5),
// the shaft valves, the chamber valve, and the rest. The freeze is a dwell
// phenomenon — the pour passes the band in under half a second, far too fast
// for any freeze to catch it, so the split that matters is shaft vs chamber.
function regions(sim) {
        const w = sim.water;
        const r = { bandLiq: 0, shaftLiq: 0, chamberLiq: 0, otherLiq: 0, bandGrains: 0, shaftGrains: 0, chamberGrains: 0, otherGrains: 0 };
        const shaft = new Set([3, 13, 23, 33, 43]);
        for (let i = 0; i < w.count; i++) {
                const gy = (i / w.nx) | 0;
                const vol = w.vol[i] + w.trapped[i];
                if (gy < 5) r.bandLiq += vol;
                else if (w.cellOwner[i] === CHAMBER) r.chamberLiq += vol;
                else if (shaft.has(w.cellOwner[i])) r.shaftLiq += vol;
                else r.otherLiq += vol;
        }
        for (let k = 0; k < sim.count; k++) {
                const i = sim.gcell[k];
                if (i < 0) { r.otherGrains++; continue; }
                const gy = (i / w.nx) | 0;
                if (gy < 5) r.bandGrains++;
                else if (w.cellOwner[i] === CHAMBER) r.chamberGrains++;
                else if (shaft.has(w.cellOwner[i])) r.shaftGrains++;
                else r.otherGrains++;
        }
        return r;
}

function totalLiq(sim) {
        let v = 0;
        for (let i = 0; i < sim.water.count; i++) v += sim.water.vol[i] + sim.water.trapped[i];
        return v;
}

function books(h, tag) {
        const r = H.residual(h);
        assert.ok(Math.abs(r) <= 1e-6 * Math.max(1, Math.abs(h.material)), `${tag}: books close (residual ${r.toExponential(2)})`);
}

// Every cell that still holds liquid reads at or above its own freeze point —
// the vent-supply floor. The dry cells under a sustained cooler dive without
// bound (no lower floor is modelled), which is why the gate is scoped to
// liquid cells and the dive is only logged.
function liquidFloor(sim, h, tag) {
        const w = sim.water;
        const p = h.p;
        for (let i = 0; i < w.count; i++) {
                const vol = w.vol[i] + w.trapped[i];
                if (!(vol > 1e-9)) continue;
                const o = i * 3;
                let pin = -Infinity;
                for (let k = 0; k < 3; k++) {
                        if (!(w.ch[o + k] > 1e-9)) continue;
                        const f = Math.min(p.melt[k], p.ambient);
                        if (f > pin) pin = f;
                }
                if (pin === -Infinity) pin = p.ambient;
                assert.ok(h.T[i] >= pin - 0.5, `${tag}: liquid cell ${i} reads ${h.T[i].toFixed(2)} °C, not below its freeze point ${pin} °C`);
        }
}

function minFieldT(h) {
        let lo = Infinity;
        for (let i = 0; i < h.count; i++) if (h.T[i] < lo) lo = h.T[i];
        return lo;
}

// ---- the freeze leg: pour, then cool the chamber ---------------------------------
function freezePace(power, log) {
        const { sim, h } = scene();
        W.setVent(sim.water, 3, true);
        W.setSupply(sim.water, POUR);
        for (let k = 0; k < POUR_S * 120; k++) S.step(sim, S.STEP);
        W.setVent(sim.water, 3, false);
        const poured = totalLiq(sim);
        assert.ok(poured > 200 && poured < 280, `freeze ${power}: the pour pooled (${poured.toFixed(0)} px² of ${POUR * POUR_S})`);
        H.setPower(h, CHAMBER, -power);
        let first = -1;
        const at = { 10: 0, 20: 0, 50: 0 };
        for (let k = 1; k <= 50 * 120; k++) {
                S.step(sim, S.STEP);
                if (h.frozen > 0 && first < 0) first = k;
                if (at[k / 120] !== undefined) at[k / 120] = h.frozen;
        }
        const r = regions(sim);
        const lo = minFieldT(h);
        liquidFloor(sim, h, `freeze ${power}`);
        books(h, `freeze ${power}`);
        log.push(`-${power}\t${(first / 120).toFixed(2)}s\t${at[10].toFixed(0)}\t${at[20].toFixed(0)}\t${at[50].toFixed(0)}\t${r.chamberLiq.toFixed(0)}\t${sim.count}\t${lo.toFixed(0)}`);
        return { first: first / 120, at, poured, remainder: r.chamberLiq, minT: lo };
}

// ---- the melt leg: freeze at -power, flip to +power -------------------------------
function meltBack(power, log) {
        const { sim, h } = scene();
        W.setVent(sim.water, 3, true);
        W.setSupply(sim.water, POUR);
        for (let k = 0; k < POUR_S * 120; k++) S.step(sim, S.STEP);
        W.setVent(sim.water, 3, false);
        H.setPower(h, CHAMBER, -power);
        for (let k = 0; k < FREEZE_S * 120; k++) S.step(sim, S.STEP);
        const frozen = h.frozen;
        H.setPower(h, CHAMBER, power);
        let first = -1;
        let allGone = -1;
        for (let k = 1; k <= MELT_CAP_S * 120; k++) {
                S.step(sim, S.STEP);
                if (h.melted > 0 && first < 0) first = k;
                if (sim.count === 0 && h.melted > 0) { allGone = k; break; }
        }
        const firstS = first < 0 ? Infinity : first / 120;
        const backS = allGone < 0 ? Infinity : allGone / 120;
        const liquid = totalLiq(sim);
        books(h, `melt ${power}`);
        log.push(`+${power}\t${Number.isFinite(firstS) ? firstS.toFixed(1) + "s" : "never"}\t${Number.isFinite(backS) ? backS.toFixed(1) + "s" : ">cap"}\t${frozen.toFixed(0)}\t${h.melted.toFixed(0)}\t${liquid.toFixed(0)}`);
        return { frozen, melted: h.melted, first: firstS, allGone: backS, liquid };
}

// ---- the running pour: the split while the cooler works ---------------------------
function runningPour(power, rate, log) {
        const { sim, h } = scene();
        W.setVent(sim.water, 3, true);
        W.setSupply(sim.water, rate);
        H.setPower(h, CHAMBER, -power);
        for (let k = 0; k < 30 * 120; k++) S.step(sim, S.STEP);
        const w = sim.water;
        const attempted = w.chAttempted[0] + w.chAttempted[1] + w.chAttempted[2];
        const admitted = w.chAdmitted[0] + w.chAdmitted[1] + w.chAdmitted[2];
        const r = regions(sim);
        liquidFloor(sim, h, `pour ${power} @${rate}`);
        books(h, `pour ${power} @${rate}`);
        assert.equal(attempted, admitted, `pour ${power} @${rate}: the mouth never clogs (attempted ${attempted} == admitted)`);
        assert.equal(r.bandGrains, 0, `pour ${power} @${rate}: nothing freezes in the band — the pour passes it in under half a second`);
        assert.ok(r.bandLiq < 5, `pour ${power} @${rate}: the band holds no pool (${r.bandLiq.toFixed(1)} px²)`);
        log.push(`-${power} @${rate}/s\t${admitted.toFixed(0)}\t${h.frozen.toFixed(0)} (${(100 * h.frozen / Math.max(1, admitted)).toFixed(0)}%)\t${r.shaftLiq.toFixed(0)}\t${r.chamberLiq.toFixed(0)}\t${r.shaftGrains}\t${r.chamberGrains}`);
        return { admitted, frozen: h.frozen, split: r };
}

// ---- the latent knob at the shipped power -----------------------------------------
function latentRow(scale, log) {
        const { sim, h } = scene();
        for (let k = 0; k < 3; k++) h.p.latent[k] = [60, 55, 50][k] * scale;
        W.setVent(sim.water, 3, true);
        W.setSupply(sim.water, POUR);
        for (let k = 0; k < POUR_S * 120; k++) S.step(sim, S.STEP);
        W.setVent(sim.water, 3, false);
        H.setPower(h, CHAMBER, -SHIPPED);
        const at = { 20: 0, 50: 0 };
        for (let k = 1; k <= 50 * 120; k++) {
                S.step(sim, S.STEP);
                if (at[k / 120] !== undefined) at[k / 120] = h.frozen;
        }
        books(h, `latent x${scale}`);
        log.push(`x${scale}\t${at[20].toFixed(0)}\t${at[50].toFixed(0)}\t${sim.count}`);
        return at;
}

const t0 = process.hrtime.bigint();
const out = [];
out.push(`heat balance, shaft scene, room ${ROOM} °C, pour ${POUR} px²/s for ${POUR_S} s at the mouth of column 3, cooler on the chamber valve (3,5) only`);
out.push(`params ${JSON.stringify(H.PARAMS)}`);

// 1. The freeze sweep. At the old default nothing melts later and only a fifth
//    of the pool freezes; at the shipped default the plateau arrives by 20 s
//    and is placement-bound, not power-bound.
out.push("");
out.push("freeze: power\tfirst\tfrozen@10s\tfrozen@20s\tfrozen@50s mg\tchamber liq px²\tgrains\tmin field °C");
const freezeRows = {};
for (const p of [150, 500, 1500, SHIPPED, 20000]) freezeRows[p] = freezePace(p, out);

// 2. The melt sweep. The shipped default is the smallest round power that
//    melts the whole frozen mass back inside the cap.
out.push("");
out.push("melt-back: power\tfirst melt\tall gone\tfrozen mg\tmelted mg\tliquid px²");
const meltRows = {};
for (const p of [150, 1500, SHIPPED, 20000]) meltRows[p] = meltBack(p, out);

// 3. The running pour at the shipped cooler: the rate ceiling. One default
//    cooler freezes about a third of a default pour; the share falls as the
//    pour rate rises, so the ceiling is a rate, not a share.
out.push("");
out.push("running pour: cooler\tpoured px²\tfrozen mg (share)\tshaft liq\tchamber liq\tshaft grains\tchamber grains");
const pourRows = {};
for (const rate of [POUR, 100, 200]) pourRows[rate] = runningPour(SHIPPED, rate, out);

// 4. The latent knob at the shipped power: second-order here because the
//    plateau is placement-bound; it was first-order at the old default, where
//    the freeze was still power-bound.
out.push("");
out.push("latent at -5000: scale\tfrozen@20s\tfrozen@50s mg\tgrains");
for (const scale of [0.5, 1, 2]) latentRow(scale, out);

// ---- gates on the shipped default --------------------------------------------------
//
// Freeze: fast on contact, plateaued by 20 s, the remainder pinned liquid.
const f = freezeRows[SHIPPED];
assert.ok(f.at[20] >= 100, `shipped freeze: ${f.at[20].toFixed(0)} mg of the ${f.poured.toFixed(0)} mg pour frozen by 20 s (at least 40%)`);
assert.ok(f.at[50] - f.at[20] < 5, `shipped freeze: the plateau holds (${f.at[50].toFixed(0)} vs ${f.at[20].toFixed(0)} mg) — placement-bound, not power-bound`);
assert.ok(f.first < 1, `shipped freeze: first freeze in ${f.first.toFixed(2)} s, under a second`);
assert.ok(f.remainder >= 100, `shipped freeze: ${f.remainder.toFixed(0)} px² stays liquid as the pinned sub-grain remainder`);

// Melt: the knee. The old default never starts; a third of the shipped never
// finishes; the shipped completes with the phase books exact.
const m = meltRows[SHIPPED];
assert.ok(m.first <= 60, `shipped melt: first melt in ${m.first.toFixed(1)} s, under a minute`);
assert.ok(m.allGone <= 120, `shipped melt: all grains back in ${m.allGone.toFixed(1)} s, under two minutes`);
assert.equal(m.frozen, m.melted, `shipped melt: the cycle closes the phase books (frozen ${m.frozen.toFixed(1)} == melted ${m.melted.toFixed(1)} mg)`);
const before = meltRows[150];
assert.ok(before.first === Infinity, "the old default ±150 E/s never starts melting inside the cap");
assert.ok(freezeRows[150].at[50] < 60, `the old default froze only ${freezeRows[150].at[50].toFixed(0)} mg in 50 s (under a quarter of the pool)`);
const third = meltRows[1500];
assert.ok(third.allGone > 120, `a third of the shipped power does not finish inside the gate (${Number.isFinite(third.allGone) ? third.allGone.toFixed(0) + " s" : "never"})`);

// The running pour: one shipped cooler cannot freeze a default pour in flight
// — most of it still reaches the chamber — and the mouth never clogs.
const split = pourRows[POUR];
const share = split.frozen / split.admitted;
assert.ok(share > 0.25 && share < 0.55, `one shipped cooler freezes ${(100 * share).toFixed(0)}% of a default pour — a third, not all of it`);
assert.ok(split.split.chamberLiq >= 200, `${split.split.chamberLiq.toFixed(0)} px² of the pour pools in the chamber as liquid`);
assert.ok(split.split.shaftLiq >= 100, `the rest backs up the shaft (${split.split.shaftLiq.toFixed(0)} px²) once the chamber fills`);

// Too much: the plateau is placement-bound, so quadruple power freezes no more
// of the pool — it only pushes the cooled block off the labeled scale.
const quad = freezeRows[20000];
assert.ok(quad.at[20] < f.at[20], `4x the power freezes less, not more (${quad.at[20].toFixed(0)} vs ${f.at[20].toFixed(0)} mg by 20 s) — the plateau is placement-bound`);
assert.ok(quad.minT < -100, `4x the power drives the cooled block to ${quad.minT.toFixed(0)} °C, far below the labeled scale`);
assert.ok(f.minT > -100, `the shipped default's dive (${f.minT.toFixed(0)} °C) stays within an order of the 0–240 scale`);

// The design ratio the default was tuned against: melting a px² back out of a
// grain pays the latent plus the capacity swap at the plateau, freezing pays
// them at the room, so melting is the expensive leg for every channel.
const p = H.PARAMS;
for (let k = 0; k < 3; k++) {
        const freezeWork = p.latent[k] + (p.liquidHeat - p.grainHeat) * Math.min(p.melt[k], p.ambient);
        const mat = H.FREEZE_MAT[k];
        const shares = H.MELT_SHARES[mat];
        let ls = 0;
        let tm = 0;
        for (let c = 0; c < 3; c++) {
                ls += shares[c] * p.latent[c];
                if (shares[c] > 0 && p.melt[c] > tm) tm = p.melt[c];
        }
        const meltWork = ls + (p.liquidHeat - p.grainHeat) * tm;
        const ratio = meltWork / freezeWork;
        assert.ok(ratio > 2.5 && ratio < 4, `channel ${k}: melt work ${meltWork.toFixed(0)} vs freeze work ${freezeWork.toFixed(0)} E/px² — the melt is the expensive leg (x${ratio.toFixed(2)})`);
        out.push(`work ratio channel ${k}: freeze ${freezeWork.toFixed(0)}, melt ${meltWork.toFixed(0)} E/px² (x${ratio.toFixed(2)})`);
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
out.push("");
out.push(`shipped default ±${SHIPPED} E/s: freeze ${f.at[20].toFixed(0)} mg by 20 s (first ${f.first.toFixed(2)} s), melt-back ${m.allGone.toFixed(0)} s, one cooler takes ${(100 * share).toFixed(0)}% of a default pour`);
out.push(`OK heat balance (${ms.toFixed(0)} ms)`);
fs.writeFileSync(path.join(__dirname, "logs", "heat-balance.txt"), out.join("\n") + "\n");
console.log(out.join("\n"));
console.log(`wrote ${path.relative(path.join(__dirname, ".."), path.join(__dirname, "logs", "heat-balance.txt"))}`);
