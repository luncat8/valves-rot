"use strict";
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");

function create() {
	const valves = [];
	for (let j = 0; j < G.N; j++) {
		for (let i = 0; i < G.N; i++) {
			const pool = j >= 4 && j <= 8 && i >= 3 && i <= 5;
			valves.push(G.makeValve(i, j, pool ? "hollow" : "solid", pool ? [0, 1, 2, 3] : [], 0, pool ? G.RV * 0.9 : 0));
		}
	}
	const sim = S.create({ seed: 3, valves }, { turning: false });
	S.setPressure(sim, "off");
	const w = S.setWater(sim, true);
	W.rebuild(sim);
	for (const [j, shares] of [[4, [1, 0, 0]], [6, [0, 1, 0]], [8, [0, 0, 1]]]) {
		const v = valves[j * G.N + 4];
		const i = Math.floor((v.cy + G.POUR) / w.cell) * w.nx + Math.floor(v.cx / w.cell);
		W.setLiquid(w, i, 1500, shares);
	}
	return sim;
}
function steps(sim, seconds) {
	for (let i = 0; i < seconds * 120; i++) S.step(sim, S.STEP);
}
module.exports = { create, steps };
