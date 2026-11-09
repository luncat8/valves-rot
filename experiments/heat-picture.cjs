// Heat picture: heater and cooler panels written to logs/heat-0.4.png so the
// temperature scale, the plateau pins and the phase change can be judged
// without a browser. The field is painted by the page's own renderers (the
// water sheet through renderWater, the temperature overlay through
// renderHeat's LUT), so it is a colour preview of the real layers, not a copy.
// The scene runs at +3000/−3000 E/s, a third of the shipped slider scale
// (±10000), chosen so the melt pins stay visible for the whole 30 s window:
// at the shipped default the heater races through its pins and saturates the
// labeled scale within seconds, and the picture stops demonstrating the
// plateaus. The heater chamber climbs to the melt pins of the grains it still
// holds; the cooler chamber freezes its pool into primary grains and pins the
// remainder at the freeze point. heat-balance.cjs measures the shipped
// ±10000 E/s behavior.
// Run: node experiments/heat-picture.cjs
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { writePng } = require("./png-writer.cjs");
const P = require("./water-paint.cjs");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "prototype", "shared");
const G = require(path.join(SHARED, "geometry.js"));
const S = require(path.join(SHARED, "simulation.js"));
const W = require(path.join(SHARED, "water.js"));
const H = require(path.join(SHARED, "heat.js"));
const R = require(path.join(SHARED, "render.js"));

const N = G.N;
const RV = G.RV;
const OUT = path.join(__dirname, "logs", "heat-0.4.png");
const LOG = path.join(__dirname, "logs", "heat-0.4.txt");
const POWER = 3000;
const WINDOW = 30 * 120;

// Two sealed chambers over a solid field: the left one heated, the right one
// cooled, both holding a pool. The cold pool under the heater and the hot pool
// under the cooler make both fronts visible: the heater has to climb to the
// plateau before any grain melts, the cooler has to fall to the freeze point
// before any liquid freezes.
function scene() {
        const spec = {
                "3,5": ["hollow", [0], RV * 0.75],
                "6,5": ["hollow", [2], RV * 0.75],
        };
        const valves = [];
        for (let j = 0; j < N; j++) {
                for (let i = 0; i < N; i++) {
                        const e = spec[i + "," + j];
                        valves.push(G.makeValve(i, j, e ? e[0] : "solid", e ? e[1] : [], 0, e && e[2] ? e[2] : 0));
                }
        }
        const sim = S.create({ seed: 3, valves }, { turning: false });
        S.setPressure(sim, "off");
        S.setWater(sim, true);
        W.rebuild(sim);
        const h = S.setHeat(sim, true);
        H.setAmbient(h, 20, 0.05);
        const cellOf = v => Math.floor((v.cy + G.POUR) / sim.water.cell) * sim.water.nx + Math.floor(v.cx / sim.water.cell);
        const left = sim.layout.valves[5 * N + 3];
        const right = sim.layout.valves[5 * N + 6];
        H.setCell(h, sim, cellOf(left), 150, [1, 0, 0], 20);
        H.setCell(h, sim, cellOf(right), 150, [0, 0, 1], 130);
        for (let c = 0; c < 6; c++) S.addGrain(sim, left.cx + (c - 2.5) * 7, left.cy - 14, 2.2, c % 6);
        H.setPower(h, 5 * N + 3, POWER);
        H.setPower(h, 5 * N + 6, -POWER);
        return { sim, h, left, right, cellOf };
}

// The temperature overlay as the page paints it: one texel per water cell
// through the fixed LUT, composited at the page's overlay alpha.
function heatOverlay(sim, view, scale, wdt, hgt, px) {
        const h = sim.heat;
        const heat = { nx: h.nx, ny: h.ny, img: { data: new Uint8ClampedArray(h.count * 4) }, ctx: { putImageData() {} } };
        R.renderHeat(heat, h);
        const data = heat.img.data;
        const cell = h.cell;
        for (let y = 0; y < hgt; y++) {
                const wy = view.y0 + (y + 0.5) / scale;
                const gy = Math.floor((wy + G.POUR) / cell);
                if (gy < 0 || gy >= h.ny) continue;
                for (let x = 0; x < wdt; x++) {
                        const gx = Math.floor((view.x0 + (x + 0.5) / scale) / cell);
                        if (gx < 0 || gx >= h.nx) continue;
                        const o = (gy * h.nx + gx) * 4;
                        const pxo = (y * wdt + x) * 3;
                        px[pxo] += (data[o] - px[pxo]) * 0.58;
                        px[pxo + 1] += (data[o + 1] - px[pxo + 1]) * 0.58;
                        px[pxo + 2] += (data[o + 2] - px[pxo + 2]) * 0.58;
                }
        }
}

