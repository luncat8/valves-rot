// Deterministic fixtures for the conservative grain solver.
// Run: node experiments/simulation-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");

const N = G.N;
const SIDE = G.S;
const STEP = S.STEP;
const RV = G.RV;
const worst = { push: 0, overlap: 0, pen: 0, rec: 0, steps: 0 };

// ---------------------------------------------------------------- helpers

// A field of blank plugs with only the listed cells opened up. Specs are keyed
// "i,j" and hold [kind, ports, chamberR].
function field(spec) {
	const valves = [];
	for (let j = 0; j < N; j++) {
		for (let i = 0; i < N; i++) {
			const e = spec[i + "," + j];
			const ports = e ? e[1] : [];
			valves.push(G.makeValve(i, j, e ? e[0] : "solid", ports, 0, e && e[2] ? e[2] : 0));
		}
	}
	return { seed: 3, valves };
}

function valve(layout, i, j) {
	return layout.valves[j * N + i];
}

function run(sim, seconds) {
	const n = Math.round(seconds * 120);
	for (let k = 0; k < n; k++) {
		S.step(sim, STEP);
		worst.steps++;
	}
}

// One step at a time, checking after each that the state is finite and that no
// grain has been left inside metal.
function runChecked(sim, seconds, tag) {
	const n = Math.round(seconds * 120);
	for (let k = 0; k < n; k++) {
		S.step(sim, STEP);
		worst.steps++;
		for (let g = 0; g < sim.count; g++) {
			assert.ok(Number.isFinite(sim.x[g]) && Number.isFinite(sim.vy[g]), `${tag}: state not finite`);
			const clear = G.airClearance(sim.layout, sim.x[g], sim.y[g]);
			assert.ok(clear >= sim.r[g] - 1e-4, `${tag}: grain ${g} left in metal at ${(k / 120).toFixed(2)} s`);
		}
	}
}

function conserved(sim, tag) {
	assert.equal(sim.injected, sim.count + sim.drained + sim.purged, `${tag}: grains created or lost`);
}

function worstOverlap(sim) {
	let pen = 0;
	for (let a = 0; a < sim.count; a++) {
		for (let b = a + 1; b < sim.count; b++) {
			const d = Math.hypot(sim.x[a] - sim.x[b], sim.y[a] - sim.y[b]);
			const p = sim.r[a] + sim.r[b] - d;
			if (p > pen) pen = p;
		}
	}
	return pen;
}

function snapshot(sim) {
	const out = [];
	for (let k = 0; k < sim.count; k++) out.push(sim.x[k], sim.y[k], sim.vx[k], sim.vy[k]);
	return out;
}

function count(sim, test) {
	let n = 0;
	for (let k = 0; k < sim.count; k++) if (test(sim.x[k], sim.y[k])) n++;
	return n;
}

function tally(sim) {
	if (sim.maxPush > worst.push) worst.push = sim.maxPush;
	if (sim.maxOverlap > worst.overlap) worst.overlap = sim.maxOverlap;
	if (sim.maxPen > worst.pen) worst.pen = sim.maxPen;
	worst.rec += sim.recovered;
}

// Angle at which one seam is as close to `width` as the quarter turn allows.
function angleForSeam(v, side, width) {
	let best = 0;
	let bestErr = Infinity;
	for (let a = 0; a <= 1.45; a += 0.0005) {
		G.setAngle(v, a);
		const err = Math.abs(v.seam[side] - width);
		if (err < bestErr) {
			bestErr = err;
			best = a;
		}
	}
	return best;
}

// ---------------------------------------------------------------- fixtures

