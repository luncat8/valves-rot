"use strict";
// Slice 3 of 0.3-water-color-plan: what the page actually paints, in both views,
// for a mixed basin and a separated one, plus the gate closure kept apart from
// that comparison. The shared painter calls the page's water renderer, so a
// drifted or dead sheet shows up here and not only in a browser.
// Run: node experiments/water-color-picture.cjs
const path = require("node:path");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const C = require("./water-color-scenario.cjs");
const P = require("./water-paint.cjs");
const { writePng } = require("./png-writer.cjs");

const logs = path.join(__dirname, "logs");
const view = { x0: 3 * G.S, y0: 7 * G.S, w: 3 * G.S, h: 2.5 * G.S }; // the basin floor
const gateView = { x0: 3 * G.S, y0: 4 * G.S, w: 3 * G.S, h: 2.5 * G.S }; // row 5

function cellAt(w, v) {
	return Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
}

// Red on the left of a straight connector, blue on the right. Open, the two
// pools meet; shut, each side keeps its own colour behind the rotor.
function gate() {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) {
			const left = i === 3 && j === 5;
			const mid = i === 4 && j === 5;
			const right = i === 5 && j === 5;
			const port = left ? [0] : right ? [2] : mid ? [0, 2] : [];
			const kind = left || right ? "hollow" : "solid";
			valves.push(G.makeValve(i, j, kind, port, 0, left || right ? G.RV * 0.7 : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	W.setMixable(w, [0, 0, 0]);
	W.setLiquid(w, cellAt(w, valves[5 * G.N + 3]), 1600, [1, 0, 0]);
	W.setLiquid(w, cellAt(w, valves[5 * G.N + 5]), 1600, [0, 0, 1]);
	return { sim, w, mid: 5 * G.N + 4 };
}

function run(sim, seconds) {
	for (let k = 0; k < 120 * seconds; k++) S.step(sim, S.STEP);
}

const mixed = C.create({ mixable: [1, 1, 1] });
const layered = C.create({ mixable: [0, 0, 0] });
run(mixed, 10);
run(layered, 10);
writePng(path.join(logs, "water-color.png"), [
	P.panel(mixed, view, 2, false),
	P.panel(mixed, view, 2, true),
	P.panel(layered, view, 2, false),
	P.panel(layered, view, 2, true),
]);

const g = gate();
run(g.sim, 2);
const open = P.panel(g.sim, gateView, 2, false);
G.setAngle(g.sim.layout.valves[g.mid], G.HALF_PI);
S.setTarget(g.sim, g.mid, G.HALF_PI);
W.rebuild(g.sim);
run(g.sim, 5);
const shut = P.panel(g.sim, gateView, 2, false);
writePng(path.join(logs, "water-color-gate.png"), [open, shut]);

console.log("seed 3, 120 Hz, basin view x 216..432 y 504..684 at scale 2, gate view x 216..432 y 288..468 at scale 2");
console.log("water-color.png panels left to right:");
console.log("  1 mixed colour   - R/G/B all mixable, 10 s after three pours");
console.log("  2 mixed pigment  - same state, pigment view");
console.log("  3 layered colour - R/G/B each its own phase, 10 s after three pours: blue on top");
console.log("  4 layered pigment- same state, pigment view (a pure layer reads light)");
console.log("water-color-gate.png panels left to right:");
console.log("  1 gate open      - red left, blue right, filled above the seam, connector open 2 s");
console.log("  2 gate shut      - the same connector turned shut, 5 s later: the stack holds on");
