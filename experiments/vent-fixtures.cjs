// Fixtures for random-map Vent mode: existing-valve routes, single-port
// collectors, mouth-only input, scoring and exact teardown.
// Run: node experiments/vent-fixtures.cjs
const assert = require("node:assert/strict");
const G = require("../prototype/shared/geometry.js");
const S = require("../prototype/shared/simulation.js");
const I = require("../prototype/shared/inlets.js");
const Game = require("../prototype/shared/game.js");

const N = G.N;
const SLOTS = N * N;

function ventGame(seed, players) {
	const sim = S.create(G.createLayout(seed));
	S.setPressure(sim, "grid");
	const game = Game.create(sim, { mode: "vent", botControl: true, players });
	return { sim, game };
}

function cellText(sim) {
	const out = [];
	for (let k = 0; k < SLOTS; k++) {
		const v = sim.layout.valves[k];
		out.push([
			G.typeOf(v).id,
			G.orientationOf(v),
			v.chamberR,
			sim.caseTint[k],
			sim.autoLocked[k],
			sim.goalOwner[k],
		].join(":"));
	}
	return out;
}

function mouthCount(sim) {
	let count = 0;
	for (let k = 0; k < sim.inlets.count; k++) if (sim.inlets.present[k]) count++;
	return count;
}

// ---- two random-map routes and one hollow-single collector per seat ---------
{
	const seed = 7;
	const baseLayout = G.createLayout(seed);
	const before = S.create(baseLayout);
	const beforeCells = cellText(before);
	const { sim, game } = ventGame(seed, 2);
	assert.equal(game.vent.count, 2);
	assert.equal(sim.autoRotate, 0.05, "the mode keeps five percent of valves on automatic rotation");
	assert.equal(sim.pressureMode, "grid");
	assert.equal(sim.count, 0, "grains cannot pack the gas routes");
	assert.equal(mouthCount(sim), 4, "each of two seats owns one source and one vent mouth");

	const mouths = new Set();
	const bottles = new Set();
	for (let s = 0; s < game.vent.count; s++) {
		const seat = game.vent.seats[s];
		assert.equal(seat.player, s);
		assert.ok(seat.bottle >= 0 && seat.bottle < SLOTS, "every seat gets a collector");
		assert.ok(!bottles.has(seat.bottle), "collectors are distinct");
		bottles.add(seat.bottle);
		assert.ok(seat.inMouth >= 0 && seat.outMouth >= 0);
		assert.notEqual(seat.inMouth, seat.outMouth);
		assert.ok(!mouths.has(seat.inMouth) && !mouths.has(seat.outMouth), "mouths are distinct and seat-owned");
		mouths.add(seat.inMouth);
		mouths.add(seat.outMouth);
		assert.equal(sim.inlets.owner[seat.inMouth], s);
		assert.equal(sim.inlets.owner[seat.outMouth], s);
		assert.equal(sim.inlets.level[seat.inMouth], I.HIGH, "the player's source mouth is high pressure");
		assert.equal(sim.inlets.level[seat.outMouth], I.LOW, "the player's vent mouth is low pressure");

		const target = sim.layout.valves[seat.bottle];
		assert.equal(G.typeOf(target).id, "hollow-single", "the collector has exactly one hollow port");
		assert.ok(G.orientationOf(target) >= 0 && G.orientationOf(target) < 4, "the single port gets a random quarter-turn");
		assert.equal(target.chamberR, Game.GOAL_CHAMBER);
		assert.equal(sim.autoLocked[seat.bottle], before.autoLocked[seat.bottle], "the collector stays in the normal rotation pool");
		assert.equal(sim.goalOwner[seat.bottle], s);
		assert.equal(sim.caseTint[seat.bottle], s);

		const span = seat.spanHi - seat.spanLo;
		assert.ok(span > 0.02, "the two routed mouths affect the collector, span " + span.toFixed(2));
		assert.ok(seat.hi > seat.lo, "the pressure task has a range");
		assert.ok(seat.lo >= seat.spanLo - 1e-6 && seat.hi <= seat.spanHi + 1e-6, "the range fits reachable pressure");
		assert.equal(seat.tag, seat.lo.toFixed(2) + "–" + seat.hi.toFixed(2));
	}

	let changed = 0;
	for (let k = 0; k < SLOTS; k++) {
		const v = sim.layout.valves[k];
		const old = before.layout.valves[k];
		assert.equal(G.typeOf(v).id, k === game.vent.seats[0].bottle || k === game.vent.seats[1].bottle ? "hollow-single" : G.typeOf(old).id,
			"routes reuse each map valve's random type");
		if (cellText(sim)[k] !== beforeCells[k]) {
			changed++;
			assert.equal(game.vent.used[k], 1, "only the collector or its route changes");
		}
		if (k !== game.vent.seats[0].bottle && k !== game.vent.seats[1].bottle) {
			assert.equal(sim.caseTint[k], before.caseTint[k], "route valves are not recolored as player-owned controls");
			assert.equal(sim.goalOwner[k], before.goalOwner[k]);
		}
	}
	assert.ok(changed < 55, "the mode routes through the map instead of replacing whole columns");
}