// A straight shaft: ten aligned valves, one grain after another, all the way to
// the drain spout. Nothing may be lost and nothing may need recovery.
function fallingColumn() {
	const spec = {};
	for (let j = 0; j < N; j++) spec["4," + j] = ["solid", [1, 3]];
	const layout = field(spec);
	const sim = S.create(layout, { turning: false });
	for (let row = 0; row < 6; row++) {
		assert.ok(S.addGrain(sim, 4.5 * SIDE, -24 + row * 5.6, 2.6, row % 6) >= 0, "the pour band must take six grains");
	}
	runChecked(sim, 8, "falling column");
	assert.equal(sim.drained, 6, "every grain must reach the drain");
	assert.equal(sim.count, 0);
	assert.equal(sim.recovered, 0, "a straight fall needs no recovery");
	assert.equal(sim.maxPen, 0, "a straight fall touches no wall from the wrong side");
	conserved(sim, "falling column");
	tally(sim);
	return sim.drained;
}

// A sealed chamber: no port, so the rim is solid all the way round. What is
// inside stays inside, settles, and never sits in metal.
function sealedReservoir() {
	const layout = field({ "4,4": ["hollow", [], 12] });
	const v = valve(layout, 4, 4);
	const sim = S.create(layout, { turning: false });
	let placed = 0;
	for (let row = -1; row <= 1; row++) {
		for (let col = -1; col <= 1; col++) {
			if (S.addGrain(sim, v.cx + col * 4.6, v.cy + row * 4.6, 2.2, (col + row + 2) % 6) >= 0) placed++;
		}
	}
	assert.equal(placed, 9, "the chamber must hold nine grains");
	runChecked(sim, 5, "sealed reservoir");
	assert.equal(sim.count, 9, "a sealed chamber keeps every grain");
	assert.equal(sim.drained, 0);
	assert.equal(sim.recovered, 0, "a sealed chamber never needs recovery");
	for (let k = 0; k < sim.count; k++) {
		assert.ok(Math.hypot(sim.x[k] - v.cx, sim.y[k] - v.cy) <= v.chamberR - sim.r[k] + 0.05, "a settled grain stays in the chamber");
	}
	assert.ok(worstOverlap(sim) < 0.05, "nine grains in a chamber settle without overlap");
	conserved(sim, "sealed reservoir");
	tally(sim);
	return sim.count;
}

// A quarter-turn elbow: the up leg becomes the left leg, and the pile has to
// leave through the mouth that was a wall before the turn.
function quarterTurnElbow() {
	const layout = field({
		"4,0": ["solid", [1, 3]],
		"4,1": ["solid", [1, 3]],
		"4,2": ["solid", [3, 0]],
	});
	const elbow = valve(layout, 4, 2);
	const sim = S.create(layout, { turning: false });
	for (let k = 0; k < 4; k++) S.addGrain(sim, 4.5 * SIDE, -22 + 5.6 * k, 2.4, k);
	runChecked(sim, 3, "elbow inlet");
	// A knock from the lubricant can park a grain anywhere inside the elbow's own
	// cavity, so the mouth counts as shut only while nothing crosses the cell edge.
	const left = (x) => x - elbow.cx < -8;
	assert.equal(count(sim, left), 0, "the left mouth is shut before the turn");
	S.turn(sim, 2 * N + 4, -1);
	runChecked(sim, 5, "elbow turn");
	assert.ok(count(sim, left) >= 1, "the quarter turn must route the pile over the shared edge");
	assert.equal(sim.drained, 0, "the elbow is a pocket, not a drain");
	assert.equal(sim.recovered, 0, "a quarter turn of a clear mouth needs no recovery");
	assert.ok(worstOverlap(sim) < 0.2, "grains leaving an elbow must not overlap");
	conserved(sim, "quarter-turn elbow");
	tally(sim);
	return count(sim, left);
}

