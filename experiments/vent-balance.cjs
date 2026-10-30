// Setup survey for random-map Vent mode: route coverage, target ranges and
// exact teardown across seeds and one/two seats.
// Run: node experiments/vent-balance.cjs [seeds...]
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const Game = require("../prototype/shared/game.js");

const SEEDS = process.argv.slice(2).map(Number);
if (!SEEDS.length) SEEDS.push(7, 21, 99, 2024);

function fieldState(sim) {
	const state = [];
	for (let k = 0; k < sim.layout.valves.length; k++) {
		const v = sim.layout.valves[k];
		state.push([
			G.typeOf(v).id,
			G.orientationOf(v),
			v.chamberR,
			sim.caseTint[k],
			sim.autoLocked[k],
			sim.goalOwner[k],
		].join(":"));
	}
	return state;
}

function mouthCount(sim) {
	let count = 0;
	for (let k = 0; k < sim.inlets.count; k++) if (sim.inlets.present[k]) count++;
	return count;
}

for (const seed of SEEDS) {
	for (const players of [1, 2]) {
		const sim = S.create(G.createLayout(seed));
		S.setPressure(sim, "grid");
		const original = fieldState(sim);
		const start = Date.now();
		const game = Game.create(sim, { mode: "vent", botControl: false, players });
		const setupMs = Date.now() - start;
		const routeCells = game.vent.used.reduce((sum, used) => sum + used, 0);
		const ranges = [];
		const mouths = new Set();

		assert.equal(game.vent.count, players);
		assert.equal(sim.autoRotate, 0.05);
		assert.equal(sim.pressureMode, "grid");
		assert.equal(sim.count, 0);
		assert.equal(mouthCount(sim), players * 4);
		for (let seatId = 0; seatId < players; seatId++) {
			const seat = game.vent.seats[seatId];
			assert.ok(seat.bottle >= 0, `seed ${seed} seat ${seatId} has a collector`);
			assert.equal(G.typeOf(sim.layout.valves[seat.bottle]).id, "hollow-single");
			assert.ok(seat.spanHi > seat.spanLo);
			assert.ok(seat.lo >= seat.spanLo - 1e-6 && seat.hi <= seat.spanHi + 1e-6);
			for (const mouth of [...seat.inMouths, ...seat.outMouths]) {
				assert.ok(!mouths.has(mouth), "seats have four distinct controls");
				mouths.add(mouth);
				assert.equal(sim.inlets.owner[mouth], seatId);
			}
			ranges.push(`${(seat.spanHi - seat.spanLo).toFixed(2)} reach / ${seat.tag}`);
		}
		for (let k = 0; k < sim.layout.valves.length; k++) {
			const target = game.vent.seats.some(seat => seat.bottle === k);
			if (target) continue;
			assert.equal(G.typeOf(sim.layout.valves[k]).id, original[k].split(":")[0], "routing keeps the random valve type");
		}

		Game.setMode(game, "lab");
		assert.deepEqual(fieldState(sim), original, "leaving restores the original random map");
		assert.equal(mouthCount(sim), sim.inlets.count);
		console.log(`seed ${seed}, ${players} seat${players === 1 ? "" : "s"}: ${setupMs} ms setup, ${routeCells} route cells, ${ranges.join("; ")}, exact restore`);
	}
}

console.log("OK  Vent route survey: every surveyed seat gets four unique mouths and a reachable hollow-single target");