// ---- seeded route placement and random direction are repeatable ------------
{
	const a = ventGame(21, 2).game.vent.seats;
	const b = ventGame(21, 2).game.vent.seats;
	for (let s = 0; s < 2; s++) {
		assert.equal(a[s].bottle, b[s].bottle);
		assert.equal(a[s].inMouth, b[s].inMouth);
		assert.equal(a[s].outMouth, b[s].outMouth);
		assert.equal(a[s].tag, b[s].tag);
		assert.equal(a[s].column, (a[s].bottle % N), "the reported collector column is its actual map position");
	}
}

// ---- mouth ownership and valve input ----------------------------------------
{
	const { sim, game } = ventGame(7, 2);
	const mine = game.vent.seats[0];
	const rival = game.vent.seats[1];
	assert.equal(Game.pressActor(game, mine.inMouth), 0);
	assert.equal(Game.pressActor(game, mine.outMouth), 0);
	assert.equal(Game.pressActor(game, rival.inMouth), -1, "a bot seat's mouth refuses a human click");
	Game.setPlayerBot(game, 1, false);
	assert.equal(Game.pressActor(game, rival.inMouth), 1, "a handed-over mouth answers its human");
	for (let k = 0; k < SLOTS; k++) assert.equal(Game.canTurn(game, k), false, "players never turn valves in Vent mode");
	assert.equal(sim.inlets.open[mine.inMouth], 1);
	assert.equal(sim.inlets.open[mine.outMouth], 1);
}

// ---- bot control works on the same mouth pair a person can operate ----------
{
	const { sim, game } = ventGame(7, 2);
	Game.setPlayerBot(game, 0, false);
	const userSeat = game.vent.seats[0];
	const openBefore = sim.inlets.open.slice();
	for (let k = 0; k < Math.round(20 / S.STEP); k++) {
		S.step(sim, S.STEP);
		Game.step(game, S.STEP);
	}
	assert.equal(userSeat.drive, 0, "an unplayed human seat is never driven");
	assert.equal(sim.inlets.open[userSeat.inMouth], openBefore[userSeat.inMouth]);
	assert.equal(sim.inlets.open[userSeat.outMouth], openBefore[userSeat.outMouth]);
	assert.equal(game.players[0].score, 0, "a human-controlled seat is not scored by the bot");
	assert.ok(game.vent.seats[1].pressure >= 0 && game.vent.seats[1].pressure <= 1);
	assert.equal(sim.injected, sim.count + sim.drained + sim.purged);
}

// ---- roster changes, exact restore and fresh-match handling -----------------
{
	const sim = S.create(G.createLayout(7));
	S.setPressure(sim, "grid");
	const before = cellText(sim);
	const game = Game.create(sim, { mode: "vent", botControl: true, players: 2 });
	assert.equal(Game.removePlayer(game, 0), false, "the local seat stays");
	assert.equal(Game.removePlayer(game, 1), true);
	assert.equal(game.players.length, 1);
	assert.equal(game.vent.count, 1);
	assert.equal(mouthCount(sim), 2);
	assert.equal(Game.addPlayer(game), true);
	assert.equal(game.vent.count, 2);
	assert.equal(Game.addPlayer(game), false, "Vent mode caps at two seats");

	Game.setMode(game, "lab");
	assert.deepEqual(cellText(sim), before, "every changed map valve is restored exactly");
	assert.equal(mouthCount(sim), sim.inlets.count, "Lab mode restores all mouths");
	assert.equal(sim.autoRotate, Game.LAB_AUTO);

	Game.setMode(game, "vent");
	assert.equal(game.vent.count, 2);
	Game.setMode(game, "game");
	assert.equal(Game.addPlayer(game), true, "the roster can grow again outside Vent mode");
	assert.ok(game.players.length <= Game.MAX_SEATS);
}

{
	const { sim, game } = ventGame(42, 2);
	Game.resetMatch(game, sim);
	assert.equal(game.players[0].score + game.players[1].score, 0);
	assert.equal(game.vent.count, 2);
	for (const seat of game.vent.seats) {
		assert.ok(seat.bottle >= 0);
		assert.equal(seat.rounds, 0);
	}
	const fresh = S.create(G.createLayout(42));
	Game.resetMatch(game, fresh);
	assert.equal(game.sim, fresh);
	assert.equal(game.vent.count, 2);
}

console.log("OK  Vent mode: random-map routes, hollow-single targets, mouth-only control, deterministic setup, roster changes and exact restore");