// Two nearly aligned ports across a cell edge: when the receiving port's seam
// is narrower than the grain radius, the grain rests on the rim jaws outside
// the lower rotor; widened past the grain radius, it drops into the lower rotor.
function nearlyAligned() {
	const layout = field({
		"4,0": ["solid", [1, 3]],
		"4,1": ["solid", [3]],
	});
	const lower = valve(layout, 4, 1);
	const narrow = angleForSeam(lower, 3, 1.9);
	G.setAngle(lower, narrow);
	const shut = S.create(layout, { turning: false });
	assert.ok(lower.seam[3] < 1.9, "the narrow throat must be narrower than the grain");
	assert.ok(S.addGrain(shut, 4.5 * SIDE, 0.5 * SIDE, 2.5, 0) >= 0, "upper rotor must take the grain");
	runChecked(shut, 2, "narrow throat");
	assert.ok(
		Math.hypot(shut.x[0] - lower.cx, shut.y[0] - lower.cy) >= RV + 1.4,
		"a narrow throat holds the grain outside the rim jaws",
	);

	const wide = angleForSeam(lower, 3, 3.6);
	G.setAngle(lower, wide);
	const open = S.create(layout, { turning: false });
	assert.ok(lower.seam[3] > 3.5, "the wide throat must clear the grain");
	assert.ok(S.addGrain(open, 4.5 * SIDE, 0.5 * SIDE, 2.5, 1) >= 0, "upper rotor must take the grain");
	runChecked(open, 2, "wide throat");
	assert.ok(Math.hypot(open.x[0] - lower.cx, open.y[0] - lower.cy) < RV - 12, "a wide throat lets the grain into the lower rotor");
	assert.equal(shut.recovered + open.recovered, 0);
	conserved(shut, "narrow throat");
	conserved(open, "wide throat");
	tally(shut);
	tally(open);
	return `${narrow.toFixed(3)}/${wide.toFixed(3)} rad`;
}

// A four-port chamber: four ways out, one pull. The pile must empty downwards
// instead of wedging in a pocket, which is what a one-port cell would do.
function multiOutlet() {
	const layout = field({ "4,4": ["hollow", [0, 1, 2, 3], 11] });
	const v = valve(layout, 4, 4);
	const sim = S.create(layout, { turning: false });
	for (let k = 0; k < 5; k++) {
		const a = (k / 5) * G.TAU;
		assert.ok(S.addGrain(sim, v.cx + Math.cos(a) * 4, v.cy + Math.sin(a) * 4, 2.3, k % 6) >= 0);
	}
	runChecked(sim, 6, "multi-outlet");
	let left = 0;
	let below = 0;
	for (let k = 0; k < sim.count; k++) {
		if (Math.hypot(sim.x[k] - v.cx, sim.y[k] - v.cy) <= RV) continue;
		left++;
		if (sim.y[k] > v.cy) below++;
	}
	assert.ok(left >= 3, `a four-port chamber must empty, only ${left} of ${sim.count} got out`);
	assert.equal(below, left, "gravity empties a chamber downwards, not sideways");
	assert.ok(worstOverlap(sim) < 0.25, "grains leaving a chamber must not overlap");
	conserved(sim, "multi-outlet");
	tally(sim);
	return left;
}

// A packed elbow is the case the solver cannot do alone: the bed is a solid
// arch over the bend, positional contacts carry no weight, and a full shaft
// above it simply stops. Dry (lubricant 0) it must stay locked; lubricated it
// must let the bed creep through the bend.
function packedBend() {
	function build(lubricant) {
		const layout = field({
			"4,0": ["solid", [1, 3]],
			"4,1": ["solid", [1, 3]],
			"4,2": ["solid", [1, 3]],
			"4,3": ["solid", [1, 3]],
			"4,4": ["solid", [3, 0]],
			"5,4": ["solid", [2, 1]],
			"5,5": ["solid", [1, 3]],
			"5,6": ["solid", [1, 3]],
			"5,7": ["solid", [1, 3]],
			"5,8": ["solid", [1, 3]],
			"5,9": ["solid", [1, 3]],
		});
		return S.create(layout, { turning: false, lubricant });
	}
	function feed(sim, seconds, rate) {
		const n = Math.round(seconds * 120);
		for (let k = 0; k < n; k++) {
			if (k % rate === 0) S.addGrain(sim, 4.5 * SIDE, -20);
			S.step(sim, STEP);
			worst.steps++;
		}
	}
	const dry = build(0);
	feed(dry, 12, 12);
	assert.ok(dry.count >= 100, "the dry bend must actually be packed");
	const wet = build(1);
	feed(wet, 12, 12);
	assert.ok(dry.drained <= 3, `a dry packed bend barely moves, ${dry.drained} got out`);
	assert.ok(wet.drained >= 4 * Math.max(dry.drained, 1), `a lubricated bend must flow, only ${wet.drained} got out`);
	assert.equal(wet.maxPen, 0, "lubrication may not press a grain through a wall");
	conserved(wet, "lubricated bend");
	tally(wet);
	return wet.drained;
}

