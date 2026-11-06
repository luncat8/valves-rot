"use strict";
// Slice 3 of 0.3-water-color-plan: what the colour channels and the separated
// phases cost per 120 Hz step, per mask rebuild and per displayed frame, on one
// basin and one valve schedule. All-mixable is the single-liquid baseline — it
// is the path the golden digest pins — so the difference to three separated
// phases is the price of layering, not of the colour channels.
// Run: node experiments/water-color-bench.cjs
const os = require("node:os");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const W = require("../prototype/shared/water.js");
const R = require("../prototype/shared/render.js");
const C = require("./water-color-scenario.cjs");

const REPS = 9;
const STEPS = 120;
const FRAMES = 5;
const BUDGET = 8.333;

const MIXED = [1, 1, 1];
const LAYERED = [0, 0, 0];

function median(values) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[sorted.length >> 1];
}

// Three pours in a two-by-five block of hollow valves: red above, green in the
// middle, blue below. Layered, that is an inverted stack that has to sort, so
// warm stands for a basin that has already had its three seconds of settling.
function scene(mixable, turning, warm) {
	const sim = C.create({ mixable, turning });
	for (let k = 0; k < 120 * warm; k++) S.step(sim, S.STEP);
	return sim;
}

// The first second after the pour, on fresh scenes: this is the step that runs
// while the inverted stack is actually sorting, not after it has settled.
function pourStepMs(mixable) {
	const runs = [];
	for (let r = 0; r < 5; r++) {
		const sim = scene(mixable, false, 0);
		const t0 = process.hrtime.bigint();
		for (let k = 0; k < STEPS; k++) S.step(sim, S.STEP);
		runs.push(Number(process.hrtime.bigint() - t0) / 1e6 / STEPS);
	}
	return median(runs);
}

function stepMs(sim) {
	const runs = [];
	for (let r = 0; r < REPS; r++) {
		const t0 = process.hrtime.bigint();
		for (let k = 0; k < STEPS; k++) S.step(sim, S.STEP);
		runs.push(Number(process.hrtime.bigint() - t0) / 1e6 / STEPS);
	}
	return median(runs);
}

// A rebuild only samples when a rotor moved or the layout changed, so an idle
// tick is free; the full mask and the per-turn path are measured separately.
function rebuildMs(sim, mode) {
	const w = sim.water;
	const valves = sim.layout.valves;
	const runs = [];
	for (let r = 0; r < REPS; r++) {
		const t0 = process.hrtime.bigint();
		for (let k = 0; k < 20; k++) {
			if (mode === "full") w.built = false;
			if (mode === "turn") G.setAngle(valves[5 * G.N + 4], (k % 4) * G.HALF_PI);
			W.rebuild(sim);
		}
		runs.push(Number(process.hrtime.bigint() - t0) / 1e6 / 20);
	}
	return median(runs);
}

// The display path the page runs: sample once, then paint the texel field in
// each view. A map stands in for the canvas so render.js runs unchanged.
function display(sim, pigment) {
	const field = W.makeDisplay(sim.water);
	const map = { nx: field.nx, ny: field.ny, img: { data: new Uint8ClampedArray(field.nx * field.ny * 4) }, ctx: { putImageData() {} } };
	const runs = [];
	for (let r = 0; r < REPS; r++) {
		const t0 = process.hrtime.bigint();
		for (let f = 0; f < FRAMES; f++) {
			W.sampleDisplay(sim, field);
			R.renderWater(map, field, pigment);
		}
		runs.push(Number(process.hrtime.bigint() - t0) / 1e6 / FRAMES);
	}
	return median(runs);
}

const ms = v => v.toFixed(3);
const pct = v => ((v / BUDGET) * 100).toFixed(1) + "%";
const delta = (a, b) => (b >= a ? "+" : "") + (b - a).toFixed(3);

const mixed = scene(MIXED, false, 3);
const layered = scene(LAYERED, false, 3);
const mixedTurn = scene(MIXED, true, 3);
const layeredTurn = scene(LAYERED, true, 3);

const pourMixed = pourStepMs(MIXED);
const pourLayered = pourStepMs(LAYERED);
const mixedStep = stepMs(mixed);
const layeredStep = stepMs(layered);
const mixedTurnStep = stepMs(mixedTurn);
const layeredTurnStep = stepMs(layeredTurn);
const mixedColor = display(mixed, 0);
const layeredColor = display(layered, 0);
const mixedPigment = display(mixed, 1);
const layeredPigment = display(layered, 1);
// Rebuilds run last: turning a valve moves the water behind it.
const mixedIdle = rebuildMs(mixed, "idle");
const layeredIdle = rebuildMs(layered, "idle");
const mixedFull = rebuildMs(mixed, "full");
const layeredFull = rebuildMs(layered, "full");
const mixedTurnRebuild = rebuildMs(mixed, "turn");
const layeredTurnRebuild = rebuildMs(layered, "turn");

console.log(`node ${process.version}; ${os.cpus()[0].model}; seed 3; dt ${S.STEP}; 120 Hz budget ${BUDGET} ms; medians of ${REPS} runs of ${STEPS} steps and ${FRAMES} frames`);
console.log(`scene: ${W.wetCount(mixed.water)} wet cells mixed, ${W.wetCount(layered.water)} layered, 0 grains`);
console.log(`wet step sorting   mixed ${ms(pourMixed)} ms  layered ${ms(pourLayered)} ms  delta ${delta(pourMixed, pourLayered)} ms (first second after the pour)`);
console.log(`wet step static    mixed ${ms(mixedStep)} ms  layered ${ms(layeredStep)} ms  delta ${delta(mixedStep, layeredStep)} ms (${pct(layeredStep)} of budget)`);
console.log(`wet step turning   mixed ${ms(mixedTurnStep)} ms  layered ${ms(layeredTurnStep)} ms  delta ${delta(mixedTurnStep, layeredTurnStep)} ms (${pct(layeredTurnStep)} of budget)`);
console.log(`rebuild idle       mixed ${ms(mixedIdle)} ms  layered ${ms(layeredIdle)} ms (no rotor moved, the step skips the mask)`);
console.log(`rebuild full mask  mixed ${ms(mixedFull)} ms  layered ${ms(layeredFull)} ms  delta ${delta(mixedFull, layeredFull)} ms`);
console.log(`rebuild one turn   mixed ${ms(mixedTurnRebuild)} ms  layered ${ms(layeredTurnRebuild)} ms  delta ${delta(mixedTurnRebuild, layeredTurnRebuild)} ms`);
console.log(`display color      mixed ${ms(mixedColor)} ms  layered ${ms(layeredColor)} ms`);
console.log(`display pigment    mixed ${ms(mixedPigment)} ms  layered ${ms(layeredPigment)} ms`);
console.log("mixed is the all-mixable single-liquid baseline (the path the golden digest pins); deltas under 0.1 ms are run-to-run noise on this machine");