// The fixed °C scale as a strip panel: gradient with notches every 60 °C.
function legendPanel() {
        const w = 18;
        const hgt = 120;
        const px = Buffer.alloc(w * hgt * 3);
        for (let y = 0; y < hgt; y++) {
                const t = R.HEAT_MAX * (1 - y / (hgt - 1));
                const c = R.heatColor(t);
                for (let x = 0; x < w; x++) {
                        const o = (y * w + x) * 3;
                        px[o] = c[0];
                        px[o + 1] = c[1];
                        px[o + 2] = c[2];
                        if (x < 3 && Math.round(t) % 60 === 0) {
                                px[o] = 255;
                                px[o + 1] = 255;
                                px[o + 2] = 255;
                        }
                }
        }
        return { rgb: px, w, h: hgt };
}

function panel(sim, view, scale) {
        const p = P.panel(sim, view, scale);
        heatOverlay(sim, view, scale, p.w, p.h, p.rgb);
        return p;
}

const { sim, h, left, right, cellOf } = scene();
for (let k = 0; k < WINDOW; k++) S.step(sim, S.STEP);
const w = sim.water;
const ch = new Float64Array(3);
W.channelTotals(w, ch);
const heatView = { x0: 0, y0: -G.POUR, w: G.SIZE, h: G.SIZE + 2 * G.POUR };
const zoom = { x0: right.cx - 62, y0: right.cy - 46, w: 124, h: 92 };
writePng(OUT, [panel(sim, heatView, 1), panel(sim, zoom, 3), legendPanel()], { background: 12 });

// The measurement log: fixed scene, parameters, ledger and phase books. The
// chamber readings are wet-cell means with their spread, because a single cell
// can go dry and dive while the pool it left behind stays pinned.
function chamberMean(h, valveIdx) {
        const w = h.w;
        let n = 0, sum = 0, lo = Infinity, hi = -Infinity;
        for (let i = 0; i < w.count; i++) {
                if (w.cellOwner[i] !== valveIdx) continue;
                const vol = w.vol[i] + w.trapped[i];
                if (!(vol > 0.01)) continue;
                n++;
                sum += h.T[i];
                if (h.T[i] < lo) lo = h.T[i];
                if (h.T[i] > hi) hi = h.T[i];
        }
        return n ? { mean: sum / n, lo, hi } : { mean: NaN, lo: NaN, hi: NaN };
}
const leftC = chamberMean(h, 5 * N + 3);
const rightC = chamberMean(h, 5 * N + 6);
const lines = [];
lines.push(`heat 0.4 picture and measurement, seed 3, ${(WINDOW / 120).toFixed(0)} s at 120 Hz`);
lines.push("params " + JSON.stringify(h.p));
lines.push(`heater valve ${5 * N + 3} at +${POWER} E/s, cooler valve ${5 * N + 6} at -${POWER} E/s, ambient ${h.p.ambient} °C`);
lines.push(`ledger: initial ${h.initial.toFixed(0)} source ${h.source.toFixed(0)} ambient ${h.ambient.toFixed(0)} material ${h.material.toFixed(0)}`);
const res = H.residual(h);
lines.push(`residual ${res.toExponential(2)} absolute, ${(res / Math.max(1, Math.abs(h.material))).toExponential(2)} relative to the material term (tolerance 1e-9 relative)`);
lines.push(`channels R ${ch[0].toFixed(1)} G ${ch[1].toFixed(1)} B ${ch[2].toFixed(1)} px², grains ${sim.count}, melted ${h.melted.toFixed(1)} mg, frozen ${h.frozen.toFixed(1)} mg`);
const meanT = (() => {
        let s = 0;
        for (let i = 0; i < h.count; i++) s += h.T[i];
        return s / h.count;
})();
lines.push(`mean field temperature ${meanT.toFixed(2)} °C, substeps ${h.substeps}`);
lines.push(`left chamber T ${leftC.mean.toFixed(1)} °C wet mean (${leftC.lo.toFixed(0)}..${leftC.hi.toFixed(0)}) — the heater climbs to the melt pins of the grains it still holds`);
lines.push(`right chamber T ${rightC.mean.toFixed(1)} °C wet mean (${rightC.lo.toFixed(0)}..${rightC.hi.toFixed(0)}) — the cooler froze its pool and the remainder pins at the freeze point`);
const t0 = process.hrtime.bigint();
for (let k = 0; k < 2000; k++) S.step(sim, S.STEP);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
lines.push(`step cost with heat on: ${ms.toFixed(3)} ms/step (grains ${sim.count}, wet ${W.wetCount(w)})`);
fs.writeFileSync(LOG, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`wrote ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, LOG)}`);