// A jammed cluster: more grains than the pocket likes. The pile stays a pile,
// relaxes to a bounded overlap and two runs agree exactly.
function jammedCluster() {
	function build() {
		const layout = field({ "4,4": ["hollow", [], 14] });
		const v = valve(layout, 4, 4);
		const sim = S.create(layout, { turning: false });
		let placed = 0;
		for (let row = -2; row <= 2; row++) {
			for (let col = -2; col <= 2; col++) {
				if (Math.hypot(col, row) > 2.7) continue;
				if (S.addGrain(sim, v.cx + col * 4.2, v.cy + row * 4.2, 2.3, (col * 3 + row + 8) % 6) >= 0) placed++;
			}
		}
		return { sim, placed };
	}
	const a = build();
	runChecked(a.sim, 4, "jammed cluster");
	const b = build();
	run(b.sim, 4);
	assert.ok(a.placed >= 12, "the jam fixture must actually pack a cluster");
	assert.equal(a.sim.count, a.placed, "a jammed cluster keeps every grain");
	assert.ok(worstOverlap(a.sim) < 0.6, "a jammed cluster must relax to a bounded overlap");
	assert.deepEqual(snapshot(a.sim), snapshot(b.sim), "a jammed cluster must be deterministic");
	assert.equal(a.sim.maxPen, 0, "no grain may be pressed through a wall");
	conserved(a.sim, "jammed cluster");
	tally(a.sim);
	return a.sim.count;
}

// Coincident grains: three on one point have no contact axis of their own. The
// seed-derived direction has to split them the same way every run.
function coincident() {
	function build() {
		const layout = field({ "4,4": ["hollow", [], 12] });
		const v = valve(layout, 4, 4);
		const sim = S.create(layout, { turning: false });
		for (let k = 0; k < 3; k++) assert.ok(S.addGrain(sim, v.cx, v.cy, 2.3, k) >= 0);
		return sim;
	}
	const a = build();
	const b = build();
	runChecked(a, 2, "coincident grains");
	run(b, 2);
	assert.equal(a.count, 3);
	for (let i = 0; i < 3; i++) {
		for (let j = i + 1; j < 3; j++) {
			const d = Math.hypot(a.x[i] - a.x[j], a.y[i] - a.y[j]);
			assert.ok(d > 2 * 2.3 - 0.6, "coincident grains must separate");
		}
	}
	assert.deepEqual(snapshot(a), snapshot(b), "coincident separation must be deterministic");
	conserved(a, "coincident grains");
	tally(a);
	return 3;
}

// A grain resting against a diagonal passage must accelerate downhill, not
// lose its tangential travel to the first blocked sweep each substep.
function slopeAndEditing() {
	const layout = field({ "4,4": ["solid", [0, 2]] });
	const v = valve(layout, 4, 4);
	G.setAngle(v, Math.PI / 6);
	const sim = S.create(layout, { turning: false });
	const offset = G.HALF - S.R_GRAIN - 0.02;
	const x = v.cx - Math.sin(v.angle) * offset;
	const y = v.cy + Math.cos(v.angle) * offset;
	assert.ok(S.addGrain(sim, x, y, S.R_GRAIN, 0) >= 0);
	runChecked(sim, 0.18, "slope");
	assert.ok(sim.x[0] > x + 2, "grain must travel downhill on a 30 degree slope");
	assert.ok(sim.vx[0] > 15, "grain must retain downhill inertia");
	const other = S.addGrain(sim, 36, -20, 2.2, 1);
	assert.ok(other >= 0);
	const otherX = sim.x[other];
	assert.ok(S.replaceValve(sim, 44, () => 0.99));
	assert.equal(sim.count, 1, "replacement only purges the edited cell");
	assert.equal(sim.x[0], otherX);
	assert.equal(sim.purged, 1);
	const added = S.fillValve(sim, 44, 3);
	assert.ok(added > 0, "replacement hollow chamber accepts a fill");
	for (let k = 1; k < sim.count; k++) assert.equal(sim.color[k], 3);
	assert.equal(S.fillValve(sim, 44, 4), 0, "repeated fill cannot overlap grains");
	conserved(sim, "valve editing");
	runChecked(sim, 0.3, "edited valve");
}
slopeAndEditing();

// Valve brush placement: type and direction resolve independently, a
// direction-only change turns in place and keeps grains, and random
// replacement never re-picks the same shape under a rotated port list.
function valvePlacement() {
	const layout = field({ "4,4": ["hollow", [0, 2], 12] });
	const sim = S.create(layout, { turning: false });
	const cell = 44;
	const v0 = valve(layout, 4, 4);
	assert.ok(S.addGrain(sim, v0.cx, v0.cy, 2.2, 0) >= 0);
	assert.ok(S.addGrain(sim, 36, -20, 2.2, 1) >= 0);

	assert.equal(S.placeValve(sim, cell, { type: null, dir: null }), false, "not change / not change is a no-op");
	assert.equal(valve(layout, 4, 4), v0);
	assert.equal(sim.count, 2);

	assert.equal(S.placeValve(sim, cell, { type: null, dir: 1 }), "turn", "direction-only change turns");
	assert.equal(valve(layout, 4, 4), v0, "a turn does not rebuild the valve");
	assert.equal(sim.count, 2, "a turn keeps every grain");
	assert.equal(G.orientationOf(v0, G.quarterOf(sim.target[cell])), 1);

	assert.equal(S.placeValve(sim, cell, { type: "solid-elbow", dir: 2 }), "replace");
	const v1 = valve(layout, 4, 4);
	assert.notEqual(v1, v0);
	assert.equal(G.typeOf(v1).id, "solid-elbow");
	assert.equal(G.orientationOf(v1), 2);
	assert.deepEqual(G.worldPorts(v1), [1, 2], "elbow at 180 degrees faces S,W");
	assert.equal(sim.count, 1, "a type change clears only its own cell");
	assert.equal(sim.purged, 1);

	const draws = [0, 0.99];
	assert.equal(S.placeValve(sim, cell, { type: "random", dir: "random" }, () => draws.shift()), "replace");
	const v2 = valve(layout, 4, 4);
	assert.equal(G.typeOf(v2).id, "solid-straight", "first random draw picks the first other type");
	assert.equal(G.orientationOf(v2), 1, "random direction 270 degrees on a straight is the vertical");

	assert.equal(S.placeValve(sim, cell, { type: "no-such-type", dir: null }), false);
	assert.equal(S.placeValve(sim, -1, { type: "random", dir: null }), false);
	assert.equal(S.placeValve(sim, cell, { type: null, dir: NaN }), false);
	assert.equal(valve(layout, 4, 4), v2, "rejected placements change nothing");

	assert.equal(S.placeValve(sim, cell, { type: "hollow-cross", dir: 0 }), "replace");
	assert.equal(S.placeValve(sim, cell, { type: null, dir: "random" }, () => 0.5), false, "a cross has no other direction");

	assert.equal(S.placeValve(sim, cell, { type: "hollow-straight", dir: null }), "replace");
	const chamber = valve(layout, 4, 4).chamberR;
	assert.ok(chamber > 0);
	assert.equal(S.placeValve(sim, cell, { type: "hollow-elbow", dir: null }), "replace");
	assert.equal(valve(layout, 4, 4).chamberR, chamber, "hollow to hollow keeps the chamber size");
	conserved(sim, "valve placement");
	runChecked(sim, 0.3, "placed valve");

	const rotated = field({ "4,4": ["hollow", [1, 3], 12] });
	const sim2 = S.create(rotated, { turning: false });
	for (const draw of [0, 0.25, 0.5, 0.75, 0.99]) {
		const before = G.typeOf(valve(rotated, 4, 4)).id;
		assert.ok(S.replaceValve(sim2, cell, () => draw));
		assert.notEqual(G.typeOf(valve(rotated, 4, 4)).id, before, "random replacement always changes the shape");
	}
}
valvePlacement();

// A rotating blind pocket: a one-port disc carrying a grain through a quarter
// turn. The mouth shuts behind the grain, so the only thing that keeps it out of
// metal is the disc carrying it.
function rotatingPocket() {
	const layout = field({ "4,4": ["solid", [3]] });
	const v = valve(layout, 4, 4);
	const sim = S.create(layout, { turning: false });
	assert.ok(S.addGrain(sim, v.cx, v.cy - 20, 2.2, 0) >= 0, "the blind passage must take the grain");
	const before = Math.atan2(sim.y[0] - v.cy, sim.x[0] - v.cx);
	S.turn(sim, 4 * N + 4, 1);
	runChecked(sim, 0.2, "rotating pocket");
	assert.equal(v.seam[3] + v.seam[0], 0, "the mouth must be shut while the grain rides");
	runChecked(sim, 1, "rotating pocket");
	const turned = v.angle;
	const moved = Math.atan2(sim.y[0] - v.cy, sim.x[0] - v.cx) - before;
	assert.ok(Math.abs(turned - G.HALF_PI) < 1e-6, `the disc must reach its target, turned ${turned.toFixed(3)}`);
	assert.ok(moved > 1.2 && moved < Math.PI, `the pocket must carry the grain round, it moved ${moved.toFixed(2)} rad`);
	assert.ok(Math.hypot(sim.x[0] - v.cx, sim.y[0] - v.cy) < RV, "a carried grain stays inside the rim");
	assert.equal(sim.drained, 0);
	assert.equal(sim.recovered, 0, "a carried grain never needs recovery");
	conserved(sim, "rotating blind pocket");
	tally(sim);

	// Free air inside a spinning hollow chamber exerts zero torque on a falling grain.
	const chamberLayout = field({ "4,4": ["hollow", [], 13] });
	const cv = valve(chamberLayout, 4, 4);
	const chamberSim = S.create(chamberLayout, { turning: false });
	assert.ok(S.addGrain(chamberSim, cv.cx, cv.cy - 5, 2.2, 0) >= 0);
	S.turn(chamberSim, 4 * N + 4, 1);
	for (let k = 0; k < 15; k++) S.step(chamberSim, STEP);
	assert.ok(Math.abs(chamberSim.x[0] - cv.cx) < 1e-9, "chamber air must not drag a free-falling grain");
	conserved(chamberSim, "spinning chamber free fall");

	return moved.toFixed(2);
}

// Fixed-step equivalence: the same simulated time in different frame chunks must
// produce the same state, and a long stall must neither spiral nor be replayed.
function frameRates() {
	const a = S.create(G.createLayout(11));
	const b = S.create(G.createLayout(11));
	assert.equal(S.seed(a), S.seed(b));
	for (let k = 0; k < 50; k++) S.advance(a, STEP * 4);
	for (let k = 0; k < 200; k++) S.advance(b, STEP);
	assert.deepEqual(snapshot(a), snapshot(b), "30 and 120 Hz must agree after the same simulated time");
	assert.ok(Math.abs(a.clock - b.clock) < 1e-9, "the two runs must share a clock");

	const before = a.steps;
	const ran = S.advance(a, 5);
	assert.ok(ran <= S.MAX_STEPS, "catch-up must be bounded");
	assert.equal(a.steps - before, ran, "a stall must run exactly the substeps it reports");
	S.resume(a);
	assert.equal(a.accumulator, 0, "resume must drop the backlog");
	assert.equal(S.advance(a, 0), 0);
	assert.equal(S.advance(a, -1), 0);
	tally(b);
	return `${ran}/${S.MAX_STEPS}`;
}

// Counters: pouring, draining and resetting must add up at every stage.
function counters() {
	const sim = S.create(G.createLayout(7));
	const seeded = S.seed(sim);
	assert.equal(seeded, sim.count);
	conserved(sim, "seed");
	const emptied = S.drain(sim);
	assert.equal(emptied, seeded);
	assert.equal(sim.count, 0, "draining empties the machine");
	conserved(sim, "drain");
	const poured = S.pour(sim, 24);
	assert.ok(poured > 0, "pouring fills the free slots again");
	assert.equal(sim.count, poured);
	conserved(sim, "pour");
	run(sim, 2);
	conserved(sim, "after a run");
	S.reset(sim);
	assert.equal(sim.count, 0);
	assert.equal(sim.injected + sim.drained + sim.purged, 0, "reset must clear the counters");
	assert.equal(sim.clock, 0);
	assert.equal(sim.steps, 0);
	assert.equal(S.seed(sim), seeded, "a reset must reproduce the seeded run");
	tally(sim);
	return `${seeded} seeded, ${poured} poured`;
}

// The whole machine for sixty seconds across two seeds: counters must add up,
// grains must drain through aligned ports, and overlap/penetration stay bounded.
function machine() {
	const sim = S.create(G.createLayout(11));
	const seeded = S.seed(sim);
	const t0 = process.hrtime.bigint();
	runChecked(sim, 60, "machine-11");
	const alt = S.create(G.createLayout(12));
	assert.ok(S.seed(alt) >= 40, "seed 12 must populate upper reservoirs");
	runChecked(alt, 15, "machine-12");
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	conserved(sim, "machine-11");
	conserved(alt, "machine-12");
	assert.ok(sim.drained > 0 && alt.drained > 0, `grains must reach the drain (${sim.drained}, ${alt.drained})`);
	assert.ok(sim.maxOverlap < 1 && alt.maxOverlap < 1, `bounded overlap, got ${sim.maxOverlap.toFixed(2)}`);
	assert.ok(sim.maxPen < 0.25 && alt.maxPen < 0.25, `bounded wall penetration, got ${sim.maxPen.toFixed(3)}`);
	assert.ok(sim.maxPush < 1.5 && alt.maxPush < 1.5, `no teleports, biggest recovery push ${sim.maxPush.toFixed(2)} px`);
	assert.ok(sim.recovered < 40, `recovery must stay rare, got ${sim.recovered}`);
	tally(sim);
	tally(alt);
	return `${seeded} seeded, ${sim.count} active, ${sim.drained} drained, ${ms.toFixed(0)} ms`;
}

// ---------------------------------------------------------------- run

const t0 = process.hrtime.bigint();
const drained = fallingColumn();
const sealed = sealedReservoir();
const routed = quarterTurnElbow();
const throat = nearlyAligned();
const exits = multiOutlet();
const bend = packedBend();
const jam = jammedCluster();
const split = coincident();
const carried = rotatingPocket();
const frames = frameRates();
const counted = counters();
const full = machine();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(
	[
		`OK  falling column ${drained} drained  sealed reservoir ${sealed} kept`,
		`quarter-turn elbow ${routed} rerouted  throat at ${throat}  multi-outlet ${exits} out`,
		`packed bend ${bend} out lubricated  jammed cluster ${jam} kept  coincident ${split} split  rotating pocket ${carried} rad carried`,
		`frame rates ${frames}  counters ${counted}`,
		`machine ${full}`,
		`steps ${worst.steps}  recovered ${worst.rec}  maxPush ${worst.push.toFixed(2)}  maxOverlap ${worst.overlap.toFixed(2)}  maxWall ${worst.pen.toFixed(3)}`,
		`ms ${ms.toFixed(0)}`,
	].join("\n"),
);
